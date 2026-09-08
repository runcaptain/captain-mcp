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
}
