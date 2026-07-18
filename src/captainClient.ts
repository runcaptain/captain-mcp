import { AsyncLocalStorage } from "node:async_hooks";

// Host only — the API version (v2/v3) is chosen per call. Overridable via env so
// the same build can point at staging/dev.
const CAPTAIN_API_HOST =
  process.env.CAPTAIN_API_HOST?.replace(/\/+$/, "") || "https://api.runcaptain.com";

export type ApiVersion = "v2" | "v3";

export interface CaptainConfig {
  apiKey: string;
  // Optional: the API key already implies its organization, so this is only sent
  // as X-Organization-ID when explicitly provided. Passing a MISMATCHED org id
  // causes a 403 ("API key does not belong to the specified organization"), so
  // it's better to omit it and let the key speak for itself.
  organizationId?: string;
}

// Request-scoped credential store. The hosted HTTP server derives credentials
// from each incoming request's Authorization header and runs the tool call
// inside `runWithConfig(...)`, so getConfig() picks them up WITHOUT any tool
// having to thread a config object through. Empty in stdio mode (falls back to
// env). Nothing is stored beyond the lifetime of a single request.
const credentialStore = new AsyncLocalStorage<CaptainConfig>();

export function runWithConfig<T>(config: CaptainConfig, fn: () => T): T {
  return credentialStore.run(config, fn);
}

/**
 * Resolve per-invocation credentials.
 *
 * Precedence: an explicit `override` wins; then request-scoped credentials set
 * by the hosted server via runWithConfig(); then process env (stdio / local
 * single-user mode). Called fresh inside every tool handler.
 */
export function getConfig(override?: Partial<CaptainConfig>): CaptainConfig {
  const scoped = credentialStore.getStore();
  const apiKey = override?.apiKey ?? scoped?.apiKey ?? process.env.CAPTAIN_API_KEY;
  const organizationId =
    override?.organizationId ?? scoped?.organizationId ?? process.env.CAPTAIN_ORGANIZATION_ID;

  if (!apiKey) throw new Error("CAPTAIN_API_KEY is required.");

  return { apiKey, organizationId };
}

function captainHeaders(config: CaptainConfig, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.apiKey}`,
    ...extra,
  };
  // Only send the org header when explicitly provided — the key implies the org.
  if (config.organizationId) headers["X-Organization-ID"] = config.organizationId;
  return headers;
}

export async function captainFetch(
  config: CaptainConfig,
  path: string,
  options: { method?: string; body?: unknown; version?: ApiVersion } = {}
): Promise<any> {
  const version = options.version || "v2";
  const url = `${CAPTAIN_API_HOST}/${version}/${path}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: captainHeaders(config, { "Content-Type": "application/json" }),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text().catch(() => response.statusText);
    throw new Error(`Captain API error (${response.status}): ${error}`);
  }

  // 204 / empty-body responses (some DELETEs) have nothing to parse.
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

export async function captainUploadFiles(
  config: CaptainConfig,
  path: string,
  form: FormData,
): Promise<any> {
  const url = `${CAPTAIN_API_HOST}/v2/${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: captainHeaders(config),
    body: form,
  });
  if (!response.ok) {
    const error = await response.text().catch(() => response.statusText);
    throw new Error(`Captain API error (${response.status}): ${error}`);
  }
  return response.json();
}

export type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function jobStartedResponse(jobId: string, source: string): ToolResult {
  return textResult(
    `Indexing started from ${source}.\nJob ID: ${jobId}\nStatus: pending\n\n` +
    `Files are being processed in the background. Search results will be available once indexing completes.`
  );
}
