import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, captainUploadFiles, textResult, type ToolResult } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);
const enc = encodeURIComponent;
const json = (data: unknown): ToolResult => textResult(JSON.stringify(data, null, 2));

/**
 * Job-level tools beyond status/cancel: discover jobs, undo a finished one,
 * read or delete a PII masking report, and validate a parsing script before
 * using it on an index call.
 */
export function registerJobTools(server: McpServer): void {
  // ── captain_list_jobs ───────────────────────────────────────
  server.registerTool(
    "captain_list_jobs",
    {
      title: "List indexing jobs",
      description:
        "List the organization's indexing jobs, newest first, with status, collection, file counts and errors. " +
        "Use it to find jobs started in another session or by a sync backfill, then captain_job_status for detail.",
      inputSchema: {
        status: z
          .enum(["running", "pending", "processing", "completed", "completed_with_errors", "failed", "cancelled", "timed_out"])
          .optional()
          .describe("Only jobs in this status"),
        collection: z.string().optional().describe("Only jobs indexing into this collection"),
        sync_id: z.string().optional().describe("Only jobs launched by this sync (backfills and reconcile re-indexes)"),
        job_environment: z
          .enum(["development", "staging", "production"])
          .optional()
          .describe("Only jobs submitted from this environment"),
        limit: z.number().int().min(1).max(200).optional().describe("Jobs per page (default 50, max 200)"),
        offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const qs = new URLSearchParams();
      for (const k of ["status", "collection", "sync_id", "job_environment", "limit", "offset"] as const) {
        const v = params[k];
        if (v !== undefined) qs.set(k, String(v));
      }
      const data = await captainFetch(config, `jobs${qs.toString() ? `?${qs}` : ""}`);
      const jobs = data.jobs || [];
      if (jobs.length === 0) return textResult("No jobs found.");
      const lines = jobs.map((j: any) => {
        const files = j.files_total != null ? ` ${j.files_indexed ?? 0}/${j.files_total} files${j.files_failed ? ` (${j.files_failed} failed)` : ""}` : "";
        const err = j.error ? ` — ${j.error}` : "";
        return `- ${j.job_id} [${j.status}] ${j.job_type ?? ""} → ${j.collection_name ?? "?"} (${j.environment ?? "?"}) ${j.created_at ?? ""}${files}${err}`;
      });
      const total = data.total_count ?? jobs.length;
      const shown = `${(data.offset ?? 0) + 1}-${(data.offset ?? 0) + jobs.length} of ${total}`;
      return textResult(`Jobs ${shown}:\n${lines.join("\n")}`);
    },
  );

  // ── captain_rollback_job ────────────────────────────────────
  server.registerTool(
    "captain_rollback_job",
    {
      title: "Roll back an indexing job",
      description:
        "Undo a completed or partially completed indexing job by removing the documents it wrote. " +
        "captain_cancel_job only stops in-flight work; this is the undo for work that already landed. Irreversible.",
      inputSchema: {
        job_id: z.string().describe("Job id to roll back"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Rolling back job '${params.job_id}'`);
      const data = await captainFetch(config, `jobs/${enc(params.job_id)}/rollback`, { method: "PATCH" });
      const removed = Array.isArray(data.files_removed) ? data.files_removed.length : undefined;
      return textResult(
        `Job ${params.job_id}: ${data.status ?? "rolled_back"}${data.rolled_back_at ? ` at ${data.rolled_back_at}` : ""}` +
          (removed !== undefined ? `\nFiles removed: ${removed}` : "") +
          (data.message ? `\n${data.message}` : ""),
      );
    },
  );

  // ── captain_get_pii_report ──────────────────────────────────
  server.registerTool(
    "captain_get_pii_report",
    {
      title: "Get a job's PII masking report",
      description:
        "Read the PII detection report of a job that ran with mask_pii: per-file entity counts and short-lived " +
        "URLs (max 5 minutes) to the per-document and per-chunk report objects. Only for jobs whose " +
        "captain_job_status shows a pii_report in state 'retained'.",
      inputSchema: {
        job_id: z.string().describe("Job id (submitted with mask_pii: true)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const data = await captainFetch(config, `jobs/${enc(params.job_id)}/pii`);
      return json(data);
    },
  );

  // ── captain_delete_pii_report ───────────────────────────────
  server.registerTool(
    "captain_delete_pii_report",
    {
      title: "Delete a job's PII masking report",
      description:
        "Delete a retained PII report before its retention window ends (a compliance action). " +
        "The masked documents themselves are unaffected. Irreversible.",
      inputSchema: {
        job_id: z.string().describe("Job id whose report to delete"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Deleting PII report for job '${params.job_id}'`);
      const data = await captainFetch(config, `jobs/${enc(params.job_id)}/pii`, { method: "DELETE" });
      return textResult(
        `PII report for job ${params.job_id} deleted${data.deleted_at ? ` at ${data.deleted_at}` : ""}` +
          (data.objects_deleted != null ? ` (${data.objects_deleted} objects).` : "."),
      );
    },
  );

  // ── captain_validate_parsing_script ─────────────────────────
  server.registerTool(
    "captain_validate_parsing_script",
    {
      title: "Validate a parsing script",
      description:
        "Check a JavaScript parsing script in Captain's sandbox before passing it as `parsing_script` to an index " +
        "tool. Runs against no real data; returns whether it loads and what is wrong if not.",
      inputSchema: {
        script: z.string().min(1).describe("The JavaScript source of the parsing script"),
        filename: z.string().optional().describe("Filename label for the script (default parser.js)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const form = new FormData();
      form.append("file", new Blob([params.script], { type: "text/javascript" }), params.filename || "parser.js");
      const data = await captainUploadFiles(config, "parsing-scripts/validate", form);
      return json(data);
    },
  );
}
