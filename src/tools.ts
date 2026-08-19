import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, captainUploadFiles, textResult, jobStartedResponse, type ToolResult, type CaptainConfig } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
};

function mimeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] || "application/octet-stream";
}

export function registerCaptainTools(server: McpServer): void {
  // ── captain_search ──────────────────────────────────────────
  server.registerTool(
    "captain_search",
    {
      title: "Search a Captain collection",
      description:
        "Search a Captain collection with natural language. Searches across text documents, images, video, and audio. " +
        "Returns relevant ranked chunks with source citations and relevance scores.",
      inputSchema: {
        collection: z.string().describe("Collection name to search"),
        query: z.string().describe("Natural language search query"),
        top_k: z.number().optional().describe("Number of results to return (default 10)"),
        rerank: z.boolean().optional().describe("Enable cross-modal reranking. Required for multimodal collections."),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Searching '${params.collection}' for: ${params.query}`);
      const body: Record<string, unknown> = {
        query: params.query,
        inference: false,
        top_k: params.top_k ?? 10,
        rerank: params.rerank ?? true,
        rerank_model: "gemini",
      };
      const data = await captainFetch(config, `collections/${encodeURIComponent(params.collection)}/query`, { method: "POST", body });
      const results = data.search_results || data.results || [];
      if (results.length === 0) return textResult("No results found.");
      const formatted = results
        .map((r: any, i: number) => {
          const source = r.filename || r.document_id || "Unknown";
          const score = r.score?.toFixed(3) ?? "N/A";
          const content = r.content || r.text || r.chunk || "";
          const modality = r.modality || "text";
          return `[${i + 1}] (${modality}, score: ${score}) ${source}\n${content}`;
        })
        .join("\n\n---\n\n");
      return textResult(`Found ${results.length} results in '${params.collection}':\n\n${formatted}`);
    }
  );

  // ── captain_list_collections ─────────────────────────────────
  server.registerTool(
    "captain_list_collections",
    {
      title: "List Captain collections",
      description: "List all available Captain collections for the configured organization.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const config = getConfig();
      const data = await captainFetch(config, "collections");
      const collections = data.collections || [];
      if (collections.length === 0) return textResult("No collections found.");
      const lines = collections.map((c: any) => `- ${c.database_name} (${c.file_count ?? 0} files)`);
      return textResult(`${collections.length} collection(s):\n${lines.join("\n")}`);
    }
  );

  // ── captain_create_collection ──────────────────────────────
  server.registerTool(
    "captain_create_collection",
    {
      title: "Create a Captain collection",
      description: "Create a new Captain collection to store and search documents.",
      inputSchema: {
        collection: z.string().describe("Collection name (lowercase, hyphens allowed, e.g. 'my-docs')"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Creating collection '${params.collection}'`);
      await captainFetch(config, `collections/${encodeURIComponent(params.collection)}`, { method: "PUT", body: {} });
      return textResult(`Collection '${params.collection}' created successfully.`);
    }
  );

  // ── captain_delete_collection ────────────────────────────────
  server.registerTool(
    "captain_delete_collection",
    {
      title: "Delete a Captain collection",
      description: "Delete a Captain collection and all its indexed documents. This action is irreversible.",
      inputSchema: {
        collection: z.string().describe("Collection name to delete"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Deleting collection '${params.collection}'`);
      await captainFetch(config, `collections/${encodeURIComponent(params.collection)}`, { method: "DELETE" });
      return textResult(`Collection '${params.collection}' deleted.`);
    }
  );

  // ── captain_change_environment ───────────────────────────────
  server.registerTool(
    "captain_change_environment",
    {
      title: "Move a Captain collection between environments",
      description:
        "Move a collection between environments (development, staging, production) without reindexing. " +
        "IMPORTANT: API keys are environment-scoped (cap_dev_ keys see development, cap_prod_ keys see production, cap_stage_ keys see staging), " +
        "so after a move the collection is only visible to keys for the new environment, including this MCP server's key. " +
        "Attached syncs do NOT follow the collection; recreate or repoint them after a move.",
      inputSchema: {
        collection: z.string().describe("Collection name to move"),
        new_environment: z.enum(["development", "staging", "production"]).describe("Target environment"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Moving collection '${params.collection}' to ${params.new_environment}`);
      const data = await captainFetch(config, `collections/${encodeURIComponent(params.collection)}/environment`, {
        method: "PATCH",
        body: { new_environment: params.new_environment },
      });
      return textResult(
        `${data.message ?? `Collection '${params.collection}' moved to ${params.new_environment}.`}\n` +
          `Files moved: ${data.files_moved ?? "unknown"}\n` +
          `Previous environment: ${data.previous_environment ?? "unknown"}\n\n` +
          `Note: this key only sees '${data.previous_environment ?? "its own"}' environment collections, so the collection ` +
          `may no longer be visible here. Syncs attached to it do not follow automatically; recreate them in the new environment.`
      );
    }
  );

  // ── captain_copy_collection ──────────────────────────────────
  server.registerTool(
    "captain_copy_collection",
    {
      title: "Copy a Captain collection",
      description:
        "Copy a collection, including its documents and vectors, under a new name. " +
        "Vectors are branched rather than re-embedded, so no indexing credits are used. " +
        "The copy lands in the same organization and environment as the source.",
      inputSchema: {
        collection: z.string().describe("Source collection name"),
        target_name: z
          .string()
          .describe(
            "Name for the copy. Unique within the organization and environment; 3-63 chars, alphanumeric start/end, letters, numbers, hyphens, underscores."
          ),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Copying collection '${params.collection}' to '${params.target_name}'`);
      const data = await captainFetch(config, `collections/${encodeURIComponent(params.collection)}/copy`, {
        method: "POST",
        body: { target_name: params.target_name },
      });
      return textResult(
        `${data.message ?? `Copied '${params.collection}' to '${params.target_name}'.`}\n` +
          `Documents copied: ${data.documents_copied ?? "unknown"}\n` +
          `New collection ID: ${data.database_id ?? "unknown"}`
      );
    }
  );

  // ── captain_list_documents ───────────────────────────────────
  server.registerTool(
    "captain_list_documents",
    {
      title: "List documents in a Captain collection",
      description: "List all documents in a Captain collection with file names, types, and chunk counts.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        limit: z.number().optional().describe("Max documents to return (default 100)"),
        offset: z.number().optional().describe("Pagination offset (default 0)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const qs = `?limit=${params.limit ?? 100}&offset=${params.offset ?? 0}`;
      const data = await captainFetch(config, `collections/${encodeURIComponent(params.collection)}/documents${qs}`);
      const docs = data.documents || [];
      if (docs.length === 0) return textResult(`No documents in '${params.collection}'.`);
      const lines = docs.map((d: any) => `- ${d.filename || d.file_name || "Unknown"} (${d.chunk_count ?? 0} chunks, ID: ${d.file_id || d.document_id || "N/A"})`);
      const total = data.total_count ?? docs.length;
      return textResult(`${total} document(s) in '${params.collection}':\n${lines.join("\n")}`);
    }
  );

  // ── captain_delete_document ──────────────────────────────────
  server.registerTool(
    "captain_delete_document",
    {
      title: "Delete a document from a Captain collection",
      description: "Delete a specific document from a Captain collection by its document ID.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        document_id: z.string().describe("Document ID to delete (from captain_list_documents)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Deleting document '${params.document_id}' from '${params.collection}'`);
      await captainFetch(config, `collections/${encodeURIComponent(params.collection)}/documents/${encodeURIComponent(params.document_id)}`, { method: "DELETE" });
      return textResult(`Document '${params.document_id}' deleted from '${params.collection}'.`);
    }
  );

  // ── captain_wipe_documents ───────────────────────────────────
  server.registerTool(
    "captain_wipe_documents",
    {
      title: "Wipe all documents in a Captain collection",
      description: "Delete ALL documents from a Captain collection, keeping the collection itself. Irreversible.",
      inputSchema: {
        collection: z.string().describe("Collection name to wipe"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Wiping all documents from '${params.collection}'`);
      const data = await captainFetch(config, `collections/${encodeURIComponent(params.collection)}/documents`, { method: "DELETE" });
      return textResult(`Wiped ${data.documents_deleted ?? "all"} documents from '${params.collection}'. Collection still exists.`);
    }
  );

  // ── captain_job_status ──────────────────────────────────────
  server.registerTool(
    "captain_job_status",
    {
      title: "Check Captain indexing job status",
      description: "Check the status of a Captain indexing job. Returns progress, stage, file counts, and errors.",
      inputSchema: {
        job_id: z.string().describe("Job ID returned by an indexing tool"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const data = await captainFetch(config, `jobs/${encodeURIComponent(params.job_id)}`);
      const progress = data.progress;
      let text = `Job: ${params.job_id}\nStatus: ${data.status}`;
      if (data.progress_message) text += `\nMessage: ${data.progress_message}`;
      if (progress && typeof progress === "object") {
        if (progress.current_stage) text += `\nStage: ${progress.current_stage}`;
        if (progress.files_total != null) text += `\nFiles: ${progress.files_processed ?? 0}/${progress.files_total} processed`;
        if (progress.files_failed) text += ` (${progress.files_failed} failed)`;
      }
      if (data.error) text += `\nError: ${data.error}`;
      return textResult(text);
    }
  );

  // ── captain_cancel_job ──────────────────────────────────────
  server.registerTool(
    "captain_cancel_job",
    {
      title: "Cancel a Captain indexing job",
      description: "Cancel a running Captain indexing job.",
      inputSchema: {
        job_id: z.string().describe("Job ID to cancel"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Cancelling job '${params.job_id}'`);
      await captainFetch(config, `jobs/${encodeURIComponent(params.job_id)}`, { method: "DELETE" });
      return textResult(`Job '${params.job_id}' cancelled.`);
    }
  );

  // ── captain_index_url ───────────────────────────────────────
  server.registerTool(
    "captain_index_url",
    {
      title: "Index URL(s) into a Captain collection",
      description:
        "Index public URL(s) into a Captain collection. Supports documents (PDF, DOCX, etc.), " +
        "web pages (auto-scraped for text and images), images, video, and audio files.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        urls: z.union([z.string(), z.array(z.string())]).describe("URL or array of URLs to index"),
        processing_type: z.enum(["advanced", "basic"]).optional().describe("'advanced' (OCR + images) or 'basic' (text only)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const urlList = Array.isArray(params.urls) ? params.urls : [params.urls];
      log(`Indexing ${urlList.length} URL(s) into '${params.collection}'`);
      const body: Record<string, unknown> = { processing_type: params.processing_type || "advanced" };
      if (urlList.length === 1) body.url = urlList[0]; else body.urls = urlList;
      const data = await captainFetch(config, `collections/${encodeURIComponent(params.collection)}/index/url`, { method: "POST", body });
      return jobStartedResponse(data.job_id, `${urlList.length} URL(s)`);
    }
  );

  // ── captain_index_youtube ───────────────────────────────────
  server.registerTool(
    "captain_index_youtube",
    {
      title: "Index YouTube video transcripts",
      description: "Index YouTube video transcripts into a Captain collection. Supports single or multiple videos (max 20).",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        urls: z.union([z.string(), z.array(z.string())]).describe("YouTube URL or array of YouTube URLs (max 20)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const urlList = Array.isArray(params.urls) ? params.urls : [params.urls];
      log(`Indexing ${urlList.length} YouTube video(s) into '${params.collection}'`);
      const body: Record<string, unknown> = urlList.length === 1 ? { url: urlList[0] } : { urls: urlList };
      const data = await captainFetch(config, `collections/${encodeURIComponent(params.collection)}/index/youtube`, { method: "POST", body });
      return jobStartedResponse(data.job_id, `${urlList.length} YouTube video(s)`);
    }
  );

  // ── captain_index_text ──────────────────────────────────────
  server.registerTool(
    "captain_index_text",
    {
      title: "Index raw text into a Captain collection",
      description: "Index raw text content directly into a Captain collection. Useful for indexing notes, transcripts, or any unstructured text without a file.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        text: z.string().describe("Text content to index"),
        filename: z.string().optional().describe("Optional filename label for the indexed text"),
        processing_type: z.enum(["advanced", "basic"]).optional().describe("'advanced' or 'basic' (default basic)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Indexing text into '${params.collection}' (${params.text.length} chars)`);
      const body: Record<string, unknown> = { content: params.text, processing_type: params.processing_type || "basic" };
      if (params.filename) body.filename = params.filename;
      const data = await captainFetch(config, `collections/${encodeURIComponent(params.collection)}/index/text`, { method: "POST", body });
      return jobStartedResponse(data.job_id, "text content");
    }
  );

  // ── captain_index_file ──────────────────────────────────────
  server.registerTool(
    "captain_index_file",
    {
      title: "Upload and index file(s) into a Captain collection",
      description:
        "Upload and index files into a Captain collection (multipart to POST /v2/collections/{c}/index/file). " +
        "Supports PDF, DOCX, XLSX, CSV, TXT, MD, JSON, YAML, images, audio, and video. Max 20 files, 100MB each. " +
        "Provide files one of three ways: `urls` (Captain-reachable URLs the server fetches), `files` " +
        "(inline base64 content), or `paths` (local filesystem paths — only when the server is running locally). " +
        "For public web pages prefer captain_index_url; for cloud storage use the provider tools.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        urls: z.array(z.string()).optional().describe("URLs to fetch and upload (works on hosted servers)"),
        files: z.array(z.object({
          name: z.string().describe("Filename incl. extension, e.g. 'report.pdf'"),
          content_base64: z.string().describe("Base64-encoded file bytes"),
        })).optional().describe("Inline files as base64 (works on hosted servers)"),
        paths: z.union([z.string(), z.array(z.string())]).optional().describe("Local filesystem path(s) — only usable when the server runs locally"),
        processing_type: z.enum(["advanced", "basic"]).optional().describe("'advanced' AI-enhanced extraction (default here); 'basic' standard"),
        custom_metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Custom metadata attached to all chunks"),
        skip_existing: z.boolean().optional().describe("Skip files already indexed (default true)"),
        overwrite_existing: z.boolean().optional().describe("Re-index and replace existing files (default false)"),
        transcription_language: z.string().optional().describe("AWS Transcribe language code for audio/video (e.g. 'en-US')"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const allowLocal = process.env.CAPTAIN_MCP_ALLOW_LOCAL_FILES !== "false";

      const form = new FormData();
      let count = 0;
      const label: string[] = [];

      const append = (part: BlobPart, name: string) => {
        const blob = new Blob([part], { type: mimeForPath(name) });
        form.append("files", blob, name);
        count++;
      };

      // Inline base64 files (hosted-friendly)
      for (const f of params.files || []) {
        const buf = Buffer.from(f.content_base64, "base64");
        append(new Blob([buf]), f.name);
        label.push(f.name);
      }
      // URLs the server fetches (hosted-friendly)
      for (const u of params.urls || []) {
        const resp = await fetch(u);
        if (!resp.ok) throw new Error(`Failed to fetch ${u}: ${resp.status}`);
        const name = basename(new URL(u).pathname) || "download";
        append(await resp.arrayBuffer(), name);
        label.push(u);
      }
      // Local paths (stdio/local only)
      const pathList = params.paths
        ? (Array.isArray(params.paths) ? params.paths : [params.paths])
        : [];
      if (pathList.length && !allowLocal) {
        throw new Error(
          "Local file paths are not accessible on the hosted Captain MCP server. " +
          "Pass `urls` or inline base64 `files` instead."
        );
      }
      for (const p of pathList) {
        const buf = await readFile(p);
        append(new Blob([buf]), basename(p));
        label.push(p);
      }

      if (count === 0) {
        throw new Error("Provide at least one of `urls`, `files` (base64), or `paths`.");
      }
      if (count > 20) throw new Error(`Too many files (${count}); max 20 per call.`);

      form.append("processing_type", params.processing_type || "advanced");
      if (params.custom_metadata) form.append("custom_metadata", JSON.stringify(params.custom_metadata));
      if (params.skip_existing !== undefined) form.append("skip_existing", String(params.skip_existing));
      if (params.overwrite_existing !== undefined) form.append("overwrite_existing", String(params.overwrite_existing));
      if (params.transcription_language) form.append("transcription_language", params.transcription_language);

      log(`Uploading ${count} file(s) into '${params.collection}'`);
      const data = await captainUploadFiles(
        config,
        `collections/${encodeURIComponent(params.collection)}/index/file`,
        form,
      );
      const source = count === 1 ? label[0] : `${count} files`;
      return jobStartedResponse(data.job_id, source);
    }
  );

  // ── captain_index_s3 ────────────────────────────────────────
  server.registerTool(
    "captain_index_s3",
    {
      title: "Index from Amazon S3",
      description:
        "Index files from Amazon S3 into a Captain collection. Can index an entire bucket, a directory, or a single file. " +
        "Requires AWS credentials with read access to the bucket.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        bucket_name: z.string().describe("S3 bucket name"),
        aws_access_key_id: z.string().describe("AWS access key ID"),
        aws_secret_access_key: z.string().describe("AWS secret access key"),
        bucket_region: z.string().optional().describe("AWS region (default: us-east-1)"),
        directory_path: z.string().optional().describe("Directory path within the bucket (omit for full bucket)"),
        file_path: z.string().optional().describe("Single file path within the bucket"),
        processing_type: z.enum(["advanced", "basic"]).optional(),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        bucket_name: params.bucket_name,
        aws_access_key_id: params.aws_access_key_id,
        aws_secret_access_key: params.aws_secret_access_key,
        bucket_region: params.bucket_region || "us-east-1",
        processing_type: params.processing_type || "advanced",
      };
      let endpoint: string;
      let source: string;
      if (params.file_path) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/s3/file`;
        body.file_uri = `s3://${params.bucket_name}/${params.file_path}`;
        source = `s3://${params.bucket_name}/${params.file_path}`;
      } else if (params.directory_path) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/s3/directory`;
        body.directory_path = params.directory_path;
        source = `s3://${params.bucket_name}/${params.directory_path}`;
      } else {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/s3`;
        source = `s3://${params.bucket_name}`;
      }
      log(`Indexing ${source} into '${params.collection}'`);
      const data = await captainFetch(config, endpoint, { method: "POST", body });
      return jobStartedResponse(data.job_id, source);
    }
  );

  // ── captain_index_gcs ───────────────────────────────────────
  server.registerTool(
    "captain_index_gcs",
    {
      title: "Index from Google Cloud Storage",
      description:
        "Index files from Google Cloud Storage into a Captain collection. Can index an entire bucket, a directory, or a single file. " +
        "Requires a GCS service account JSON key with read access.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        bucket_name: z.string().describe("GCS bucket name"),
        service_account_json: z.string().describe("GCS service account JSON key (stringified)"),
        directory_path: z.string().optional().describe("Directory path within the bucket"),
        file_path: z.string().optional().describe("Single file path within the bucket"),
        processing_type: z.enum(["advanced", "basic"]).optional(),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        bucket_name: params.bucket_name,
        service_account_json: params.service_account_json,
        processing_type: params.processing_type || "advanced",
      };
      let endpoint: string;
      let source: string;
      if (params.file_path) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/gcs/file`;
        body.file_uri = `gs://${params.bucket_name}/${params.file_path}`;
        source = `gs://${params.bucket_name}/${params.file_path}`;
      } else if (params.directory_path) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/gcs/directory`;
        body.directory_path = params.directory_path;
        source = `gs://${params.bucket_name}/${params.directory_path}`;
      } else {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/gcs`;
        source = `gs://${params.bucket_name}`;
      }
      log(`Indexing ${source} into '${params.collection}'`);
      const data = await captainFetch(config, endpoint, { method: "POST", body });
      return jobStartedResponse(data.job_id, source);
    }
  );

  // ── captain_index_azure ─────────────────────────────────────
  server.registerTool(
    "captain_index_azure",
    {
      title: "Index from Azure Blob Storage",
      description:
        "Index files from Azure Blob Storage into a Captain collection. Can index an entire container, a directory, or a single file. " +
        "Requires Azure storage account name and key.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        container_name: z.string().describe("Azure container name"),
        account_name: z.string().describe("Azure storage account name"),
        account_key: z.string().describe("Azure storage account key"),
        directory_path: z.string().optional().describe("Directory path within the container"),
        file_path: z.string().optional().describe("Single file path within the container"),
        processing_type: z.enum(["advanced", "basic"]).optional(),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        container_name: params.container_name,
        account_name: params.account_name,
        account_key: params.account_key,
        processing_type: params.processing_type || "advanced",
      };
      let endpoint: string;
      let source: string;
      if (params.file_path) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/azure/file`;
        body.file_uri = `azure://${params.container_name}/${params.file_path}`;
        source = `azure://${params.container_name}/${params.file_path}`;
      } else if (params.directory_path) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/azure/directory`;
        body.directory_path = params.directory_path;
        source = `azure://${params.container_name}/${params.directory_path}`;
      } else {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/azure`;
        source = `azure://${params.container_name}`;
      }
      log(`Indexing ${source} into '${params.collection}'`);
      const data = await captainFetch(config, endpoint, { method: "POST", body });
      return jobStartedResponse(data.job_id, source);
    }
  );

  // ── captain_index_r2 ────────────────────────────────────────
  server.registerTool(
    "captain_index_r2",
    {
      title: "Index from Cloudflare R2",
      description:
        "Index files from Cloudflare R2 into a Captain collection. Can index an entire bucket, a directory, or a single file. " +
        "Requires R2 account ID and API token credentials.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        bucket_name: z.string().describe("R2 bucket name"),
        r2_account_id: z.string().describe("Cloudflare account ID"),
        r2_access_key_id: z.string().describe("R2 access key ID"),
        r2_secret_access_key: z.string().describe("R2 secret access key"),
        jurisdiction: z.string().optional().describe("R2 jurisdiction (default, eu, fedramp)"),
        directory_path: z.string().optional().describe("Directory path within the bucket"),
        file_path: z.string().optional().describe("Single file path within the bucket"),
        processing_type: z.enum(["advanced", "basic"]).optional(),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        bucket_name: params.bucket_name,
        r2_account_id: params.r2_account_id,
        r2_access_key_id: params.r2_access_key_id,
        r2_secret_access_key: params.r2_secret_access_key,
        processing_type: params.processing_type || "advanced",
      };
      if (params.jurisdiction && params.jurisdiction !== "default") body.jurisdiction = params.jurisdiction;
      let endpoint: string;
      let source: string;
      if (params.file_path) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/r2/file`;
        body.file_uri = `r2://${params.bucket_name}/${params.file_path}`;
        source = `r2://${params.bucket_name}/${params.file_path}`;
      } else if (params.directory_path) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/r2/directory`;
        body.directory_path = params.directory_path;
        source = `r2://${params.bucket_name}/${params.directory_path}`;
      } else {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/r2`;
        source = `r2://${params.bucket_name}`;
      }
      log(`Indexing ${source} into '${params.collection}'`);
      const data = await captainFetch(config, endpoint, { method: "POST", body });
      return jobStartedResponse(data.job_id, source);
    }
  );

  // ── captain_index_dropbox ───────────────────────────────────
  server.registerTool(
    "captain_index_dropbox",
    {
      title: "Index from Dropbox",
      description:
        "Index files from Dropbox into a Captain collection. Indexes the whole account, a folder (recursive), or a single file. " +
        "Requires a Dropbox access token with read access.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        dropbox_access_token: z.string().describe("Dropbox access token"),
        directory_path: z.string().optional().describe("Dropbox folder to index recursively, e.g. '/Reports/2024' (omit for whole account)"),
        file_path: z.string().optional().describe("Single Dropbox file path, e.g. '/Reports/2024/q1.pdf'"),
        processing_type: z.enum(["advanced", "basic"]).optional(),
        custom_metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        dropbox_access_token: params.dropbox_access_token,
        processing_type: params.processing_type || "advanced",
      };
      if (params.custom_metadata) body.custom_metadata = params.custom_metadata;
      let endpoint: string;
      let source: string;
      if (params.file_path) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/dropbox/file`;
        body.file_path = params.file_path;
        source = `dropbox:${params.file_path}`;
      } else if (params.directory_path) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/dropbox/directory`;
        body.directory_path = params.directory_path;
        source = `dropbox:${params.directory_path}`;
      } else {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/dropbox`;
        source = "dropbox (whole account)";
      }
      log(`Indexing ${source} into '${params.collection}'`);
      const data = await captainFetch(config, endpoint, { method: "POST", body });
      return jobStartedResponse(data.job_id, source);
    }
  );

  // ── captain_index_supabase ──────────────────────────────────
  server.registerTool(
    "captain_index_supabase",
    {
      title: "Index from Supabase Storage",
      description:
        "Index files from Supabase Storage (S3-compatible) into a Captain collection. Indexes a whole bucket, a directory, or a single file. " +
        "Requires the Supabase S3 endpoint URL and access key / secret.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        bucket_name: z.string().describe("Supabase storage bucket name"),
        endpoint_url: z.string().describe("Supabase S3 endpoint URL"),
        access_key_id: z.string().describe("Supabase S3 access key ID"),
        secret_access_key: z.string().describe("Supabase S3 secret access key"),
        region: z.string().optional().describe("Region (default: us-east-1)"),
        directory_path: z.string().optional().describe("Directory/prefix within the bucket"),
        file_path: z.string().optional().describe("Single object key within the bucket"),
        processing_type: z.enum(["advanced", "basic"]).optional(),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      return indexS3Compatible(config, "supabase", params);
    }
  );

  // ── captain_index_backblaze ─────────────────────────────────
  server.registerTool(
    "captain_index_backblaze",
    {
      title: "Index from Backblaze B2",
      description:
        "Index files from Backblaze B2 (S3-compatible) into a Captain collection. Indexes a whole bucket, a directory, or a single file. " +
        "Requires the Backblaze S3 endpoint URL and application key ID / key.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        bucket_name: z.string().describe("Backblaze B2 bucket name"),
        endpoint_url: z.string().describe("Backblaze S3 endpoint URL"),
        access_key_id: z.string().describe("Backblaze application key ID"),
        secret_access_key: z.string().describe("Backblaze application key"),
        region: z.string().optional().describe("Region (default: us-east-1)"),
        directory_path: z.string().optional().describe("Directory/prefix within the bucket"),
        file_path: z.string().optional().describe("Single object key within the bucket"),
        processing_type: z.enum(["advanced", "basic"]).optional(),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      return indexS3Compatible(config, "backblaze", params);
    }
  );

  // ── captain_index_gdrive ────────────────────────────────────
  server.registerTool(
    "captain_index_gdrive",
    {
      title: "Index from Google Drive",
      description:
        "Index files from Google Drive into a Captain collection. Indexes a whole Drive, a folder (recursive), or a single file. " +
        "Requires a Google service-account JSON key with domain-wide delegation and the email of the user to impersonate.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        service_account_json: z.string().describe("Google service account JSON key (stringified)"),
        subject_email: z.string().describe("Email of the Drive user to impersonate (domain-wide delegation)"),
        folder_id: z.string().optional().describe("Drive folder id to index recursively (omit for whole Drive)"),
        file_id: z.string().optional().describe("Single Drive file id"),
        processing_type: z.enum(["advanced", "basic"]).optional(),
        custom_metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        service_account_json: params.service_account_json,
        subject_email: params.subject_email,
        processing_type: params.processing_type || "advanced",
      };
      if (params.custom_metadata) body.custom_metadata = params.custom_metadata;
      let endpoint: string;
      let source: string;
      if (params.file_id) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/gdrive/file`;
        body.file_id = params.file_id;
        source = `gdrive:file/${params.file_id}`;
      } else if (params.folder_id) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/gdrive/directory`;
        body.folder_id = params.folder_id;
        source = `gdrive:folder/${params.folder_id}`;
      } else {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/gdrive`;
        source = `gdrive (${params.subject_email})`;
      }
      log(`Indexing ${source} into '${params.collection}'`);
      const data = await captainFetch(config, endpoint, { method: "POST", body });
      return jobStartedResponse(data.job_id, source);
    }
  );

  // ── captain_index_sharepoint ────────────────────────────────
  server.registerTool(
    "captain_index_sharepoint",
    {
      title: "Index from SharePoint",
      description:
        "Index files from a SharePoint site into a Captain collection. Indexes the site's default drive, a folder (recursive), or a single file. " +
        "Requires Microsoft Graph app credentials (tenant_id, client_id, client_secret) with SharePoint read access.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        tenant_id: z.string().describe("Microsoft Entra tenant id"),
        client_id: z.string().describe("Microsoft Graph app (client) id"),
        client_secret: z.string().describe("Microsoft Graph app client secret"),
        site_url: z.string().describe("SharePoint site URL"),
        drive_id: z.string().optional().describe("Specific document library (drive) id (default: the site's default drive)"),
        folder_id: z.string().optional().describe("Folder id to index recursively"),
        item_id: z.string().optional().describe("Single item (file) id"),
        processing_type: z.enum(["advanced", "basic"]).optional(),
        custom_metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        tenant_id: params.tenant_id,
        client_id: params.client_id,
        client_secret: params.client_secret,
        site_url: params.site_url,
        processing_type: params.processing_type || "advanced",
      };
      if (params.drive_id) body.drive_id = params.drive_id;
      if (params.custom_metadata) body.custom_metadata = params.custom_metadata;
      let endpoint: string;
      let source: string;
      if (params.item_id) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/sharepoint/file`;
        body.item_id = params.item_id;
        source = `sharepoint:file/${params.item_id}`;
      } else if (params.folder_id) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/sharepoint/directory`;
        body.folder_id = params.folder_id;
        source = `sharepoint:folder/${params.folder_id}`;
      } else {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/sharepoint`;
        source = `sharepoint (${params.site_url})`;
      }
      log(`Indexing ${source} into '${params.collection}'`);
      const data = await captainFetch(config, endpoint, { method: "POST", body });
      return jobStartedResponse(data.job_id, source);
    }
  );

  // ── captain_index_onedrive ──────────────────────────────────
  server.registerTool(
    "captain_index_onedrive",
    {
      title: "Index from OneDrive",
      description:
        "Index files from a user's OneDrive into a Captain collection. Indexes the whole OneDrive, a folder (recursive), or a single file. " +
        "Requires Microsoft Graph app credentials (tenant_id, client_id, client_secret) and the target user's email.",
      inputSchema: {
        collection: z.string().describe("Collection name to index into"),
        tenant_id: z.string().describe("Microsoft Entra tenant id"),
        client_id: z.string().describe("Microsoft Graph app (client) id"),
        client_secret: z.string().describe("Microsoft Graph app client secret"),
        user_email: z.string().describe("Email of the OneDrive owner to index"),
        folder_id: z.string().optional().describe("Folder id to index recursively"),
        item_id: z.string().optional().describe("Single item (file) id"),
        processing_type: z.enum(["advanced", "basic"]).optional(),
        custom_metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        tenant_id: params.tenant_id,
        client_id: params.client_id,
        client_secret: params.client_secret,
        user_email: params.user_email,
        processing_type: params.processing_type || "advanced",
      };
      if (params.custom_metadata) body.custom_metadata = params.custom_metadata;
      let endpoint: string;
      let source: string;
      if (params.item_id) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/onedrive/file`;
        body.item_id = params.item_id;
        source = `onedrive:file/${params.item_id}`;
      } else if (params.folder_id) {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/onedrive/directory`;
        body.folder_id = params.folder_id;
        source = `onedrive:folder/${params.folder_id}`;
      } else {
        endpoint = `collections/${encodeURIComponent(params.collection)}/index/onedrive`;
        source = `onedrive (${params.user_email})`;
      }
      log(`Indexing ${source} into '${params.collection}'`);
      const data = await captainFetch(config, endpoint, { method: "POST", body });
      return jobStartedResponse(data.job_id, source);
    }
  );
}

// Shared handler for the S3-compatible providers (Supabase, Backblaze): identical
// request shape (bucket_name / endpoint_url / access_key_id / secret_access_key /
// region) with a bucket|file|directory endpoint triad.
async function indexS3Compatible(
  config: CaptainConfig,
  provider: "supabase" | "backblaze",
  params: {
    collection: string;
    bucket_name: string;
    endpoint_url: string;
    access_key_id: string;
    secret_access_key: string;
    region?: string;
    directory_path?: string;
    file_path?: string;
    processing_type?: "advanced" | "basic";
  },
): Promise<ToolResult> {
  const body: Record<string, unknown> = {
    bucket_name: params.bucket_name,
    endpoint_url: params.endpoint_url,
    access_key_id: params.access_key_id,
    secret_access_key: params.secret_access_key,
    region: params.region || "us-east-1",
    processing_type: params.processing_type || "advanced",
  };
  const base = `collections/${encodeURIComponent(params.collection)}/index/${provider}`;
  let endpoint: string;
  let source: string;
  if (params.file_path) {
    endpoint = `${base}/file`;
    body.file_uri = params.file_path;
    source = `${provider}://${params.bucket_name}/${params.file_path}`;
  } else if (params.directory_path) {
    endpoint = `${base}/directory`;
    body.directory_path = params.directory_path;
    source = `${provider}://${params.bucket_name}/${params.directory_path}`;
  } else {
    endpoint = base;
    source = `${provider}://${params.bucket_name}`;
  }
  log(`Indexing ${source} into '${params.collection}'`);
  const data = await captainFetch(config, endpoint, { method: "POST", body });
  return jobStartedResponse(data.job_id, source);
}
