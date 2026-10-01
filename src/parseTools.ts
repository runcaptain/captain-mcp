import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, captainUploadFiles, textResult, type ToolResult, type CaptainConfig } from "./captainClient.js";
import { indexOptionFields } from "./tools.js";
import { validateInlineFile, INLINE_BASE64_SOFT_LIMIT_BYTES } from "./inlineFileValidation.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);
const json = (data: unknown): ToolResult => textResult(JSON.stringify(data, null, 2));

/**
 * Parse API (/v3/parse/*): run a file through Captain's parsing and chunking
 * and get the chunks back without indexing anything.
 *
 *   captain_parse_upload       POST   /v3/parse/uploads        (multipart, returns captain://upl_...)
 *   captain_parse_document     POST   /v3/parse/documents      (PDF, DOCX, DOC)
 *   captain_parse_spreadsheet  POST   /v3/parse/spreadsheets   (XLSX, XLSM, XLS, CSV, TSV)
 *   captain_get_parse_job      GET    /v3/parse/jobs/{job_id}  (optional wait)
 *   captain_cancel_parse_job   DELETE /v3/parse/jobs/{job_id}
 *
 * A file reaches a parse job one of three ways: `input` (an https link or a
 * captain:// id, passed through), `path` (a local file, uploaded first), or
 * `content_base64` + `name` (inline bytes, validated strictly, uploaded first).
 */

export const PARSE_TOOL_NAMES = [
  "captain_parse_upload",
  "captain_parse_document",
  "captain_parse_spreadsheet",
  "captain_get_parse_job",
  "captain_cancel_parse_job",
] as const;

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAX_WAIT_SECONDS = 50;

const fileSourceFields = {
  input: z.string().optional().describe(
    "The file to parse: an https:// download link (public, or a presigned S3 / GCS / Azure URL) or a captain:// id from captain_parse_upload. Captain downloads it once when the job starts."),
  path: z.string().optional().describe("Local file path, uploaded first (only when the MCP server runs locally)"),
  name: z.string().optional().describe("File name including extension, required with content_base64, e.g. 'report.pdf'"),
  content_base64: z.string().optional().describe("Inline base64 file bytes, uploaded first. Only reliable for small files; prefer `path` or `input`"),
};

const piiFields = {
  mask_pii: z.boolean().optional().describe("Mask detected PII in the parsed content before it is chunked and returned (default false)"),
  pii_engine: indexOptionFields.pii_engine,
  pii_fallback: indexOptionFields.pii_fallback,
  pii_fields: indexOptionFields.pii_fields,
  pii_instructions: indexOptionFields.pii_instructions,
};

const idempotencyField = {
  idempotency_key: z.string().min(1).max(255).optional().describe(
    "Retrying with the same key returns the original job instead of starting a second one"),
};

type FileSource = { input?: string; path?: string; name?: string; content_base64?: string };

/** Multipart upload of one file to /v3/parse/uploads; returns the API body. */
export async function uploadForParse(config: CaptainConfig, bytes: Uint8Array<ArrayBuffer>, name: string): Promise<any> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), name);
  return captainUploadFiles(config, "parse/uploads", form, "v3");
}

async function bytesFromSource(src: FileSource): Promise<{ bytes: Uint8Array<ArrayBuffer>; name: string } | null> {
  if (src.content_base64 !== undefined) {
    if (!src.name) throw new Error("`name` (with extension) is required with content_base64.");
    const buf = validateInlineFile(src.name, src.content_base64);
    if (buf.length > INLINE_BASE64_SOFT_LIMIT_BYTES) {
      log(`inline base64 ${src.name}: ${buf.length} bytes; prefer path or input for files this size`);
    }
    return { bytes: new Uint8Array(buf), name: src.name };
  }
  if (src.path !== undefined) {
    if (process.env.CAPTAIN_MCP_ALLOW_LOCAL_FILES === "false") {
      throw new Error("Local file paths are not accessible on the hosted Captain MCP server. Pass `input` (an https link) or `content_base64` instead.");
    }
    return { bytes: new Uint8Array(await readFile(src.path)), name: basename(src.path) };
  }
  return null;
}

