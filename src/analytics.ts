import { PostHog } from "posthog-node";
import { createHash } from "node:crypto";
import type { CaptainConfig } from "./captainClient.js";

const log = (msg: string) => process.stderr.write(`[captain-mcp] ${msg}\n`);

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

// A missing PostHog key must never break the server. When the key is absent,
// analytics is a no-op — but outside production we say so, because silent misses
// hide the very data-quality problem this instrumentation exists to measure.
let client: PostHog | null = null;
if (POSTHOG_API_KEY) {
  client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST, flushAt: 1, flushInterval: 0 });
} else if (process.env.NODE_ENV !== "production") {
  log(
    "POSTHOG_API_KEY variable required by PostHog is missing or un-configured, this causes " +
      "events to be silently missed. This error stops appearing once POSTHOG_API_KEY is configured"
  );
}

// The API key is a secret, so we identify a caller by a stable hash of it rather
// than the key itself. The organization id, when present, is already safe to use.
function distinctId(config: CaptainConfig): string {
  if (config.organizationId) return config.organizationId;
  return `key_${createHash("sha256").update(config.apiKey).digest("hex").slice(0, 16)}`;
}

/**
 * Record the outcome of an indexing job. Called when a job reaches a terminal
 * state, so the team can count how often files are skipped and land as empty,
 * unsearchable documents.
 */
export function captureJobOutcome(config: CaptainConfig, properties: Record<string, unknown>): void {
  if (!client) return;
  try {
    client.capture({ distinctId: distinctId(config), event: "captain_job_outcome", properties });
  } catch (e: any) {
    log(`analytics capture failed: ${e?.message || e}`);
  }
}
