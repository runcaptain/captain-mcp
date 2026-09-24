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
export const WEBHOOK_TOOL_NAMES: ReadonlySet<string> = new Set(["captain_webhook_setup", "captain_webhook_events"]);

/** The five job events, one per final job status. */
export const WEBHOOK_EVENT_TYPES = [
  "job.completed",
  "job.completed_with_errors",
  "job.failed",
  "job.timed_out",
  "job.cancelled",
] as const;

export const SETUP_ACTIONS = ["create", "list", "get", "update", "delete", "rotate_secret", "test"] as const;
export const EVENTS_ACTIONS = ["event_types", "deliveries", "attempts", "resend", "recover"] as const;

const WRITE_NOTE = "Needs write access on an OAuth connection (captain:write).";

// ── Field schemas (shared by the advertised shape and the per-action union) ──

const endpointId = z.string().min(1).describe("Webhook endpoint id (whe_...), from action list");
const messageId = z
  .string()
  .min(1)
  .describe(
    "Which delivery: its message_id (msg_...) from action deliveries. The attempts and resend routes also accept the payload's event id (evt_<job_id>) for the same delivery.",
  );
const url = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), { message: "url must start with https://" })
  .describe("HTTPS URL that receives events (https://, publicly reachable)");
const eventType = z.enum(WEBHOOK_EVENT_TYPES).describe("Which event's example to send (default job.completed)");
const limit = z.number().int().min(1).max(100).describe("Items per page (default 25, max 100)");
const cursor = z.string().describe("next_cursor from the previous page");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const since = z
  .string()
  .refine((value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)), {
    message: "since must be an ISO 8601 time, for example 2026-09-22T00:00:00Z",
  })
  .refine(
    (value) => {
      const age = Date.now() - Date.parse(value);
      return age >= 0 && age <= SEVEN_DAYS_MS;
    },
    { message: "since must be in the past and within the last 7 days" },
  )
  .describe("ISO 8601 time, for example 2026-09-22T00:00:00Z. In the past and within the last 7 days.");

const endpointFields = {
  description: z.string().max(200).describe("Free-text label, up to 200 characters."),
  event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)).describe("Events to receive. Empty or omitted means all five."),
  collection_ids: z.array(z.string()).max(10).describe("Only jobs in these collections (up to 10). Empty means all."),
  sync_ids: z.array(z.string()).max(10).describe("Only jobs started by these syncs (up to 10). Empty means any."),
  sources: z
    .array(z.enum(["api", "sync"]))
    .describe("Only jobs from these sources: api (an index call) or sync (a storage sync)."),
  include_collection_name: z.boolean().describe("Send collection_name in payloads (default true)."),
  disabled: z.boolean().describe("true pauses sending to the endpoint; false resumes it."),
};

const ENDPOINT_KEYS = ["url", ...Object.keys(endpointFields)] as const;
const optionalFields = Object.fromEntries(
  Object.entries(endpointFields).map(([k, v]) => [k, v.optional()]),
) as { [K in keyof typeof endpointFields]: z.ZodOptional<(typeof endpointFields)[K]> };

// ── Per-action schemas. Strict, so an argument the action does not use is an error. ──

const setupSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), url, ...optionalFields }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("get"), endpoint_id: endpointId }).strict(),
  z.object({ action: z.literal("update"), endpoint_id: endpointId, url: url.optional(), ...optionalFields }).strict(),
  z.object({ action: z.literal("delete"), endpoint_id: endpointId }).strict(),
  z.object({ action: z.literal("rotate_secret"), endpoint_id: endpointId }).strict(),
  z.object({ action: z.literal("test"), endpoint_id: endpointId, event_type: eventType.optional() }).strict(),
]);

const eventsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("event_types") }).strict(),
  z
    .object({ action: z.literal("deliveries"), endpoint_id: endpointId, limit: limit.optional(), cursor: cursor.optional() })
    .strict(),
  z
    .object({
      action: z.literal("attempts"),
      endpoint_id: endpointId,
      message_id: messageId,
      limit: limit.optional(),
      cursor: cursor.optional(),
    })
    .strict(),
  z.object({ action: z.literal("resend"), endpoint_id: endpointId, message_id: messageId }).strict(),
  z.object({ action: z.literal("recover"), endpoint_id: endpointId, since }).strict(),
]);

type ActionUnion = z.ZodDiscriminatedUnion<"action", z.ZodDiscriminatedUnionOption<"action">[]>;

/** Arguments each action accepts, for error messages. */
function argsByAction(schema: ActionUnion): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const option of schema.options) {
    const shape = option.shape as Record<string, z.ZodTypeAny>;
    const action = (shape.action as z.ZodLiteral<string>).value;
    out.set(action, Object.keys(shape).filter((k) => k !== "action"));
  }
  return out;
}

/**
 * Validate `args` against the action's own schema. Throws one readable error
 * naming the action, what is wrong, and what the action accepts.
 */
