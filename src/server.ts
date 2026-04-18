#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCaptainTools } from "./tools.js";
import { registerLiveSearchTools } from "./liveSearch.js";

const VERSION = "0.1.1";

async function main() {
  const server = new McpServer({
    name: "captain-mcp",
    version: VERSION,
  });

  registerCaptainTools(server);
  registerLiveSearchTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`[captain-mcp] v${VERSION} ready on stdio (18 tools registered)\n`);
}

main().catch((err) => {
  process.stderr.write(`[captain-mcp] fatal: ${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