/** Exactly one source; local bytes are uploaded and replaced by their captain:// id. */
export async function resolveInput(config: CaptainConfig, src: FileSource): Promise<string> {
  const given = ["input", "path", "content_base64"].filter((k) => (src as Record<string, unknown>)[k] !== undefined);
  if (given.length !== 1) throw new Error("Provide exactly one of `input`, `path` or `content_base64`.");
  if (src.input !== undefined) return src.input;
  const file = await bytesFromSource(src);
  const up = await uploadForParse(config, file!.bytes, file!.name);
  return up.file_id;
}

function piiBody(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["mask_pii", "pii_engine", "pii_fallback", "pii_fields", "pii_instructions"]) {
    if (params[k] !== undefined) out[k] = params[k];
  }
  return out;
}

async function startParse(kind: "documents" | "spreadsheets", params: Record<string, any>, extra: Record<string, unknown>): Promise<ToolResult> {
  const config = getConfig();
  const input = await resolveInput(config, params);
  const body = { input, ...extra, ...piiBody(params) };
  const headers = params.idempotency_key ? { "Idempotency-Key": params.idempotency_key } : undefined;
  log(`Parse ${kind}: ${input.startsWith("captain://") ? input : "link"}`);
  const data = await captainFetch(config, `parse/${kind}`, { method: "POST", body, version: "v3", headers });
  return json({ ...data, next: `captain_get_parse_job with job_id ${data.job_id} (wait_seconds up to ${MAX_WAIT_SECONDS})` });
}

/** Trim the job body for a model: at most `maxChunks` chunks inline, the rest via result_url. */
export function summarizeJob(job: any, maxChunks: number): any {
  if (!Array.isArray(job?.chunks) || job.chunks.length <= maxChunks) return job;
  return {
    ...job,
    chunks: job.chunks.slice(0, maxChunks),
    chunks_truncated: { shown: maxChunks, total: job.chunks.length, full_result: "result_url" },
  };
}