function parseAction<T>(tool: string, schema: ActionUnion, args: unknown): T {
  // Drop keys a client sent as undefined/null so "not given" means the same everywhere.
  const cleaned = Object.fromEntries(
    Object.entries((args ?? {}) as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null),
  );
  const result = schema.safeParse(cleaned);
  if (result.success) return result.data as T;
  const accepted = argsByAction(schema);
  const action = String(cleaned.action ?? "");
  if (!accepted.has(action)) {
    throw new Error(`${tool}: action must be one of ${[...accepted.keys()].join(", ")}.`);
  }
  const takes = accepted.get(action)!;
  const problems = result.error.issues.map((issue) => {
    if (issue.code === "unrecognized_keys") return `${issue.keys.join(", ")} not used by this action`;
    const field = issue.path.join(".");
    if (issue.code === "invalid_type" && issue.received === "undefined") return `${field} is required`;
    return `${field}: ${issue.message}`;
  });
  throw new Error(
    `${tool} action "${action}": ${problems.join("; ")}. ` +
      `This action takes: ${takes.length ? takes.join(", ") : "no other arguments"}.`,
  );
}

function pickDefined(params: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of keys) if (params[k] !== undefined) body[k] = params[k];
  return body;
}

function page(params: { limit?: number; cursor?: string }): string {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  return qs.toString() ? `?${qs}` : "";
}

const EVENTS_LIST = WEBHOOK_EVENT_TYPES.join(", ");

/**
 * Job webhooks (/v2/webhooks): Captain sends a signed HTTPS request to an
 * endpoint when an indexing job reaches its final status. Two tools, each
 * selecting its operation with `action`:
 *   captain_webhook_setup   manages endpoints (7 actions)
 *   captain_webhook_events  reads what was sent and re-sends it (5 actions)
 * There is deliberately no action that reads a signing secret back: the
 * secret is shown once, on create and on rotate_secret.
 *
 * The advertised input schema is a flat object, because MCP clients need an
 * object schema to list arguments (the SDK advertises a union as an empty
 * object). The handler then validates against a discriminated union on
 * `action`, so each action checks its own arguments.
 */
