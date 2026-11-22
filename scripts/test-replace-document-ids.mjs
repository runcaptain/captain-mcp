import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceDocumentIdsField, replaceDocumentIdsFormValue, registerCaptainTools } from "../dist/tools.js";
import { runWithConfig } from "../dist/captainClient.js";

const DOC_A = "9f3c1d0e5a7b4c2d8e6f0a1b2c3d4e5f";
const DOC_B = "41ab0c9d8e7f6a5b4c3d2e1f0a9b8c7d";

test("replace_document_ids is optional and takes one document id or null per file", () => {
  assert.equal(replaceDocumentIdsField.parse(undefined), undefined);
  assert.deepEqual(replaceDocumentIdsField.parse([DOC_A, null]), [DOC_A, null]);
});

test("replace_document_ids refuses a map keyed by filename and entries that are not ids", () => {
  assert.throws(() => replaceDocumentIdsField.parse({ "report.txt": DOC_A }));
  assert.throws(() => replaceDocumentIdsField.parse([7]));
  assert.throws(() => replaceDocumentIdsField.parse([""]));
  assert.throws(() => replaceDocumentIdsField.parse(DOC_A));
});

test("the multipart value is the array as JSON, in the order given", () => {
  assert.deepEqual(JSON.parse(replaceDocumentIdsFormValue([null, DOC_A, DOC_B], 3)), [null, DOC_A, DOC_B]);
});

test("no replace_document_ids, or one that names no document, sends no form field", () => {
  assert.equal(replaceDocumentIdsFormValue(undefined, 3), undefined);
  assert.equal(replaceDocumentIdsFormValue([null, null], 2), undefined);
});

test("a list that does not have one entry per file is refused with the counts", () => {
  assert.throws(() => replaceDocumentIdsFormValue([DOC_A, null], 3), /has 2 entries but 3 files are being uploaded/);
  assert.throws(() => replaceDocumentIdsFormValue([DOC_A, DOC_B], 1), /has 2 entries but 1 file is being uploaded/);
  assert.throws(() => replaceDocumentIdsFormValue([], 2), /has 0 entries but 2 files/);
});

// ── through the registered tool: what is actually uploaded ─────────────────
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function handlers() {
  const map = new Map();
  registerCaptainTools({ registerTool: (name, definition, handler) => map.set(name, { definition, handler }) });
  return map;
}
const callTool = (args) => runWithConfig({ apiKey: "synthetic" }, () => handlers().get("captain_index_file").handler(args));
const b64 = (text) => Buffer.from(text).toString("base64");

// Serves the one URL the tool fetches and captures the multipart upload. The
// upload answers with `reply`: a job, or the API's refusal.
function captureUpload(t, reply = { status: 200, body: JSON.stringify({ job_id: "job_1", status: "pending" }) }) {
  const uploads = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options || !options.method || options.method === "GET") {
      return new Response("from the url", { status: 200 });
    }
    const form = options.body;
    const files = [];
    for (const f of form.getAll("files")) files.push({ name: f.name, text: await f.text() });
    uploads.push({
      url: String(url), files,
      replaceDocumentIds: form.get("replace_document_ids"),
      skipExisting: form.get("skip_existing"),
      overwriteExisting: form.get("overwrite_existing"),
      fileMetadata: form.get("file_metadata"),
    });
    return new Response(reply.body, { status: reply.status });
  });
  return uploads;
}

test("the registered tool takes replace_document_ids", () => {
  const { definition } = handlers().get("captain_index_file");
  assert.ok(definition.inputSchema.replace_document_ids, "captain_index_file has no replace_document_ids input");
  assert.match(definition.inputSchema.replace_document_ids.description, /one entry per uploaded file, in upload order/);
});

