#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCaptainTools } from "./tools.js";
import { registerChunkTools } from "./chunkTools.js";
import { registerLiveSearchTools } from "./liveSearch.js";
import { registerSyncTools } from "./syncTools.js";
import { registerWizardTool } from "./wizard.js";
import { registerEvalTools } from "./evalTools.js";

export const VERSION = "0.5.0";
export const TOOL_COUNT = 47;

/**
 * Build a fully-configured MCP server with every Captain tool registered.
 * Shared by the stdio entrypoint (this file) and the hosted HTTP server, so
 * both expose exactly the same tool surface.
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "captain-mcp", version: VERSION });
  registerCaptainTools(server);
  registerChunkTools(server);
  registerLiveSearchTools(server);
  registerSyncTools(server);
  registerWizardTool(server);
  registerEvalTools(server);
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
