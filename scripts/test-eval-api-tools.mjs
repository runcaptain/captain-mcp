import assert from 'node:assert/strict';
import test from 'node:test';
import { registerEvalApiTools, buildEvalConfig, toNdjson, deriveIdempotencyKey } from '../dist/evalApiTools.js';
import { runWithConfig } from '../dist/captainClient.js';

function handlers() {
  const map = new Map();
  registerEvalApiTools({ registerTool: (name, definition, handler) => map.set(name, { definition, handler }) });
  return map;
}
const call = (map, name, args) => runWithConfig({ apiKey: 'synthetic' }, () => map.get(name).handler(args));
const parse = (r) => JSON.parse(r.content[0].text);

test('registers the Evaluation API tools with their titles', () => {
  const map = handlers();
  assert.deepEqual(
    [...map.keys()],
    ['captain_create_eval_upload', 'captain_run_eval', 'captain_list_evals', 'captain_get_eval_results'],
    'the four steps of the Evaluation API: upload, queue, find, read',
  );
  assert.equal(map.get('captain_run_eval').definition.title, 'Run Evaluation');
  assert.equal(map.get('captain_list_evals').definition.title, 'List Evaluations');
});

test('buildEvalConfig is the v3 query body minus query, plus name; include_* fold into include', () => {
  const cfg = buildEvalConfig({ name: 'deep', limit: 5, rerank: { enabled: true, candidate_limit: 40 }, include_relations: true });
  assert.deepEqual(cfg, { name: 'deep', limit: 5, rerank: { enabled: true, candidate_limit: 40 }, include: { relations: true } });
  assert.deepEqual(buildEvalConfig({ name: 'baseline' }), { name: 'baseline' }, 'an omitted limit stays omitted: the API records sent fields as caller-explicit');
});

test('create_eval_upload serialises NDJSON, mints with the exact byte size, PUTs with the exact length', async (t) => {
  const map = handlers();
  const cases = [{ id: 'a', query: 'q1', expected_files: ['form.pdf'] }, { query: 'q2', expected_files: ['docB'], filters: { k: 'v' } }];
  const body = toNdjson(cases);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
    if (String(url).endsWith('/v3/collections/my%20col/evals/uploads')) {
      assert.equal(JSON.parse(options.body).byte_size, Buffer.byteLength(body));
      return new Response(JSON.stringify({ upload_id: 'evu_1', upload_url: 'https://uploads.captainusercontent.com/evals/o/evu_1.ndjson?sig=s', expires_at: '2026-09-16T00:15:00Z' }), { status: 200 });
    }
    return new Response('', { status: 200 });
  });
  const out = parse(await call(map, 'captain_create_eval_upload', { collection: 'my col', cases }));
  assert.equal(out.upload_id, 'evu_1');
  assert.equal(out.cases, 2);
  assert.equal(out.byte_size, Buffer.byteLength(body));
  const put = seen[1];
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers['Content-Type'], 'application/x-ndjson');
  assert.equal(put.headers['Content-Length'], String(Buffer.byteLength(body)));
  assert.equal(put.body.toString('utf8'), body);
  assert.equal(put.headers.Authorization, undefined, 'the capability URL carries its own signature; no API key leaves the API host');
});

test('create_eval_upload refuses duplicate ids before spending an upload, and surfaces a failed PUT', async (t) => {
  const map = handlers();
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetched++; return new Response('{}', { status: 200 }); });
  await assert.rejects(call(map, 'captain_create_eval_upload', { collection: 'c', cases: [{ id: 'x', query: 'q', expected_files: ['a'] }, { id: 'x', query: 'q', expected_files: ['a'] }] }), /Duplicate case id 'x'/);
  assert.equal(fetched, 0);
  t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).includes('/evals/uploads')
      ? new Response(JSON.stringify({ upload_id: 'evu_2', upload_url: 'https://uploads.captainusercontent.com/x?sig=s' }), { status: 200 })
      : new Response('{"error":"UPLOAD_LENGTH_MISMATCH"}', { status: 400 }));
  await assert.rejects(call(map, 'captain_create_eval_upload', { collection: 'c', cases: [{ query: 'q', expected_files: ['a'] }] }), /Upload PUT failed \(400\)/);
});

