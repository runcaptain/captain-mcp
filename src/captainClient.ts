const CAPTAIN_API_BASE = "https://api.runcaptain.com/v2";

export interface CaptainConfig {
  apiKey: string;
  organizationId: string;
}

export function getConfig(): CaptainConfig {
  const apiKey = process.env.CAPTAIN_API_KEY;
  const organizationId = process.env.CAPTAIN_ORGANIZATION_ID;

  if (!apiKey) throw new Error("CAPTAIN_API_KEY env var is required.");
  if (!organizationId) throw new Error("CAPTAIN_ORGANIZATION_ID env var is required.");

  return { apiKey, organizationId };
}

export async function captainFetch(
  config: CaptainConfig,
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<any> {
  const url = `${CAPTAIN_API_BASE}/${path}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "X-Organization-ID": config.organizationId,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
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
