import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, textResult, type ToolResult, type CaptainConfig } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);

interface QueryResult {
  filename: string;
  document_id: string;
  content: string;
  score: number;
}

// One expected string turned into the two ways it can match a result.
interface Matcher {
  needle: string;
  words: string[];
}

// Prepare the expected strings for a test case once, so matching does not
// re-split them for every result. Ported from captain-mrag-bench eval.py:
// a result matches on a direct substring, or on all words of a multi-word term.
function buildMatchers(expected: string[]): Matcher[] {
  return expected
    .map((raw) => raw.toLowerCase().trim())
    .filter(Boolean)
    .map((needle) => ({
      needle,
      words: needle.replace(/[_-]+/g, " ").split(/\s+/).filter((w) => w.length > 2),
    }));
}

function isRelevant(result: QueryResult, matchers: Matcher[]): boolean {
  const haystack = `${result.filename}\n${result.document_id}\n${result.content}`.toLowerCase();
  return matchers.some(
    (m) => haystack.includes(m.needle) || (m.words.length >= 2 && m.words.every((w) => haystack.includes(w))),
  );
}

async function runQuery(
  config: CaptainConfig,
  collection: string,
  query: string,
  topK: number,
  rerank: boolean,
): Promise<{ results: QueryResult[]; latencyMs: number }> {
  const started = Date.now();
  const data = await captainFetch(config, `collections/${encodeURIComponent(collection)}/query`, {
    method: "POST",
    body: { query, inference: false, top_k: topK, rerank, rerank_model: "gemini" },
  });
  const latencyMs = Date.now() - started;
  const raw = data.search_results || data.results || [];
  const results: QueryResult[] = raw.map((r: any) => ({
    filename: r.filename || "",
    document_id: r.document_id || "",
    content: r.content || r.text || r.chunk || "",
    score: typeof r.score === "number" ? r.score : 0,
  }));
  return { results, latencyMs };
}

// hit@k, reciprocal rank, and precision@k at one cutoff, from a per-result
// relevance flag computed once for the whole result list.
function scoreAtK(hits: boolean[], k: number) {
  const top = hits.slice(0, k);
  const relevant = top.filter(Boolean).length;
  const firstRank = top.indexOf(true) + 1; // 0 when absent
  return {
    recall: relevant > 0 ? 1 : 0,
    rr: firstRank > 0 ? 1 / firstRank : 0,
    precision: top.length > 0 ? relevant / top.length : 0,
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function median(sorted: number[]): number {
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

export function registerEvalTools(server: McpServer): void {
  server.registerTool(
    "captain_eval",
    {
      title: "Score a Captain collection's retrieval quality",
      description:
        "Run a scored retrieval evaluation against a Captain collection. Give a set of test cases — each a query " +
        "plus the strings that mark a relevant result (a filename, document id, or a phrase the right chunk contains) " +
        "— and this measures recall@k, MRR, precision@k, and query latency. Use it to check whether tuning a " +
        "collection (chunking, reranking, indexing sources) makes retrieval better or worse. Every run carries a " +
        "`surface` tag so MCP quality can be compared against the CLI benchmark.",
      inputSchema: {
        collection: z.string().describe("Collection name to evaluate"),
        test_cases: z
          .array(
            z.object({
              query: z.string().describe("Natural language search query"),
              relevant: z
                .array(z.string())
                .min(1)
                .describe("Strings that mark a relevant result: a filename, document id, or a phrase the right chunk contains"),
            }),
          )
          .min(1)
          .describe("Labelled queries to score against the collection"),
        k_values: z
          .array(z.number().int().positive())
          .optional()
          .describe("Cutoffs to score at, e.g. [1, 3, 5, 10] (default [1, 3, 5, 10])"),
        rerank: z.boolean().optional().describe("Enable cross-modal reranking (default true). Required for multimodal collections."),
        surface: z.enum(["mcp", "cli"]).optional().describe("Surface tag for this run (default 'mcp')"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const surface = params.surface ?? "mcp";
      const kValues = [...new Set(params.k_values ?? [1, 3, 5, 10])].sort((a, b) => a - b);
      const maxK = kValues[kValues.length - 1];
      const rerank = params.rerank ?? true;

      log(`eval: '${params.collection}' — ${params.test_cases.length} case(s), k=${kValues.join(",")}, surface=${surface}`);

      // Per case, the recall/rr/precision at every cutoff.
      const perCase: Record<number, ReturnType<typeof scoreAtK>>[] = [];
      const latencies: number[] = [];
      const failures: string[] = [];

      for (const tc of params.test_cases) {
        let hits: boolean[] = []; // empty on failure → scores zero at every cutoff
        try {
          const out = await runQuery(config, params.collection, tc.query, maxK, rerank);
          latencies.push(out.latencyMs);
          const matchers = buildMatchers(tc.relevant);
          hits = out.results.map((r) => isRelevant(r, matchers));
        } catch (err: any) {
          failures.push(`"${tc.query}": ${err?.message || err}`);
        }
        const scores: Record<number, ReturnType<typeof scoreAtK>> = {};
        for (const k of kValues) scores[k] = scoreAtK(hits, k);
        perCase.push(scores);
      }

      const rows = kValues
        .map((k) => {
          const recall = pct(mean(perCase.map((c) => c[k].recall)));
          const mrr = mean(perCase.map((c) => c[k].rr)).toFixed(3);
          const precision = pct(mean(perCase.map((c) => c[k].precision)));
          return `  k=${String(k).padEnd(3)} recall@k ${recall.padStart(6)}   MRR@k ${mrr}   precision@k ${precision.padStart(6)}`;
        })
        .join("\n");

      const sortedLat = [...latencies].sort((a, b) => a - b);
      const latencyLine =
        sortedLat.length > 0
          ? `mean ${Math.round(mean(latencies))}ms · p50 ${median(sortedLat)}ms · min ${sortedLat[0]}ms · max ${sortedLat[sortedLat.length - 1]}ms`
          : "no successful queries";

      const failureBlock = failures.length
        ? `\n\nFailed queries (${failures.length}, scored as misses):\n${failures.map((f) => `  - ${f}`).join("\n")}`
        : "";

      return textResult(
        `Captain eval — '${params.collection}' (surface: ${surface})\n` +
          `Cases: ${params.test_cases.length} · rerank: ${rerank}\n\n` +
          `${rows}\n\n` +
          `Latency: ${latencyLine}${failureBlock}\n\n` +
          `Next step — tune from the CLI:\n` +
          `  The CLI benchmark (runcaptain/captain-mrag-bench) is the tuning path. Run the same test set there ` +
          `to iterate on chunking, reranking, and indexing sources, then re-run this eval to confirm the change. ` +
          `Comparing 'mcp' and 'cli' runs on one collection is how the team tracks quality parity across surfaces.`,
      );
    },
  );
}
