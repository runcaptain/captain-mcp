import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  registerChunkTools, buildMultiQueryV3Body, buildQueryV3Body, formatMultiQueryResult, entriesMissingQuery, MULTI_QUERY_MAX_COLLECTIONS,
} from '../dist/chunkTools.js';
import { runWithConfig } from '../dist/captainClient.js';

const TOOL = 'captain_search_v3_multi';

function tools() {
  const map = new Map();
  registerChunkTools({ registerTool: (name, definition, handler) => map.set(name, { definition, handler }) });
  return map;
}

test('top-level query only: entries carry no query and get the single-query limit default', () => {
  const body = buildMultiQueryV3Body('refund policy', [{ collection: 'a' }, { collection: 'b' }]);
  assert.deepEqual(body, {
    query: 'refund policy',
    collections: [{ collection: 'a', limit: 10 }, { collection: 'b', limit: 10 }],
  });
});

test('per-entry query overrides; an omitted entry query is not sent', () => {
  const body = buildMultiQueryV3Body('shared', [{ collection: 'a', query: 'own' }, { collection: 'b' }]);
  assert.equal(body.collections[0].query, 'own');
  assert.equal('query' in body.collections[1], false);
  const noTop = buildMultiQueryV3Body(undefined, [{ collection: 'a', query: 'own' }]);
  assert.equal('query' in noTop, false);
});

test('each entry is built exactly like captain_search_v3, include flags per entry', () => {
  const cfgA = { limit: 3, semantic_ratio: 0.2, include_regions: true, include_document: false, rerank: { candidate_limit: 50 } };
  const cfgB = { include_related_chunks: true, relation_direction: 'both', filter: { year: { $gte: 2024 } } };
  const body = buildMultiQueryV3Body('q', [{ collection: 'a', ...cfgA }, { collection: 'b', query: 'qb', ...cfgB }]);
  const { query: _a, ...singleA } = buildQueryV3Body('q', cfgA);
  assert.deepEqual(body.collections[0], { collection: 'a', ...singleA });
  assert.deepEqual(body.collections[0].include, { regions: true, document: false });
  assert.deepEqual(body.collections[1], { collection: 'b', ...buildQueryV3Body('qb', cfgB) });
  assert.deepEqual(body.collections[1].include, { related_chunks: true });
});

test('input schema accepts 1 to 10 entries and rejects 0 or 11', () => {
  const schema = z.object(tools().get(TOOL).definition.inputSchema);
  const entries = (n) => Array.from({ length: n }, (_, i) => ({ collection: `c${i}` }));
  assert.equal(MULTI_QUERY_MAX_COLLECTIONS, 10);
  assert.equal(schema.safeParse({ query: 'q', collections: entries(10) }).success, true);
  assert.equal(schema.safeParse({ query: 'q', collections: entries(11) }).success, false);
  assert.equal(schema.safeParse({ query: 'q', collections: [] }).success, false);
  assert.equal(schema.safeParse({ query: 'q', collections: [{ collection: 'a', limit: 5, include_regions: true }] }).success, true);
});

test('description has no em dashes and names the limits and fallback', () => {
  const d = tools().get(TOOL).definition.description;
  assert.doesNotMatch(d, /—/);
  assert.match(d, /1 to 10/);
  assert.match(d, /top-level/);
  assert.match(d, /not comparable/);
});

test('handler POSTs /v3/collections/batch-query and renders each slot under its index and collection', async (t) => {
  const response = {
    request_id: 'req_1',
    execution_time_ms: 42,
    results: [
      { collection: 'policies', status: 'succeeded', query_id: 'q1', results: [{ chunk_id: 'd:0', score: 0.9 }] },
      { collection: 'missing', status: 'failed', error: { status_code: 404, message: 'Collection not found', detail: null, retry_after_seconds: null } },
    ],
  };
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: new URL(String(url)), method: options.method, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(response), { status: 200 });
  });
  const result = await runWithConfig({ apiKey: 'synthetic' }, () =>
    tools().get(TOOL).handler({ query: 'refunds', collections: [{ collection: 'policies' }, { collection: 'missing', limit: 3 }] }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url.pathname, '/v3/collections/batch-query');
  assert.deepEqual(seen[0].body, {
    query: 'refunds',
    collections: [{ collection: 'policies', limit: 10 }, { collection: 'missing', limit: 3 }],
  });
  const text = result.content[0].text;
  assert.match(text, /^1 succeeded, 1 failed, 0 unknown of 2 collection\(s\)/);
  assert.match(text, /not merged/);
  assert.match(text, /## \[0\] policies: succeeded/);
  assert.match(text, /## \[1\] missing: failed \(404\) Collection not found/);
  assert.match(text, /"query_id": "q1"/);
});

test('oauth mode routes through /mcp-app/v3/collections/batch-query with the environment', async (t) => {
  let seenUrl;
  t.mock.method(globalThis, 'fetch', async (url) => {
    seenUrl = new URL(String(url));
    return new Response(JSON.stringify({ results: [], request_id: 'r', execution_time_ms: 1 }), { status: 200 });
  });
  await runWithConfig({ apiKey: 'tok', mode: 'oauth', environment: 'staging' }, () =>
    tools().get(TOOL).handler({ query: 'q', collections: [{ collection: 'a' }] }));
  assert.equal(seenUrl.pathname, '/mcp-app/v3/collections/batch-query');
  assert.equal(seenUrl.searchParams.get('environment'), 'staging');
});

test('formatter reports a slot with no status as unknown, not failed', () => {
  const text = formatMultiQueryResult({ results: [{ collection: 'x' }], request_id: 'r', execution_time_ms: 1 }, 1).content[0].text;
  assert.match(text, /^0 succeeded, 0 failed, 1 unknown of 1/);
  assert.match(text, /## \[0\] x: unknown/);
});

test('formatter flags a response with fewer results than requested entries', () => {
  const text = formatMultiQueryResult({ request_id: 'r', execution_time_ms: 1 }, 2).content[0].text;
  assert.match(text, /^WARNING: requested 2 collection\(s\) but the response has 0 result\(s\)/);
});

test('an entry with no query and no top-level query is refused before any request', async (t) => {
  assert.deepEqual(entriesMissingQuery(undefined, [{ collection: 'a', query: 'x' }, { collection: 'b' }]), [1]);
  assert.deepEqual(entriesMissingQuery('top', [{ collection: 'a' }]), []);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  await assert.rejects(
    runWithConfig({ apiKey: 'synthetic' }, () =>
      tools().get(TOOL).handler({ collections: [{ collection: 'a', query: 'x' }, { collection: 'b' }] })),
    /collections\[1\] have no query/,
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});
