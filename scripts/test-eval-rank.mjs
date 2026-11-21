// Document-level matching accepts every id a document is known by: the stable
// document.id, the indexed version's document.version_id, and the chunk_id prefix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedCount, ndcgAt, rankResults as rankFull, unifyExpectedCounts, expectsSeveralAmong } from "../dist/evalTools.js";

// Most cases assert rank and matchedRanks only.
const rankResults = (...args) => {
  const { rank, matchedRanks } = rankFull(...args);
  return { rank, matchedRanks };
};

const STABLE = "doc-stable", VERSION = "file-version-2";
// A result as the API returns it since stable ids: id is stable, version_id is the version.
const shaped = { chunk_id: `${VERSION}:3`, document: { id: STABLE, version_id: VERSION } };
// A result as the API returned it before: the version id sat in document.id.
const legacy = { chunk_id: `${VERSION}:3`, document: { id: VERSION } };
const other = { chunk_id: "x:0", document: { id: "other", version_id: "x" } };
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

test("a spreadsheet chunk id (file:parent:index) matches its file's version id", () => {
  const sheet = { chunk_id: `${VERSION}:2:7` };
  assert.deepEqual(rankResults([sheet], gt([VERSION]), "document"), { rank: 1, matchedRanks: [1] });
});

test("a stable-id response with no version_id matches version-id ground truth through the chunk id", () => {
  const noVersion = { chunk_id: `${VERSION}:3`, document: { id: STABLE } };
  assert.deepEqual(rankResults([noVersion], gt([VERSION]), "document"), { rank: 1, matchedRanks: [1] });
});

test("both ids of one document are one expected answer, so a perfect hit scores 1", () => {
  const { matchedRanks, aliases } = rankFull([shaped], gt([STABLE, VERSION]), "document");
  assert.equal(aliases, 1);
  const relevantCount = expectedCount([STABLE, VERSION], aliases);
  assert.equal(relevantCount, 1);
  assert.equal(ndcgAt([{ matchedRanks, relevantCount }], 10), 1);
});

test("two different documents are still two expected answers", () => {
  const { matchedRanks, aliases } = rankFull([shaped, other], gt([STABLE, "other"]), "document");
  assert.equal(aliases, 0);
  assert.equal(expectedCount([STABLE, "other"], aliases), 2);
  assert.equal(ndcgAt([{ matchedRanks, relevantCount: 2 }], 10), 1);
});

test("every configuration is scored with the same answer count per question", () => {
  // Configuration A missed q1, so it never saw that q1's two ids are one document.
  const a = [{ id: "q1", listedCount: 2, aliases: 0, relevantCount: 2 }];
  const b = [{ id: "q1", listedCount: 2, aliases: 1, relevantCount: 1 }];
  assert.equal(unifyExpectedCounts([a, b]), false);
  assert.equal(a[0].relevantCount, 1);
  assert.equal(b[0].relevantCount, 1);
  // A question with two real answers keeps the comparison multi-hop for both.
  const c = [{ id: "q2", listedCount: 2, aliases: 0, relevantCount: 2 }];
  assert.equal(unifyExpectedCounts([a, c]), true);
});

test("a multi-hop question outside the compared set does not make the comparison multi-hop", () => {
  // q2 expects two answers but failed in the candidate round, so only q1 is compared.
  const baseline = [{ id: "q1", relevantCount: 1 }, { id: "q2", relevantCount: 2 }];
  const candidate = [{ id: "q1", relevantCount: 1 }];
  assert.equal(expectsSeveralAmong([baseline, candidate], ["q1"]), false);
  assert.equal(expectsSeveralAmong([baseline, candidate], ["q1", "q2"]), true);
});
