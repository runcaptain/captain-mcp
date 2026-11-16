import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { registerChunkTools, buildQueryAllV3Body, buildQueryV3Body, ALL_QUERY_MAX_WINDOW } from '../dist/chunkTools.js';
import { TOOL_COUNT } from '../dist/server.js';

const TOOL = 'captain_search_v3_all';

function tools() {
  const map = new Map();
  registerChunkTools({ registerTool: (name, definition, handler) => map.set(name, { definition, handler }) });
  return map;
}

test('the body is a single v3 query body plus only the window fields the caller set', () => {
  const cfg = { limit: 5, include_regions: true, semantic_ratio: 0.3 };
  assert.deepEqual(buildQueryAllV3Body('renewal terms', cfg), buildQueryV3Body('renewal terms', cfg));
  const body = buildQueryAllV3Body('renewal terms', {
    ...cfg, exclude_collections: ['archive'], collection_cursor: 'eyJ2IjoxfQ', collection_window: 200,
  });
  assert.deepEqual(body, {
    ...buildQueryV3Body('renewal terms', cfg),
    exclude_collections: ['archive'], collection_cursor: 'eyJ2IjoxfQ', collection_window: 200,
  });
  // rerank is left to the server's query-all default (on) unless set.
  assert.equal('rerank' in body, false);
});

test('the tool is registered with the window fields and their bounds', () => {
  const tool = tools().get(TOOL);
  assert.ok(tool, `${TOOL} is registered`);
  const schema = z.object(tool.definition.inputSchema);
  assert.ok(schema.safeParse({ query: 'q', collection_cursor: 'abc', collection_window: ALL_QUERY_MAX_WINDOW }).success);
  assert.equal(schema.safeParse({ query: 'q', collection_window: 0 }).success, false);
  assert.equal(schema.safeParse({ query: 'q', collection_window: ALL_QUERY_MAX_WINDOW + 1 }).success, false);
  assert.equal(schema.safeParse({ query: 'q', collection_cursor: '' }).success, false);
  assert.match(tool.definition.description, /next_collection_cursor/);
});

test('the tool count includes the new tool', () => {
  assert.equal(TOOL_COUNT, 81);
});