export function registerParseTools(server: McpServer): void {
  // ── captain_parse_upload ────────────────────────────────────
  server.registerTool(
    "captain_parse_upload",
    {
      title: "Upload a file for parsing",
      description:
        "Upload one local file (up to 100 MB) for the Parse API and get a captain:// id to pass as `input` to " +
        "captain_parse_document or captain_parse_spreadsheet. Kept 24 hours, reusable, not billed. " +
        "The parse tools upload `path` / `content_base64` themselves, so this is only needed to parse one file several times.",
      inputSchema: {
        path: fileSourceFields.path,
        name: fileSourceFields.name,
        content_base64: fileSourceFields.content_base64,
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const file = await bytesFromSource(params);
      if (!file) throw new Error("Provide `path` or `content_base64` (with `name`).");
      return json(await uploadForParse(config, file.bytes, file.name));
    },
  );

  // ── captain_parse_document ──────────────────────────────────
  server.registerTool(
    "captain_parse_document",
    {
      title: "Parse and chunk a document",
      description:
        "Parse a PDF, DOCX or DOC with the same parsing and chunking Captain uses for indexing and get the final " +
        "chunks back, without storing anything in a collection. Starts a job (returns job_id); read the chunks " +
        "with captain_get_parse_job. Billed per page at the indexing rates for processing_type; failed or cancelled jobs are not billed.",
      inputSchema: {
        ...fileSourceFields,
        processing_type: z.enum(["advanced", "basic"]).optional().describe(
          "'advanced' extracts tables, figures and charts and bills advanced pages; 'basic' (default) bills basic pages"),
        include_tags_summary: z.boolean().optional().describe("Add the tags and summary indexing generates to each chunk (default false)"),
        ...piiFields,
        ...idempotencyField,
      },
    },
    async (params): Promise<ToolResult> => {
      const extra: Record<string, unknown> = {};
      if (params.processing_type !== undefined) extra.processing_type = params.processing_type;
      if (params.include_tags_summary !== undefined) extra.include_tags_summary = params.include_tags_summary;
      return startParse("documents", params, extra);
    },
  );

  // ── captain_parse_spreadsheet ───────────────────────────────
  server.registerTool(
    "captain_parse_spreadsheet",
    {
      title: "Parse and chunk a spreadsheet",
      description:
        "Parse an XLSX, XLSM, XLS, CSV or TSV with the same parsing and chunking Captain uses for indexing and get the " +
        "final row-group chunks back (sheet name, row and column range, column headers on every chunk), without " +
        "storing anything. Starts a job; read the chunks with captain_get_parse_job. Spreadsheets bill no pages but are " +
        "charged for sheet text (0.5 credits per 3,000 characters) and each described image when include_images is on; " +
        "failed or cancelled jobs are not billed.",
      inputSchema: {
        ...fileSourceFields,
        include_tags_summary: z.boolean().optional().describe("Add the tags and summary indexing generates to each chunk (default false)"),
        include_images: z.boolean().optional().describe("Describe images and charts as figure chunks (default false). Cannot be combined with mask_pii"),
        include_verified_facts: z.boolean().optional().describe("Exact per-column minimums, maximums and row counts on each row-group chunk (default false)"),
        ...piiFields,
        ...idempotencyField,
      },
    },
    async (params): Promise<ToolResult> => {
      if (params.include_images && params.mask_pii) {
        throw new Error("include_images cannot be combined with mask_pii.");
      }
      const extra: Record<string, unknown> = {};
      for (const k of ["include_tags_summary", "include_images", "include_verified_facts"] as const) {
        if (params[k] !== undefined) extra[k] = params[k];
      }
      return startParse("spreadsheets", params, extra);
    },
  );

  // ── captain_get_parse_job ───────────────────────────────────
  server.registerTool(
    "captain_get_parse_job",
    {
      title: "Get a parse job",
      description:
        "Status of a parse job and, once completed, its chunks in order (inline when the result is 1 MB or smaller) " +
        "plus a fresh result_url for the full JSON. Set wait_seconds to poll until the job finishes.",
      inputSchema: {
        job_id: z.string().describe("Parse job id (prs_...)"),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe(
          `Poll until the job is completed, failed or cancelled, up to this many seconds (default 0, max ${MAX_WAIT_SECONDS})`),
        max_chunks: z.number().int().min(0).max(1000).optional().describe(
          "Return at most this many chunks in the reply (default 50); the rest stay available through result_url"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const path = `parse/jobs/${encodeURIComponent(params.job_id)}`;
      const deadline = Date.now() + (params.wait_seconds ?? 0) * 1000;
      let job = await captainFetch(config, path, { version: "v3" });
      while (!TERMINAL.has(job.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(3000, Math.max(0, deadline - Date.now()))));
        job = await captainFetch(config, path, { version: "v3" });
      }
      return json(summarizeJob(job, params.max_chunks ?? 50));
    },
  );

  // ── captain_cancel_parse_job ────────────────────────────────
  server.registerTool(
    "captain_cancel_parse_job",
    {
      title: "Cancel a parse job",
      description:
        "Stop a running parse job (a cancelled job is not billed), or delete a finished job's result before it expires.",
      inputSchema: {
        job_id: z.string().describe("Parse job id (prs_...)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Cancelling parse job '${params.job_id}'`);
      const job = await captainFetch(config, `parse/jobs/${encodeURIComponent(params.job_id)}`, { method: "DELETE", version: "v3" });
      return json(summarizeJob(job, 0));
    },
  );
}
