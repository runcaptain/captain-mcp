# @captain-sdk/captain-mcp

MCP server for [Captain](https://runcaptain.com) — multimodal RAG search and persistent project search. Works with Claude Code, Cursor, Windsurf, and any MCP-aware client.

## What it does

Exposes 18 tools:

**Core search & collection management (16):**
- `captain_search`, `captain_list_collections`, `captain_create_collection`, `captain_delete_collection`
- `captain_list_documents`, `captain_delete_document`, `captain_wipe_documents`
- `captain_job_status`, `captain_cancel_job`
- `captain_index_url`, `captain_index_youtube`, `captain_index_text`
- `captain_index_s3`, `captain_index_gcs`, `captain_index_azure`, `captain_index_r2`

**Live search (2):**
- `captain_save` — save a short note (decision, gotcha, bug repro, design constraint) to a per-project collection with a timestamped, slugified filename. Auto-creates the collection on first use.
- `captain_find` — semantic search over saved notes, with timestamps surfaced so stale notes are obvious.

## Credentials

Set these env vars in your shell (every client reads them the same way):

```bash
export CAPTAIN_API_KEY=cap_...
export CAPTAIN_ORGANIZATION_ID=019a...
```

Get an API key at [runcaptain.com/studio](https://runcaptain.com/studio).

## Install — Claude Code

Add to `~/.claude/settings.json` (user scope) or `.claude/settings.json` (project scope):

```json
{
  "mcpServers": {
    "captain": {
      "command": "npx",
      "args": ["-y", "@captain-sdk/captain-mcp"],
      "env": {
        "CAPTAIN_API_KEY": "${CAPTAIN_API_KEY}",
        "CAPTAIN_ORGANIZATION_ID": "${CAPTAIN_ORGANIZATION_ID}"
      }
    }
  }
}
```

Restart Claude Code. `/mcp` shows `captain` connected.

## Install — Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "captain": {
      "command": "npx",
      "args": ["-y", "@captain-sdk/captain-mcp"],
      "type": "stdio",
      "env": {
        "CAPTAIN_API_KEY": "${env:CAPTAIN_API_KEY}",
        "CAPTAIN_ORGANIZATION_ID": "${env:CAPTAIN_ORGANIZATION_ID}"
      }
    }
  }
}
```

## Install — any other MCP client

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

## Usage

```
> Search runcaptain-docs for how the scientific/medical/ask streaming works
> Save this to runcaptain: We picked Lambda over CF Worker for PubMed — NCBI doesn't IP-rate-limit.
> What did we decide about PubMed proxying?
> Index https://docs.runcaptain.com/api-reference into runcaptain-docs
```

## Optional: agent guidance

Drop a `.cursor/rules/captain.mdc` (Cursor) or `CLAUDE.md` snippet (Claude Code) in your repo to nudge the agent toward the Captain tools:

```markdown
When searching docs or recalling past decisions, prefer captain_search, captain_save, and captain_find over grep/WebFetch. Use the repo basename as the search collection; captain_save auto-creates it.
```

## Links

- [Captain API docs](https://docs.runcaptain.com)
- [npm package](https://www.npmjs.com/package/@captain-sdk/captain-mcp)
- [OpenClaw Captain plugin](https://github.com/runcaptain/openclaw-plugin-captain) — equivalent tools for the OpenClaw runtime.

## License

MIT.
