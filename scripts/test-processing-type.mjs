import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { PROCESSING_TYPES } from "../dist/processingType.js";
import { registerCaptainTools } from "../dist/tools.js";
import { registerSyncTools } from "../dist/syncTools.js";
import { registerParseTools } from "../dist/parseTools.js";

function schemas(register) {
  const map = new Map();
  register({ registerTool: (name, definition) => map.set(name, z.object(definition.inputSchema)) });
  return map;
}

const index = schemas(registerCaptainTools);
const sync = schemas(registerSyncTools);
const parse = schemas(registerParseTools);

const pt = (map, name) => map.get(name).shape.processing_type;

test("processing_type values match the API: advanced, basic, auto", () => {
  assert.deepEqual([...PROCESSING_TYPES], ["advanced", "basic", "auto"]);
});

test("every tool that takes processing_type uses the shared enum", () => {
  let count = 0;
  for (const map of [index, sync, parse]) {
    for (const [name, schema] of map) {
      const field = schema.shape.processing_type;
      if (!field) continue;
      count++;
      for (const v of PROCESSING_TYPES) assert.equal(field.parse(v), v, `${name} rejects ${v}`);
      assert.equal(field.parse(undefined), undefined, `${name} requires processing_type`);
      assert.throws(() => field.parse("premium"), undefined, `${name} accepts an unknown tier`);
      assert.match(field.description ?? field.unwrap().description, /'auto' inspects each file/, `${name} lacks the auto note`);
    }
  }
  // 12 index tools + 6 create-sync tools + parse_document.
  assert.ok(count >= 19,`expected the index, sync and parse tools to take processing_type, found ${count}`);
});

test("an index tool, a sync tool and parse_document accept auto", () => {
  assert.equal(pt(index, "captain_index_url").parse("auto"), "auto");
  assert.equal(pt(index, "captain_index_s3").parse("auto"), "auto");
  assert.equal(pt(sync, "captain_create_s3_sync").parse("auto"), "auto");
  assert.equal(pt(parse, "captain_parse_document").parse("auto"), "auto");
});
