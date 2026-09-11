# @captain-sdk/captain-mcp

MCP server for [Captain](https://runcaptain.com) — multimodal RAG search and persistent project search. Works with Claude Code, Cursor, Windsurf, and any MCP-aware client.

## What it does

Exposes 19 tools:

**Core search & collection management (17):**
- `captain_search` (v2: metadata filter, semantic ratio, rerank options), `captain_list_collections`, `captain_create_collection` (description, metadata), `captain_delete_collection`
- `captain_copy_collection`: clone a collection (vectors branched, no indexing credits)
- `captain_change_environment`: move a collection between development, staging, and production. API keys are environment-scoped: `cap_dev_` keys see development, `cap_prod_` keys see production, and `cap_stage_` keys see staging. A moved collection disappears from keys of the old environment, and attached syncs do not follow automatically.
- `captain_list_documents` (filter by custom metadata), `captain_get_document`, `captain_get_document_page`, `captain_create_asset_urls` (viewable URLs for figure regions), `captain_set_document_metadata`, `captain_update_document_metadata`, `captain_delete_document`, `captain_wipe_documents`
- `captain_list_jobs`, `captain_job_status` (per-file results, credits billed, PII report pointer), `captain_cancel_job`, `captain_rollback_job`, `captain_get_pii_report`, `captain_delete_pii_report`
- `captain_validate_parsing_script`: check a JavaScript parsing script in the sandbox before passing it as `parsing_script` to an index tool
- `captain_index_url`, `captain_index_youtube` (transcript / audio / video mode), `captain_index_text`, `captain_index_file`
- `captain_index_s3` (assume-role or access key), `captain_index_gcs`, `captain_index_azure`, `captain_index_r2` (jurisdiction incl. `us`)
- Every index tool accepts `custom_metadata`, `mask_pii`, `max_files`, `skip_existing`, `overwrite_existing`, `transcription_language`, and `parsing_script` where the endpoint does

`captain_index_file` uploads local paths (PDF, DOCX, XLSX, CSV, TXT, images, …) via multipart/form-data — max 20 files, 100MB each.

**Live search (2):**
- `captain_save` — save a short note (decision, gotcha, bug repro, design constraint) to a per-project collection with a timestamped, slugified filename. Auto-creates the collection on first use.
- `captain_find` — semantic search over saved notes, with timestamps surfaced so stale notes are obvious.

**Storage syncs (11):**
- `captain_create_s3_sync`, `captain_create_r2_sync`, `captain_create_supabase_sync`, `captain_create_backblaze_sync`, `captain_create_azure_sync`, `captain_create_gcs_sync` — create a sync that keeps a collection continuously up to date with a cloud-storage bucket (initial backfill + scheduled/event/on-demand updates).
- `captain_list_syncs`, `captain_get_sync`, `captain_update_sync`, `captain_delete_sync` — manage existing syncs (scope, schedule, deletion policy, pause/resume; delete is a soft-delete that retains indexed docs).
- `captain_reconcile_sync` — run an on-demand diff-and-index now; returns counts of added/modified/removed.
- `captain_validate_sync` — dry-run a sync's credentials and bucket before creating it.
- `captain_subscribe_sync_webhook` — enable near-real-time event updates (SNS/SQS for S3, a signed ingest URL for the other providers); `rotate_secret` after a leak.

**Query history (2):**
- `captain_list_queries` — the queries your keys and agents have run, newest first, scoped to the key's environment; filter by collection, status, and time window, page by cursor, and opt in to `include` (results, request, response) to get each query's retrieved chunks and exact bodies per row.
- `captain_get_query` — one stored query by `query_id` or by the `request_id` a query response returns: summary, exact request body, normalised results, and optionally the exact response body.

**Retrieval evaluation (1):**
- `captain_eval` — run a question set against one or more v3 query configurations and score retrieval: recall@1/3/10, MRR, nDCG@10 (multi-hop), latency p50/p95, and a 0-100 composite with a letter grade and a plain-English diagnosis of the weakest component. Configurations are compared as a **paired** test on the same questions (McNemar plus the paired difference's 95% interval), so the output says whether a gain is real rather than just bigger. With no `configs` it runs the standard ladder (baseline → rerank → deeper candidate pool → drop layout noise) and recommends a winner.

  Question generation stays on the client (this server has no model): map with `captain_list_documents` / `captain_list_chunks`, write one *paraphrased* question per sampled chunk (the exact prompt is in the tool description), record `groundTruth`, then call `captain_eval`. Failed queries are excluded and counted, never scored as misses; a round with failures can never trigger early stopping; and the winner is chosen on the questions that survived in *every* round.

**Integration wizard (1):**
- `captain_wizard` — writes Captain into a codebase, using Captain's own agent docs (`llms.txt`) as the source of truth for the current API surface. On first use it asks the user's permission to send routine, de-identified feedback about the integration to Captain's public feedback endpoint (no key, no code, no personal data).

> The hosted server (see below) also adds more indexing sources (Dropbox, Supabase, Backblaze, SharePoint, OneDrive, Google Drive), storage syncs, v3 search, chunk-level tools, query history, and `captain_eval` — 64 tools total.

**Advanced search (`captain_search_v3`).** Every retrieval lever is a request parameter, not a re-index, so they can be tuned against a question set with `captain_eval`:
- `semantic_ratio` — blends the two retrieval legs, keyword (BM25) and semantic (dense vector). `0.0` is keyword only and fastest (it skips embedding the query), `1.0` is semantic only, `0.5` is the default. Lower it for corpora full of exact strings (part numbers, error codes); raise it when callers paraphrase.
- `rerank` — `true`, or an object to tune `candidate_limit` (how many fused candidates are reranked, default `limit` × 3) and `model`. Fixes "found, but not near the top".
- `boost` — up to 10 metadata rules, each of `{field, eq}`, `{field, in}`, or `{chunk_ids}`, with a `weight` and optional `reserve`. A rule both retrieves matching chunks and multiplies their score, for when the right chunk does not match the query's wording.
- `exclude_chunk_types` — drop `page_header`, `page_footer`, `footnote` and friends so page furniture stops competing with body text.
- `include_relations` / `include_related_chunks` / `relation_direction` / `relation_types` — hydrate graph neighbours, so an answer split across a claim and its evidence table comes back together. This is the multi-hop lever; build the edges with `captain_create_chunk_relation`.

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

## Connecting with OAuth (recommended, once enabled)

No API key needed: add the server URL and your MCP client discovers Captain's
OAuth flow, opens a browser to log in with your Captain account, and you pick
the organization and environments to grant.

```json
{
  "mcpServers": {
    "captain": { "url": "https://mcp.captain.dev/mcp" }
  }
}
```

One URL covers every environment. Each tool takes an optional `environment`
argument (`development` — the default — `staging`, or `production`); the
agent picks it per call, and the API refuses any environment you did not
approve on the consent screen. Access is read-only unless you left "Allow
writing" on at consent. The connection uses the organization you picked
there; to point one at another organization you belong to, add
`?org=<organization id>` to the URL. (`?env=<name>` on the URL is still
accepted and sets the default for that entry.) Login is your Captain
account (Auth0); tokens are Auth0-issued and verified locally by this server
against Auth0's keys. Revoking: `POST /oauth/revoke` with the refresh token,
or "Clear authentication" in your MCP client; access tokens expire within an
hour.

`Authorization: Bearer cap_...` keys keep working unchanged (below).

## Hosted (remote) server

Instead of running the stdio server locally, connect to the hosted Captain MCP
over HTTP at **`https://mcp.captain.dev/mcp`**. Authenticate with your Captain
API key as a bearer token — the key implies your organization, so no
organization id is needed.

```json
{
  "mcpServers": {
    "captain": {
      "url": "https://mcp.captain.dev/mcp",
      "headers": { "Authorization": "Bearer cap_..." }
    }
  }
}
```

Same tools as the stdio build, with two differences: the server stores no
credentials (your key is used per-request and never persisted), and
`captain_index_file` cannot read local paths — pass `urls` (which the server
fetches) or inline base64 `files` instead.

**Self-hosting:** the server is a container (`Dockerfile`) serving the MCP at
`/mcp` and a health check at `/health` on `PORT` (default 8080). Run
`npm run start:http` locally, or deploy the image behind TLS.

## Links

- [Captain API docs](https://docs.runcaptain.com)
- [npm package](https://www.npmjs.com/package/@captain-sdk/captain-mcp)
- [OpenClaw Captain plugin](https://github.com/runcaptain/openclaw-plugin-captain) — equivalent tools for the OpenClaw runtime.

## License

MIT.
