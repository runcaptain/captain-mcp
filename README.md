# @captain-sdk/captain-mcp

MCP server for [Captain](https://runcaptain.com) — multimodal RAG search and persistent project search. Usable from Claude Code, Cursor, and any MCP-aware client.

## What it does

Exposes 18 tools:

**Core search & collection management (16, ported from the OpenClaw plugin):**
- `captain_search`, `captain_list_collections`, `captain_create_collection`, `captain_delete_collection`
- `captain_list_documents`, `captain_delete_document`, `captain_wipe_documents`
- `captain_job_status`, `captain_cancel_job`
- `captain_index_url`, `captain_index_youtube`, `captain_index_text`
- `captain_index_s3`, `captain_index_gcs`, `captain_index_azure`, `captain_index_r2`

**Live search (2, new in MCP):**
- `captain_save` — save a short note (decision, gotcha, bug repro, design constraint) to a per-project collection with a timestamped, slugified filename. Auto-creates the collection on first use.
- `captain_find` — semantic search over saved notes, with timestamps surfaced so stale notes are obvious.

## Install

```bash
npm install -g @captain-sdk/captain-mcp
```

Or run directly via `npx` (recommended — what the Claude Code and Cursor integrations use):

```bash
npx -y @captain-sdk/captain-mcp
```

## Config (env vars)

```
CAPTAIN_API_KEY=cap_...                # required
CAPTAIN_ORGANIZATION_ID=019a...        # required
```

Get an API key at [runcaptain.com/studio](https://runcaptain.com/studio).

## Use from Claude Code

Install the companion plugin: [`claude-code-plugin-captain`](../claude-code-plugin-captain). It bundles the `.mcp.json` pointing at this package.

## Use from Cursor

Use the one-click deeplink or manual `.cursor/mcp.json` in [`cursor-plugin-captain`](../cursor-plugin-captain).

## Use from any MCP client

Add to your client's MCP config:

```json
{
  "mcpServers": {
    "captain": {
      "command": "npx",
      "args": ["-y", "@captain-sdk/captain-mcp"],
      "env": {
        "CAPTAIN_API_KEY": "cap_...",
        "CAPTAIN_ORGANIZATION_ID": "019a..."
      }
    }
  }
}
```

## Related

- [Captain API docs](https://docs.runcaptain.com)
- [OpenClaw Captain plugin](../openclaw-plugin-captain) — equivalent tools for the OpenClaw runtime.
