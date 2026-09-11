import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, textResult, type ToolResult } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);

const enc = encodeURIComponent;
const json = (data: unknown): ToolResult => textResult(JSON.stringify(data, null, 2));

// Shared enums used across the sync tools.
const processingType = z
  .enum(["advanced", "basic"])
  .describe("Parsing tier. 'advanced' = full document understanding; 'basic' = faster/cheaper.");
const deletionPolicy = z
  .enum(["mirror", "archive", "ignore"])
  .describe(
    "How to propagate deletes: 'mirror' removes from the collection, 'archive' retains but marks, 'ignore' leaves untouched. Default 'mirror'.",
  );
const customMetadata = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .describe("Static metadata applied to every synced document.");
const syncInterval = z
  .number()
  .int()
  .describe(
    "Scheduled reconcile cadence in minutes. MINIMUM 5 (values below 5 are raised to 5). null/omitted = manual (events + on-demand only).",
  );

// Common creation-request fields shared by every provider (the S3-compatible
// ones and, minus `auth`, S3 itself).
const commonSyncFields = {
  prefix: z.string().optional().describe("Key prefix to scope the sync (e.g. 'docs/2024/'). Empty syncs the whole bucket."),
  include_patterns: z.array(z.string()).optional().describe("Glob patterns; only matching keys are synced."),
  exclude_patterns: z.array(z.string()).optional().describe("Glob patterns; matching keys are excluded."),
  deletion_policy: deletionPolicy.optional(),
  custom_metadata: customMetadata.optional(),
  sync_interval_minutes: syncInterval.nullable().optional(),
};

// Assemble the shared body fields from validated params, omitting undefined
// values so the API applies its own defaults.
function buildCommonBody(params: {
  processing_type?: "advanced" | "basic";
  prefix?: string;
  include_patterns?: string[];
  exclude_patterns?: string[];
  deletion_policy?: "mirror" | "archive" | "ignore";
  custom_metadata?: Record<string, string | number | boolean>;
  sync_interval_minutes?: number | null;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    processing_type: params.processing_type || "advanced",
  };
  if (params.prefix !== undefined) body.prefix = params.prefix;
  if (params.include_patterns) body.include_patterns = params.include_patterns;
  if (params.exclude_patterns) body.exclude_patterns = params.exclude_patterns;
  if (params.deletion_policy) body.deletion_policy = params.deletion_policy;
  if (params.custom_metadata) body.custom_metadata = params.custom_metadata;
  if (params.sync_interval_minutes !== undefined) body.sync_interval_minutes = params.sync_interval_minutes;
  return body;
}

// Render a created/updated sync object into a readable summary.
function summarizeSync(s: any): string {
  const lines = [
    `Sync ID: ${s.sync_id}`,
    `Collection: ${s.collection_name}`,
    `Source: ${s.storage_type}://${s.bucket}${s.prefix ? "/" + s.prefix : ""}`,
    `Status: ${s.status ?? "unknown"}${s.sync_state ? ` (${s.sync_state})` : ""}`,
    `Auth: ${s.auth_method ?? "unknown"}`,
    `Deletion policy: ${s.deletion_policy ?? "mirror"}`,
  ];
  if (s.sync_interval_minutes != null) lines.push(`Interval: every ${s.sync_interval_minutes} min`);
  else lines.push(`Interval: manual (events + on-demand only)`);
  if (s.last_backfill_job_id) lines.push(`Backfill job: ${s.last_backfill_job_id}`);
  if (s.last_sync_error) lines.push(`Last error: ${s.last_sync_error}`);
  return lines.join("\n");
}

/**
 * Sync tools: create a keep-in-sync connection between a cloud storage source
 * and a Captain collection (one create tool per storage type), plus the
 * management surface (list/get/update/delete/reconcile/subscribe-webhook).
 *
 * A sync backfills the collection once at creation and then keeps it current —
 * on a schedule (sync_interval_minutes), via the event webhook, or on demand
 * (reconcile). Creation endpoints live under the collection
 * (POST /v2/collections/{c}/sync/{provider}); management endpoints are global
 * (/v2/syncs...). All on the v2 API surface.
 */
