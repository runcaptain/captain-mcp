import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, textResult, type ToolResult } from "./captainClient.js";

const enc = encodeURIComponent;

// GET /v2/queries and GET /v2/queries/{query_id}: the org's stored query
// history, scoped to the environment of the API key in use. The store holds
// completed, non-streamed queries; bodies are archived 90 days after the
// query (`body_status: archived`) while the summary rows are kept.

const INCLUDE = z.enum(["results", "request", "response"]);

function fmtWhen(iso?: string | null): string {
  return iso ? iso.replace("T", " ").replace(/\.\d+Z?$/, "Z") : "-";
}

function summarizeRow(q: any): string {
  const parts = [
    `${fmtWhen(q.created_at)}`,
    q.api_version ? q.api_version : "v?",
    q.collection_name ?? "-",
    q.latency_ms != null ? `${q.latency_ms} ms` : "- ms",
    q.result_count != null ? `${q.result_count} results` : "? results",
    q.status ?? "",
  ];
  return `- ${q.query_id}  ${parts.join("  ")}\n  ${JSON.stringify(q.query_text ?? "")}`;
}

function summarizeResults(results: any[] | null | undefined, maxText = 240): string {
  if (!results || results.length === 0) return "(no results)";
  return results
    .map((r: any) => {
      const loc = r.location || {};
      const where =
        loc.page_start != null
          ? `p.${loc.page_start}${loc.page_end != null && loc.page_end !== loc.page_start ? `-${loc.page_end}` : ""}`
          : loc.start_seconds != null
            ? `${loc.start_seconds}s`
            : loc.sheet_name
              ? `${loc.sheet_name}${loc.row_start != null ? ` row ${loc.row_start}` : ""}`
              : "";
      const score = r.score != null ? Number(r.score).toFixed(3) : "-";
      const rr = r.rerank_score != null ? ` rerank ${Number(r.rerank_score).toFixed(3)}` : "";
      const text = String(r.text ?? "");
      const snippet = text.length > maxText ? `${text.slice(0, maxText)}…` : text;
      return `${r.rank}. ${r.filename ?? "untitled"}${where ? ` (${where})` : ""}  score ${score}${rr}  chunk ${r.chunk_id ?? "-"}\n   ${snippet.replace(/\s+/g, " ")}`;
    })
    .join("\n");
}

