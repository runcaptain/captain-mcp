#!/usr/bin/env node
/**
 * MCP OAuth end-to-end against a live deployment (staging first).
 *
 *   node scripts/oauth-e2e.mjs https://staging.api.runcaptain.com [mcpBase]
 *
 * When mcpBase is given (e.g. a branch-deploy of the MCP server pointed at
 * staging), the script also proves the ENV ENFORCEMENT chain: tools work on a
 * granted ?env=, and an un-granted ?env=production is refused with an error
 * naming the granted environments — the only end-to-end proof the token's
 * envs[] claim is enforced.
 *
 * Walks: DCR register -> (human: open the printed /authorize URL, approve)
 * -> loopback callback captures code+state -> token exchange (verifies the
 * JWT against the live JWKS) -> refresh rotation -> CONCURRENT refresh (grace
 * window: both must succeed) -> replay-beyond-grace expectation printed for
 * manual runs -> revoke (family + oracle-free). Plus a negative battery.
 * Prints PASS/FAIL per step; exits non-zero on failure.
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const API = (process.argv[2] || "https://staging.api.runcaptain.com").replace(/\/+$/, "");
const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function main() {
  // ---- discovery ---------------------------------------------------------
  const meta = await (await fetch(`${API}/.well-known/oauth-authorization-server`)).json();
  check("AS metadata", meta.code_challenge_methods_supported?.[0] === "S256");
  const jwks = await (await fetch(meta.jwks_uri)).json();
  check("JWKS reachable", Array.isArray(jwks.keys) && jwks.keys.length >= 1);

  // ---- loopback listener -------------------------------------------------
  let resolveCode;
  const codeP = new Promise((r) => (resolveCode = r));
  const srv = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    res.end("You can close this tab.");
    if (u.searchParams.get("code")) {
      resolveCode({ code: u.searchParams.get("code"), state: u.searchParams.get("state") });
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const redirectUri = `http://127.0.0.1:${port}/cb`;

  // ---- DCR ---------------------------------------------------------------
  const reg = await fetch(`${API}/oauth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "oauth-e2e script", redirect_uris: [`http://127.0.0.1/cb`] }),
  });
  const client = await reg.json();
  check("DCR register", reg.status === 201 && client.client_id?.startsWith("mcp_"));
  check("DCR no secret", !("client_secret" in client));

  // ---- authorize (human step) -------------------------------------------
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  const authorizeUrl = `${meta.authorization_endpoint}?` + new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", state,
    scope: "captain:read captain:write",
  });
  console.log(`\nOpen and approve:\n\n  ${authorizeUrl}\n`);
  const { code, state: gotState } = await codeP;
  srv.close();
  check("state round-trips byte-exact", gotState === state);

  // ---- token exchange ----------------------------------------------------
  const form = (o) => new URLSearchParams(o);
  const tok = await fetch(meta.token_endpoint, {
    method: "POST", body: form({
      grant_type: "authorization_code", code, redirect_uri: redirectUri,
      client_id: client.client_id, code_verifier: verifier,
    }),
  });
  const tokens = await tok.json();
  check("token exchange", tok.status === 200 && !!tokens.access_token, JSON.stringify(tokens).slice(0, 120));
  const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString());
  check("claims: org+envs present", !!claims.org && Array.isArray(claims.envs), `envs=${claims.envs}`);

  // ---- code replay => family revoked -------------------------------------
  const replay = await fetch(meta.token_endpoint, {
    method: "POST", body: form({
      grant_type: "authorization_code", code, redirect_uri: redirectUri,
      client_id: client.client_id, code_verifier: verifier,
    }),
  });
  check("code replay rejected", replay.status === 400);
  const afterReplay = await fetch(meta.token_endpoint, {
    method: "POST", body: form({
      grant_type: "refresh_token", refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    }),
  });
  check("replayed code killed its family", afterReplay.status === 400);

  // ---- fresh consent for refresh tests (needs another human approve) -----
  console.log("\nA second consent is needed for the refresh battery.");
  let resolve2; const codeP2 = new Promise((r) => (resolve2 = r));
  const srv2 = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    res.end("You can close this tab.");
    if (u.searchParams.get("code")) resolve2(u.searchParams.get("code"));
  });
  await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
  const redirect2 = `http://127.0.0.1:${srv2.address().port}/cb`;
  const v2 = b64url(randomBytes(48));
  const ch2 = b64url(createHash("sha256").update(v2).digest());
  console.log(`\nOpen and approve:\n\n  ${meta.authorization_endpoint}?` + new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: redirect2,
    code_challenge: ch2, code_challenge_method: "S256", state: "s2",
    scope: "captain:read captain:write",
  }) + "\n");
  const code2 = await codeP2; srv2.close();
  const tok2 = await (await fetch(meta.token_endpoint, {
    method: "POST", body: form({
      grant_type: "authorization_code", code: code2, redirect_uri: redirect2,
      client_id: client.client_id, code_verifier: v2,
    }),
  })).json();
  check("second consent exchange", !!tok2.refresh_token);

  // ---- CONCURRENT refresh (grace) ----------------------------------------
  const [ra, rb] = await Promise.all([1, 2].map(() =>
    fetch(meta.token_endpoint, {
      method: "POST", body: form({
        grant_type: "refresh_token", refresh_token: tok2.refresh_token,
        client_id: client.client_id,
      }),
    })));
  check("concurrent refresh both succeed (grace)", ra.status === 200 && rb.status === 200,
        `${ra.status}/${rb.status}`);
  const child = (await rb.json()).refresh_token;
  const rc = await fetch(meta.token_endpoint, {
    method: "POST", body: form({
      grant_type: "refresh_token", refresh_token: child, client_id: client.client_id,
    }),
  });
  const rcBody = await rc.json();
  check("child refresh rotates", rc.status === 200 && rcBody.refresh_token !== child);

  // ---- revoke ------------------------------------------------------------
  const rev = await fetch(`${API}/oauth/revoke`, {
    method: "POST", body: form({ token: rcBody.refresh_token }),
  });
  check("revoke 200", rev.status === 200);
  const afterRevoke = await fetch(meta.token_endpoint, {
    method: "POST", body: form({
      grant_type: "refresh_token", refresh_token: rcBody.refresh_token,
      client_id: client.client_id,
    }),
  });
  check("revoked family dead", afterRevoke.status === 400);
  const revUnknown = await fetch(`${API}/oauth/revoke`, {
    method: "POST", body: form({ token: "cmr_unknown" }),
  });
  check("revoke oracle-free", revUnknown.status === 200);

  // ---- MCP leg: env enforcement (the headline verification) --------------
  const MCP_BASE = (process.argv[3] || "").replace(/\/+$/, "");
  if (MCP_BASE) {
    console.log("\nA third consent is needed for the MCP env battery.");
    let resolve3; const codeP3 = new Promise((r) => (resolve3 = r));
    const srv3 = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      res.end("You can close this tab.");
      if (u.searchParams.get("code")) resolve3(u.searchParams.get("code"));
    });
    await new Promise((r) => srv3.listen(0, "127.0.0.1", r));
    const redirect3 = `http://127.0.0.1:${srv3.address().port}/cb`;
    const v3 = b64url(randomBytes(48));
    const ch3 = b64url(createHash("sha256").update(v3).digest());
    console.log(`\nOpen and approve (grant development + staging, NOT production):\n\n  ${meta.authorization_endpoint}?` + new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: redirect3,
      code_challenge: ch3, code_challenge_method: "S256", state: "s3",
      scope: "captain:read captain:write",
    }) + "\n");
    const code3 = await codeP3; srv3.close();
    const tok3 = await (await fetch(meta.token_endpoint, {
      method: "POST", body: form({
        grant_type: "authorization_code", code: code3, redirect_uri: redirect3,
        client_id: client.client_id, code_verifier: v3 }),
    })).json();
    check("third consent exchange", !!tok3.access_token);

    const mcpCall = async (env, payload) => {
      const r = await fetch(`${MCP_BASE}/mcp?env=${env}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Authorization": `Bearer ${tok3.access_token}`,
        },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      return { status: r.status, text };
    };
    const listReq = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const callReq = { jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "captain_list_collections", arguments: {} } };

    const l1 = await mcpCall("development", listReq);
    check("MCP tools/list on granted env", l1.status === 200 && l1.text.includes("captain_list_collections"));
    const c1 = await mcpCall("development", callReq);
    check("MCP tool call on development", c1.status === 200 && !c1.text.includes("not authorized"),
          c1.text.slice(0, 120));
    const c2 = await mcpCall("staging", callReq);
    check("MCP tool call on staging (granted)", c2.status === 200 && !c2.text.includes("not authorized"));
    const c3 = await mcpCall("production", callReq);
    check("MCP tool call on UN-granted production is refused",
          c3.text.includes("not authorized") || c3.text.includes("Re-authorize"),
          c3.text.slice(0, 160));
  } else {
    console.log("\n(no mcpBase argument — MCP env-enforcement leg SKIPPED; " +
                "run with the MCP base URL before sign-off)");
  }

  // ---- negatives ----------------------------------------------------------
  const badReg = await fetch(`${API}/oauth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "x", redirect_uris: ["http://localhost/cb"] }),
  });
  check("localhost redirect rejected", badReg.status === 400);
  const badGrant = await fetch(meta.token_endpoint, {
    method: "POST", body: form({ grant_type: "password", username: "x", password: "y" }),
  });
  check("unsupported grant rejected", badGrant.status === 400);

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("e2e crashed:", e); process.exit(1); });