export function registerSyncTools(server: McpServer): void {
  // ── captain_create_s3_sync ──────────────────────────────────
  server.registerTool(
    "captain_create_s3_sync",
    {
      title: "Create an Amazon S3 sync",
      description:
        "Create a sync that keeps a Captain collection up to date with an Amazon S3 bucket, and start the initial backfill. " +
        "S3 authenticates two ways: cross-account assume-role (recommended — no long-lived keys leave your account, set up per the S3 Cross-Account IAM guide) " +
        "or an access key (used when a role is not an option). " +
        "For S3-compatible stores (R2, Supabase, Backblaze) prefer their dedicated create tools.",
      inputSchema: {
        collection: z.string().describe("Destination collection name"),
        bucket: z.string().describe("S3 bucket to keep in sync"),
        auth_type: z
          .enum(["assume_role", "access_key"])
          .describe("'assume_role' (recommended, cross-account IAM role) or 'access_key' (when a role is not an option)"),
        // assume_role fields
        role_arn: z.string().optional().describe("assume_role: ARN of the IAM role in your account for Captain to assume, e.g. 'arn:aws:iam::123456789012:role/CaptainS3ReadRole'"),
        external_id: z.string().optional().describe("assume_role: the Captain-issued external ID your role's trust policy requires (prevents the confused-deputy problem)"),
        // access_key fields
        access_key_id: z.string().optional().describe("access_key: access key ID"),
        secret_access_key: z.string().optional().describe("access_key: secret access key (stored securely in Secrets Manager, never returned)"),
        endpoint_url: z.string().optional().describe("access_key: S3-compatible endpoint URL. Omit for real AWS S3. (For R2/Supabase/Backblaze prefer their dedicated create tools.)"),
        region: z.string().optional().describe("Bucket region (default: us-east-1)"),
        processing_type: processingType.optional(),
        metadata_mapping: z.record(z.string()).optional().describe("Maps an S3 object metadata key to a Captain metadata field name."),
        ...commonSyncFields,
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      let auth: Record<string, unknown>;
      if (params.auth_type === "assume_role") {
        if (!params.role_arn || !params.external_id) {
          throw new Error("assume_role auth requires `role_arn` and `external_id`.");
        }
        auth = { type: "assume_role", role_arn: params.role_arn, external_id: params.external_id };
      } else {
        if (!params.access_key_id || !params.secret_access_key) {
          throw new Error("access_key auth requires `access_key_id` and `secret_access_key`.");
        }
        auth = {
          type: "access_key",
          access_key_id: params.access_key_id,
          secret_access_key: params.secret_access_key,
        };
        if (params.endpoint_url) auth.endpoint_url = params.endpoint_url;
      }
      const body: Record<string, unknown> = {
        bucket: params.bucket,
        auth,
        storage_type: "s3",
        region: params.region || "us-east-1",
        ...buildCommonBody(params),
      };
      if (params.metadata_mapping) body.metadata_mapping = params.metadata_mapping;
      log(`Creating S3 sync for '${params.bucket}' → '${params.collection}'`);
      const data = await captainFetch(config, `collections/${enc(params.collection)}/sync/s3`, { method: "POST", body });
      return textResult(`S3 sync created and backfill started.\n\n${summarizeSync(data)}`);
    },
  );

  // ── captain_create_r2_sync ──────────────────────────────────
  server.registerTool(
    "captain_create_r2_sync",
    {
      title: "Create a Cloudflare R2 sync",
      description:
        "Create a sync that keeps a Captain collection up to date with a Cloudflare R2 bucket, and start the initial backfill. " +
        "R2 is S3-compatible and authenticates with an access key.",
      inputSchema: {
        collection: z.string().describe("Destination collection name"),
        bucket: z.string().describe("R2 bucket to keep in sync"),
        account_id: z.string().describe("Cloudflare account ID (from the R2 dashboard)"),
        access_key_id: z.string().describe("R2 S3 API token access key ID"),
        secret_access_key: z.string().describe("R2 S3 API token secret access key"),
        jurisdiction: z.enum(["default", "eu", "fedramp", "us"]).optional().describe("R2 jurisdiction (default: 'default')"),
        processing_type: processingType.optional(),
        ...commonSyncFields,
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        bucket: params.bucket,
        account_id: params.account_id,
        access_key_id: params.access_key_id,
        secret_access_key: params.secret_access_key,
        ...buildCommonBody(params),
      };
      if (params.jurisdiction && params.jurisdiction !== "default") body.jurisdiction = params.jurisdiction;
      log(`Creating R2 sync for '${params.bucket}' → '${params.collection}'`);
      const data = await captainFetch(config, `collections/${enc(params.collection)}/sync/r2`, { method: "POST", body });
      return textResult(`R2 sync created and backfill started.\n\n${summarizeSync(data)}`);
    },
  );

  // ── captain_create_supabase_sync ────────────────────────────
  server.registerTool(
    "captain_create_supabase_sync",
    {
      title: "Create a Supabase Storage sync",
      description:
        "Create a sync that keeps a Captain collection up to date with a Supabase Storage bucket, and start the initial backfill. " +
        "Supabase Storage is S3-compatible and authenticates with an access key plus the S3 endpoint URL.",
      inputSchema: {
        collection: z.string().describe("Destination collection name"),
        bucket: z.string().describe("Supabase Storage bucket to keep in sync"),
        endpoint_url: z.string().describe("Supabase S3 endpoint URL"),
        access_key_id: z.string().describe("Supabase S3 access key ID"),
        secret_access_key: z.string().describe("Supabase S3 secret access key"),
        region: z.string().optional().describe("Region for the S3 protocol (default: us-east-1)"),
        processing_type: processingType.optional(),
        ...commonSyncFields,
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        bucket: params.bucket,
        endpoint_url: params.endpoint_url,
        access_key_id: params.access_key_id,
        secret_access_key: params.secret_access_key,
        region: params.region || "us-east-1",
        ...buildCommonBody(params),
      };
      log(`Creating Supabase sync for '${params.bucket}' → '${params.collection}'`);
      const data = await captainFetch(config, `collections/${enc(params.collection)}/sync/supabase`, { method: "POST", body });
      return textResult(`Supabase sync created and backfill started.\n\n${summarizeSync(data)}`);
    },
  );

  // ── captain_create_backblaze_sync ───────────────────────────
  server.registerTool(
    "captain_create_backblaze_sync",
    {
      title: "Create a Backblaze B2 sync",
      description:
        "Create a sync that keeps a Captain collection up to date with a Backblaze B2 bucket, and start the initial backfill. " +
        "Backblaze B2 is S3-compatible and authenticates with an application key plus the S3 endpoint URL.",
      inputSchema: {
        collection: z.string().describe("Destination collection name"),
        bucket: z.string().describe("Backblaze B2 bucket to keep in sync"),
        endpoint_url: z.string().describe("Backblaze S3 endpoint URL"),
        access_key_id: z.string().describe("Backblaze application key ID"),
        secret_access_key: z.string().describe("Backblaze application key"),
        region: z.string().optional().describe("Region for the S3 protocol (default: us-east-1, e.g. 'us-west-004')"),
        processing_type: processingType.optional(),
        ...commonSyncFields,
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        bucket: params.bucket,
        endpoint_url: params.endpoint_url,
        access_key_id: params.access_key_id,
        secret_access_key: params.secret_access_key,
        region: params.region || "us-east-1",
        ...buildCommonBody(params),
      };
      log(`Creating Backblaze sync for '${params.bucket}' → '${params.collection}'`);
      const data = await captainFetch(config, `collections/${enc(params.collection)}/sync/backblaze`, { method: "POST", body });
      return textResult(`Backblaze sync created and backfill started.\n\n${summarizeSync(data)}`);
    },
  );

  // ── captain_create_azure_sync ───────────────────────────────
  server.registerTool(
    "captain_create_azure_sync",
    {
      title: "Create an Azure Blob Storage sync",
      description:
        "Create a sync that keeps a Captain collection up to date with an Azure Blob Storage container, and start the initial backfill. " +
        "Authenticates with the storage account name and an account access key (key1 or key2) with read access to the container; " +
        "the key is stored securely and never returned (rotate it later with captain_update_sync). " +
        "The container is echoed back as `bucket` on the sync record. Azure defaults to a 60-minute reconcile cadence when " +
        "sync_interval_minutes is omitted, so reconciliation backstops any missed Event Grid deliveries.",
      inputSchema: {
        collection: z.string().describe("Destination collection name"),
        container: z
          .string()
          .describe("Azure Blob container to keep in sync (3-63 chars, lowercase letters, digits, single hyphens)"),
        account_name: z
          .string()
          .describe("Storage account name: the <account> in https://<account>.blob.core.windows.net (3-24 lowercase letters and digits)"),
        account_key: z.string().describe("Storage account access key (key1 or key2) with read access to the container"),
        processing_type: processingType.optional(),
        metadata_mapping: z
          .record(z.string())
          .optional()
          .describe("Maps an Azure blob metadata key to a Captain metadata field name."),
        ...commonSyncFields,
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        container: params.container,
        account_name: params.account_name,
        account_key: params.account_key,
        ...buildCommonBody(params),
      };
      if (params.metadata_mapping) body.metadata_mapping = params.metadata_mapping;
      log(`Creating Azure Blob sync for '${params.account_name}/${params.container}' → '${params.collection}'`);
      const data = await captainFetch(config, `collections/${enc(params.collection)}/sync/azure`, { method: "POST", body });
      return textResult(`Azure Blob sync created and backfill started.\n\n${summarizeSync(data)}`);
    },
  );

  // ── captain_create_gcs_sync ─────────────────────────────────
  server.registerTool(
    "captain_create_gcs_sync",
    {
      title: "Create a Google Cloud Storage sync",
      description:
        "Create a sync that keeps a Captain collection up to date with a Google Cloud Storage bucket, and start the initial backfill. " +
        "Authenticates with a service-account JSON key (roles/storage.objectViewer on the bucket); the key is stored securely and never returned.",
      inputSchema: {
        collection: z.string().describe("Destination collection name"),
        bucket: z.string().describe("GCS bucket to keep in sync"),
        service_account_json: z.string().describe("Google service-account key JSON (type 'service_account'), stringified"),
        processing_type: processingType.optional(),
        metadata_mapping: z.record(z.string()).optional().describe("Maps a GCS object metadata key to a Captain metadata field name."),
        ...commonSyncFields,
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {
        bucket: params.bucket,
        service_account_json: params.service_account_json,
        ...buildCommonBody(params),
      };
      if (params.metadata_mapping) body.metadata_mapping = params.metadata_mapping;
      log(`Creating GCS sync for '${params.bucket}' → '${params.collection}'`);
      const data = await captainFetch(config, `collections/${enc(params.collection)}/sync/gcs`, { method: "POST", body });
      return textResult(`GCS sync created and backfill started.\n\n${summarizeSync(data)}`);
    },
  );

  // ── captain_validate_sync ───────────────────────────────────
  server.registerTool(
    "captain_validate_sync",
    {
      title: "Validate sync credentials before creating a sync",
      description:
        "Dry-run a sync: prove the storage credentials and bucket with one cheap read, creating nothing. " +
        "Pass the same fields you would give the matching captain_create_*_sync tool (bucket, credentials, prefix, ...); " +
        "on failure the response names the field to fix. Use it before committing a sync.",
      inputSchema: {
        collection: z.string().describe("Destination collection name"),
        provider: z.enum(["s3", "r2", "supabase", "backblaze", "azure", "gcs"]).describe("Storage provider"),
        config: z.record(z.any()).describe("The provider's create body, exactly as the create tool would send it (e.g. for s3: bucket, auth {type, ...}, region; for azure: container, account_name, account_key)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Validating ${params.provider} sync credentials for '${params.collection}'`);
      const body = { processing_type: "advanced", ...params.config };
      const data = await captainFetch(config, `collections/${enc(params.collection)}/sync/${params.provider}/validate`, { method: "POST", body });
      return textResult(JSON.stringify(data, null, 2));
    },
  );

  // ── captain_list_syncs ──────────────────────────────────────
  server.registerTool(
    "captain_list_syncs",
    {
      title: "List Captain syncs",
      description:
        "List all syncs (cloud-storage → collection connections) for the configured organization, " +
        "with their storage source, status, schedule, and last-sync state.",
      inputSchema: {
        collection_name: z.string().optional().describe("Only syncs feeding this collection"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const qs = params.collection_name ? `?collection_name=${enc(params.collection_name)}` : "";
      const data = await captainFetch(config, `syncs${qs}`);
      const syncs = data.connections || data.syncs || [];
      if (syncs.length === 0) return textResult("No syncs found.");
      const lines = syncs.map((s: any) => {
        const src = `${s.storage_type}://${s.bucket}${s.prefix ? "/" + s.prefix : ""}`;
        const sched = s.sync_interval_minutes != null ? `every ${s.sync_interval_minutes}m` : "manual";
        const state = s.sync_state ? `, ${s.sync_state}` : "";
        return `- ${s.sync_id} — ${src} → ${s.collection_name} [${s.status}${state}, ${sched}]`;
      });
      return textResult(`${syncs.length} sync(s):\n${lines.join("\n")}`);
    },
  );

  // ── captain_get_sync ────────────────────────────────────────
  server.registerTool(
    "captain_get_sync",
    {
      title: "Get a Captain sync",
      description: "Get the full configuration and current state of a single sync by its sync id.",
      inputSchema: {
        sync_id: z.string().describe("The sync id (from captain_list_syncs)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const data = await captainFetch(config, `syncs/${enc(params.sync_id)}`);
      return textResult(`${summarizeSync(data)}\n\n---\nFull object:\n${JSON.stringify(data, null, 2)}`);
    },
  );

  // ── captain_update_sync ─────────────────────────────────────
  server.registerTool(
    "captain_update_sync",
    {
      title: "Update a Captain sync",
      description:
        "Update a sync's configuration: scope (prefix / include / exclude patterns), deletion policy, " +
        "schedule (sync_interval_minutes), custom metadata, or pause/resume it via status. " +
        "Only the fields you pass are changed. The storage source cannot be changed here; the one credential that can is " +
        "an Azure storage account key (`account_key`, for key rotation).",
      inputSchema: {
        sync_id: z.string().describe("The sync id to update"),
        account_key: z.string().optional().describe("Azure syncs only: the new storage account access key (key rotation)"),
        prefix: z.string().optional().describe("New key prefix to scope the sync"),
        include_patterns: z.array(z.string()).optional().describe("Replacement include glob patterns"),
        exclude_patterns: z.array(z.string()).optional().describe("Replacement exclude glob patterns"),
        deletion_policy: deletionPolicy.optional(),
        status: z.enum(["active", "paused"]).optional().describe("Pause or resume syncing"),
        custom_metadata: customMetadata.optional(),
        sync_interval_minutes: syncInterval.nullable().optional().describe("New cadence in minutes (min 5; null = manual)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body: Record<string, unknown> = {};
      if (params.prefix !== undefined) body.prefix = params.prefix;
      if (params.include_patterns) body.include_patterns = params.include_patterns;
      if (params.exclude_patterns) body.exclude_patterns = params.exclude_patterns;
      if (params.deletion_policy) body.deletion_policy = params.deletion_policy;
      if (params.status) body.status = params.status;
      if (params.custom_metadata) body.custom_metadata = params.custom_metadata;
      if (params.sync_interval_minutes !== undefined) body.sync_interval_minutes = params.sync_interval_minutes;
      if (params.account_key !== undefined) body.account_key = params.account_key;
      if (Object.keys(body).length === 0) {
        throw new Error("Provide at least one field to update.");
      }
      log(`Updating sync '${params.sync_id}'`);
      const data = await captainFetch(config, `syncs/${enc(params.sync_id)}`, { method: "PATCH", body });
      return textResult(`Sync updated.\n\n${summarizeSync(data)}`);
    },
  );

  // ── captain_delete_sync ─────────────────────────────────────
  server.registerTool(
    "captain_delete_sync",
    {
      title: "Delete a Captain sync",
      description:
        "Delete a sync (soft-delete): syncing stops and the record is marked inactive; indexed documents and " +
        "history are retained. The storage source is no longer kept in sync.",
      inputSchema: {
        sync_id: z.string().describe("The sync id to delete"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Deleting sync '${params.sync_id}'`);
      const data = await captainFetch(config, `syncs/${enc(params.sync_id)}`, { method: "DELETE" });
      const when = data.deactivated_at ? ` at ${data.deactivated_at}` : "";
      return textResult(`Sync '${params.sync_id}' deactivated${when}. Status: ${data.status ?? "inactive"}. Indexed documents retained.`);
    },
  );

  // ── captain_reconcile_sync ──────────────────────────────────
  server.registerTool(
    "captain_reconcile_sync",
    {
      title: "Reconcile a Captain sync now",
      description:
        "Trigger an on-demand sync: list the bucket, diff it against Captain's indexed state, index added/modified " +
        "objects, and apply the deletion policy to removed ones. Returns counts of what changed.",
      inputSchema: {
        sync_id: z.string().describe("The sync id to reconcile"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Reconciling sync '${params.sync_id}'`);
      const data = await captainFetch(config, `syncs/${enc(params.sync_id)}/reconcile`, { method: "POST" });
      const lines = [
        `Reconcile started for sync '${params.sync_id}'.`,
        data.job_id ? `Job ID: ${data.job_id}` : "No indexing job needed (nothing to add/modify).",
        `Added: ${data.added ?? 0}, Modified: ${data.modified ?? 0}, Removed: ${data.removed ?? 0}, Unchanged: ${data.unchanged ?? 0}`,
      ];
      if (data.deleted_documents != null) lines.push(`Documents deleted: ${data.deleted_documents}`);
      if (data.deletions_withheld) lines.push(`Deletions withheld (another connector still references the file): ${data.deletions_withheld}`);
      return textResult(lines.join("\n"));
    },
  );

  // ── captain_subscribe_sync_webhook ──────────────────────────
  server.registerTool(
    "captain_subscribe_sync_webhook",
    {
      title: "Subscribe an event webhook for a sync",
      description:
        "Enable near-real-time change detection for a sync (faster than scheduled reconcile). For S3 the sync's SQS queue is " +
        "subscribed to your SNS topic (response: queue_arn); for the other providers a signed ingest URL is minted for you to " +
        "point the bucket's event notifications at (response: ingest_url), with setup steps. " +
        "For an S3 access-key sync, `sns_topic_arn` is required: it is the ARN of the SNS topic you created for your " +
        "bucket's ObjectCreated/ObjectRemoved notifications (e.g. 'arn:aws:sns:us-east-1:123456789012:captain-bucket-events'). " +
        "Captain subscribes to that topic to receive the events.",
      inputSchema: {
        sync_id: z.string().describe("The sync id to enable event webhooks for"),
        sns_topic_arn: z
          .string()
          .optional()
          .describe(
            "ARN of the SNS topic wired to your bucket's ObjectCreated/ObjectRemoved notifications, e.g. " +
              "'arn:aws:sns:us-east-1:123456789012:captain-bucket-events'. Required to enroll real-time events for an " +
              "S3 connector; the API returns 422 without it.",
          ),
        rotate_secret: z.boolean().optional()
          .describe("Mint a fresh webhook secret and revoke the current ingest URL (use after a suspected leak). Default false."),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Subscribing event webhook for sync '${params.sync_id}'`);
      const body: Record<string, unknown> = {};
      if (params.sns_topic_arn !== undefined) body.sns_topic_arn = params.sns_topic_arn;
      if (params.rotate_secret !== undefined) body.rotate_secret = params.rotate_secret;
      const data = await captainFetch(config, `syncs/${enc(params.sync_id)}/webhooks`, { method: "POST", body });
      const lines = [`Event webhook enabled for sync '${params.sync_id}'.`];
      if (data.queue_arn) lines.push(`Queue ARN: ${data.queue_arn}`);
      if (data.topic_arn_bound) lines.push(`Subscribed to topic: ${data.topic_arn_bound}`);
      if (data.ingest_url) lines.push(`Ingest URL (point your bucket's event notifications here): ${data.ingest_url}`);
      lines.push(`Secret set: ${data.secret_set ?? true}`);
      if (Array.isArray(data.instructions) && data.instructions.length) {
        lines.push("", "Setup steps:", ...data.instructions.map((s: string, i: number) => `  ${i + 1}. ${s}`));
      }
      return textResult(lines.join("\n"));
    },
  );
}
