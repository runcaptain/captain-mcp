import { test } from "node:test";
import assert from "node:assert/strict";
import { indexOptionFields, piiFallbackFormValue } from "../dist/tools.js";

const { pii_engine, pii_fallback } = indexOptionFields;

test("pii_engine accepts kev, jev, presidio and the earlier names", () => {
  for (const e of ["kev", "jev", "presidio", "captain-jev", "captain-presidio"]) assert.equal(pii_engine.parse(e), e);
  assert.equal(pii_engine.parse(undefined), undefined);
  assert.throws(() => pii_engine.parse("openai"));
});

test("pii_fallback accepts the object form and the earlier boolean", () => {
  const obj = { engines: ["jev-ai-gateway", "kev"], retry_budget_seconds: 0 };
  assert.deepEqual(pii_fallback.parse(obj), obj);
  assert.deepEqual(pii_fallback.parse({}), {});
  assert.equal(pii_fallback.parse(true), true);
  assert.equal(pii_fallback.parse(false), false);
});

test("pii_fallback rejects presidio, out-of-range budgets and unknown keys", () => {
  assert.throws(() => pii_fallback.parse({ engines: ["presidio"] }));
  assert.throws(() => pii_fallback.parse({ retry_budget_seconds: 301 }));
  assert.throws(() => pii_fallback.parse({ retry_budget_seconds: -1 }));
  assert.throws(() => pii_fallback.parse({ retry_budget_seconds: 1.5 }));
  assert.throws(() => pii_fallback.parse({ engine: ["kev"] }));
});

test("multipart pii_fallback: booleans as true/false, objects as JSON", () => {
  assert.equal(piiFallbackFormValue(true), "true");
  assert.equal(piiFallbackFormValue(false), "false");
  const obj = { engines: ["jev-openrouter", "kev"], retry_budget_seconds: 30 };
  assert.deepEqual(JSON.parse(piiFallbackFormValue(obj)), obj);
});
