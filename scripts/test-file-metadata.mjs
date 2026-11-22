import { test } from "node:test";
import assert from "node:assert/strict";
import { fileMetadataField, fileMetadataFormValue } from "../dist/tools.js";

test("file_metadata is optional and takes one object or null per file", () => {
  assert.equal(fileMetadataField.parse(undefined), undefined);
  const value = [{ type: "invoice" }, null, { type: "invoice", year: 2025, urgent: true, tags: ["a", "b"] }, {}];
  assert.deepEqual(fileMetadataField.parse(value), value);
});

test("file_metadata refuses a map keyed by filename and entries that are not objects", () => {
  assert.throws(() => fileMetadataField.parse({ "invoice.pdf": { type: "invoice" } }));
  assert.throws(() => fileMetadataField.parse(["invoice"]));
  assert.throws(() => fileMetadataField.parse([{ nested: { a: 1 } }]));
  assert.throws(() => fileMetadataField.parse([{ tags: [1, 2] }]));
});

test("the multipart value is the array as JSON, in the order given", () => {
  const value = [{ type: "invoice" }, null, { type: "invoice", year: 2025 }];
  assert.deepEqual(JSON.parse(fileMetadataFormValue(value, 3)), value);
});

test("no file_metadata sends no form field", () => {
  assert.equal(fileMetadataFormValue(undefined, 3), undefined);
});

test("a list that does not have one entry per file is refused with the counts", () => {
  assert.throws(() => fileMetadataFormValue([{ a: 1 }, { a: 2 }], 3), /has 2 entries but 3 files are being uploaded/);
  assert.throws(() => fileMetadataFormValue([{ a: 1 }, { a: 2 }], 1), /has 2 entries but 1 file is being uploaded/);
  assert.throws(() => fileMetadataFormValue([], 2), /has 0 entries but 2 files/);
});

// ── through the registered tool: what is actually uploaded ─────────────────
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCaptainTools } from "../dist/tools.js";
import { runWithConfig } from "../dist/captainClient.js";

function handlers() {
  const map = new Map();
  registerCaptainTools({ registerTool: (name, definition, handler) => map.set(name, { definition, handler }) });
  return map;
}
const callTool = (args) => runWithConfig({ apiKey: "synthetic" }, () => handlers().get("captain_index_file").handler(args));
const b64 = (text) => Buffer.from(text).toString("base64");

// Serves the one URL the tool fetches and captures the multipart upload.
function captureUpload(t) {
  const uploads = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options || !options.method || options.method === "GET") {
      return new Response("from the url", { status: 200 });
    }
    const form = options.body;
    const files = [];
    for (const f of form.getAll("files")) files.push({ name: f.name, text: await f.text() });
    uploads.push({ url: String(url), files, fileMetadata: form.get("file_metadata"), customMetadata: form.get("custom_metadata") });
    return new Response(JSON.stringify({ job_id: "job_1", status: "pending" }), { status: 200 });
  });
  return uploads;
}

test("captain_index_file uploads file_metadata beside the files, in upload order across all three sources", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pfm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const local = join(dir, "local.txt");
  await writeFile(local, "from the path");
  const uploads = captureUpload(t);
  // Given paths first on purpose: the upload order is files, then urls, then paths.
  const metadata = [{ source: "inline-1" }, null, { source: "url" }, { source: "path", year: 2025 }];
  await callTool({
    collection: "docs",
    paths: local,
    urls: ["https://files.example/remote.txt"],
    files: [{ name: "a.txt", content_base64: b64("inline one") }, { name: "a.txt", content_base64: b64("inline two") }],
    custom_metadata: { batch: "q3" },
    file_metadata: metadata,
  });
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].url, /\/collections\/docs\/index\/file$/);
  assert.deepEqual(uploads[0].files, [
    { name: "a.txt", text: "inline one" },
    { name: "a.txt", text: "inline two" },   // same name as the first: position is the pairing
    { name: "remote.txt", text: "from the url" },
    { name: "local.txt", text: "from the path" },
  ]);
  assert.deepEqual(JSON.parse(uploads[0].fileMetadata), metadata);
  assert.deepEqual(JSON.parse(uploads[0].customMetadata), { batch: "q3" });
});

test("captain_index_file sends no file_metadata field when none is given", async (t) => {
  const uploads = captureUpload(t);
  await callTool({ collection: "docs", files: [{ name: "a.txt", content_base64: b64("inline one") }], custom_metadata: { batch: "q3" } });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].fileMetadata, null);
});

test("captain_index_file refuses a mismatched file_metadata before any upload", async (t) => {
  const uploads = captureUpload(t);
  await assert.rejects(
    () => callTool({
      collection: "docs",
      files: [{ name: "a.txt", content_base64: b64("one") }, { name: "b.txt", content_base64: b64("two") }],
      file_metadata: [{ only: "one" }],
    }),
    /file_metadata has 1 entry but 2 files are being uploaded/,
  );
  assert.equal(uploads.length, 0);
});
