import assert from 'node:assert/strict';
import test from 'node:test';
import { registerWebhookTools } from '../dist/webhookTools.js';
import { buildServer, TOOL_COUNT } from '../dist/server.js';
import { runWithConfig } from '../dist/captainClient.js';

function handlers() {
  const map = new Map();
  registerWebhookTools({ registerTool: (name, definition, handler) => map.set(name, { definition, handler }) });
  return map;
}
const call = (map, name, args) => runWithConfig({ apiKey: 'synthetic' }, () => map.get(name).handler(args));
const text = (r) => r.content[0].text;

function mockFetch(t, reply = {}) {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  return seen;
}

test('registers one tool per /v2/webhooks route and none that reads a secret back', () => {
  const map = handlers();
  assert.deepEqual([...map.keys()], [
    'captain_list_webhook_event_types',
    'captain_create_webhook_endpoint',
    'captain_list_webhook_endpoints',
    'captain_get_webhook_endpoint',
    'captain_update_webhook_endpoint',
    'captain_delete_webhook_endpoint',
    'captain_rotate_webhook_secret',
    'captain_test_webhook_endpoint',
    'captain_list_webhook_deliveries',
    'captain_list_webhook_delivery_attempts',
    'captain_resend_webhook_delivery',
    'captain_recover_webhook_endpoint',
  ]);
  for (const name of map.keys()) assert.doesNotMatch(name, /get_.*secret|reveal/);
  assert.match(map.get('captain_create_webhook_endpoint').definition.description, /ONLY in this response/);
  assert.match(map.get('captain_rotate_webhook_secret').definition.description, /24 hours/);
});

test('TOOL_COUNT matches the registry', () => {
  const server = buildServer();
  const registered = Object.keys(server._registeredTools ?? {}).length;
  assert.equal(registered, TOOL_COUNT);
});

test('create posts only the fields given and says the secret is shown once', async (t) => {
  const map = handlers();
  const seen = mockFetch(t, { endpoint_id: 'whe_1', secret: 'whsec_x' });
  const out = await call(map, 'captain_create_webhook_endpoint', {
    url: 'https://example.com/hooks', event_types: ['job.failed'], sources: ['sync'],
  });
  assert.ok(seen[0].url.endsWith('/v2/webhooks/endpoints'));
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(seen[0].body, { url: 'https://example.com/hooks', event_types: ['job.failed'], sources: ['sync'] });
  assert.match(text(out), /shown only once/);
  assert.match(text(out), /whsec_x/);
});

test('update sends a PATCH with only the changed fields and refuses an empty change', async (t) => {
  const map = handlers();
  const seen = mockFetch(t, { endpoint_id: 'whe_1' });
  await call(map, 'captain_update_webhook_endpoint', { endpoint_id: 'whe_1', disabled: false, collection_ids: [] });
  assert.ok(seen[0].url.endsWith('/v2/webhooks/endpoints/whe_1'));
  assert.equal(seen[0].method, 'PATCH');
  assert.deepEqual(seen[0].body, { collection_ids: [], disabled: false });
  await assert.rejects(call(map, 'captain_update_webhook_endpoint', { endpoint_id: 'whe_1' }), /at least one field/);
});

test('routes, methods and query strings match the API', async (t) => {
  const map = handlers();
  const seen = mockFetch(t, {});
  await call(map, 'captain_list_webhook_event_types', {});
  await call(map, 'captain_list_webhook_endpoints', {});
  await call(map, 'captain_get_webhook_endpoint', { endpoint_id: 'whe_1' });
  await call(map, 'captain_delete_webhook_endpoint', { endpoint_id: 'whe_1' });
  await call(map, 'captain_rotate_webhook_secret', { endpoint_id: 'whe_1' });
  await call(map, 'captain_test_webhook_endpoint', { endpoint_id: 'whe_1', event_type: 'job.failed' });
  await call(map, 'captain_list_webhook_deliveries', { endpoint_id: 'whe_1', limit: 10, cursor: 'abc' });
  await call(map, 'captain_list_webhook_delivery_attempts', { endpoint_id: 'whe_1', message_id: 'evt_j1' });
  await call(map, 'captain_resend_webhook_delivery', { endpoint_id: 'whe_1', message_id: 'msg_1' });
  await call(map, 'captain_recover_webhook_endpoint', { endpoint_id: 'whe_1', since: '2026-09-22T00:00:00Z' });
  const got = seen.map((s) => `${s.method} ${new URL(s.url).pathname}${new URL(s.url).search}`);
  assert.deepEqual(got, [
    'GET /v2/webhooks/event-types',
    'GET /v2/webhooks/endpoints',
    'GET /v2/webhooks/endpoints/whe_1',
    'DELETE /v2/webhooks/endpoints/whe_1',
    'POST /v2/webhooks/endpoints/whe_1/rotate-secret',
    'POST /v2/webhooks/endpoints/whe_1/test',
    'GET /v2/webhooks/endpoints/whe_1/deliveries?limit=10&cursor=abc',
    'GET /v2/webhooks/endpoints/whe_1/deliveries/evt_j1/attempts',
    'POST /v2/webhooks/endpoints/whe_1/deliveries/msg_1/resend',
    'POST /v2/webhooks/endpoints/whe_1/recover',
  ]);
  assert.deepEqual(seen[5].body, { event_type: 'job.failed' });
  assert.deepEqual(seen[9].body, { since: '2026-09-22T00:00:00Z' });
});

test('an OAuth connection reaches the same routes under /mcp-app with the environment', async (t) => {
  const map = handlers();
  const seen = mockFetch(t, {});
  await runWithConfig({ apiKey: 'tok', mode: 'oauth', environment: 'production' },
    () => map.get('captain_list_webhook_endpoints').handler({}));
  const u = new URL(seen[0].url);
  assert.equal(u.pathname, '/mcp-app/v2/webhooks/endpoints');
  assert.equal(u.searchParams.get('environment'), 'production');
});
