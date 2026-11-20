import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, captainUploadFiles, textResult, type ToolResult } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);
const enc = encodeURIComponent;
const json = (data: unknown): ToolResult => textResult(JSON.stringify(data, null, 2));

const FINAL_STATUSES = new Set(["completed", "completed_with_errors", "failed", "cancelled", "timed_out", "rolled_back"]);
const JOBS_STATUS_CONCURRENCY = 5;
const JOB_STATUS_TIMEOUT_MS = 30_000;

/** One compact line per job for captain_jobs_status. */
function jobStatusLine(jobId: string, d: any): string {
  const p = d.progress && typeof d.progress === "object" ? d.progress : {};
  let line = `- ${jobId} [${d.status ?? "?"}]`;
  if (d.collection_name) line += ` → ${d.collection_name}`;
  if (p.files_total != null) {
    line += ` ${p.files_processed ?? 0}/${p.files_total} files`;
    if (p.files_failed) line += ` (${p.files_failed} failed)`;
  }
  if (p.current_stage && !FINAL_STATUSES.has(d.status)) line += `, stage ${p.current_stage}`;
  if (d.error_code || d.error_message) line += ` — ${[d.error_code, d.error_message].filter(Boolean).join(": ")}`;
  return line;
}

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
        "Use it to find jobs started in another session or by a sync backfill, then captain_job_status for detail " +
        "or captain_jobs_status to check many jobs in one call.",
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

  // ── captain_jobs_status ─────────────────────────────────────
  server.registerTool(
    "captain_jobs_status",
    {
      title: "Check many indexing jobs at once",
      description:
        "Check the status of up to 100 indexing jobs in one call: one line per job (status, collection, file counts, " +
        "stage, error) and a count per status. Use it instead of one captain_job_status call per job when you watch " +
        "many jobs. The output lists the jobs that are not final yet, so the next call can check only those. " +
        "A job that cannot be read (not found, or no response in 30 seconds) shows [error] with the reason; the " +
        "other jobs are still returned. For per-file results, credits or the PII report of one job, use captain_job_status.",
      inputSchema: {
        job_ids: z.array(z.string().min(1)).min(1).max(100).describe("Job IDs returned by indexing tools (max 100)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const ids = [...new Set(params.job_ids)];
      const results: Array<{ data?: any; error?: string }> = new Array(ids.length);
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const i = next++;
          try {
            // files_limit=1: the per-file list is not shown here, so keep each response small.
            results[i] = { data: await captainFetch(config, `jobs/${enc(ids[i])}?files_limit=1`, { timeoutMs: JOB_STATUS_TIMEOUT_MS }) };
          } catch (err) {
            results[i] = { error: (err as Error)?.message ?? String(err) };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(JOBS_STATUS_CONCURRENCY, ids.length) }, worker));

      const counts: Record<string, number> = {};
      const notFinal: string[] = [];
      const lines = ids.map((id, i) => {
        const r = results[i];
        const status = r.error !== undefined ? "error" : String(r.data?.status ?? "unknown");
        counts[status] = (counts[status] ?? 0) + 1;
        if (r.error !== undefined) return `- ${id} [error] ${r.error}`;
        if (!FINAL_STATUSES.has(status)) notFinal.push(id);
        return jobStatusLine(id, r.data);
      });
      const tally = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ");
      const out = [`${ids.length} jobs: ${tally}`];
      out.push(notFinal.length ? `Not final yet (${notFinal.length}): ${notFinal.join(", ")}` : "All readable jobs are final.");
      if (counts.error) out.push(`Could not read ${counts.error} job(s); see [error] lines.`);
      out.push("", ...lines);
      return textResult(out.join("\n"));
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
