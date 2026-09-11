#!/usr/bin/env node
/**
 * Hosted Captain MCP server (mcp.captain.dev; mcp.runcaptain.com kept as an alias) — Express 5.
 *
 * Two auth modes on one /mcp endpoint:
 *   legacy  Bearer cap_* — raw passthrough, byte-identical to the pre-OAuth
 *           server. Always available.
 *   oauth   any other Bearer — Captain-issued at+jwt, verified LOCALLY
 *           against the token issuer's JWKS (requireBearerAuth + CaptainTokenVerifier;
 *           no per-request introspection). Gated by CAPTAIN_OAUTH_ENABLED
 *           (default off => the merge is inert and the flag flip is the
 *           release).
 *
 * The active environment for an OAuth connection comes from the connection
 * URL's ?env= (or X-Captain-Environment) — never validated here; the API's
 * McpOAuthMiddleware is the single enforcement point against the token's
 * envs claim.
 *
 * Stateless by construction: a fresh McpServer + StreamableHTTPServerTransport
 * per request, no session store, no server-held Captain credentials
 * (porter.yaml still carries public config only). Body parsing stays at
 * express.json({limit:'200mb'}) — the SDK enforces no cap of its own — and
 * the parsed body is passed to transport.handleRequest explicitly (the SDK
 * would otherwise re-read an already-drained stream as empty).
 */
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { buildServer, ENVIRONMENTS, VERSION, TOOL_COUNT } from "./server.js";
import { runWithConfig, type CaptainConfig } from "./captainClient.js";
import { CaptainTokenVerifier } from "./auth/tokenVerifier.js";

// The hosted server never reads the user's local disk.
process.env.CAPTAIN_MCP_ALLOW_LOCAL_FILES = "false";

const PORT = Number(process.env.PORT || 8080);
const MCP_PATH = "/mcp";
const OAUTH_ENABLED = process.env.CAPTAIN_OAUTH_ENABLED === "true";
const ISSUER = (process.env.CAPTAIN_OAUTH_ISSUER || "https://api.captain.dev").replace(/\/+$/, "");
const JWKS_URL = process.env.CAPTAIN_JWKS_URL || `${ISSUER}/.well-known/jwks.json`;
// Token `iss` may differ from the discovery origin when the metadata document is
// served by Captain but tokens are minted by Auth0 (DCR-shim mode).
const TOKEN_ISSUER = process.env.CAPTAIN_OAUTH_TOKEN_ISSUER || ISSUER;
// Every public URL this server is reachable at (canonical first). The
// protected-resource metadata, the WWW-Authenticate challenge and the token
// audience are all per host: an MCP client checks that the advertised
// `resource` matches the URL it connected to, and Auth0 mints one audience
// per registered API — so the legacy host keeps its own identity rather than
// being told it is somebody else.
const PUBLIC_MCP_URLS: string[] = (
  process.env.CAPTAIN_MCP_PUBLIC_URLS
  || process.env.CAPTAIN_MCP_PUBLIC_URL
  || "https://mcp.captain.dev/mcp,https://mcp.runcaptain.com/mcp"
).split(",").map((u) => u.trim()).filter(Boolean);
const PUBLIC_MCP_URL = PUBLIC_MCP_URLS[0];
const PUBLIC_URL_BY_HOST = new Map(PUBLIC_MCP_URLS.map((u) => [new URL(u).host.toLowerCase(), u]));

/** The public URL for the host a request arrived on; the canonical one for any other. */
function publicUrlFor(req: Request): string {
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host);
  const h = (Array.isArray(host) ? host[0] : host)?.split(",")[0]?.trim().toLowerCase();
  return (h && PUBLIC_URL_BY_HOST.get(h)) || PUBLIC_MCP_URL;
}

const log = (msg: string) => process.stderr.write(`[captain-mcp-http] ${msg}\n`);

/** Hardcoded AS-metadata fallback: an API blip must never block boot. */
const FALLBACK_AS_METADATA: OAuthMetadata = {
  issuer: ISSUER,
  authorization_endpoint: "https://www.captain.dev/authorize",
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  jwks_uri: JWKS_URL,
  scopes_supported: ["captain:read", "captain:write"],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
};

async function fetchAsMetadata(): Promise<OAuthMetadata> {
  try {
    const r = await fetch(`${ISSUER}/.well-known/oauth-authorization-server`,
      { signal: AbortSignal.timeout(5000) });
    if (r.ok) return (await r.json()) as OAuthMetadata;
  } catch { /* fall through */ }
  log("AS metadata boot-fetch failed; serving the hardcoded fallback");
  return FALLBACK_AS_METADATA;
}

function bearerFrom(req: Request): string | undefined {
  // Deliberately as strict as the SDK's requireBearerAuth parser (a single
  // "Bearer " prefix): two parsers on one endpoint must agree on what a
  // token is.
  const auth = req.headers.authorization;
  if (!auth) return undefined;
  const [scheme, token] = auth.split(" ");
  return scheme === "Bearer" && token ? token : undefined;
}

function envFrom(req: Request): string | undefined {
  const q = typeof req.query.env === "string" ? req.query.env : undefined;
  const h = req.headers["x-captain-environment"];
  return q || (Array.isArray(h) ? h[0] : h) || undefined;
}

/**
 * The `environment` argument of a tools/call, if any. Stateless transport
 * means one JSON-RPC message per POST, so the request's config IS the
 * call's config. Precedence: tool argument > ?env= / header > development.
 */
function envFromCall(body: unknown): string | undefined {
  const b = body as { method?: string; params?: { arguments?: { environment?: unknown } } } | undefined;
  if (!b || b.method !== "tools/call") return undefined;
  const e = b.params?.arguments?.environment;
  return typeof e === "string" && (ENVIRONMENTS as readonly string[]).includes(e) ? e : undefined;
}

