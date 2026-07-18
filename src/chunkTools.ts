import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, textResult, type ToolResult } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);

const enc = encodeURIComponent;
const json = (data: unknown): ToolResult => textResult(JSON.stringify(data, null, 2));

/**
 * v3 chunk-level tools: list/get chunks, chunk-metadata CRUD (which writes
 * through to the vector store so the metadata becomes filterable in search),
 * chunk relations, and the v3 (multimodal + filterable) query endpoint.
 *
 * All of these live on the API's /v3 surface, so every call passes
 * `{ version: "v3" }`.
 */
export function registerChunkTools(server: McpServer): void {
  // ── captain_list_chunks ─────────────────────────────────────
  server.registerTool(
    "captain_list_chunks",
    {
      title: "List chunks of a document",
      description:
        "List the chunks of a single document in a collection, paginated. Returns chunk_id, text, " +
        "location, and metadata per chunk plus total_results and a next_cursor for paging. " +
        "Use captain_get_chunk for one chunk by id.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        document_id: z.string().describe("Document id whose chunks to list"),
        limit: z.number().int().min(1).max(500).optional().describe("Page size (default 100, max 500)"),
        cursor: z.number().int().min(0).optional().describe("Offset cursor from a prior next_cursor (default 0)"),
        include_regions: z.boolean().optional().describe("Include layout/bounding-box regions (default false)"),
        include_metadata: z.boolean().optional().describe("Include chunk metadata (default true)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const qs = new URLSearchParams({ document_id: params.document_id });
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      if (params.cursor !== undefined) qs.set("cursor", String(params.cursor));
      if (params.include_regions !== undefined) qs.set("include_regions", String(params.include_regions));
      if (params.include_metadata !== undefined) qs.set("include_metadata", String(params.include_metadata));
      log(`Listing chunks for doc ${params.document_id} in '${params.collection}'`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/chunks?${qs.toString()}`,
        { version: "v3" },
      );
      return json(data);
    }
  );

  // ── captain_get_chunk ───────────────────────────────────────
  server.registerTool(
    "captain_get_chunk",
    {
      title: "Get a single chunk",
      description: "Fetch one chunk by its chunk_id, including text, location, and metadata.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        chunk_id: z.string().describe("Chunk id (typically '{document_id}:{index}')"),
        document_id: z.string().optional().describe("Owning document id — makes the lookup faster/more reliable"),
        include_regions: z.boolean().optional().describe("Include layout/bounding-box regions (default false)"),
        include_metadata: z.boolean().optional().describe("Include chunk metadata (default true)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const qs = new URLSearchParams();
      if (params.document_id) qs.set("document_id", params.document_id);
      if (params.include_regions !== undefined) qs.set("include_regions", String(params.include_regions));
      if (params.include_metadata !== undefined) qs.set("include_metadata", String(params.include_metadata));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/chunks/${enc(params.chunk_id)}${suffix}`,
        { version: "v3" },
      );
      return json(data);
    }
  );

  // ── captain_get_chunk_metadata ──────────────────────────────
  server.registerTool(
    "captain_get_chunk_metadata",
    {
      title: "Get chunk metadata",
      description: "Get the custom metadata attached to a chunk.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        chunk_id: z.string().describe("Chunk id"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/chunks/${enc(params.chunk_id)}/metadata`,
        { version: "v3" },
      );
      return json(data);
    }
  );

  // ── captain_set_chunk_metadata (PUT — replace) ──────────────
  server.registerTool(
    "captain_set_chunk_metadata",
    {
      title: "Set (replace) chunk metadata",
      description:
        "Replace a chunk's custom metadata with the provided object. The metadata is also written onto " +
        "the chunk's vector-store row so it becomes usable in search filters (see `filterable` in the response). " +
        "Reserved internal keys (e.g. 'vector', 'file_id') are rejected. Use captain_update_chunk_metadata to merge instead of replace.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        chunk_id: z.string().describe("Chunk id"),
        custom_metadata: z.record(z.any()).describe("Full metadata object to store (replaces any existing custom metadata)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Setting metadata on chunk ${params.chunk_id}`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/chunks/${enc(params.chunk_id)}/metadata`,
        { version: "v3", method: "PUT", body: { custom_metadata: params.custom_metadata } },
      );
      return json(data);
    }
  );

  // ── captain_update_chunk_metadata (PATCH — merge) ───────────
  server.registerTool(
    "captain_update_chunk_metadata",
    {
      title: "Update (merge) chunk metadata",
      description:
        "Merge the provided keys into a chunk's custom metadata (existing keys not mentioned are kept). " +
        "Also written through to the vector store so the keys are filterable in search. Reserved internal keys are rejected.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        chunk_id: z.string().describe("Chunk id"),
        custom_metadata: z.record(z.any()).describe("Keys to merge into the chunk's custom metadata"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Patching metadata on chunk ${params.chunk_id}`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/chunks/${enc(params.chunk_id)}/metadata`,
        { version: "v3", method: "PATCH", body: { custom_metadata: params.custom_metadata } },
      );
      return json(data);
    }
  );

  // ── captain_delete_chunk_metadata ───────────────────────────
  server.registerTool(
    "captain_delete_chunk_metadata",
    {
      title: "Delete chunk metadata",
      description:
        "Remove all custom metadata from a chunk (also cleared from the vector-store row so it no longer affects filters).",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        chunk_id: z.string().describe("Chunk id"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Deleting metadata on chunk ${params.chunk_id}`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/chunks/${enc(params.chunk_id)}/metadata`,
        { version: "v3", method: "DELETE" },
      );
      return json(data);
    }
  );

  // ── captain_list_chunk_relations ────────────────────────────
  server.registerTool(
    "captain_list_chunk_relations",
    {
      title: "List a chunk's relations",
      description: "List relations from/to a chunk (graph edges between chunks).",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        chunk_id: z.string().describe("Chunk id"),
        relation_types: z.array(z.string()).optional().describe("Filter to these relation types"),
        relation_direction: z.enum(["outgoing", "incoming", "both"]).optional().describe("Edge direction (default outgoing)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const qs = new URLSearchParams();
      if (params.relation_direction) qs.set("relation_direction", params.relation_direction);
      for (const t of params.relation_types || []) qs.append("relation_types", t);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/chunks/${enc(params.chunk_id)}/relations${suffix}`,
        { version: "v3" },
      );
      return json(data);
    }
  );

  // ── captain_create_chunk_relation ───────────────────────────
  server.registerTool(
    "captain_create_chunk_relation",
    {
      title: "Create a chunk relation",
      description: "Create a directed relation (edge) from a source chunk to a target chunk.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        chunk_id: z.string().describe("Source chunk id"),
        target_chunk_id: z.string().describe("Target chunk id"),
        relation_type: z.string().describe("Relation type label, e.g. 'references', 'follows'"),
        target_document_id: z.string().optional().describe("Target document id (helps resolve the target chunk)"),
        metadata: z.record(z.any()).optional().describe("Optional metadata on the relation"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        target_chunk_id: params.target_chunk_id,
        relation_type: params.relation_type,
      };
      if (params.target_document_id) body.target_document_id = params.target_document_id;
      if (params.metadata) body.metadata = params.metadata;
      log(`Creating relation ${params.chunk_id} -> ${params.target_chunk_id} (${params.relation_type})`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/chunks/${enc(params.chunk_id)}/relations`,
        { version: "v3", method: "POST", body },
      );
      return json(data);
    }
  );

  // ── captain_delete_chunk_relation ───────────────────────────
  server.registerTool(
    "captain_delete_chunk_relation",
    {
      title: "Delete a chunk relation",
      description: "Delete a chunk relation by its relation_id.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        relation_id: z.string().describe("Relation id to delete"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Deleting relation ${params.relation_id}`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/relations/${enc(params.relation_id)}`,
        { version: "v3", method: "DELETE" },
      );
      return json(data);
    }
  );

  // ── captain_search_v3 ───────────────────────────────────────
  server.registerTool(
    "captain_search_v3",
    {
      title: "Search a collection (v3, multimodal + filterable)",
      description:
        "Semantic search over a collection using the v3 query contract. Supports metadata filters " +
        "(Pinecone-style, e.g. {\"userId\": {\"$eq\": \"u-1\"}}) that match custom metadata set via the chunk-metadata tools, " +
        "optional reranking, and control over what's included in each result. Prefer this over captain_search for " +
        "filtered or multimodal collections.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        query: z.string().describe("Natural-language search query"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 10)"),
        filter: z.record(z.any()).optional().describe("Metadata filter, e.g. {\"category\": {\"$eq\": \"claims\"}}"),
        rerank: z.boolean().optional().describe("Enable reranking (default false)"),
        include_metadata: z.boolean().optional().describe("Include metadata in results (default true)"),
        include_regions: z.boolean().optional().describe("Include layout regions (default false)"),
        include_relations: z.boolean().optional().describe("Include chunk relations (default false)"),
        include_related_chunks: z.boolean().optional().describe("Include related chunks (default false)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const include: Record<string, boolean> = {};
      if (params.include_metadata !== undefined) include.metadata = params.include_metadata;
      if (params.include_regions !== undefined) include.regions = params.include_regions;
      if (params.include_relations !== undefined) include.relations = params.include_relations;
      if (params.include_related_chunks !== undefined) include.related_chunks = params.include_related_chunks;
      const body: Record<string, unknown> = {
        query: params.query,
        limit: params.limit ?? 10,
        rerank: params.rerank ?? false,
      };
      if (params.filter) body.filter = params.filter;
      if (Object.keys(include).length) body.include = include;
      log(`v3 search '${params.query}' in '${params.collection}'`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/query`,
        { version: "v3", method: "POST", body },
      );
      return json(data);
    }
  );
}
