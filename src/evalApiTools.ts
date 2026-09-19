import { z } from "zod";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, textResult, type ToolResult } from "./captainClient.js";
import { QueryV3ConfigSchema, buildQueryV3Body, type QueryV3Config } from "./chunkTools.js";

/**
 * Evaluation API tools (CAP-745): the server-side counterpart of `captain_eval`.
 *
 * `captain_eval` runs every query from this process and scores locally, which
 * caps it at what fits in one MCP call (the hosted gateway cuts a call at 60 s).
 * The Evaluation API instead runs the set as an asynchronous job inside
 * Captain: up to 10,000 cases under up to eight named configurations, scored
 * server-side, with the job kept as the record (results, questions, configs and
 * every answer). Three calls: upload the cases, run, poll for results.
 *
 * Each call here is a few short HTTP requests, so it fits the gateway budget;
 * the agent polls `captain_get_eval_results` until `status` is terminal.
 */

const enc = encodeURIComponent;
const json = (data: unknown): ToolResult => textResult(JSON.stringify(data, null, 2));

const MAX_CASES = 10_000;
const MAX_CONFIGS = 8;
const MAX_ANSWERS = 20;
const TERMINAL = new Set(["completed", "completed_with_errors", "failed"]);

const CaseSchema = z.object({
  id: z.string().min(1).max(200).optional()
    .describe("Stable case id (defaults to case_{line}). Must be unique within the set."),
  query: z.string().min(1).describe("The question sent as the query."),
  expected_files: z.array(z.string().min(1)).min(1).max(50)
    .describe("1-50 documents that should be retrieved: a filename, or a document id as shown in query results or the documents list. 0 or 2+ matches marks the case GOLD_UNRESOLVED (not run, not billed)."),
  filters: z.record(z.any()).optional()
    .describe("Optional metadata filter for this case, AND-ed with the configuration's filter."),
});

const EvalConfigSchema = QueryV3ConfigSchema.extend({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
    .describe("Configuration name (lowercase, digits, _ and -). Scorecards and per-case results are keyed by it."),
});
type EvalConfig = z.infer<typeof EvalConfigSchema>;

/** The Evaluation API config is the v3 query body minus `query`, plus `name`. */
export function buildEvalConfig(cfg: EvalConfig): Record<string, unknown> {
  const { name, ...rest } = cfg;
  const body = buildQueryV3Body("", rest as QueryV3Config);
  delete body.query;
  // buildQueryV3Body fills `limit` for the query route; the Evaluation API
  // records every field the caller sent as caller-explicit (explicit_fields),
  // so an omitted limit must stay omitted and follow the server default.
  if (rest.limit === undefined) delete body.limit;
  return { name, ...body };
}

export function deriveIdempotencyKey(collection: string, uploadId: string, configs: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify([collection, uploadId, configs])).digest("hex");
  return `mcp-${digest.slice(0, 32)}`;
}

export function toNdjson(cases: z.infer<typeof CaseSchema>[]): string {
  return cases.map((c) => JSON.stringify(c)).join("\n") + "\n";
}

/** Compact per-case results: keep what an agent decides on, drop the echo. */
function compactItem(item: any) {
  const results: Record<string, unknown> = {};
  for (const [name, r] of Object.entries<any>(item.results ?? {})) {
    results[name] = {
      status: r.status,
      hit: r.hit ?? null,
      rank: r.rank ?? null,
      latency_ms: r.latency_ms ?? null,
      query_id: r.query_id ?? null,
      error_code: r.error_code ?? null,
    };
  }
  return {
    id: item.id ?? item.case_key,
    status: item.status,
    error_code: item.error_code ?? null,
    expected_document_ids: item.expected_document_ids ?? null,
    results,
  };
}

function compactAnswer(answer: any) {
  const response = answer?.response ?? {};
  const results = Array.isArray(response.results) ? response.results.slice(0, 10) : [];
  return {
    query_id: answer?.query_id ?? response.query_id ?? null,
    request: answer?.request ?? null,
    results: results.map((r: any) => ({
      document_id: r?.document?.id ?? null,
      filename: r?.document?.filename ?? null,
      chunk_id: r?.chunk_id ?? null,
      score: r?.score ?? null,
      text: typeof r?.text === "string" ? r.text.slice(0, 200) : null,
    })),
    total_results: response.total_results ?? results.length,
  };
}

