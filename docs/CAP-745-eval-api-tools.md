# Follow-up: mirror the Evaluation API (CAP-745) as MCP tools

Tracking stub for the three public endpoints added by
[runcaptain/captain#1232](https://github.com/runcaptain/captain/pull/1232).
That PR lands without the MCP change, as AGENTS.md permits when the API PR
says so and links the follow-up. This file is that link.

**Why not in the same change set.** The Evaluation API is asynchronous: an
eval is created, then polled to a terminal state that can be minutes or
hours later. The MCP tools therefore need shapes (and a polling story) that
should be written against a real run's responses rather than inferred from
the Pydantic models. The API PR cannot reach a running eval until the infra
PR lands and the staging end-to-end recipe passes, so the tools are written
immediately after that run and this branch becomes the real PR.

## Tools to add

| Tool | Endpoint | Notes |
|---|---|---|
| `captain_create_eval_upload` | `POST /v3/collections/{name}/evals/uploads` | returns `upload_id`, a single-use PUT URL, and the exact headers the PUT must send |
| `captain_create_eval` | `POST /v3/collections/{name}/evals` | requires `Idempotency-Key`; input mirrors `CreateEvalRequestV3` (upload_id, configs[], environment) |
| `captain_get_eval` | `GET /v3/evals/{eval_id}` | `items_limit` / `items_cursor` paging; scorecards and billing are null until terminal |

Plus the housekeeping AGENTS.md requires: bump `TOOL_COUNT` in
`src/server.ts` (49 → 52), the README tool table, and the docs MCP page.

## Open questions for the implementation

- **The PUT.** The upload URL is a capability URL on `*.captainusercontent.com`
  and the client must PUT the NDJSON itself. Decide whether the tool performs
  the PUT on the caller's behalf (convenient, but the tool then handles the
  customer's query text) or returns the URL and lets the agent do it.
- **Polling.** `captain_get_eval` is the only progress surface. Either the
  agent polls, or a thin wrapper polls to terminal with a bounded timeout.
  Note the 60s gateway timeout recorded in the MCP eval gotchas.
- **Relationship to `captain_eval`.** The existing synchronous tool in
  `src/evalTools.ts` runs its own queries client-side and is not a wrapper of
  this API. Both can coexist; the docs need to say which to reach for.

## Not in scope

Nothing here is required for the API PR to be correct; these tools are the
agent-facing mirror, and the API is usable over HTTP without them.
