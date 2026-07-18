#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, VERSION, TOOL_COUNT } from "./server.js";
import { runWithConfig, type CaptainConfig } from "./captainClient.js";

// The hosted server never reads the user's local disk.
process.env.CAPTAIN_MCP_ALLOW_LOCAL_FILES = "false";

const PORT = Number(process.env.PORT || 8080);
const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 200 * 1024 * 1024; // 200MB — accommodate base64 file uploads

const log = (msg: string) => process.stderr.write(`[captain-mcp-http] ${msg}\n`);

/**
 * Extract per-request Captain credentials from the incoming HTTP request.
 *
 * - API key: `Authorization: Bearer <cap_...>` (never logged, never stored).
 * - Organization id: `X-Organization-ID` header, or the `org` query param.
 *
 * Bearer-passthrough model: the server holds no credentials of its own and
 * persists nothing — each request carries its own key, used only for the
 * duration of that request.
 */
function credentialsFromRequest(req: IncomingMessage): CaptainConfig | null {
  const auth = req.headers["authorization"];
  const bearer = Array.isArray(auth) ? auth[0] : auth;
  const apiKey = bearer?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!apiKey) return null;

  // Org id is OPTIONAL — the API key implies its organization. Only forward it
  // when the caller explicitly supplied one (a mismatched org id causes a 403).
  const orgHeader = req.headers["x-organization-id"];
  let organizationId = (Array.isArray(orgHeader) ? orgHeader[0] : orgHeader)?.trim() || undefined;
  if (!organizationId && req.url) {
    organizationId = new URL(req.url, "http://localhost").searchParams.get("org")?.trim() || undefined;
  }

  return organizationId ? { apiKey, organizationId } : { apiKey };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const creds = credentialsFromRequest(req);
  if (!creds) {
    sendJson(res, 401, {
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "Missing API key. Send 'Authorization: Bearer <CAPTAIN_API_KEY>'. " +
          "An organization id is optional (the key implies its org).",
      },
      id: null,
    });
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (e: any) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: e?.message || "Bad request body" },
      id: null,
    });
    return;
  }

  // Stateless: a fresh server + transport per request, no session store. Each
  // request runs inside runWithConfig so every tool's getConfig() resolves THIS
  // request's credentials (never a leaked/previous caller's).
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await runWithConfig(creds, () => transport.handleRequest(req, res, body));
  } catch (e: any) {
    log(`handler error: ${e?.message || e}`); // message only — never the key
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

const httpServer = createServer(async (req, res) => {
  const url = req.url ? new URL(req.url, "http://localhost").pathname : "/";

  // Health check (unauthenticated) for the load balancer / k8s probes.
  if (url === "/health" || url === "/healthz") {
    sendJson(res, 200, { status: "healthy", service: "captain-mcp", version: VERSION, tools: TOOL_COUNT });
    return;
  }

  if (url === MCP_PATH) {
    await handleMcp(req, res);
    return;
  }

  sendJson(res, 404, { error: "Not found", mcp_endpoint: MCP_PATH });
});

httpServer.listen(PORT, () => {
  log(`v${VERSION} listening on :${PORT} — MCP at ${MCP_PATH}, health at /health (${TOOL_COUNT} tools)`);
});