export function registerEvalApiTools(server: McpServer): void {
  server.registerTool(
    "captain_create_eval_upload",
    {
      title: "Create Evaluation Upload",
      description:
        "Step 1 of a server-side retrieval evaluation. Takes the case set (question + expected documents, " +
        "optionally a per-case filter), serialises it as NDJSON, mints a single-use upload for the collection " +
        "and performs the upload itself. Returns the upload_id to pass to captain_run_eval, which must be used " +
        "within 15 minutes. Up to 10,000 cases. Question generation stays on your side (see captain_eval for " +
        "the sampling and paraphrase method); expected_files may be filenames or document ids. " +
        "Works on API-key and OAuth connections alike; an OAuth connection needs write access (captain:write), " +
        "since an evaluation bills query credits per unit.",
      inputSchema: {
        collection: z.string().describe("Collection the evaluation runs against."),
        cases: z.array(CaseSchema).min(1).max(MAX_CASES).describe(`The case set, max ${MAX_CASES}.`),
        filename: z.string().regex(/\.ndjson$/).optional()
          .describe("Name recorded for the upload (must end in .ndjson). Default: cases.ndjson."),
      },
    },
    async ({ collection, cases, filename }) => {
      const config = getConfig();
      const ids = new Set<string>();
      cases.forEach((c, i) => {
        const key = c.id ?? `case_${i + 1}`;
        if (ids.has(key)) throw new Error(`Duplicate case id '${key}' (the API rejects the whole file).`);
        ids.add(key);
      });
      const body = Buffer.from(toNdjson(cases), "utf8");
      const minted = await captainFetch(config, `collections/${enc(collection)}/evals/uploads`, {
        method: "POST",
        version: "v3",
        body: { filename: filename ?? "cases.ndjson", byte_size: body.byteLength, content_type: "application/x-ndjson" },
      });
      const put = await fetch(minted.upload_url, {
        method: "PUT",
        headers: { "Content-Type": "application/x-ndjson", "Content-Length": String(body.byteLength) },
        body,
      });
      if (!put.ok) {
        const text = await put.text().catch(() => put.statusText);
        throw new Error(`Upload PUT failed (${put.status}): ${text}`);
      }
      return json({
        upload_id: minted.upload_id,
        collection,
        cases: cases.length,
        byte_size: body.byteLength,
        expires_at: minted.expires_at ?? null,
        next: "Call captain_run_eval with this upload_id and 1-8 named configurations.",
      });
    },
  );

  server.registerTool(
    "captain_run_eval",
    {
      title: "Run Evaluation",
      description:
        "Step 2: run an uploaded case set under one to eight named v3 query configurations as an asynchronous " +
        "job. Every case runs under every configuration; scoring is document-level (recall@1/3/10, MRR, " +
        "nDCG@10, latency p50/p95) and the job keeps every answer. Billed per query that ran, per the plan. " +
        "Returns immediately with the eval_id and a preview of the unit count; poll captain_get_eval_results. " +
        "Idempotent: the same idempotency_key with the same body returns the same eval; pass your own key to " +
        "make retries safe, or let the tool generate one.",
      inputSchema: {
        collection: z.string().describe("Collection the upload was minted for."),
        upload_id: z.string().regex(/^evu_/).describe("From captain_create_eval_upload."),
        configs: z.array(EvalConfigSchema).min(1).max(MAX_CONFIGS)
          .describe(`1-${MAX_CONFIGS} named configurations. Each is a v3 query configuration (limit, filter, rerank, boost, semantic_ratio, exclude_chunk_types, max_chunks_per_document, include_*) plus a unique name. {name: "baseline"} = server defaults.`),
        idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()
          .describe("Replay key. When omitted it is derived from the collection, upload_id and configs, so a retry with the same arguments replays the same eval; returned either way."),
      },
    },
    async ({ collection, upload_id, configs, idempotency_key }) => {
      const config = getConfig();
      const names = configs.map((c) => c.name);
      if (new Set(names).size !== names.length) throw new Error("Configuration names must be unique.");
      // Derived from the arguments, never random: a transport retry with the
      // same collection, upload and configs replays the same eval instead of
      // starting (and billing) a second one. The upload is single-use, so the
      // key is naturally unique per case set.
      const key = idempotency_key ?? deriveIdempotencyKey(collection, upload_id, configs.map(buildEvalConfig));
      const created = await captainFetch(config, `collections/${enc(collection)}/evals`, {
        method: "POST",
        version: "v3",
        headers: { "Idempotency-Key": key },
        body: { upload_id, configs: configs.map(buildEvalConfig) },
      });
      return json({
        eval_id: created.eval_id,
        status: created.status,
        idempotency_key: key,
        preview: created.preview ?? null,
        configs: names,
        next: "Poll captain_get_eval_results with eval_id until status is completed, completed_with_errors or failed.",
      });
    },
  );

  server.registerTool(
    "captain_list_evals",
    {
      title: "List Evaluations",
      description:
        "List the evaluations in this environment, newest first, each with its status, progress and " +
        "per-configuration scorecards. Use it to find an eval_id you did not keep, to compare recent runs " +
        "against the same collection, or to check whether anything is still running before queueing more. " +
        "Per-case results and stored answers stay on captain_get_eval_results. Page with cursor until " +
        "next_cursor is null; there is no total count.",
      inputSchema: {
        collection: z.string().optional().describe("Only evaluations against this collection."),
        status: z.enum(["pending", "running", "completed", "completed_with_errors", "failed"]).optional()
          .describe("Filter by status."),
        limit: z.number().int().min(1).max(100).optional().describe("Rows per page (default 25, max 100)."),
        cursor: z.string().optional().describe("Opaque cursor from a previous page's next_cursor."),
      },
    },
    async ({ collection, status, limit, cursor }): Promise<ToolResult> => {
      const config = getConfig();
      const params = new URLSearchParams();
      if (collection) params.set("collection", collection);
      if (status) params.set("status", status);
      if (limit !== undefined) params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      const page = await captainFetch(config, `evals${qs ? `?${qs}` : ""}`, { version: "v3" });
      const rows: any[] = page.evals || [];
      if (rows.length === 0) {
        return textResult(
          collection || status
            ? "No evaluations match that filter."
            : "No evaluations yet. Queue one with captain_create_eval_upload then captain_run_eval.",
        );
      }
      const lines = [`${rows.length} evaluation${rows.length === 1 ? "" : "s"}:`];
      for (const row of rows) {
        const progress = row.progress || {};
        const best = Object.entries(row.scorecards || {})
          .map(([name, card]: [string, any]) => ({ name, recall: card?.recall_at_1 }))
          .filter(entry => typeof entry.recall === "number")
          .sort((a, b) => b.recall - a.recall)[0];
        lines.push(
          `- ${row.eval_id}  ${row.status}  ${row.collection_name}  ` +
          `${Number(row.cases ?? 0).toLocaleString()} cases x ${(row.config_names || []).length} configs` +
          (TERMINAL.has(row.status)
            ? best ? `  best recall@1 ${best.recall.toFixed(3)} (${best.name})` : "  no scores"
            : `  ${progress.percent ?? 0}% complete`) +
          (row.error_code ? `  ${row.error_code}` : ""),
        );
      }
      if (page.next_cursor) lines.push("", `More: pass cursor ${page.next_cursor}`);
      lines.push("", "Read one in full with captain_get_eval_results.");
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "captain_get_eval_results",
    {
      title: "Get Evaluation Results",
      description:
        "Step 3: read an evaluation's status, progress and, once terminal, the scorecards per configuration " +
        "(recall@1/3/10, MRR, nDCG@10, latency p50/p95, scored/failed/error counts), billing, and per-case " +
        "results keyed by configuration (hit, rank, latency, query_id). Page through cases with items_limit " +
        "and items_cursor. With include_answers, also returns the stored request and top results for up to " +
        `${MAX_ANSWERS} scored cases on this page (the job is the record of every answer).`,
      inputSchema: {
        eval_id: z.string().regex(/^eval_/).describe("From captain_run_eval."),
        items_limit: z.number().int().min(1).max(500).optional().describe("Cases per page (default 100, max 500)."),
        items_cursor: z.string().optional().describe("Opaque cursor from a previous page."),
        include_answers: z.boolean().optional()
          .describe(`Fetch the stored request and top results for up to ${MAX_ANSWERS} scored cases on this page.`),
      },
    },
    async ({ eval_id, items_limit, items_cursor, include_answers }) => {
      const config = getConfig();
      const params = new URLSearchParams();
      if (items_limit !== undefined) params.set("items_limit", String(items_limit));
      if (items_cursor) params.set("items_cursor", items_cursor);
      const qs = params.toString();
      const ev = await captainFetch(config, `evals/${enc(eval_id)}${qs ? `?${qs}` : ""}`, { version: "v3" });
      const rawItems = Array.isArray(ev.items) ? ev.items : (ev.items?.items ?? []);
      const items = rawItems.map(compactItem);
      const out: Record<string, unknown> = {
        eval_id: ev.eval_id,
        status: ev.status,
        terminal: TERMINAL.has(ev.status),
        error_code: ev.error_code ?? null,
        error_message: ev.error_message ?? null,
        collection_name: ev.collection_name,
        progress: ev.progress ?? null,
        scorecards: ev.scorecards ?? {},
        billing: ev.billing ?? null,
        configs: (ev.configs ?? []).map((c: any) => c.name),
        items,
        next_cursor: ev.items_page?.next_cursor ?? ev.next_cursor ?? null,
      };
      if (include_answers) {
        const eligible: Array<[string, string]> = [];
        for (const item of items) {
          for (const [name, r] of Object.entries<any>(item.results)) {
            if (r.status === "scored") eligible.push([String(item.id), name]);
          }
        }
        const answers: Record<string, Record<string, unknown>> = {};
        for (const [caseId, name] of eligible.slice(0, MAX_ANSWERS)) {
          const a = await captainFetch(config, `evals/${enc(eval_id)}/answers/${enc(caseId)}/${enc(name)}`, { version: "v3" });
          (answers[caseId] ??= {})[name] = compactAnswer(a);
        }
        out.answers = answers;
        out.answers_fetched = Math.min(eligible.length, MAX_ANSWERS);
        out.answers_truncated = eligible.length > MAX_ANSWERS;
      }
      return json(out);
    },
  );
}
