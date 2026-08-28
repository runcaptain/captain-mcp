import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, textResult, type ToolResult } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);

const enc = encodeURIComponent;
const json = (data: unknown): ToolResult => textResult(JSON.stringify(data, null, 2));

// ── Shared v3 query schemas ──────────────────────────────────────────────
// These mirror QueryRequestV3 in the OpenAPI spec exactly and are exported so
// captain_eval (evalTools.ts) reuses the SAME config shape as captain_search_v3:
// a candidate "config" in an eval is literally a subset of these params.

/** Layout roles the v3 query can drop from results (QueryRequestV3.exclude_chunk_types). */
export const ExcludeChunkTypeEnum = z.enum([
  "body", "table", "heading", "page_header", "page_footer", "footnote", "figure",
]);

/** Graph edge direction for relation context (QueryRequestV3.relation_direction). */
export const RelationDirectionEnum = z.enum(["outgoing", "incoming", "both"]);

/** Object form of `rerank` (RerankOptions). Boolean `true` == this object with every default. */
export const RerankOptionsSchema = z.object({
  enabled: z.boolean().optional()
    .describe("Whether to rerank. Sending the object without this field means enabled."),
  candidate_limit: z.number().int().min(1).max(200).optional()
    .describe("Fused candidates fetched and reranked before the top `limit` are returned. Default limit x 3; must be >= limit; capped at 200. Larger pools lift recall on near-duplicate-heavy corpora at the cost of latency."),
  model: z.string().optional()
    .describe("Reranker model: 'voyage-rerank-2.5' (default) or 'gemini-2.5-flash'; aliases 'voyage' / 'gemini' accepted."),
});

/**
 * One metadata boost rule (BoostClauseV3). Exactly one of `{field, eq}`,
 * `{field, in}`, or `{chunk_ids}`. A rule both RETRIEVES matching chunks through
 * its own leg and multiplies their fused score by `weight`.
 */
export const BoostClauseSchema = z.object({
  field: z.string().min(1).max(256).optional()
    .describe("One of your own custom_metadata keys (required with eq / in; omit for a chunk_ids rule). Internal fields (file_id, job_id, ...) are rejected."),
  eq: z.union([z.string(), z.number(), z.boolean()]).optional()
    .describe("Requires `field`. Boost chunks whose `field` equals this value."),
  in: z.array(z.union([z.string(), z.number(), z.boolean()])).max(50).optional()
    .describe("Requires `field`. Boost chunks whose `field` matches any of these values (max 50)."),
  chunk_ids: z.array(z.string()).max(100).optional()
    .describe("Use instead of field/eq/in to boost specific chunks (a chunk_id, or document_id:chunk_index; max 100)."),
  weight: z.number().min(0.2).max(5).optional()
    .describe("Score multiplier 0.2-5.0. Start at 1.5-2.0; 3.0-5.0 only when boosted chunks compete with each other; below 1.0 demotes."),
  reserve: z.number().int().min(0).optional()
    .describe("Guarantee this many result slots for the rule regardless of the reranker (sum of reserves must not exceed limit)."),
});

/**
 * Every TUNABLE v3 query parameter (everything except `query` + `collection`),
 * all optional so server defaults apply for anything omitted. captain_search_v3
 * spreads this shape into its input; captain_eval takes an array of these as
 * candidate configurations.
 */
