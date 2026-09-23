import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, captainFetch, textResult, type ToolResult } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);
const enc = encodeURIComponent;
const json = (data: unknown): ToolResult => textResult(JSON.stringify(data, null, 2));

/**
 * Webhook endpoints belong to the organization, not to an environment: one
 * set receives events for jobs in every environment. These tools therefore
 * take no `environment` argument (server.ts skips them when adding it).
 */
export const WEBHOOK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "captain_list_webhook_event_types",
  "captain_create_webhook_endpoint",
  "captain_list_webhook_endpoints",
  "captain_get_webhook_endpoint",
  "captain_update_webhook_endpoint",
  "captain_delete_webhook_endpoint",
  "captain_rotate_webhook_secret",
  "captain_test_webhook_endpoint",
  "captain_list_webhook_deliveries",
  "captain_list_webhook_delivery_attempts",
  "captain_resend_webhook_delivery",
  "captain_recover_webhook_endpoint",
]);

/** The five job events, one per final job status. */
export const WEBHOOK_EVENT_TYPES = [
  "job.completed",
  "job.completed_with_errors",
  "job.failed",
  "job.timed_out",
  "job.cancelled",
] as const;

const WRITE_NOTE =
  " Needs write access on an OAuth connection (captain:write).";

const endpointId = z.string().min(1).describe("Webhook endpoint id (whe_...), from captain_list_webhook_endpoints");

const messageId = z
  .string()
  .min(1)
  .describe(
    "The delivery's message_id from captain_list_webhook_deliveries, or the event id (evt_<job_id>) from the payload",
  );

const filterFields = {
  event_types: z
    .array(z.enum(WEBHOOK_EVENT_TYPES))
    .optional()
    .describe("Events to receive. Empty or omitted means all five."),
  collection_ids: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Only jobs in these collections (up to 10). Empty means every collection."),
  sync_ids: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Only jobs started by these syncs (up to 10). Empty means any sync or none."),
  sources: z
    .array(z.enum(["api", "sync"]))
    .optional()
    .describe("Only jobs from these sources: api (you called an index endpoint) or sync (a storage sync started it)."),
  include_collection_name: z
    .boolean()
    .optional()
    .describe(
      "Send collection_name in payloads (default true). When any endpoint that receives an event turns this off, " +
        "that event carries collection_name: null.",
    ),
  disabled: z.boolean().optional().describe("true pauses sending to this endpoint; false resumes it."),
  description: z.string().max(200).optional().describe("Free-text label, up to 200 characters."),
};

const FILTER_RULE =
  "Filters combine with AND across kinds (collection_ids, sync_ids, sources) and OR within a kind. " +
  "The number of combinations (collection_ids x sync_ids x sources, counting only non-empty lists) must be at most 10. " +
  "sync_ids only match sync jobs, so sources must include sync or be empty when sync_ids is set.";

function pickDefined(params: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of keys) if (params[k] !== undefined) body[k] = params[k];
  return body;
}

const ENDPOINT_KEYS = [
  "url",
  "description",
  "event_types",
  "collection_ids",
  "sync_ids",
  "sources",
  "include_collection_name",
  "disabled",
] as const;

/**
 * Job webhooks (/v2/webhooks): Captain sends a signed HTTPS request to your
 * endpoint when an indexing job reaches its final status. These tools manage
 * the endpoints and read their delivery history. There is deliberately no
 * tool that reads a signing secret back: the secret is shown once, on create
 * and on rotate.
 */
