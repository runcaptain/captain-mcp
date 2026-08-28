import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, textResult, type ToolResult } from "./captainClient.js";
import { QueryV3ConfigSchema, buildQueryV3Body, type QueryV3Config } from "./chunkTools.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);
const enc = encodeURIComponent;
const json = (data: unknown): ToolResult => textResult(JSON.stringify(data, null, 2));

/**
 * captain_eval — retrieval evaluation as a single tool call.
 *
 * Implements the loop the Captain CLI runs under Optimize/Tune: run a question
 * set against one or more query configurations, score recall@k / MRR / nDCG,
 * and compare configurations as a PAIRED test on the same questions.
 *
 * Question GENERATION deliberately lives in the calling agent, not here: this
 * server is a bearer-passthrough API proxy with no model access. The client
 * samples chunks and writes one paraphrased question per chunk (the prompt is
 * embedded in the tool description), then hands the set to this tool, which
 * does the deterministic part — query, match, score, compare.
 */

// ── Question set ─────────────────────────────────────────────────────────

const GroundTruthSchema = z.object({
  chunkIds: z.array(z.string()).default([])
    .describe("chunk_ids that answer this question (the chunk the question was generated from)."),
  documentIds: z.array(z.string()).default([])
    .describe("document_ids that answer this question. Required for the default document-level matching."),
});

const QuestionSchema = z.object({
  id: z.string().describe("Stable id for this question (used to pair configurations)."),
  question: z.string().min(1).describe("The question text sent as the query."),
  groundTruth: GroundTruthSchema,
});
type EvalQuestion = z.infer<typeof QuestionSchema>;

const NamedConfigSchema = z.object({
  name: z.string().describe("Label for this candidate, e.g. 'rerank, deeper pool'."),
  config: QueryV3ConfigSchema.describe("Query parameters for this candidate. {} = server defaults (baseline)."),
});
type NamedConfig = z.infer<typeof NamedConfigSchema>;

/**
 * Fan-out caps. One call issues questions x configs authenticated upstream
 * queries, so an uncapped set could burn a caller's API quota and hold server
 * capacity for a long time. These bounds sit well above the methodology's
 * working range (300-500 questions, a 4-config ladder) while keeping the worst
 * case bounded.
 */
const MAX_QUESTIONS = 2000;
const MAX_CONFIGS = 12;
const MAX_TOTAL_QUERIES = 8000;

/**
 * The CLI's fixed ladder. Used when the caller passes no `configs`.
 * Deliberately ordered cheapest-first so early stopping saves the most work.
 *
 * Built from `limit` rather than frozen, because the API requires
 * `candidate_limit >= limit`: a hardcoded pool of 50 would send an invalid
 * query for any limit above 50. The deeper pool stays meaningfully deeper than
 * the default (limit x 3) while respecting the API's ceiling of 200.
 */
function defaultLadder(limit: number): NamedConfig[] {
  const ladder: NamedConfig[] = [
    { name: "baseline", config: {} },
    { name: "rerank on", config: { rerank: true } },
  ];
  // The server's default pool is `limit * 3`, capped at 200. Only add the
  // deeper-pool rung when it can actually be deeper than that: from limit 67
  // upward both land on the 200 ceiling, which would repeat the previous rung's
  // query for every question and report a comparison of a config against itself.
  const serverDefaultPool = Math.min(200, limit * 3);
  const deeperPool = Math.min(200, Math.max(50, limit * 5));
  if (deeperPool > serverDefaultPool) {
    ladder.push({
      name: "rerank, deeper pool",
      config: { rerank: { enabled: true, candidate_limit: deeperPool } },
    });
  }
  ladder.push({
    name: "rerank, drop layout noise",
    config: { rerank: true, exclude_chunk_types: ["page_header", "page_footer", "footnote"] },
  });
  return ladder;
}

// ── Scoring primitives ───────────────────────────────────────────────────

/**
 * Ground-truth ids that can actually match a result: trimmed, blanks dropped,
 * DEDUPED. Every consumer of ground truth goes through this, and it must agree
 * with how the matcher counts, which resolves ids through a Set — a repeated id
 * can only ever be matched once.
 *
 * Counting an unmatchable or repeated id distorts a different number at each
 * site: it scores a question as a miss, inflates nDCG's ideal DCG (a duplicated
 * id turns a perfect rank-1 hit into nDCG 0.613), or classifies a single-hop run
 * as multi-hop and pulls nDCG into every configuration's composite.
 */