export const QueryV3ConfigSchema = z.object({
  limit: z.number().int().min(1).max(100).optional()
    .describe("Max ranked chunks to return (default 10)."),
  filter: z.record(z.any()).optional()
    .describe("Document-metadata filter. Top-level keys only (never nested under metadata). Bare value = $eq. Operators: $eq $ne $gt $gte $lt $lte $in $nin $and $or. Scope to documents with {\"file_id\": {\"$in\": [...]}}."),
  semantic_ratio: z.number().min(0).max(1).optional()
    .describe("Keyword vs semantic balance. 0.0 = keyword (BM25) only and fastest (skips query embedding); 1.0 = semantic only; 0.5 default weighs both. Lower for exact-term corpora (part numbers, error codes); raise when callers paraphrase."),
  rerank: z.union([z.boolean(), RerankOptionsSchema]).optional()
    .describe("Rerank candidates before returning (adds ~200 ms). `true` = defaults (voyage-rerank-2.5 over limit x 3). Object form tunes model / candidate_limit. Multimodal collections rerank by default; an explicit false opts out and degrades cross-modal ranking. Omit to keep the server default."),
  boost: z.array(BoostClauseSchema).max(10).optional()
    .describe("Up to 10 metadata boost rules. Use when the right chunk does not match the query wording (a reviewer-tagged answer, a chunk already cited earlier). Response echoes matched / in_pool / on_page per rule so you can verify a boost fired. Not applied on image/video/audio collections."),
  exclude_chunk_types: z.array(ExcludeChunkTypeEnum).optional()
    .describe("Layout roles to drop: body, table, heading, page_header, page_footer, footnote, figure. Drop page_header / page_footer / footnote to stop page furniture competing with body text. Applied before reranking."),
  relation_types: z.array(z.string()).optional()
    .describe("Relation-type filter when include_relations / include_related_chunks is on."),
  relation_direction: RelationDirectionEnum.optional()
    .describe("Graph edge direction for relation context: outgoing (default), incoming, or both."),
  include_document: z.boolean().optional().describe("Include the parent document object per chunk (default true)."),
  include_metadata: z.boolean().optional().describe("Include retrieval + application chunk metadata (default true)."),
  include_regions: z.boolean().optional().describe("Include layout regions / bounding boxes (default false)."),
  include_relations: z.boolean().optional().describe("Include graph relations on each chunk (default false)."),
  include_related_chunks: z.boolean().optional().describe("Include the linked chunks for returned relations (default false). The lever for multi-hop: evidence travels with the claim."),
  include_neighboring_chunks: z.boolean().optional().describe("Include the chunk before and after each result in its source file (default false)."),
  include_document_metadata: z.boolean().optional().describe("Include document-level metadata (default false)."),
  include_archived: z.boolean().optional().describe("Surface chunks archived by a sync `archive` deletion policy (default false)."),
});
export type QueryV3Config = z.infer<typeof QueryV3ConfigSchema>;

/**
 * Build the POST /v3/collections/{name}/query body from a query string plus a
 * tunable config. Only keys the caller supplied are sent, so anything omitted
 * falls back to the server default (notably `rerank`, which multimodal
 * collections default to ON — forcing `false` here would silently opt them out).
 */
export function buildQueryV3Body(query: string, cfg: QueryV3Config): Record<string, unknown> {
  const body: Record<string, unknown> = { query, limit: cfg.limit ?? 10 };
  if (cfg.filter !== undefined) body.filter = cfg.filter;
  if (cfg.semantic_ratio !== undefined) body.semantic_ratio = cfg.semantic_ratio;
  if (cfg.rerank !== undefined) body.rerank = cfg.rerank;
  if (cfg.boost !== undefined) body.boost = cfg.boost;
  if (cfg.exclude_chunk_types !== undefined) body.exclude_chunk_types = cfg.exclude_chunk_types;
  if (cfg.relation_types !== undefined) body.relation_types = cfg.relation_types;
  if (cfg.relation_direction !== undefined) body.relation_direction = cfg.relation_direction;
  const include: Record<string, boolean> = {};
  if (cfg.include_document !== undefined) include.document = cfg.include_document;
  if (cfg.include_metadata !== undefined) include.metadata = cfg.include_metadata;
  if (cfg.include_regions !== undefined) include.regions = cfg.include_regions;
  if (cfg.include_relations !== undefined) include.relations = cfg.include_relations;
  if (cfg.include_related_chunks !== undefined) include.related_chunks = cfg.include_related_chunks;
  if (cfg.include_neighboring_chunks !== undefined) include.neighboring_chunks = cfg.include_neighboring_chunks;
  if (cfg.include_document_metadata !== undefined) include.document_metadata = cfg.include_document_metadata;
  if (cfg.include_archived !== undefined) include.archived = cfg.include_archived;
  if (Object.keys(include).length) body.include = include;
  return body;
}

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
      title: "Search a collection (v3: hybrid, filterable, boostable, multimodal)",
      description:
        "Search a collection with the full v3 query contract. Two retrieval legs run at once — keyword (BM25) " +
        "and semantic (dense vector) — blended by `semantic_ratio`; then optional `boost` rules (metadata-driven " +
        "retrieval + score multipliers), `filter` (document metadata, Pinecone-style operators), " +
        "`exclude_chunk_types` (drop page headers/footers/footnotes), and an optional cross-encoder `rerank` " +
        "(boolean, or an object to tune model / candidate_limit). `include_relations` / `include_related_chunks` " +
        "hydrate graph neighbours so an answer split across a claim and its evidence table comes back together. " +
        "Every one of these is a request parameter, not a re-index — tune them against a question set with " +
        "captain_eval. Prefer this over captain_search for filtered, boosted, or multimodal collections.",
      inputSchema: {
        collection: z.string().describe("Collection name"),
        query: z.string().describe("Natural-language search query"),
        ...QueryV3ConfigSchema.shape,
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const { collection, query, ...cfg } = params;
      const body = buildQueryV3Body(query, cfg);
      log(`v3 search '${query}' in '${collection}'`);
      const data = await captainFetch(
        config,
        `collections/${enc(params.collection)}/query`,
        { version: "v3", method: "POST", body },
      );
      return json(data);
    }
  );
}
