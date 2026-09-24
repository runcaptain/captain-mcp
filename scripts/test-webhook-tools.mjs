import assert from 'node:assert/strict';
import test from 'node:test';
import { registerWebhookTools, WEBHOOK_TOOL_NAMES, SETUP_ACTIONS, EVENTS_ACTIONS } from '../dist/webhookTools.js';
import { buildServer, TOOL_COUNT, VERSION } from '../dist/server.js';
import { runWithConfig } from '../dist/captainClient.js';
import { readFileSync } from 'node:fs';

const SETUP = 'captain_webhook_setup';
const EVENTS = 'captain_webhook_events';

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
const recentSince = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const route = (s) => `${s.method} ${new URL(s.url).pathname}${new URL(s.url).search}`;

test('registers exactly two webhook tools, with the documented actions', () => {
  const map = handlers();
  assert.deepEqual([...map.keys()], [SETUP, EVENTS]);
  assert.deepEqual([...WEBHOOK_TOOL_NAMES], [SETUP, EVENTS]);
  assert.deepEqual([...SETUP_ACTIONS], ['create', 'list', 'get', 'update', 'delete', 'rotate_secret', 'test']);
  assert.deepEqual([...EVENTS_ACTIONS], ['event_types', 'deliveries', 'attempts', 'resend', 'recover']);
  assert.deepEqual(map.get(SETUP).definition.inputSchema.action.options, [...SETUP_ACTIONS]);
  assert.deepEqual(map.get(EVENTS).definition.inputSchema.action.options, [...EVENTS_ACTIONS]);
});

test('descriptions name the five events, the write scope, the once-only secret and the polling hint', () => {
  const map = handlers();
  for (const name of [SETUP, EVENTS]) {
    const d = map.get(name).definition.description;
    for (const e of ['job.completed', 'job.completed_with_errors', 'job.failed', 'job.timed_out', 'job.cancelled']) {
      assert.ok(d.includes(e), `${name} names ${e}`);
    }
    assert.match(d, /captain:write/);
    assert.match(d, /To stop polling GET \/v2\/jobs\/\{id\}, create an endpoint with captain_webhook_setup/);
  }
  const setup = map.get(SETUP).definition.description;
  assert.match(setup, /ONLY in this response/);
  assert.match(setup, /24 hours/);
  assert.match(map.get(EVENTS).definition.description, /7 days/);
});

test('no action reads a secret back', () => {
  for (const a of [...SETUP_ACTIONS, ...EVENTS_ACTIONS]) assert.doesNotMatch(a, /reveal|get_secret|read_secret/);
});

test('TOOL_COUNT matches the registry, and the versions agree', () => {
  const server = buildServer();
  assert.equal(Object.keys(server._registeredTools ?? {}).length, TOOL_COUNT);
  assert.equal(TOOL_COUNT, 74);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.equal(VERSION, '0.9.0');
});

test('captain_webhook_setup: every action sends the right method, path and body', async (t) => {
  const map = handlers();
  const seen = mockFetch(t, { endpoint_id: 'whe_1', secret: 'whsec_x' });
  const created = await call(map, SETUP, {
    action: 'create', url: 'https://example.com/hooks', event_types: ['job.failed'], sources: ['sync'],
  });
  await call(map, SETUP, { action: 'list' });
  await call(map, SETUP, { action: 'get', endpoint_id: 'whe_1' });
  await call(map, SETUP, { action: 'update', endpoint_id: 'whe_1', disabled: false, collection_ids: [] });
  await call(map, SETUP, { action: 'delete', endpoint_id: 'whe_1' });
  const rotated = await call(map, SETUP, { action: 'rotate_secret', endpoint_id: 'whe_1' });
  await call(map, SETUP, { action: 'test', endpoint_id: 'whe_1', event_type: 'job.failed' });
  await call(map, SETUP, { action: 'test', endpoint_id: 'whe/2' });
  assert.deepEqual(seen.map(route), [
    'POST /v2/webhooks/endpoints',
    'GET /v2/webhooks/endpoints',
    'GET /v2/webhooks/endpoints/whe_1',
    'PATCH /v2/webhooks/endpoints/whe_1',
    'DELETE /v2/webhooks/endpoints/whe_1',
    'POST /v2/webhooks/endpoints/whe_1/rotate-secret',
    'POST /v2/webhooks/endpoints/whe_1/test',
    'POST /v2/webhooks/endpoints/whe%2F2/test',
  ]);
  assert.deepEqual(seen.map((s) => s.body), [
    { url: 'https://example.com/hooks', event_types: ['job.failed'], sources: ['sync'] },
    undefined,
    undefined,
    { collection_ids: [], disabled: false },
    undefined,
    undefined,
    { event_type: 'job.failed' },
    {},
  ]);
  assert.match(text(created), /shown only once/);
  assert.match(text(created), /whsec_x/);
  assert.match(text(rotated), /shown only once/);
  assert.match(text(rotated), /24 hours/);
});

