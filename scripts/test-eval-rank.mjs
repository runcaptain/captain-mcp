// Document-level matching accepts every id a document is known by: the stable
// document.id, the indexed version's document.file_id, and the chunk_id prefix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rankResults } from "../dist/evalTools.js";

const STABLE = "doc-stable", VERSION = "file-version-2";
// A result as the API returns it since stable ids: id is stable, file_id is the version.
const shaped = { chunk_id: `${VERSION}:3`, document: { id: STABLE, file_id: VERSION } };
// A result as the API returned it before: the version id sat in document.id.
const legacy = { chunk_id: `${VERSION}:3`, document: { id: VERSION } };
const other = { chunk_id: "x:0", document: { id: "other", file_id: "x" } };
const gt = (ids) => ({ chunkIds: [], documentIds: ids });

test("a question set holding version ids still matches a stable-id response", () => {
  assert.deepEqual(rankResults([other, shaped], gt([VERSION]), "document"), { rank: 2, matchedRanks: [2] });
});

test("a question set holding stable ids matches", () => {
  assert.deepEqual(rankResults([shaped], gt([STABLE]), "document"), { rank: 1, matchedRanks: [1] });
});

test("an older response shape keeps matching", () => {
  assert.deepEqual(rankResults([legacy], gt([VERSION]), "document"), { rank: 1, matchedRanks: [1] });
});

test("one document is credited once even when both of its ids are in the ground truth", () => {
  const twoChunks = [shaped, { ...shaped, chunk_id: `${VERSION}:4` }];
  assert.deepEqual(rankResults(twoChunks, gt([STABLE, VERSION]), "document"), { rank: 1, matchedRanks: [1] });
});

test("a result with no document block falls back to the chunk_id prefix", () => {
  assert.deepEqual(rankResults([{ chunk_id: `${VERSION}:0` }], gt([VERSION]), "document"), { rank: 1, matchedRanks: [1] });
});

test("an unrelated document is a miss", () => {
  assert.deepEqual(rankResults([other], gt([STABLE, VERSION]), "document"), { rank: null, matchedRanks: [] });
});
