import assert from 'node:assert/strict';
import test from 'node:test';
import { registerChunkTools } from '../dist/chunkTools.js';
import { runWithConfig } from '../dist/captainClient.js';

test('v3 tool preserves grouped timing and encoded collection path', async (t) => {
  const handlers = new Map();
  registerChunkTools({ registerTool: (name, definition, handler) => handlers.set(name, handler) });
  const response = {
    query_id: 'synthetic-query',
    timing: { total_ms: 90, stages: [
      { name: 'preparation', start_ms: 0, duration_ms: 90, segments: [
        { start_ms: 0, duration_ms: 10 }, { start_ms: 80, duration_ms: 10 },
      ] },
      { name: 'embedding', start_ms: 10, duration_ms: 70 },
    ] },
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(String(url).endsWith('/v3/collections/example%20policies/query'));
    assert.equal(JSON.parse(options.body).query, 'Synthetic policy');
    return new Response(JSON.stringify(response), { status: 200 });
  });
  const result = await runWithConfig({ apiKey: 'synthetic' }, () =>
    handlers.get('captain_search_v3')({ collection: 'example policies', query: 'Synthetic policy' }));
  assert.deepEqual(JSON.parse(result.content[0].text), response);
});