const usableIds = (ids: string[] | undefined): string[] => [
  ...new Set((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0)),
];

/** Per-question outcome for one configuration. */
type QuestionOutcome = {
  id: string;
  /** 1-based rank of the best matching item, or null when not found in the returned page. */
  rank: number | null;
  /** All 1-based ranks that matched (used for nDCG on multi-hop questions). */
  matchedRanks: number[];
  relevantCount: number;
  latencyMs: number;
};

/** Rank (1-based) of the first result matching ground truth, plus every matching rank. */
function rankResults(
  results: any[],
  gt: { chunkIds: string[]; documentIds: string[] },
  matchLevel: "document" | "chunk",
): { rank: number | null; matchedRanks: number[] } {
  const wantChunks = new Set(usableIds(gt.chunkIds));
  const wantDocs = new Set(usableIds(gt.documentIds));
  const matchedRanks: number[] = [];
  // A document can occupy several of the top-k slots; count it once at its BEST
  // rank so recall stays comparable across configs that return different chunk
  // densities. `seen` tracks which relevant item each rank is credited to.
  const seen = new Set<string>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i] ?? {};
    const chunkId = String(r.chunk_id ?? "");
    const docId = String(r.document?.id ?? r.document_id ?? "");
    let key: string | null = null;
    if (matchLevel === "chunk") {
      if (chunkId && wantChunks.has(chunkId)) key = `c:${chunkId}`;
    } else {
      if (docId && wantDocs.has(docId)) key = `d:${docId}`;
      // Fall back to the chunk's own document prefix (chunk_id is document_id:index)
      else if (!docId && chunkId.includes(":")) {
        const prefix = chunkId.slice(0, chunkId.lastIndexOf(":"));
        if (wantDocs.has(prefix)) key = `d:${prefix}`;
      }
    }
    if (key && !seen.has(key)) {
      seen.add(key);
      matchedRanks.push(i + 1);
    }
  }
  return { rank: matchedRanks.length ? Math.min(...matchedRanks) : null, matchedRanks };
}

const recallAt = (outcomes: QuestionOutcome[], k: number): number =>
  outcomes.length === 0
    ? 0
    : outcomes.filter((o) => o.rank !== null && o.rank <= k).length / outcomes.length;

const mrr = (outcomes: QuestionOutcome[]): number =>
  outcomes.length === 0
    ? 0
    : outcomes.reduce((s, o) => s + (o.rank ? 1 / o.rank : 0), 0) / outcomes.length;

/**
 * nDCG@k with binary relevance. Only informative when a question has more than
 * one relevant item — with a single relevant item it collapses to a monotone
 * function of rank and carries the same information as MRR.
 */