export function registerQueryHistoryTools(server: McpServer): void {
  // ── captain_list_queries ────────────────────────────────────
  server.registerTool(
    "captain_list_queries",
    {
      title: "List stored queries (query history)",
      description:
        "List the queries your API keys and agents have run, newest first, scoped to the environment of the API key in use " +
        "(a production key lists production queries). Page with `cursor` until next_cursor is null; there is no total count. " +
        "`from`/`to` bound the window cheaply. Add `include` (results, request, response) to inline each query's retrieved " +
        "chunks and exact request/response bodies per row; with `include`, `limit` is capped at 25. " +
        "Use captain_get_query for one query by its query_id or request_id.",
      inputSchema: {
        collection: z.string().optional().describe("Only queries against this collection"),
        status: z.enum(["completed", "failed"]).optional().describe("Filter by query status"),
        from: z.string().optional().describe("Only queries at or after this ISO-8601 date or timestamp (e.g. 2026-09-01 or 2026-09-01T12:00:00Z)"),
        to: z.string().optional().describe("Only queries before this ISO-8601 date or timestamp"),
        sort: z.enum(["desc", "asc"]).optional().describe("desc (default, newest first) or asc"),
        limit: z.number().int().min(1).max(100).optional().describe("Rows per page, 1-100 (default 25; max 25 when include is set)"),
        cursor: z.string().optional().describe("Opaque continuation from a previous page's next_cursor"),
        include: z
          .array(INCLUDE)
          .optional()
          .describe("Inline bodies per row: results (normalised chunks), request (exact request body), response (exact response body)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const qs = new URLSearchParams();
      if (params.collection) qs.set("collection", params.collection);
      if (params.status) qs.set("status", params.status);
      if (params.from) qs.set("from", params.from);
      if (params.to) qs.set("to", params.to);
      if (params.sort) qs.set("sort", params.sort);
      if (params.limit != null) qs.set("limit", String(params.limit));
      if (params.cursor) qs.set("cursor", params.cursor);
      if (params.include && params.include.length) qs.set("include", params.include.join(","));
      const query = qs.toString();
      const data = await captainFetch(config, `queries${query ? `?${query}` : ""}`);
      const rows: any[] = data.queries || [];
      if (rows.length === 0) {
        return textResult(
          data.next_cursor
            ? `No matching queries on this page; more history remains. Continue with cursor: ${data.next_cursor}`
            : "No stored queries match.",
        );
      }
      const hydrated = !!(params.include && params.include.length);
      const lines = [`${rows.length} quer${rows.length === 1 ? "y" : "ies"}${hydrated ? " (hydrated)" : ""}:`];
      for (const q of rows) {
        lines.push(summarizeRow(q));
        if (hydrated) {
          if (q.body_status && q.body_status !== "available") lines.push(`  body_status: ${q.body_status}`);
          if (params.include!.includes("results")) lines.push(`  results:\n${summarizeResults(q.results).replace(/^/gm, "    ")}`);
          if (params.include!.includes("request")) lines.push(`  request: ${JSON.stringify(q.request)}`);
          if (params.include!.includes("response")) lines.push(`  response: ${JSON.stringify(q.response)}`);
        }
      }
      lines.push(data.next_cursor ? `\nnext_cursor: ${data.next_cursor}` : "\n(end of history)");
      return textResult(lines.join("\n"));
    },
  );

  // ── captain_get_query ───────────────────────────────────────
  server.registerTool(
    "captain_get_query",
    {
      title: "Get one stored query with its request, response and results",
      description:
        "Fetch one stored query: its summary (collection, environment, version, latency, result count), the exact request body, " +
        "the retrieved chunks in one normalised shape (rank, score, text, filename, document id, page/time/sheet location), and " +
        "optionally the exact response body. Accepts the query_id from captain_list_queries or a query response, OR the request_id " +
        "(req_...) every query response returns, so a query can be inspected straight after running it. Unknown ids, other " +
        "organizations' queries and other environments' queries are all a 404.",
      inputSchema: {
        query_id: z.string().describe("query_id (UUID) or request_id (req_<unix>_<hex>) of the query"),
        include_response: z
          .boolean()
          .optional()
          .describe("Also return the exact response body as JSON (can be large). Default false."),
        max_result_text: z
          .number()
          .int()
          .min(0)
          .max(5000)
          .optional()
          .describe("Characters of each result's text to show (default 600; 0 hides text)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const q = await captainFetch(config, `queries/${enc(params.query_id)}`);
      const lines = [
        `Query: ${JSON.stringify(q.query_text ?? "")}`,
        `query_id: ${q.query_id}${q.request_id ? `   request_id: ${q.request_id}` : ""}`,
        `Collection: ${q.collection_name ?? "-"}   Environment: ${q.environment ?? "-"}   API: ${q.api_version ?? "?"}`,
        `Status: ${q.status ?? "-"}   Latency: ${q.latency_ms != null ? `${q.latency_ms} ms` : "-"}   Results: ${q.result_count ?? "?"}   When: ${fmtWhen(q.created_at)}`,
        `Bodies: ${q.body_status ?? "unknown"}`,
      ];
      if (q.error_message) lines.push(`Error: ${q.error_message}`);
      if (q.params) lines.push(`Params: ${JSON.stringify(q.params)}`);
      lines.push("", "Request body:", q.request != null ? JSON.stringify(q.request, null, 2) : "(not stored for this query)");
      lines.push("", "Results:", summarizeResults(q.results, params.max_result_text ?? 600));
      if (params.include_response) {
        lines.push("", "Response body:", q.response != null ? JSON.stringify(q.response, null, 2) : "(not stored)");
      }
      return textResult(lines.join("\n"));
    },
  );

  // ── captain_get_query_latency ───────────────────────────────
  server.registerTool(
    "captain_get_query_latency",
    {
      title: "Query latency percentiles and distribution",
      description:
        "Summarise query latency over a window: exact p50/p95/p99, a histogram with explicit bin edges, and the same " +
        "bins per collection so their shapes can be compared. This is the aggregate counterpart to captain_list_queries, " +
        "which returns individual records a page at a time — use this when the question is 'how fast are queries', not " +
        "'which queries ran'. Scoped to the environment of the API key in use.\n\n" +
        "Two numbers are reported separately on purpose: `measured` queries have a recorded processing time, and " +
        "`missing` ones do not and are left out of the percentiles rather than counted as zero milliseconds. `coverage` " +
        "says how much of the population recorded each filterable setting, because older queries predate some of them " +
        "and answer 'unknown'. Windows are capped at 90 days, and the metric covers completed, non-evaluation queries.",
      inputSchema: {
        from: z.string().describe("Window start, inclusive. ISO-8601 date or timestamp (e.g. 2026-09-01), read as UTC without an offset"),
        to: z.string().describe("Window end, exclusive"),
        collection: z.string().optional().describe("Only queries against this collection"),
        api_version: z.enum(["v3", "v2", "unknown"]).optional().describe("unknown covers queries that recorded no version"),
        rerank: z
          .enum(["on", "off", "unknown"])
          .optional()
          .describe("The recorded rerank REQUEST setting, not whether reranking actually ran; unknown means the query did not record it"),
        search_mode: z
          .enum(["keyword", "semantic", "hybrid", "unknown"])
          .optional()
          .describe("Derived from the recorded semantic ratio; unknown means it was not recorded"),
        has_filter: z
          .enum(["true", "false", "unknown"])
          .optional()
          .describe("Whether the request carried a metadata filter; unknown means it was not recorded"),
        bins: z.number().int().min(4).max(64).optional().describe("Histogram resolution (default 16); edges are returned explicitly"),
        refresh: z.boolean().optional().describe("Recompute instead of serving a briefly cached result"),
        slowest: z.boolean().optional().describe("Also list the slowest queries in the window, with ids and durations"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const qs = new URLSearchParams({ from: params.from, to: params.to });
      if (params.collection) qs.set("collection", params.collection);
      if (params.api_version) qs.set("api_version", params.api_version);
      if (params.rerank) qs.set("rerank", params.rerank);
      if (params.search_mode) qs.set("search_mode", params.search_mode);
      if (params.has_filter) qs.set("has_filter", params.has_filter);
      if (params.bins != null) qs.set("bins", String(params.bins));
      if (params.refresh) qs.set("refresh", "true");

      const data = await captainFetch(config, `queries/latency?${qs.toString()}`);
      const counts = data.counts || {};
      const pct = data.percentiles || {};
      const ms = (value: any) => (value == null ? "-" : `${Number(value).toLocaleString()} ms`);

      const lines = [
        `${data.metric ?? "query_processing_time"} over ${data.window?.from ?? params.from} to ${data.window?.to ?? params.to} (end exclusive)`,
        `Population: ${data.population ?? "completed, non-evaluation queries"}`,
        `Matching ${Number(counts.matching ?? 0).toLocaleString()}  measured ${Number(counts.measured ?? 0).toLocaleString()}  no recorded latency ${Number(counts.missing ?? 0).toLocaleString()}`,
        `p50 ${ms(pct.p50)}   p95 ${ms(pct.p95)}   p99 ${ms(pct.p99)}   (${data.percentile_method ?? "exact"})`,
      ];

      if (data.completeness && data.completeness.complete === false) {
        lines.push(`Still arriving: this window reaches into the ingestion lag (data reaches ${data.completeness.watermark ?? "an earlier point"}).`);
      }

      const edges: number[] = data.histogram?.edges || [];
      const binCounts: number[] = data.histogram?.counts || [];
      if (binCounts.length) {
        lines.push("", "Distribution:");
        binCounts.forEach((count, index) => {
          if (!count) return;
          lines.push(`  ${edges[index]?.toLocaleString() ?? "?"}-${edges[index + 1]?.toLocaleString() ?? "?"} ms: ${count.toLocaleString()}`);
        });
      }

      const series: any[] = data.collections || [];
      if (series.length) {
        lines.push("", "By collection:");
        for (const entry of series) {
          const label = entry.is_other ? `${entry.collection_name} (the remaining collections, grouped)` : entry.collection_name;
          const percentiles = entry.p50 == null ? "percentiles not available for a grouped row" : `p50 ${ms(entry.p50)}  p95 ${ms(entry.p95)}  p99 ${ms(entry.p99)}`;
          lines.push(`  ${label}: ${Number(entry.count ?? 0).toLocaleString()} queries  ${percentiles}`);
        }
      }

      const coverage: Record<string, number> = data.coverage || {};
      const thin = Object.entries(coverage).filter(([, ratio]) => ratio < 0.95);
      if (thin.length) {
        lines.push("", "Partially recorded settings (the rest answer 'unknown'):");
        for (const [name, ratio] of thin) lines.push(`  ${name}: recorded on ${Math.round(ratio * 100)}% of matching queries`);
      }

      if (params.slowest) {
        const slowQs = new URLSearchParams({ from: params.from, to: params.to, limit: "5" });
        if (params.collection) slowQs.set("collection", params.collection);
        const slow = await captainFetch(config, `queries/latency/slowest?${slowQs.toString()}`);
        const rows: any[] = slow.queries || [];
        lines.push("", rows.length ? "Slowest queries (open with captain_get_query):" : "Slowest queries: none measured.");
        for (const row of rows) {
          lines.push(`  ${ms(row.duration_ms)}  ${row.collection_name ?? "-"}  ${row.request_id}`);
        }
      }

      lines.push("", `Computed ${data.generated_at ?? "just now"}.`);
      return textResult(lines.join("\n"));
    },
  );
}