test('captain_webhook_events: every action sends the right method, path and body', async (t) => {
  const map = handlers();
  const seen = mockFetch(t, {});
  await call(map, EVENTS, { action: 'event_types' });
  await call(map, EVENTS, { action: 'deliveries', endpoint_id: 'whe_1' });
  await call(map, EVENTS, { action: 'deliveries', endpoint_id: 'whe_1', limit: 10, cursor: 'abc' });
  await call(map, EVENTS, { action: 'attempts', endpoint_id: 'whe_1', message_id: 'evt_j1' });
  await call(map, EVENTS, { action: 'attempts', endpoint_id: 'whe_1', message_id: 'evt_j1', limit: 5, cursor: 'c2' });
  await call(map, EVENTS, { action: 'resend', endpoint_id: 'whe_1', message_id: 'msg_1' });
  const since = recentSince();
  await call(map, EVENTS, { action: 'recover', endpoint_id: 'whe_1', since });
  assert.deepEqual(seen.map(route), [
    'GET /v2/webhooks/event-types',
    'GET /v2/webhooks/endpoints/whe_1/deliveries',
    'GET /v2/webhooks/endpoints/whe_1/deliveries?limit=10&cursor=abc',
    'GET /v2/webhooks/endpoints/whe_1/deliveries/evt_j1/attempts',
    'GET /v2/webhooks/endpoints/whe_1/deliveries/evt_j1/attempts?limit=5&cursor=c2',
    'POST /v2/webhooks/endpoints/whe_1/deliveries/msg_1/resend',
    'POST /v2/webhooks/endpoints/whe_1/recover',
  ]);
  assert.deepEqual(seen.map((s) => s.body), [undefined, undefined, undefined, undefined, undefined, undefined,
    { since }]);
});

