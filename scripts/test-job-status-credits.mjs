import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// captain_job_status prints a per-type credit line, including spreadsheets.
test("job status renders the spreadsheet credit dimension", () => {
  const src = readFileSync(new URL("../dist/tools.js", import.meta.url), "utf8");
  assert.match(src, /used_sheet/);
  assert.match(src, /credits for spreadsheets/);
});