export function registerWebhookTools(server: McpServer): void {
  // ── captain_list_webhook_event_types ────────────────────────
  server.registerTool(
    "captain_list_webhook_event_types",
    {
      title: "List webhook event types",
      description:
        "List the five job webhook events (job.completed, job.completed_with_errors, job.failed, job.timed_out, " +
        "job.cancelled) with a description, schema version and the JSON Schema of each payload, including an example. " +
        "Each indexing job sends exactly one of them when it reaches its final status. Read-only.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const data = await captainFetch(getConfig(), "webhooks/event-types");
      return json(data);
    },
  );

  // ── captain_create_webhook_endpoint ─────────────────────────
  server.registerTool(
    "captain_create_webhook_endpoint",
    {
      title: "Create a webhook endpoint",
      description:
        "Register an HTTPS URL that receives a signed request when any indexing job in the organization finishes, " +
        "in every environment (the payload's data.environment says where the job ran). " +
        "The response contains the endpoint's signing secret (whsec_...). It is returned ONLY in this response and " +
        "cannot be read back later by any tool or API call, so show it to the user now and tell them to store it; " +
        "if it is lost, use captain_rotate_webhook_secret. An organization can have up to 20 endpoints. " +
        FILTER_RULE +
        " Follow with captain_test_webhook_endpoint to check the receiver." +
        WRITE_NOTE,
      inputSchema: {
        url: z.string().url().describe("HTTPS URL that receives events (must start with https:// and be publicly reachable)"),
        ...filterFields,
        disabled: z.boolean().optional().describe("Create the endpoint without sending to it yet (default false)."),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Creating webhook endpoint for ${params.url}`);
      const data = await captainFetch(config, "webhooks/endpoints", {
        method: "POST",
        body: pickDefined(params, ENDPOINT_KEYS),
      });
      return textResult(
        "Webhook endpoint created. The signing secret below is shown only once; store it now.\n\n" +
          JSON.stringify(data, null, 2),
      );
    },
  );

  // ── captain_list_webhook_endpoints ──────────────────────────
  server.registerTool(
    "captain_list_webhook_endpoints",
    {
      title: "List webhook endpoints",
      description:
        "List the organization's webhook endpoints with their URL, filters, whether they are disabled (and why), " +
        "and the last delivery's time and status. Secrets are never included. Read-only.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const data = await captainFetch(getConfig(), "webhooks/endpoints");
      return json(data);
    },
  );

  // ── captain_get_webhook_endpoint ────────────────────────────
  server.registerTool(
    "captain_get_webhook_endpoint",
    {
      title: "Get a webhook endpoint",
      description:
        "Read one webhook endpoint: URL, filters, disabled state and reason (delivery_failures means Captain stopped " +
        "sending after sustained failures), and the last delivery. Secrets are never included. Read-only.",
      inputSchema: { endpoint_id: endpointId },
    },
    async (params): Promise<ToolResult> => {
      const data = await captainFetch(getConfig(), `webhooks/endpoints/${enc(params.endpoint_id)}`);
      return json(data);
    },
  );

  // ── captain_update_webhook_endpoint ─────────────────────────
  server.registerTool(
    "captain_update_webhook_endpoint",
    {
      title: "Update a webhook endpoint",
      description:
        "Change a webhook endpoint's URL, filters, description, include_collection_name, or pause/resume it with " +
        "`disabled`. Only the fields you pass change; pass an empty list to clear a filter. Setting disabled: false " +
        "re-enables an endpoint that Captain disabled after sustained failures (then use " +
        "captain_recover_webhook_endpoint to re-send what it missed). " +
        FILTER_RULE +
        WRITE_NOTE,
      inputSchema: {
        endpoint_id: endpointId,
        url: z.string().url().optional().describe("New HTTPS URL"),
        ...filterFields,
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const body = pickDefined(params, ENDPOINT_KEYS);
      if (Object.keys(body).length === 0) throw new Error("Pass at least one field to change.");
      log(`Updating webhook endpoint '${params.endpoint_id}'`);
      const data = await captainFetch(config, `webhooks/endpoints/${enc(params.endpoint_id)}`, {
        method: "PATCH",
        body,
      });
      return json(data);
    },
  );

  // ── captain_delete_webhook_endpoint ─────────────────────────
  server.registerTool(
    "captain_delete_webhook_endpoint",
    {
      title: "Delete a webhook endpoint",
      description:
        "Delete a webhook endpoint. Captain stops sending to it immediately and its delivery history is no longer " +
        "readable. Irreversible; to pause instead, use captain_update_webhook_endpoint with disabled: true." +
        WRITE_NOTE,
      inputSchema: { endpoint_id: endpointId },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Deleting webhook endpoint '${params.endpoint_id}'`);
      const data = await captainFetch(config, `webhooks/endpoints/${enc(params.endpoint_id)}`, { method: "DELETE" });
      return json(data);
    },
  );

  // ── captain_rotate_webhook_secret ───────────────────────────
  server.registerTool(
    "captain_rotate_webhook_secret",
    {
      title: "Rotate a webhook signing secret",
      description:
        "Create a new signing secret for a webhook endpoint. The new secret is returned ONLY in this response and " +
        "cannot be read back later, so show it to the user now. For the next 24 hours each request is signed with " +
        "both the old and the new secret, so the receiver can switch over without dropping events." +
        WRITE_NOTE,
      inputSchema: { endpoint_id: endpointId },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Rotating webhook secret for '${params.endpoint_id}'`);
      const data = await captainFetch(config, `webhooks/endpoints/${enc(params.endpoint_id)}/rotate-secret`, {
        method: "POST",
      });
      return textResult(
        "New signing secret created. It is shown only once; store it now. The previous secret stays valid for 24 hours.\n\n" +
          JSON.stringify(data, null, 2),
      );
    },
  );

  // ── captain_test_webhook_endpoint ───────────────────────────
  server.registerTool(
    "captain_test_webhook_endpoint",
    {
      title: "Send a test webhook",
      description:
        "Send one event's example payload to this endpoint only. The payload has data.test: true and synthetic ids, " +
        "and is signed like a real event, so it checks the receiver's signature verification end to end. Check the " +
        "result with captain_list_webhook_deliveries." +
        WRITE_NOTE,
      inputSchema: {
        endpoint_id: endpointId,
        event_type: z
          .enum(WEBHOOK_EVENT_TYPES)
          .optional()
          .describe("Which event's example to send (default job.completed)"),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      const data = await captainFetch(config, `webhooks/endpoints/${enc(params.endpoint_id)}/test`, {
        method: "POST",
        body: params.event_type ? { event_type: params.event_type } : {},
      });
      return json(data);
    },
  );

  // ── captain_list_webhook_deliveries ─────────────────────────
  server.registerTool(
    "captain_list_webhook_deliveries",
    {
      title: "List webhook deliveries",
      description:
        "List the events sent (or being sent) to one webhook endpoint, newest first: message_id, event_id " +
        "(evt_<job_id>), event_type, status (succeeded, failed, pending, sending), whether it was a test, and when " +
        "the next retry is due. Page with next_cursor. Read-only.",
      inputSchema: {
        endpoint_id: endpointId,
        limit: z.number().int().min(1).max(100).optional().describe("Deliveries per page (default 25, max 100)"),
        cursor: z.string().optional().describe("next_cursor from the previous page"),
      },
    },
    async (params): Promise<ToolResult> => {
      const qs = new URLSearchParams();
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      if (params.cursor) qs.set("cursor", params.cursor);
      const data = await captainFetch(
        getConfig(),
        `webhooks/endpoints/${enc(params.endpoint_id)}/deliveries${qs.toString() ? `?${qs}` : ""}`,
      );
      return json(data);
    },
  );

  // ── captain_list_webhook_delivery_attempts ──────────────────
  server.registerTool(
    "captain_list_webhook_delivery_attempts",
    {
      title: "List webhook delivery attempts",
      description:
        "List every attempt to deliver one event to one endpoint: status, the HTTP status code your server returned, " +
        "how long it took, and whether the attempt was scheduled (automatic retry) or manual (resend or recover). " +
        "Use it to see why a delivery failed. Read-only.",
      inputSchema: {
        endpoint_id: endpointId,
        message_id: messageId,
        limit: z.number().int().min(1).max(100).optional().describe("Attempts per page (default 25, max 100)"),
        cursor: z.string().optional().describe("next_cursor from the previous page"),
      },
    },
    async (params): Promise<ToolResult> => {
      const qs = new URLSearchParams();
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      if (params.cursor) qs.set("cursor", params.cursor);
      const data = await captainFetch(
        getConfig(),
        `webhooks/endpoints/${enc(params.endpoint_id)}/deliveries/${enc(params.message_id)}/attempts` +
          (qs.toString() ? `?${qs}` : ""),
      );
      return json(data);
    },
  );

  // ── captain_resend_webhook_delivery ─────────────────────────
  server.registerTool(
    "captain_resend_webhook_delivery",
    {
      title: "Resend a webhook delivery",
      description:
        "Send one event to one endpoint again, with the same webhook-id header and body, so a receiver that dedupes " +
        "on webhook-id treats it as the same event. Use after fixing the receiver." +
        WRITE_NOTE,
      inputSchema: { endpoint_id: endpointId, message_id: messageId },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Resending webhook '${params.message_id}' to '${params.endpoint_id}'`);
      const data = await captainFetch(
        config,
        `webhooks/endpoints/${enc(params.endpoint_id)}/deliveries/${enc(params.message_id)}/resend`,
        { method: "POST" },
      );
      return json(data);
    },
  );

  // ── captain_recover_webhook_endpoint ────────────────────────
  server.registerTool(
    "captain_recover_webhook_endpoint",
    {
      title: "Recover failed webhooks",
      description:
        "Re-send every event that failed to reach this endpoint since a point in time, at most 7 days ago. Use it " +
        "after an outage on the receiving side or after re-enabling an endpoint Captain disabled. Delivery happens in " +
        "the background; follow it with captain_list_webhook_deliveries." +
        WRITE_NOTE,
      inputSchema: {
        endpoint_id: endpointId,
        since: z
          .string()
          .describe("ISO 8601 time, for example 2026-09-22T00:00:00Z. Must be in the past and within the last 7 days."),
      },
    },
    async (params): Promise<ToolResult> => {
      const config = getConfig();
      log(`Recovering webhooks for '${params.endpoint_id}' since ${params.since}`);
      const data = await captainFetch(config, `webhooks/endpoints/${enc(params.endpoint_id)}/recover`, {
        method: "POST",
        body: { since: params.since },
      });
      return json(data);
    },
  );
}