test('captain_webhook_setup: each action validates its own arguments before any request', async (t) => {
  const map = handlers();
  const seen = mockFetch(t, {});
  const cases = [
    [{ action: 'create' }, /action "create": url is required/],
    [{ action: 'create', url: 'not a url' }, /action "create": url: Invalid url/],
    [{ action: 'create', url: 'http://example.com/hooks' }, /url must start with https:\/\//],
    [{ action: 'create', url: 'https://x.test', endpoint_id: 'whe_1' }, /endpoint_id not used by this action/],
    [{ action: 'get' }, /action "get": endpoint_id is required\. This action takes: endpoint_id\./],
    [{ action: 'update' }, /action "update": endpoint_id is required/],
    [{ action: 'update', endpoint_id: 'whe_1' }, /action "update": pass at least one field to change/],
    [{ action: 'delete' }, /action "delete": endpoint_id is required/],
    [{ action: 'rotate_secret' }, /action "rotate_secret": endpoint_id is required/],
    [{ action: 'test' }, /action "test": endpoint_id is required/],
    [{ action: 'test', endpoint_id: 'whe_1', event_type: 'job.started' }, /action "test": event_type:/],
    [{ action: 'list', endpoint_id: 'whe_1' }, /action "list": endpoint_id not used by this action\. This action takes: no other arguments\./],
    [{ action: 'reveal_secret', endpoint_id: 'whe_1' }, /action must be one of create, list, get, update, delete, rotate_secret, test/],
    [{}, /action must be one of/],
  ];
  for (const [args, pattern] of cases) {
    await assert.rejects(call(map, SETUP, args), pattern, JSON.stringify(args));
  }
  assert.equal(seen.length, 0, 'no request is sent for invalid arguments');
});

test('captain_webhook_events: each action validates its own arguments before any request', async (t) => {
  const map = handlers();
  const seen = mockFetch(t, {});
  const cases = [
    [{ action: 'deliveries' }, /action "deliveries": endpoint_id is required/],
    [{ action: 'deliveries', endpoint_id: 'whe_1', limit: 500 }, /action "deliveries": limit:/],
    [{ action: 'deliveries', endpoint_id: 'whe_1', since: '2026-09-22T00:00:00Z' }, /since not used by this action/],
    [{ action: 'attempts', endpoint_id: 'whe_1' }, /action "attempts": message_id is required/],
    [{ action: 'resend', endpoint_id: 'whe_1' }, /action "resend": message_id is required/],
    [{ action: 'resend', message_id: 'msg_1' }, /action "resend": endpoint_id is required/],
    [{ action: 'recover', endpoint_id: 'whe_1' }, /action "recover": since is required/],
    [{ action: 'recover', endpoint_id: 'whe_1', since: 'yesterday' }, /since must be an ISO 8601 time/],
    [{ action: 'recover', endpoint_id: 'whe_1', since: new Date(Date.now() + 3600e3).toISOString() }, /within the last 7 days/],
    [{ action: 'recover', endpoint_id: 'whe_1', since: new Date(Date.now() - 8 * 86400e3).toISOString() }, /within the last 7 days/],
    [{ action: 'event_types', endpoint_id: 'whe_1' }, /endpoint_id not used by this action/],
    [{ action: 'redeliver' }, /action must be one of event_types, deliveries, attempts, resend, recover/],
  ];
  for (const [args, pattern] of cases) {
    await assert.rejects(call(map, EVENTS, args), pattern, JSON.stringify(args));
  }
  assert.equal(seen.length, 0, 'no request is sent for invalid arguments');
});

test('null arguments count as not given', async (t) => {
  const map = handlers();
  const seen = mockFetch(t, {});
  await call(map, SETUP, { action: 'list', endpoint_id: null });
  await call(map, EVENTS, { action: 'deliveries', endpoint_id: 'whe_1', cursor: null, limit: undefined });
  assert.deepEqual(seen.map(route), ['GET /v2/webhooks/endpoints', 'GET /v2/webhooks/endpoints/whe_1/deliveries']);
});

test('an OAuth connection reaches the same routes under /mcp-app with the environment', async (t) => {
  const map = handlers();
  const seen = mockFetch(t, {});
  await runWithConfig({ apiKey: 'tok', mode: 'oauth', environment: 'production' },
    () => map.get(SETUP).handler({ action: 'list' }));
  const u = new URL(seen[0].url);
  assert.equal(u.pathname, '/mcp-app/v2/webhooks/endpoints');
  assert.equal(u.searchParams.get('environment'), 'production');
});

test('webhook tools take no environment argument; other tools still do', async () => {
  const tools = buildServer()._registeredTools;
  for (const name of [SETUP, EVENTS]) {
    const schema = tools[name].inputSchema;
    const shape = schema?.shape ?? schema ?? {};
    assert.equal('environment' in shape, false, `${name} must not take environment`);
    // Passing one anyway is not silently used: the SDK strips it and the action ignores it.
    const parsed = schema.safeParse({ action: name === SETUP ? 'list' : 'event_types', environment: 'production' });
    assert.equal(parsed.success, true);
    assert.equal('environment' in parsed.data, false);
  }
  const jobs = tools['captain_list_jobs'].inputSchema;
  assert.ok('environment' in (jobs?.shape ?? jobs), 'non-webhook tools keep the environment argument');
});

test('the advertised input schema lists every argument (a flat object, not an empty union)', () => {
  const tools = buildServer()._registeredTools;
  assert.deepEqual(Object.keys(tools[SETUP].inputSchema.shape).sort(), [
    'action', 'collection_ids', 'description', 'disabled', 'endpoint_id', 'event_type', 'event_types',
    'include_collection_name', 'sources', 'sync_ids', 'url',
  ]);
  assert.deepEqual(Object.keys(tools[EVENTS].inputSchema.shape).sort(), [
    'action', 'cursor', 'endpoint_id', 'limit', 'message_id', 'since',
  ]);
});

test('creating an endpoint never logs the receiver URL', async (t) => {
  const map = handlers();
  mockFetch(t, { endpoint_id: 'whe_1', secret: 'whsec_x' });
  const written = [];
  t.mock.method(process.stderr, 'write', (chunk) => { written.push(String(chunk)); return true; });
  await call(map, SETUP, { action: 'create', url: 'https://example.com/hooks?token=receiver-secret' });
  assert.ok(written.length > 0, 'the create is logged');
  assert.ok(written.every((line) => !line.includes('receiver-secret') && !line.includes('example.com')));
});
