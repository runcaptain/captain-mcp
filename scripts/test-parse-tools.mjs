import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerParseTools, PARSE_TOOL_NAMES, summarizeJob } from '../dist/parseTools.js';
import { runWithConfig } from '../dist/captainClient.js';

function handlers() {
  const map = new Map();
  registerParseTools({ registerTool: (name, definition, handler) => map.set(name, { definition, handler }) });
  return map;
}
const call = (map, name, args) => runWithConfig({ apiKey: 'synthetic' }, () => map.get(name).handler(args));
const parse = (r) => JSON.parse(r.content[0].text);

test('registers the five Parse API tools', () => {
  assert.deepEqual([...handlers().keys()], [...PARSE_TOOL_NAMES]);
});

test('parse_document passes an https input through as JSON to /v3/parse/documents', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
    return new Response(JSON.stringify({ job_id: 'prs_1', type: 'document', status: 'queued', status_url: '/v3/parse/jobs/prs_1', created_at: '2026-09-30T00:00:00Z' }), { status: 202 });
  });
  const out = parse(await call(handlers(), 'captain_parse_document', {
    input: 'https://files.example.com/r.pdf', processing_type: 'advanced', mask_pii: true, pii_engine: 'kev', idempotency_key: 'k1',
  }));
  assert.equal(out.job_id, 'prs_1');
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/v3\/parse\/documents$/);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers['Idempotency-Key'], 'k1');
  assert.deepEqual(JSON.parse(seen[0].body), { input: 'https://files.example.com/r.pdf', processing_type: 'advanced', mask_pii: true, pii_engine: 'kev' });
});

test('parse_spreadsheet uploads a local path first and parses its captain:// id', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'parse-'));
  const file = join(dir, 'book.csv');
  writeFileSync(file, 'a,b\n1,2\n');
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: String(url), options });
    if (String(url).endsWith('/v3/parse/uploads')) {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('file').name, 'book.csv');
      return new Response(JSON.stringify({ file_id: 'captain://upl_abc', expires_at: '2026-10-01T00:00:00Z' }), { status: 200 });
    }
    return new Response(JSON.stringify({ job_id: 'prs_2', status: 'queued' }), { status: 202 });
  });
  await call(handlers(), 'captain_parse_spreadsheet', { path: file, include_verified_facts: true });
  assert.equal(seen.length, 2);
  assert.match(seen[1].url, /\/v3\/parse\/spreadsheets$/);
  assert.deepEqual(JSON.parse(seen[1].options.body), { input: 'captain://upl_abc', include_verified_facts: true });
});

test('exactly one source, and no images with masking', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  const map = handlers();
  await assert.rejects(call(map, 'captain_parse_document', {}), /exactly one of/);
  await assert.rejects(call(map, 'captain_parse_document', { input: 'https://x/y.pdf', path: '/tmp/y.pdf' }), /exactly one of/);
  await assert.rejects(call(map, 'captain_parse_document', { content_base64: 'aGk=' }), /name/);
  await assert.rejects(call(map, 'captain_parse_spreadsheet', { input: 'https://x/y.xlsx', include_images: true, mask_pii: true }), /include_images/);
});

test('get_parse_job waits until terminal and trims chunks for the reply', async (t) => {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(String(url), /\/v3\/parse\/jobs\/prs_3$/);
    n++;
    const done = n >= 2;
    return new Response(JSON.stringify({
      job_id: 'prs_3', status: done ? 'completed' : 'processing',
      chunks: done ? Array.from({ length: 5 }, (_, i) => ({ chunk_id: `c${i}` })) : null,
      result_url: done ? 'https://s3.example/r.json' : null,
    }), { status: 200 });
  });
  const out = parse(await call(handlers(), 'captain_get_parse_job', { job_id: 'prs_3', wait_seconds: 10, max_chunks: 2 }));
  assert.equal(out.status, 'completed');
  assert.equal(out.chunks.length, 2);
  assert.deepEqual(out.chunks_truncated, { shown: 2, total: 5, full_result: 'result_url' });
  assert.equal(n, 2);
});

test('cancel_parse_job sends DELETE', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: String(url), method: options.method });
    return new Response(JSON.stringify({ job_id: 'prs_4', status: 'cancelled' }), { status: 200 });
  });
  const out = parse(await call(handlers(), 'captain_cancel_parse_job', { job_id: 'prs_4' }));
  assert.equal(out.status, 'cancelled');
  assert.equal(seen[0].method, 'DELETE');
  assert.match(seen[0].url, /\/v3\/parse\/jobs\/prs_4$/);
});

test('summarizeJob leaves small results alone', () => {
  const job = { chunks: [{}, {}] };
  assert.equal(summarizeJob(job, 5), job);
});