export function registerWebhookTools(server: McpServer): void {
  // ── captain_webhook_setup ───────────────────────────────────
  server.registerTool(
    "captain_webhook_setup",
    {
      title: "Set up job webhooks",
      description:
        "Manage the organization's job webhook endpoints. Captain sends a signed HTTPS request to each endpoint when " +
        `an indexing job reaches its final status, with one of five events: ${EVENTS_LIST}. ` +
        "Endpoints cover every environment (the payload's data.environment says where the job ran). " +
        "To stop polling GET /v2/jobs/{id}, create an endpoint with captain_webhook_setup.\n" +
        "Actions:\n" +
        "- create(url, description?, event_types?, collection_ids?, sync_ids?, sources?, include_collection_name?, " +
        "disabled?): register an endpoint (up to 20 per organization). Returns the signing secret (whsec_...) ONLY in " +
        "this response, so show it to the user now. Nothing reads it back later.\n" +
        "- list(): every endpoint with filters, disabled state and last delivery. Secrets never included.\n" +
        "- get(endpoint_id): one endpoint.\n" +
        "- update(endpoint_id, any create field): changes only the fields given. An empty list clears a filter. " +
        "disabled: false re-enables an endpoint Captain disabled after sustained failures.\n" +
        "- delete(endpoint_id): irreversible. To pause instead, update with disabled: true.\n" +
        "- rotate_secret(endpoint_id): a new secret, returned ONLY in this response. The old one keeps signing for 24 hours.\n" +
        "- test(endpoint_id, event_type?): send one event's example payload (data.test: true), signed like a real one.\n" +
        "Filters combine with AND across collection_ids, sync_ids and sources and OR within each, at most 10 " +
        "combinations. sync_ids needs sources empty or including sync.\n" +
        `create, update, delete, rotate_secret and test are writes. ${WRITE_NOTE}`,
      inputSchema: {
        action: z.enum(SETUP_ACTIONS).describe("Which operation to run"),
        endpoint_id: endpointId.optional().describe("Required for get, update, delete, rotate_secret, test"),
        url: url.optional().describe("create (required) and update: HTTPS URL that receives events"),
        ...optionalFields,
        event_type: eventType.optional().describe("test only: which event's example to send (default job.completed)"),
      },
    },
    async (args): Promise<ToolResult> => {
      const p = parseAction<z.infer<typeof setupSchema>>("captain_webhook_setup", setupSchema, args);
      const config = getConfig();
      switch (p.action) {
        case "create": {
          log("Creating webhook endpoint");
          const data = await captainFetch(config, "webhooks/endpoints", {
            method: "POST",
            body: pickDefined(p, ENDPOINT_KEYS),
          });
          return textResult(
            "Webhook endpoint created. The signing secret below is shown only once; store it now.\n\n" +
              JSON.stringify(data, null, 2),
          );
        }
        case "list":
          return json(await captainFetch(config, "webhooks/endpoints"));
        case "get":
          return json(await captainFetch(config, `webhooks/endpoints/${enc(p.endpoint_id)}`));
        case "update": {
          const body = pickDefined(p, ENDPOINT_KEYS);
          if (Object.keys(body).length === 0) {
            throw new Error(
              `captain_webhook_setup action "update": pass at least one field to change (${ENDPOINT_KEYS.join(", ")}).`,
            );
          }
          log(`Updating webhook endpoint '${p.endpoint_id}'`);
          return json(
            await captainFetch(config, `webhooks/endpoints/${enc(p.endpoint_id)}`, { method: "PATCH", body }),
          );
        }
        case "delete":
          log(`Deleting webhook endpoint '${p.endpoint_id}'`);
          return json(await captainFetch(config, `webhooks/endpoints/${enc(p.endpoint_id)}`, { method: "DELETE" }));
        case "rotate_secret": {
          log(`Rotating webhook secret for '${p.endpoint_id}'`);
          const data = await captainFetch(config, `webhooks/endpoints/${enc(p.endpoint_id)}/rotate-secret`, {
            method: "POST",
          });
          return textResult(
            "New signing secret created. It is shown only once; store it now. The previous secret stays valid for 24 hours.\n\n" +
              JSON.stringify(data, null, 2),
          );
        }
        case "test":
          return json(
            await captainFetch(config, `webhooks/endpoints/${enc(p.endpoint_id)}/test`, {
              method: "POST",
              body: p.event_type ? { event_type: p.event_type } : {},
            }),
          );
      }
    },
  );

  // ── captain_webhook_events ──────────────────────────────────
  server.registerTool(
    "captain_webhook_events",
    {
      title: "Job webhook events and deliveries",
      description:
        `What Captain sends to job webhook endpoints and what happened to it. The five events: ${EVENTS_LIST}. Each ` +
        "indexing job sends exactly one when it reaches its final status. To stop polling GET /v2/jobs/{id}, create " +
        "an endpoint with captain_webhook_setup.\n" +
        "Actions:\n" +
        "- event_types(): each event's description, schema version and payload JSON Schema with an example.\n" +
        "- deliveries(endpoint_id, limit?, cursor?): events sent to one endpoint, newest first: message_id, event_id " +
        "(evt_<job_id>), event_type, status (succeeded, failed, pending, sending), test flag, next retry. Page with next_cursor.\n" +
        "- attempts(endpoint_id, message_id, limit?, cursor?): every attempt for one event: the HTTP status your " +
        "server returned, duration, and whether it was an automatic retry or manual. Use it to see why a delivery failed.\n" +
        "- resend(endpoint_id, message_id): send one event again with the same webhook-id and body.\n" +
        "- recover(endpoint_id, since): re-send every failed event since a time at most 7 days ago, in the background.\n" +
        `resend and recover are writes. ${WRITE_NOTE}`,
      inputSchema: {
        action: z.enum(EVENTS_ACTIONS).describe("Which operation to run"),
        endpoint_id: endpointId.optional().describe("Required for deliveries, attempts, resend, recover"),
        message_id: messageId.optional().describe("attempts and resend: message_id from deliveries, or evt_<job_id>"),
        limit: limit.optional().describe("deliveries and attempts: items per page (default 25, max 100)"),
        cursor: cursor.optional().describe("deliveries and attempts: next_cursor from the previous page"),
        since: since.optional().describe("recover only: ISO 8601 time, in the past and within the last 7 days"),
      },
    },
    async (args): Promise<ToolResult> => {
      const p = parseAction<z.infer<typeof eventsSchema>>("captain_webhook_events", eventsSchema, args);
      const config = getConfig();
      switch (p.action) {
        case "event_types":
          return json(await captainFetch(config, "webhooks/event-types"));
        case "deliveries":
          return json(await captainFetch(config, `webhooks/endpoints/${enc(p.endpoint_id)}/deliveries${page(p)}`));
        case "attempts":
          return json(
            await captainFetch(
              config,
              `webhooks/endpoints/${enc(p.endpoint_id)}/deliveries/${enc(p.message_id)}/attempts${page(p)}`,
            ),
          );
        case "resend":
          log(`Resending webhook '${p.message_id}' to '${p.endpoint_id}'`);
          return json(
            await captainFetch(
              config,
              `webhooks/endpoints/${enc(p.endpoint_id)}/deliveries/${enc(p.message_id)}/resend`,
              { method: "POST" },
            ),
          );
        case "recover":
          log(`Recovering webhooks for '${p.endpoint_id}' since ${p.since}`);
          return json(
            await captainFetch(config, `webhooks/endpoints/${enc(p.endpoint_id)}/recover`, {
              method: "POST",
              body: { since: p.since },
            }),
          );
      }
    },
  );
}
