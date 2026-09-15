import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, textResult, batchResult, type ToolResult } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);
const enc = encodeURIComponent;
const json = (data: unknown): ToolResult => textResult(JSON.stringify(data, null, 2));

/**
 * v3 document-level tools: read one document (all chunks, OCR, layout),
 * read one page, mint viewable URLs for figure regions, and replace / merge a
 * document's custom metadata (the metadata `filter` on query is scoped to).
 * Responses are passed through as JSON, like captain_search_v3.
 */
export function registerDocumentTools(server: McpServer): void {
  // ── captain_get_document ────────────────────────────────────
  server.registerTool(
    "captain_get_document",
    {
      title: "Get a document",
      description:
        "Read one document from a collection: its metadata, custom_metadata, indexing status, and every chunk " +
        "with location (page / timestamp), chunk_type and, optionally, layout regions. Use after " +
        "captain_list_documents or a search result to read a whole file rather than one chunk.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        document_id: z.string().describe("Document id (from captain_list_documents, a search result, or a job's files list)"),
        include_regions: z.boolean().optional().describe("Include layout regions / bounding boxes per chunk (default false)"),
        include_metadata: z.boolean().optional().describe("Include chunk metadata (default true)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const qs = new URLSearchParams();
      if (params.include_regions !== undefined) qs.set("include_regions", String(params.include_regions));
      if (params.include_metadata !== undefined) qs.set("include_metadata", String(params.include_metadata));
      const suffix = qs.toString() ? `?${qs}` : "";
      log(`Reading document ${params.document_id} in '${params.collection}'`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/documents/${enc(params.document_id)}${suffix}`,
        { version: "v3" },
      );
      return json(data);
    },
  );

  // ── captain_get_document_page ───────────────────────────────
  server.registerTool(
    "captain_get_document_page",
    {
      title: "Get one page of a document",
      description:
        "Read a single page of a parsed document in reading order (text plus, optionally, its layout regions). " +
        "The 'read page N of this PDF' primitive; pages are 0-based.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        document_id: z.string().describe("Document id"),
        page_number: z.number().int().min(0).describe("Page number, 0-based"),
        include_regions: z.boolean().optional().describe("Include layout regions for the page (default false)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const qs = params.include_regions !== undefined ? `?include_regions=${params.include_regions}` : "";
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/documents/${enc(params.document_id)}/pages/${params.page_number}${qs}`,
        { version: "v3" },
      );
      return json(data);
    },
  );

  // ── captain_create_asset_urls ───────────────────────────────
  server.registerTool(
    "captain_create_asset_urls",
    {
      title: "Get viewable URLs for figures",
      description:
        "Mint short-lived URLs for figure crops referenced by `regions[].figure_id` (from captain_search_v3 with " +
        "include_regions, captain_get_document, or captain_get_document_page). The figure ids are stable and safe to " +
        "store; the URLs expire (see `expires_at`), so mint them when you need to view the image.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        document_id: z.string().describe("Document the figures belong to"),
        asset_ids: z.array(z.string()).min(1).max(100).describe("Figure ids (`fig_1_...`) to mint URLs for, max 100"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/documents/${enc(params.document_id)}/asset-urls`,
        { version: "v3", method: "POST", body: { asset_ids: params.asset_ids } },
      );
      return json(data);
    },
  );

  // ── captain_set_document_metadata ───────────────────────────
  server.registerTool(
    "captain_set_document_metadata",
    {
      title: "Replace a document's custom metadata",
      description:
        "Replace a document's custom_metadata wholesale (keys not in the new object are removed). Document metadata " +
        "is what the query `filter` matches on. Use captain_update_document_metadata to change a few keys instead.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        document_id: z.string().describe("Document id"),
        custom_metadata: z.record(z.any()).describe("The complete new custom_metadata object"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Replacing metadata on document ${params.document_id}`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/documents/${enc(params.document_id)}/metadata`,
        { version: "v3", method: "PUT", body: { custom_metadata: params.custom_metadata } },
      );
      return json(data);
    },
  );

  // ── captain_update_document_metadata ────────────────────────
  server.registerTool(
    "captain_update_document_metadata",
    {
      title: "Merge into a document's custom metadata",
      description:
        "Merge keys into a document's custom_metadata; existing keys not mentioned are kept. " +
        "Document metadata is what the query `filter` matches on.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        document_id: z.string().describe("Document id"),
        custom_metadata: z.record(z.any()).describe("Keys to set or overwrite"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Merging metadata on document ${params.document_id}`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/documents/${enc(params.document_id)}/metadata`,
        { version: "v3", method: "PATCH", body: { custom_metadata: params.custom_metadata } },
      );
      return json(data);
    },
  );

  // ── captain_batch_document_metadata ─────────────────────────
  // CAP-763 / CAP-764. mode and collection_name are REQUIRED with no defaults;
  // the tool never switches merge<->replace or the collection on its own, and
  // mixed / unknown outcomes are surfaced per item (the caller must see
  // results[]). mode "overwrite" is the PUT endpoint (CAP-741): omitted keys
  // are removed and {} clears the document.
  server.registerTool(
    "captain_batch_document_metadata",
    {
      title: "Update or overwrite document metadata in batches",
      description:
        "Apply custom_metadata to up to 100 documents in one request. mode=\"merge\" merges the supplied keys into " +
        "each document (omitted keys are kept, a null value deletes its key); mode=\"overwrite\" replaces each " +
        "document's whole custom_metadata object (omitted keys are removed, {} clears it; consider copying the " +
        "collection first). The response is HTTP 200 with one " +
        "result per item, in input order, each `succeeded`, `failed`, or `unknown`; a failed item does not roll back " +
        "the others. `unknown` means the write could not be confirmed: read the document back before retrying it. " +
        "item_id only correlates results; it is not an idempotency key.",
      inputSchema: {
        collection_name: z.string().describe("Collection name (required, no default)"),
        mode: z.enum(["merge", "overwrite"]).describe("Write mode (required, no default). \"merge\" keeps omitted keys; \"overwrite\" removes them."),
        items: z
          .array(
            z.object({
              item_id: z.string().min(1).describe("Unique within this request; echoed on the result"),
              document_id: z.string().min(1).describe("Document id as returned by indexing or listing"),
              metadata: z.record(z.any()).describe("Custom metadata for this document"),
            }),
          )
          .min(1)
          .max(100)
          .describe("1 to 100 items"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Batch ${params.mode} of document metadata on ${params.items.length} item(s) in ${params.collection_name}`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection_name)}/documents/metadata/batch`,
        { version: "v3", method: params.mode === "overwrite" ? "PUT" : "PATCH", body: { items: params.items } },
      );
      return batchResult(data);
    },
  );
}