function ndcgAt(outcomes: QuestionOutcome[], k: number): number {
  if (outcomes.length === 0) return 0;
  let total = 0;
  for (const o of outcomes) {
    let dcg = 0;
    for (const r of o.matchedRanks) if (r <= k) dcg += 1 / Math.log2(r + 1);
    const ideal = Math.min(o.relevantCount, k);
    let idcg = 0;
    for (let i = 1; i <= ideal; i++) idcg += 1 / Math.log2(i + 1);
    total += idcg > 0 ? dcg / idcg : 0;
  }
  return total / outcomes.length;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

/**
 * Wilson 95% interval for a proportion. Preferred over the normal
 * approximation, which overshoots 1.0 when p is near 1 or n is small.
 */
function wilson95(hits: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [
    Math.max(0, Number(((centre - half) / d).toFixed(4))),
    Math.min(1, Number(((centre + half) / d).toFixed(4))),
  ];
}

/**
 * Two-sided exact binomial test at p = 0.5 over the discordant pairs: the
 * probability of an outcome at least as extreme as `b` successes in `b + c`
 * trials. Used for McNemar below 25 discordant pairs, where the chi-square
 * approximation is unreliable.
 */
function exactBinomialTwoSided(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  // Binomial pmf at p=0.5: C(n,k) / 2^n. Work in logs to stay exact for large n.
  const logFact: number[] = [0];
  for (let i = 1; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  const pmf = (k: number) =>
    Math.exp(logFact[n] - logFact[k] - logFact[n - k] - n * Math.LN2);
  const target = pmf(b);
  let p = 0;
  for (let k = 0; k <= n; k++) {
    const pk = pmf(k);
    // Tolerance guards against float noise making an equally-extreme outcome
    // (the symmetric tail) miss the comparison.
    if (pk <= target * (1 + 1e-9)) p += pk;
  }
  return Math.min(1, p);
}

/**
 * Paired comparison of two configurations on the SAME questions (McNemar).
 * Only discordant pairs carry information: b = A hit & B missed, c = B hit & A
 * missed. Chi-square with continuity correction at >= 25 discordant pairs,
 * exact binomial below that.
 */
function mcnemar(
  aHits: Map<string, boolean>,
  bHits: Map<string, boolean>,
  ids: string[],
): { b: number; c: number; statistic: number | null; p_value: number; significant: boolean; diff: number; diff_ci95: [number, number] } {
  let b = 0; // baseline hit, candidate missed
  let c = 0; // candidate hit, baseline missed
  for (const id of ids) {
    const a = aHits.get(id) === true;
    const d = bHits.get(id) === true;
    if (a && !d) b++;
    else if (!a && d) c++;
  }
  const n = ids.length;
  const discordant = b + c;
  let statistic: number | null = null;
  let p = 1;
  if (discordant === 0) {
    p = 1;
  } else if (discordant >= 25) {
    statistic = Math.pow(Math.abs(b - c) - 1, 2) / discordant;
    // Two-sided normal tail for chi-square with 1 df.
    const zAbs = Math.sqrt(Math.max(0, statistic));
    p = 2 * (1 - normalCdf(zAbs));
  } else {
    p = exactBinomialTwoSided(Math.min(b, c), Math.max(b, c));
  }
  // Paired difference (candidate - baseline) and its 95% interval.
  const diff = n === 0 ? 0 : (c - b) / n;
  const se = n === 0 ? 0 : Math.sqrt(Math.max(0, discordant - Math.pow(b - c, 2) / n)) / n;
  return {
    b,
    c,
    statistic: statistic === null ? null : Number(statistic.toFixed(4)),
    p_value: Number(Math.min(1, Math.max(0, p)).toFixed(4)),
    significant: p < 0.05,
    diff: Number(diff.toFixed(4)),
    diff_ci95: [Number((diff - 1.96 * se).toFixed(4)), Number((diff + 1.96 * se).toFixed(4))],
  };
}

/** Abramowitz & Stegun 26.2.17 normal CDF — enough precision for a p-value. */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// ── Composite score ──────────────────────────────────────────────────────

type Metrics = {
  n: number;
  recall_at_1: number;
  recall_at_3: number;
  recall_at_10: number;
  mrr: number;
  ndcg_at_10: number | null;
  latency_p50_ms: number;
  latency_p95_ms: number;
};

/**
 * 0-100 composite. Weights: recall@10 0.40, recall@3 0.25, MRR 0.20,
 * nDCG@10 0.15 — redistributed across the components present, so a single-hop
 * question set (where nDCG carries no information beyond MRR) is not penalised.
 */
function composite(m: Metrics, multiHop: boolean): { score: number; grade: string; weakest: string } {
  const parts: Array<{ key: string; value: number; weight: number }> = [
    { key: "found", value: m.recall_at_10, weight: 0.4 },
    { key: "found early", value: m.recall_at_3, weight: 0.25 },
    { key: "ranked first", value: m.mrr, weight: 0.2 },
  ];
  if (multiHop && m.ndcg_at_10 !== null) {
    parts.push({ key: "ordering", value: m.ndcg_at_10, weight: 0.15 });
  }
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const score = parts.reduce((s, p) => s + p.value * (p.weight / totalWeight), 0) * 100;
  const weakest = parts.reduce((lo, p) => (p.value < lo.value ? p : lo), parts[0]).key;
  const grade =
    score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  return { score: Number(score.toFixed(1)), grade, weakest };
}

/** Plain-English next step keyed to the weakest component. */
function diagnose(weakest: string): string {
  switch (weakest) {
    case "found":
      return "Documents are not surfacing at all. Re-index with processing_type 'advanced' if the sources are PDFs, scans, or DOCX with tables; add chunk/document metadata so `filter` can narrow the search; or raise `limit`. Lower `semantic_ratio` if the corpus is full of exact terms (part numbers, error codes).";
    case "found early":
      return "The right document is retrieved but ranked too low for a consumer that reads the top few. Turn on `rerank`, then raise the reranker's `candidate_limit` (the ladder's 'deeper pool' step). Dropping page_header/page_footer/footnote via `exclude_chunk_types` also stops layout text competing with body text.";
    case "ranked first":
      return "Documents are found and near the top but rarely first. Reranking with a larger candidate pool is the usual fix; a `boost` rule on the metadata that marks authoritative chunks helps when the wording gap is the problem.";
    case "ordering":
      return "Multi-hop ordering is weak. Add chunk relations (claim -> evidence) and query with include_related_chunks so the supporting chunk travels with the match.";
    default:
      return "No dominant weakness.";
  }
}

// ── Tool ─────────────────────────────────────────────────────────────────

/** Run one configuration over the whole question set, bounded by `concurrency`. */
async function runConfig(
  config: ReturnType<typeof getConfig>,
  collection: string,
  questions: EvalQuestion[],
  cfg: QueryV3Config,
  matchLevel: "document" | "chunk",
  concurrency: number,
): Promise<{ outcomes: QuestionOutcome[]; failed: Array<{ id: string; error: string }> }> {
  const outcomes: QuestionOutcome[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < questions.length) {
      const q = questions[cursor++];
      const started = Date.now();
      try {
        const body = buildQueryV3Body(q.question, cfg);
        const data = await captainFetch(config, `collections/${enc(collection)}/query`, {
          version: "v3",
          method: "POST",
          body,
        });
        const latencyMs = Date.now() - started;
        const results = Array.isArray(data?.results) ? data.results : [];
        const { rank, matchedRanks } = rankResults(results, q.groundTruth, matchLevel);
        const relevantCount = usableIds(
          matchLevel === "chunk" ? q.groundTruth.chunkIds : q.groundTruth.documentIds,
        ).length;
        outcomes.push({ id: q.id, rank, matchedRanks, relevantCount: Math.max(1, relevantCount), latencyMs });
      } catch (e: any) {
        // A query that fails (timeout, 5xx) is EXCLUDED, never scored as a miss:
        // scoring it as a miss makes a flaky round look worse than it is, and
        // dropping a hard question makes a round look better than it is.
        failed.push({ id: q.id, error: String(e?.message || e).slice(0, 300) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 16)) }, worker));
  return { outcomes, failed };
}

export function registerEvalTools(server: McpServer): void {
  server.registerTool(
    "captain_eval",
    {
      title: "Evaluate and tune retrieval quality",
      description:
        "Run a question set against one or more v3 query configurations and score retrieval quality: " +
        "recall@1/3/10 (primary), MRR, nDCG@10 (multi-hop only), latency p50/p95, and a 0-100 composite with a " +
        "letter grade and a plain-English diagnosis of the weakest component. Configurations are compared as a " +
        "PAIRED test on the same questions (McNemar + the paired difference's 95% interval), so the result says " +
        "whether a gain is real rather than just bigger.\n\n" +
        "BUILD THE QUESTION SET FIRST (this server has no model, so generation happens on your side):\n" +
        "1. Map the corpus: captain_list_documents, then captain_list_chunks per document.\n" +
        "2. Sample chunks. Skip chunks under ~200 characters and skip page_header / page_footer / footnote / " +
        "heading chunks — a question generated from page furniture is a bad question. Prefer breadth (more " +
        "documents) over depth; questions from one document are correlated.\n" +
        "3. Write ONE question per sampled chunk with this instruction, verbatim:\n" +
        "   \"You write search evaluation questions. Given one chunk of text from a real document, write ONE " +
        "question a real user of this document collection would plausibly ask, that this chunk answers. Do not " +
        "reuse distinctive words or phrases from the chunk; paraphrase the underlying need in different " +
        "language, the way someone who has not read this exact passage would phrase it. Reply with ONLY the " +
        "question, no preamble, no quotes.\"\n" +
        "   The paraphrase rule is the whole trick: a question that copies the chunk's wording tests keyword " +
        "matching, not retrieval. Record groundTruth {chunkIds:[chunk_id], documentIds:[document_id]} — because " +
        "the question came FROM the chunk, relevance is known without human grading.\n" +
        "4. How many: n0 = 385 covers a large corpus at 95% confidence with a 5-point margin; apply the " +
        "finite-population correction n = n0 / (1 + (n0-1)/N) for a corpus of N sampled chunks, and just use the " +
        "whole corpus when that would cover 80% or more. Under 100 questions cannot distinguish 97% from 93%.\n\n" +
        "Then call this tool. With no `configs` it runs the standard ladder (baseline, rerank on, rerank with a " +
        "deeper pool, rerank plus dropping layout noise) and recommends a winner. Tuning query parameters this " +
        "way needs no holdout, but the moment you tune the COLLECTION itself (chunk metadata, relations, or a " +
        "boost keyed on specific chunk_ids) you are teaching to the test: split by document, tune on one split, " +
        "and report on the other.",
      inputSchema: {
        collection: z.string().describe("Collection to evaluate."),
        questions: z.array(QuestionSchema).min(1).max(MAX_QUESTIONS)
          .describe(`The question set, one entry per sampled chunk, with ground truth. Ids must be unique (they pair configurations). Max ${MAX_QUESTIONS}.`),
        configs: z.array(NamedConfigSchema).min(1).max(MAX_CONFIGS).optional()
          .describe(`Candidate configurations to compare. Defaults to the standard ladder: baseline, rerank on, rerank with a deeper candidate pool (scaled to \`limit\`, since the API requires pool >= limit), and rerank plus exclude_chunk_types [page_header, page_footer, footnote]. Max ${MAX_CONFIGS}.`),
        match_level: z.enum(["document", "chunk"]).optional()
          .describe("Match ground truth at document level (default — a document occupying several slots counts once at its best rank) or chunk level (stricter)."),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Results requested per query (default 10). Applies to every config that does not set its own."),
        concurrency: z.number().int().min(1).max(16).optional()
          .describe("Parallel queries in flight (default 4)."),
        early_stop_score: z.number().min(0).max(100).optional()
          .describe("Stop trying further configs once a CLEAN round scores at least this (default 97). A round with any failed question can never trigger early stopping."),
        compare_at_k: z.number().int().min(1).max(100).optional()
          .describe("Rank cutoff for the PAIRED comparison between configurations (default 3). Use the k your consumer actually reads: at k=10 two configs that both retrieve the document somewhere on the page look identical even when one ranks it first."),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const matchLevel = params.match_level ?? "document";
      const limit = params.limit ?? 10;
      const concurrency = params.concurrency ?? 4;
      const earlyStop = params.early_stop_score ?? 97;
      const compareAtK = params.compare_at_k ?? 3;
      const ladder = params.configs ?? defaultLadder(limit);
      const questions = params.questions as EvalQuestion[];
      const multiHop = questions.some(
        (q) =>
          usableIds(matchLevel === "chunk" ? q.groundTruth.chunkIds : q.groundTruth.documentIds)
            .length > 1,
      );
      const warnings: string[] = [];

      // Question ids are the key that pairs configurations together, so they
      // must be unique: a duplicate id collapses to one entry in the per-round
      // outcome map while still appearing twice in the common-id list, which
      // double-counts it in McNemar and can flip the recommendation. Fail loudly
      // rather than silently de-duplicating the caller's set.
      const idCounts = new Map<string, number>();
      for (const q of questions) idCounts.set(q.id, (idCounts.get(q.id) ?? 0) + 1);
      const duplicates = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
      if (duplicates.length) {
        throw new Error(
          `Question ids must be unique — they pair configurations for the comparison. Duplicated: ${duplicates
            .slice(0, 10)
            .join(", ")}${duplicates.length > 10 ? ` (+${duplicates.length - 10} more)` : ""}.`,
        );
      }

      // Ground truth must contain identifiers for the level being matched,
      // otherwise the matcher has nothing to compare against and every affected
      // question scores as a miss — a confidently wrong 0.0, not an error.
      const gtField = matchLevel === "chunk" ? "chunkIds" : "documentIds";
      const missingGt = questions
        .filter((q) => usableIds(q.groundTruth?.[gtField]).length === 0)
        .map((q) => q.id);
      if (missingGt.length) {
        throw new Error(
          `match_level '${matchLevel}' scores against groundTruth.${gtField}, but ${missingGt.length} question(s) have none: ${missingGt
            .slice(0, 10)
            .join(", ")}${missingGt.length > 10 ? ` (+${missingGt.length - 10} more)` : ""}. ` +
            `Populate ${gtField}${matchLevel === "document" ? " (or pass match_level: 'chunk' if you only have chunk ids)" : ""} — without it every one of these would be scored as a miss.`,
        );
      }

      // Cap the cross-product, not just each array: 2000 questions x 12 configs
      // would be 24k upstream queries. Early stopping may cut this short, but
      // the ceiling has to hold for the worst case.
      const plannedQueries = questions.length * ladder.length;
      if (plannedQueries > MAX_TOTAL_QUERIES) {
        throw new Error(
          `This run would issue ${plannedQueries} queries (${questions.length} questions x ${ladder.length} configurations), above the ${MAX_TOTAL_QUERIES} cap. Reduce the question set or the number of configurations — or split the run.`,
        );
      }

      if (questions.length < 100) {
        warnings.push(
          `Only ${questions.length} questions: the 95% interval on recall@10 is roughly +/- ${(
            1.96 * Math.sqrt((0.9 * 0.1) / questions.length) * 100
          ).toFixed(1)} points. Fine for a smoke test, too noisy to decide between close configurations (300-500 is the working range).`,
        );
      }
      if (!multiHop) {
        warnings.push(
          "Single-hop question set: nDCG@10 is reported but excluded from the composite, since with one relevant item it is a monotone function of rank and duplicates MRR.",
        );
      }

      type Round = {
        name: string;
        config: QueryV3Config;
        outcomes: QuestionOutcome[];
        hits: Map<string, boolean>;
        failed: Array<{ id: string; error: string }>;
      };
      const rounds: Round[] = [];

      for (const candidate of ladder) {
        const cfg: QueryV3Config = { limit, ...candidate.config };
        // The API rejects a rerank pool smaller than the result limit. Raise it
        // rather than sending a request we know will 400 — a caller tuning
        // `limit` should not have to hand-edit every candidate's pool.
        if (
          cfg.rerank &&
          typeof cfg.rerank === "object" &&
          typeof cfg.rerank.candidate_limit === "number" &&
          cfg.rerank.candidate_limit < (cfg.limit ?? 10)
        ) {
          const raised = Math.min(200, cfg.limit ?? 10);
          warnings.push(
            `'${candidate.name}': candidate_limit ${cfg.rerank.candidate_limit} is below limit ${cfg.limit} (the API requires pool >= limit); raised to ${raised}.`,
          );
          cfg.rerank = { ...cfg.rerank, candidate_limit: raised };
        }
        log(`eval '${candidate.name}' over ${questions.length} questions in '${params.collection}'`);
        const { outcomes, failed } = await runConfig(
          config, params.collection, questions, cfg, matchLevel, concurrency,
        );
        if (outcomes.length === 0) {
          throw new Error(
            `Every question failed for configuration '${candidate.name}' — nothing was measured. First error: ${failed[0]?.error ?? "unknown"}`,
          );
        }
        // `hits` drives the PAIRED comparison, so it is keyed on compare_at_k
        // (default 3), not always 10. Two configs that both retrieve the
        // document somewhere in the top 10 have zero discordant pairs at k=10
        // even when one ranks it first and the other ranks it tenth — the
        // comparison would report "no difference" for a large real improvement.
        const hits = new Map<string, boolean>();
        for (const o of outcomes) hits.set(o.id, o.rank !== null && o.rank <= compareAtK);
        rounds.push({ name: candidate.name, config: cfg, outcomes, hits, failed });

        // Early stop only on a CLEAN round: a candidate that dropped a hard
        // question to a query failure would otherwise look artificially good.
        const m = metricsFor(outcomes);
        const { score } = composite(m, multiHop);
        if (failed.length === 0 && score >= earlyStop) {
          log(`eval early stop at '${candidate.name}' (${score} >= ${earlyStop})`);
          break;
        }
      }

      // Per-round report over that round's own surviving questions.
      const results = rounds.map((r) => {
        const m = metricsFor(r.outcomes);
        const { score, grade, weakest } = composite(m, multiHop);
        const hitCount = r.outcomes.filter((o) => o.rank !== null && o.rank <= 10).length;
        return {
          name: r.name,
          config: r.config,
          metrics: m,
          score,
          grade,
          weakest_component: weakest,
          diagnosis: diagnose(weakest),
          recall_at_10_ci95: wilson95(hitCount, r.outcomes.length),
          failed_count: r.failed.length,
          failures: r.failed.slice(0, 5),
        };
      });

      // Winner selection on the INTERSECTION of questions that survived in
      // every round — otherwise a config wins by never answering the hard ones.
      const common = questions
        .map((q) => q.id)
        .filter((id) => rounds.every((r) => r.hits.has(id)));
      const degraded = common.length === 0;
      if (degraded) {
        warnings.push(
          "No question survived in every configuration, so the candidates are not comparable. Keeping the baseline rather than persisting a change that only looked better because of which questions it never answered.",
        );
      } else if (common.length < questions.length) {
        warnings.push(
          `Winner chosen on the ${common.length} of ${questions.length} questions that survived in every configuration.`,
        );
      }

      const commonScores = degraded
        ? []
        : rounds.map((r) => {
            const subset = r.outcomes.filter((o) => common.includes(o.id));
            const m = metricsFor(subset);
            return { name: r.name, config: r.config, ...composite(m, multiHop), clean: r.failed.length === 0 };
          });

      const baseline = rounds[0];
      const comparison = degraded
        ? []
        : rounds.slice(1).map((r) => ({
            name: r.name,
            vs: baseline.name,
            ...mcnemar(baseline.hits, r.hits, common),
          }));

      let recommendation: { name: string; config: QueryV3Config; reason: string };
      if (degraded || commonScores.length === 0) {
        recommendation = {
          name: baseline.name,
          config: baseline.config,
          reason: "Comparison degraded (no common surviving questions) — keeping the baseline.",
        };
      } else {
        const best = commonScores.reduce((a, b) => (b.score > a.score ? b : a));
        const baseScore = commonScores[0];
        const stat = comparison.find((c) => c.name === best.name);
        const isBaseline = best.name === baseScore.name;
        recommendation = {
          name: best.name,
          config: best.config,
          reason: isBaseline
            ? `Baseline scored highest (${best.score}) on the common question set; no candidate beat it.`
            : stat && !stat.significant
              ? `'${best.name}' scored highest (${best.score} vs ${baseScore.score}) but the paired difference is not significant (p=${stat.p_value}); treat it as a tie and prefer the cheaper configuration unless the latency cost is acceptable.`
              : `'${best.name}' scored ${best.score} vs baseline ${baseScore.score} on the common question set${stat ? ` (paired difference ${stat.diff >= 0 ? "+" : ""}${(stat.diff * 100).toFixed(1)} points, p=${stat.p_value})` : ""}.`,
        };
      }

      if (rounds.length > 2) {
        warnings.push(
          `Picking the best of ${rounds.length} configurations is optimistic: the maximum of several noisy scores is biased upward. Re-measure the winner on a fresh question set (or a held-out document split) before reporting its score.`,
        );
      }

      return json({
        collection: params.collection,
        question_count: questions.length,
        match_level: matchLevel,
        multi_hop: multiHop,
        limit,
        results,
        comparison: {
          compared_at_k: compareAtK,
          common_question_count: common.length,
          degraded,
          scores_on_common_set: commonScores,
          paired_vs_baseline: comparison,
        },
        recommendation,
        warnings,
        run_at: new Date().toISOString(),
      });
    },
  );
}

function metricsFor(outcomes: QuestionOutcome[]): Metrics {
  const latencies = outcomes.map((o) => o.latencyMs);
  return {
    n: outcomes.length,
    recall_at_1: Number(recallAt(outcomes, 1).toFixed(4)),
    recall_at_3: Number(recallAt(outcomes, 3).toFixed(4)),
    recall_at_10: Number(recallAt(outcomes, 10).toFixed(4)),
    mrr: Number(mrr(outcomes).toFixed(4)),
    ndcg_at_10: Number(ndcgAt(outcomes, 10).toFixed(4)),
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
  };
}
