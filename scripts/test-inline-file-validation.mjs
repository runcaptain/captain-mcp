import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { validateInlineFile, InlineFileError, checkPng } from "../dist/inlineFileValidation.js";

function crc32(buf) { let c = ~0 >>> 0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("valid PNG passes and decodes to the same bytes", () => {
  const p = png();
  assert.deepEqual(validateInlineFile("a.png", p.toString("base64")), p);
});
test("truncated PNG (the transit failure) is rejected with the cause", () => {
  const p = png().subarray(0, 40);
  assert.throws(() => validateInlineFile("a.png", p.toString("base64")), (e) => e instanceof InlineFileError && /truncated PNG|corrupt PNG/.test(e.message) && /paths/.test(e.message));
});
test("PNG with a CRC mismatch mid-stream names the chunk and byte offset", () => {
  const p = Buffer.from(png()); p[p.length - 20] ^= 0xff;   // damage inside the IDAT data
  assert.throws(() => checkPng(p, "a.png"), (e) => /CRC mismatch in IDAT chunk at byte \d+/.test(e.message));
});
test("invalid base64 characters are rejected with the position", () => {
  const good = png().toString("base64");
  const bad = good.slice(0, 20) + "!" + good.slice(21);
  assert.throws(() => validateInlineFile("a.png", bad), /invalid character at position 20/);
});
test("mismatched signature is rejected", () => {
  assert.throws(() => validateInlineFile("doc.pdf", Buffer.from("hello").toString("base64")), /PDF signature/);
});
test("truncated JPEG is rejected", () => {
  const j = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.throws(() => validateInlineFile("p.jpg", j.toString("base64")), /truncated JPEG/);
});
test("data: URL prefix is tolerated", () => {
  const p = png();
  assert.equal(validateInlineFile("a.png", "data:image/png;base64," + p.toString("base64")).length, p.length);
});
