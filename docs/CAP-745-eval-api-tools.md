# Evaluation API tools (CAP-745)

The agent-facing mirror of the Evaluation API
([docs](https://docs.captain.dev/guides/evaluations),
[reference](https://docs.captain.dev/reference/evals/create)), added in
`src/evalApiTools.ts` after the API shipped to production on 2026-09-16.

| Tool | Endpoint | Notes |
|---|---|---|
| `captain_create_eval_upload` | `POST /v3/collections/{name}/evals/uploads` + the `PUT` to the minted URL | takes the cases as objects, writes the NDJSON, mints and uploads in one call; the upload expires in 15 minutes |
| `captain_run_eval` | `POST /v3/collections/{name}/evals` | sends `Idempotency-Key` (generated when the caller gives none, always returned); configs are v3 query configurations plus a `name` |
| `captain_get_eval_results` | `GET /v3/evals/{eval_id}` (+ `GET .../answers/{case}/{config}` with `include_answers`) | paged cases; answers bounded to 20 per call |

## Decisions

- **The tool performs the PUT.** The capability URL carries its own signature, so
  the API key never leaves the API host; the tool simply forwards the bytes it
  just serialised. Returning the URL for the agent to upload would have meant a
  second round trip and a Content-Length the agent had to get exactly right.
- **No polling wrapper.** The hosted gateway cuts a call at 60 s and an eval can
  run for minutes, so the agent polls `captain_get_eval_results` (`terminal`
  says when to stop). Each call is a few short requests.
- **`captain_eval` stays.** It is the quick, in-process paired comparison for a
  few hundred questions; the API tools are for large sets and for results that
  should outlive the session. The README says which to reach for.
- **Compact outputs.** Per-case results keep hit, rank, latency, `query_id` and
  the error code; the retrieved-id echo is dropped. Answers keep the request and
  the top ten results with the text clipped to 200 characters.

Housekeeping done here: `TOOL_COUNT` 65 → 68, version 0.8.0, README tool table.
The docs MCP page in captain-docs lists the hosted tools and is updated separately.
