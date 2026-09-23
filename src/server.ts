#!/usr/bin/env node
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCaptainTools } from "./tools.js";
import { registerChunkTools } from "./chunkTools.js";
import { registerLiveSearchTools } from "./liveSearch.js";
import { registerSyncTools } from "./syncTools.js";
import { registerWizardTool } from "./wizard.js";
import { registerEvalTools } from "./evalTools.js";
import { registerEvalApiTools } from "./evalApiTools.js";
import { registerQueryHistoryTools } from "./queryHistoryTools.js";
import { registerDocumentTools } from "./documentTools.js";
import { registerJobTools } from "./jobTools.js";

export const VERSION = "0.8.2";
/** Actual number of tools registered by buildServer() — verified against the registry. */
export const TOOL_COUNT = 72;

/**
 * Build a fully-configured MCP server with every Captain tool registered.
 * Shared by the stdio entrypoint (this file) and the hosted HTTP server, so
 * both expose exactly the same tool surface.
 */
export const ENVIRONMENTS = ["development", "staging", "production"] as const;

/**
 * Every tool takes an optional `environment` (development | staging |
 * production). One MCP URL covers all environments: the OAuth token carries
 * the environments the user approved, and the API refuses any it did not.
 * The hosted server reads this argument off each tools/call before the SDK
 * dispatches it (see httpServer.ts). Added here, once, so no tool has to
 * know; handlers simply ignore the extra field.
 */
function withEnvironmentArg(server: McpServer): void {
  const original = server.registerTool.bind(server);
  // registerTool is generic over the zod shape; widening it here is the one
  // place that generic is deliberately erased.
  (server as unknown as { registerTool: (...a: any[]) => unknown }).registerTool = (
    name: string,
    config: { inputSchema?: Record<string, unknown> } & Record<string, unknown>,
    cb: unknown,
  ) => {
    const inputSchema = {
      ...(config.inputSchema ?? {}),
      environment: z
        .enum(ENVIRONMENTS)
        .optional()
        .describe(
          "Environment to act in: development (default), staging, or production. " +
          "OAuth connections only — the connection must have been approved for it.",
        ),
    };
    return (original as (...a: any[]) => unknown)(name, { ...config, inputSchema }, cb);
  };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "captain-mcp", version: VERSION });
  withEnvironmentArg(server);
  registerCaptainTools(server);
  registerChunkTools(server);
  registerLiveSearchTools(server);
  registerSyncTools(server);
  registerWizardTool(server);
  registerEvalTools(server);
  registerEvalApiTools(server);
  registerQueryHistoryTools(server);
  registerDocumentTools(server);
  registerJobTools(server);
  return server;
}

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[captain-mcp] v${VERSION} ready on stdio (${TOOL_COUNT} tools registered)\n`
  );
}

// Run the stdio server ONLY when this file is the process entrypoint — not when
// imported by httpServer.ts (which calls buildServer() itself). Compares the
// resolved module URL against the invoked script path.
import { fileURLToPath } from "node:url";
import { argv } from "node:process";
const isEntrypoint = argv[1] && fileURLToPath(import.meta.url) === argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    process.stderr.write(`[captain-mcp] fatal: ${err?.stack || err?.message || err}\n`);
    process.exit(1);
  });
}