function orgFrom(req: Request): string | undefined {
  const h = req.headers["x-organization-id"];
  const fromHeader = (Array.isArray(h) ? h[0] : h)?.trim();
  const fromQuery = typeof req.query.org === "string" ? req.query.org.trim() : undefined;
  return fromHeader || fromQuery || undefined;
}

async function serveMcp(req: Request, res: Response, creds: CaptainConfig): Promise<void> {
  // Stateless: fresh server + transport per request; runWithConfig binds THIS
  // request's credentials for every tool's getConfig().
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    // req.body is express.json's parsed body — passed EXPLICITLY (the SDK
    // cannot re-read the drained stream).
    await runWithConfig(creds, () => transport.handleRequest(req, res, req.body));
  } catch (e: any) {
    log(`handler error: ${e?.message || e}`); // message only — never a token
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

async function main(): Promise<void> {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "200mb" }));

  app.use(cors({
    origin: true,
    credentials: false,
    allowedHeaders: ["Content-Type", "Authorization", "X-Organization-ID",
                     "X-Captain-Environment", "Mcp-Session-Id", "mcp-protocol-version"],
    // Without WWW-Authenticate exposed, a browser-based MCP client can never
    // read the 401 challenge and discovery silently fails.
    exposedHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
  }));

  app.get(["/health", "/healthz"], (_req, res) => {
    res.json({ status: "healthy", service: "captain-mcp", version: VERSION,
               tools: TOOL_COUNT, oauth: OAUTH_ENABLED });
  });

  if (OAUTH_ENABLED) {
    const oauthMetadata = await fetchAsMetadata();
    // Serves /.well-known/oauth-protected-resource/mcp (and mirrors the AS
    // metadata document — a second serving surface for the boot-fetched copy,
    // which is why it is re-fetched periodically below).
    // One metadata router per public host, dispatched on the request's host.
    const metadataRouters = new Map(PUBLIC_MCP_URLS.map((u) => [u, mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: new URL(u),
      scopesSupported: ["captain:read", "captain:write"],
      resourceName: "Captain",
    })]));
    app.use((req: Request, res: Response, next: NextFunction) => {
      metadataRouters.get(publicUrlFor(req))!(req, res, next);
    });
    setInterval(() => {
      fetchAsMetadata().then(m => Object.assign(oauthMetadata, m)).catch(() => {});
    }, 15 * 60 * 1000).unref();

    const verifier = new CaptainTokenVerifier({
      jwksUrl: JWKS_URL, issuer: TOKEN_ISSUER, audiences: PUBLIC_MCP_URLS,
    });
    // The 401 challenge points at the metadata of the host the client used.
    const bearerAuths = new Map(PUBLIC_MCP_URLS.map((u) => [u, requireBearerAuth({
      verifier,
      requiredScopes: ["captain:read"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(u)),
    })]));

    app.all(MCP_PATH, (req: Request, res: Response) => {
      const token = bearerFrom(req);
      if (token?.startsWith("cap_")) {
        // Legacy path: byte-identical passthrough, skips OAuth entirely.
        const org = orgFrom(req);
        void serveMcp(req, res, {
          apiKey: token, mode: "legacy",
          ...(org ? { organizationId: org } : {}),
        });
        return;
      }
      // OAuth path (including "no token": requireBearerAuth emits the 401
      // with WWW-Authenticate resource_metadata — the discovery trigger).
      // requireBearerAuth writes 401/403 responses itself and only invokes
      // the callback on success — there is no error to forward.
      bearerAuths.get(publicUrlFor(req))!(req, res, () => {
        const auth = (req as Request & {
          auth?: { token: string; scopes?: string[]; extra?: Record<string, unknown> };
        }).auth;
        // The token identifies the USER; the org is per connection: ?org= on
        // the MCP URL (forwarded as X-Organization-ID), else the API falls
        // back to the org the user picked on the consent page. The API
        // re-checks membership on every request either way.
        const org = orgFrom(req);
        // Default environment = development when the grant includes it, else
        // the first environment the user did approve: a consent that unticked
        // development must not make every default call a 403.
        const granted = (auth!.scopes ?? [])
          .filter((s) => s.startsWith("env:"))
          .map((s) => s.slice(4))
          .filter((e) => (ENVIRONMENTS as readonly string[]).includes(e));
        const defaultEnv = granted.includes("development") ? "development" : (granted[0] ?? "development");
        void serveMcp(req, res, {
          apiKey: auth!.token,
          mode: "oauth",
          environment: envFromCall(req.body) || envFrom(req) || defaultEnv,
          ...(org ? { organizationId: org } : {}),
        });
      });
    });
  } else {
    // Flag off: EXACTLY the pre-OAuth contract (any Bearer passes through;
    // 401 shape unchanged, no WWW-Authenticate, no well-known routes).
    app.all(MCP_PATH, (req: Request, res: Response) => {
      const token = bearerFrom(req);
      if (!token) {
        res.status(401).json({
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
      const org = orgFrom(req);
      void serveMcp(req, res, {
        apiKey: token, mode: "legacy",
        ...(org ? { organizationId: org } : {}),
      });
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found", mcp_endpoint: MCP_PATH });
  });

  // Express 5 catch-all error handler (json body-parse failures and any
  // middleware throw land here).
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    log(`middleware error: ${err?.message || err}`);
    if (!res.headersSent) res.status(400).json({ error: "Bad request" });
  });

  app.listen(PORT, () => {
    log(`v${VERSION} listening on :${PORT} — MCP at ${MCP_PATH}, health at /health `
      + `(${TOOL_COUNT} tools, oauth=${OAUTH_ENABLED ? "on" : "off"})`);
  });
}

void main();