test('run_eval sends Idempotency-Key, unique config names, and returns the key it used', async (t) => {
  const map = handlers();
  let sentKey, sentBody;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(String(url).endsWith('/v3/collections/c/evals'));
    sentKey = options.headers['Idempotency-Key']; sentBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ eval_id: 'eval_1', status: 'pending', preview: { cases: 7, configs: 2, units: 14, cases_error: 1, billable_units: 12 } }), { status: 201 });
  });
  const out = parse(await call(map, 'captain_run_eval', { collection: 'c', upload_id: 'evu_1', configs: [{ name: 'baseline' }, { name: 'rerank', rerank: true }] }));
  assert.equal(out.eval_id, 'eval_1');
  assert.match(out.idempotency_key, /^mcp-[0-9a-f]{32}$/);
  assert.equal(sentKey, out.idempotency_key);
  assert.equal(out.idempotency_key, deriveIdempotencyKey('c', 'evu_1', [{ name: 'baseline' }, { name: 'rerank', rerank: true }]), 'derived from the arguments, so a transport retry replays the same eval');
  assert.notEqual(out.idempotency_key, deriveIdempotencyKey('c', 'evu_2', [{ name: 'baseline' }]));
  assert.deepEqual(sentBody, { upload_id: 'evu_1', configs: [{ name: 'baseline' }, { name: 'rerank', rerank: true }] });
  assert.equal(out.preview.billable_units, 12);
  await assert.rejects(call(map, 'captain_run_eval', { collection: 'c', upload_id: 'evu_1', configs: [{ name: 'a' }, { name: 'a' }] }), /unique/);
  await call(map, 'captain_run_eval', { collection: 'c', upload_id: 'evu_1', configs: [{ name: 'a' }], idempotency_key: 'mine-1' });
  assert.equal(sentKey, 'mine-1');
});

test('get_eval_results compacts items, pages, and fetches bounded answers only for scored units', async (t) => {
  const map = handlers();
  const ev = {
    eval_id: 'eval_1', status: 'completed_with_errors', collection_name: 'c', configs: [{ name: 'baseline' }],
    progress: { percent: 100 }, billing: { billable_units: 1, skipped_units: 1, failed_configs: [] },
    scorecards: { baseline: { recall_at_1: 1.0, mrr: 1.0, scored: 1, failed: 0, error: 1 } },
    items: [
      { id: 'a', status: 'scored', expected_document_ids: ['d1'], results: { baseline: { status: 'scored', hit: true, rank: 1, latency_ms: 120, query_id: 'q-1', retrieved_document_ids: ['d1', 'd2'] } } },
      { id: 'b', status: 'error', error_code: 'GOLD_UNRESOLVED', results: { baseline: { status: 'skipped' } } },
    ],
    items_page: { next_cursor: 'abc', total: 2 },
  };
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    if (String(url).includes('/answers/')) {
      return new Response(JSON.stringify({ query_id: 'q-1', request: { query: 'q1', limit: 10 }, response: { results: [{ document: { id: 'd1', filename: 'form.pdf' }, chunk_id: 'd1:0', score: 0.9, text: 'x'.repeat(500) }], total_results: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify(ev), { status: 200 });
  });
  const out = parse(await call(map, 'captain_get_eval_results', { eval_id: 'eval_1', items_limit: 2, items_cursor: 'zzz', include_answers: true }));
  assert.ok(urls[0].endsWith('/v3/evals/eval_1?items_limit=2&items_cursor=zzz'));
  assert.equal(out.terminal, true);
  assert.equal(out.next_cursor, 'abc');
  assert.deepEqual(out.items[0].results.baseline, { status: 'scored', hit: true, rank: 1, latency_ms: 120, query_id: 'q-1', error_code: null });
  assert.equal(out.items[0].results.baseline.retrieved_document_ids, undefined, 'echo dropped');
  assert.equal(urls.filter((u) => u.includes('/answers/')).length, 1, 'only the scored unit is fetched');
  assert.ok(urls[1].endsWith('/v3/evals/eval_1/answers/a/baseline'));
  assert.equal(out.answers.a.baseline.results[0].document_id, 'd1');
  assert.equal(out.answers.a.baseline.results[0].text.length, 200);
  assert.equal(out.answers_fetched, 1);
  assert.equal(out.answers_truncated, false);
});

test('answers_truncated is true only when eligible answers remained past the cap', async (t) => {
  const map = handlers();
  const mk = (n) => ({ eval_id: 'eval_2', status: 'completed', configs: [{ name: 'b' }], items: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, status: 'scored', results: { b: { status: 'scored', hit: true, rank: 1 } } })) });
  let ev = mk(20);
  t.mock.method(globalThis, 'fetch', async (url) => String(url).includes('/answers/')
    ? new Response(JSON.stringify({ request: {}, response: { results: [] } }), { status: 200 })
    : new Response(JSON.stringify(ev), { status: 200 }));
  let out = parse(await call(map, 'captain_get_eval_results', { eval_id: 'eval_2', include_answers: true }));
  assert.equal(out.answers_fetched, 20); assert.equal(out.answers_truncated, false, 'exactly 20 eligible: complete');
  ev = mk(21);
  out = parse(await call(map, 'captain_get_eval_results', { eval_id: 'eval_2', include_answers: true }));
  assert.equal(out.answers_fetched, 20); assert.equal(out.answers_truncated, true, '21 eligible: one remained');
});