test("captain_index_file uploads replace_document_ids beside the files, in upload order across all three sources", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rdi-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const local = join(dir, "report.txt");
  await writeFile(local, "from the path");
  const uploads = captureUpload(t);
  // Given paths first on purpose: the upload order is files, then urls, then paths.
  await callTool({
    collection: "docs",
    paths: local,
    urls: ["https://files.example/report.txt"],
    files: [{ name: "report.txt", content_base64: b64("inline one") }, { name: "report.txt", content_base64: b64("inline two") }],
    skip_existing: false,
    replace_document_ids: [DOC_A, null, DOC_B, null],
    file_metadata: [{ edition: 1 }, null, { edition: 3 }, null],
  });
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].url, /\/collections\/docs\/index\/file$/);
  // four files with one filename: position is the only pairing there is
  assert.deepEqual(uploads[0].files, [
    { name: "report.txt", text: "inline one" },
    { name: "report.txt", text: "inline two" },
    { name: "report.txt", text: "from the url" },
    { name: "report.txt", text: "from the path" },
  ]);
  assert.deepEqual(JSON.parse(uploads[0].replaceDocumentIds), [DOC_A, null, DOC_B, null]);
  assert.equal(uploads[0].skipExisting, "false");
  assert.deepEqual(JSON.parse(uploads[0].fileMetadata), [{ edition: 1 }, null, { edition: 3 }, null]);
});

test("captain_index_file sends no replace_document_ids field when none is given", async (t) => {
  const uploads = captureUpload(t);
  await callTool({ collection: "docs", files: [{ name: "a.txt", content_base64: b64("one") }] });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].replaceDocumentIds, null);
  assert.equal(uploads[0].skipExisting, null);
});

test("captain_index_file refuses a mismatched replace_document_ids before any upload", async (t) => {
  const uploads = captureUpload(t);
  await assert.rejects(
    () => callTool({
      collection: "docs",
      files: [{ name: "a.txt", content_base64: b64("one") }, { name: "b.txt", content_base64: b64("two") }],
      skip_existing: false,
      replace_document_ids: [DOC_A],
    }),
    /replace_document_ids has 1 entry but 2 files are being uploaded/,
  );
  assert.equal(uploads.length, 0);
});

const REFUSAL_409 = {
  error: "HTTP_ERROR",
  message: `2 documents in this collection are named 'report.txt' (document_id ${DOC_A}, ${DOC_B}). ` +
    "Say which one to replace with replace_document_ids, or send skip_existing=true to add this file as a new document.",
  status_code: 409,
  path: "/v2/collections/docs/index/file",
};
const REFUSAL_404 = {
  error: "HTTP_ERROR",
  message: `replace_document_ids[0] (file 'report.txt'): no document with id '${DOC_A}' in this collection.`,
  status_code: 404,
  path: "/v2/collections/docs/index/file",
};

test("the API's 409 reaches the caller unchanged, with both document ids", async (t) => {
  captureUpload(t, { status: 409, body: JSON.stringify(REFUSAL_409) });
  await assert.rejects(
    () => callTool({ collection: "docs", files: [{ name: "report.txt", content_base64: b64("new") }], skip_existing: false }),
    (error) => {
      assert.equal(error.message, `Captain API error (409): ${JSON.stringify(REFUSAL_409)}`);
      assert.ok(error.message.includes(DOC_A) && error.message.includes(DOC_B));
      assert.ok(error.message.includes("Say which one to replace with replace_document_ids"));
      return true;
    },
  );
});

test("the API's 404 for an unknown document id reaches the caller unchanged", async (t) => {
  const uploads = captureUpload(t, { status: 404, body: JSON.stringify(REFUSAL_404) });
  await assert.rejects(
    () => callTool({
      collection: "docs", files: [{ name: "report.txt", content_base64: b64("new") }],
      skip_existing: false, replace_document_ids: [DOC_A],
    }),
    (error) => {
      assert.equal(error.message, `Captain API error (404): ${JSON.stringify(REFUSAL_404)}`);
      return true;
    },
  );
  assert.deepEqual(JSON.parse(uploads[0].replaceDocumentIds), [DOC_A]);
});
