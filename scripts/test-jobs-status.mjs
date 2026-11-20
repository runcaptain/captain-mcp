import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { registerJobTools } from '../dist/jobTools.js';
import { captainFetch, runWithConfig } from '../dist/captainClient.js';

function handlers() {
  const map = new Map();
  registerJobTools({ registerTool: (name, definition, handler) => map.set(name, { definition, handler }) });
  return map;
}
const call = (name, args) => runWithConfig({ apiKey: 'synthetic' }, () => handlers().get(name).handler(args));

const JOBS = {
  job_done: { status: 'completed', collection_name: 'docs', progress: { files_total: 4, files_processed: 4 } },
  job_run: { status: 'running', collection_name: 'docs', progress: { files_total: 10, files_processed: 3, files_failed: 1, current_stage: 'embedding' } },
  job_bad: { status: 'failed', collection_name: 'docs', error_code: 'parse_error', error_message: 'File is encrypted' },
};

test('job_ids takes 1 to 100 ids', () => {
  const schema = z.object(handlers().get('captain_jobs_status').definition.inputSchema);
  assert.ok(schema.safeParse({ job_ids: ['a'] }).success);
  assert.equal(schema.safeParse({ job_ids: [] }).success, false);
  assert.equal(schema.safeParse({ job_ids: Array(101).fill('a') }).success, false);
});

test('one call reads every job, with a count per status and the jobs not final yet', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(String(url));
    seen.push(u.pathname);
    assert.equal(u.searchParams.get('files_limit'), '1');
    const job = JOBS[u.pathname.split('/').pop()];
    return job ? new Response(JSON.stringify(job), { status: 200 }) : new Response('Job not found', { status: 404 });
  });
  const result = await call('captain_jobs_status', { job_ids: ['job_done', 'job_run', 'job_bad', 'job_gone', 'job_done'] });
  const text = result.content[0].text;
  assert.equal(seen.length, 4, 'a repeated id is read once');
  assert.match(text, /^4 jobs: 1 completed, 1 running, 1 failed, 1 error$/m);
  assert.match(text, /^Not final yet \(1\): job_run$/m);
  assert.match(text, /^- job_run \[running\] → docs 3\/10 files \(1 failed\), stage embedding$/m);
  assert.match(text, /^- job_bad \[failed\] → docs — parse_error: File is encrypted$/m);
  assert.match(text, /^- job_gone \[error\] Captain API error \(404\): Job not found$/m);
});

test('reads at most 5 jobs at a time', async (t) => {
  let inFlight = 0;
  let peak = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return new Response(JSON.stringify({ status: 'completed' }), { status: 200 });
  });
  const ids = Array.from({ length: 20 }, (_, i) => `job_${i}`);
  const text = (await call('captain_jobs_status', { job_ids: ids })).content[0].text;
  assert.equal(peak, 5);
  assert.match(text, /^20 jobs: 20 completed$/m);
  assert.match(text, /^All readable jobs are final\.$/m);
});

test('captainFetch fails with a clear error when the API does not answer in time', async (t) => {
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  });
  await assert.rejects(
    captainFetch({ apiKey: 'synthetic' }, 'jobs/job_1?files_limit=1', { timeoutMs: 20 }),
    { message: 'Captain API request timed out after 0.02s: GET /v2/jobs/job_1' },
  );
});

test('every captainFetch call has a timeout signal by default', async (t) => {
  let signal;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    signal = options.signal;
    return new Response('{}', { status: 200 });
  });
  await captainFetch({ apiKey: 'synthetic' }, 'collections');
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});
