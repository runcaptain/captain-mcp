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
