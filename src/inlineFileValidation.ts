/**
 * Validation for inline base64 uploads (`captain_index_file` `files[]`).
 *
 * Why this exists: a model emitting a large base64 string in a tool call does
 * not reproduce it faithfully. Node's `Buffer.from(s, "base64")` silently
 * skips invalid characters, so a corrupt or truncated string still "decodes"
 * and the bytes reach the API as a file. Seen 2026-09-17: a 940x699 PNG sent
 * as 1,185,192 base64 chars arrived as 786,444 bytes (768 KiB + 12) with a
 * CRC failure inside the fifth IDAT chunk and no IEND; the image handler then
 * failed a minute later with Gemini's opaque "Unable to process input image".
 *
 * Every check here is on the bytes we are about to upload, so the caller gets
 * the direct cause and the fix (use `paths` or `urls`) instead of a vague
 * downstream failure.
 */

export const INLINE_BASE64_SOFT_LIMIT_BYTES = 64 * 1024;

export class InlineFileError extends Error {}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict base64 decode: no whitespace, no stray characters, length multiple of 4. */
export function decodeBase64Strict(s: string, name: string): Buffer {
  const clean = s.replace(/^data:[^;]+;base64,/, "");
  if (clean.length % 4 !== 0 || !B64.test(clean)) {
    const bad = clean.search(/[^A-Za-z0-9+/=]/);
    throw new InlineFileError(
      `content_base64 for '${name}' is not valid base64` +
        (bad >= 0 ? ` (invalid character at position ${bad.toLocaleString()})` : ` (length ${clean.length.toLocaleString()} is not a multiple of 4)`) +
        ". Inline base64 through a model tool call is unreliable for anything but small files; pass `paths` (local server) or `urls` instead.",
    );
  }
  return Buffer.from(clean, "base64");
}

function crc32(buf: Buffer): number {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/** Walk PNG chunks; every chunk must have a valid CRC and the stream must end with IEND. */
export function checkPng(buf: Buffer, name: string): void {
  if (buf.length < 8 || buf.toString("latin1", 0, 8) !== "\x89PNG\r\n\x1a\n") {
    throw new InlineFileError(`'${name}' has a .png name but the bytes are not a PNG (bad signature).`);
  }
  let off = 8;
  let sawIend = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || off + 12 + len > buf.length) {
      throw new InlineFileError(
        `'${name}' is a corrupt PNG: chunk header at byte ${off.toLocaleString()} is invalid (the data was damaged or truncated in transit). Re-upload via \`paths\` or \`urls\`.`,
      );
    }
    const crc = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== crc) {
      throw new InlineFileError(
        `'${name}' is a corrupt PNG: CRC mismatch in ${type} chunk at byte ${off.toLocaleString()} of ${buf.length.toLocaleString()} (the data was damaged in transit). Re-upload via \`paths\` or \`urls\`.`,
      );
    }
    if (type === "IEND") { sawIend = true; break; }
    off += 12 + len;
  }
  if (!sawIend) {
    throw new InlineFileError(
      `'${name}' is a truncated PNG: ${buf.length.toLocaleString()} bytes and no IEND chunk (the upload was cut off). Re-upload via \`paths\` or \`urls\`.`,
    );
  }
}

export function checkJpeg(buf: Buffer, name: string): void {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new InlineFileError(`'${name}' has a JPEG name but the bytes are not a JPEG (no SOI marker).`);
  }
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
    throw new InlineFileError(
      `'${name}' is a truncated JPEG: ${buf.length.toLocaleString()} bytes and no EOI marker (the upload was cut off). Re-upload via \`paths\` or \`urls\`.`,
    );
  }
}

const SIGNATURES: Array<[RegExp, (b: Buffer) => boolean, string]> = [
  [/\.pdf$/i, (b) => b.toString("latin1", 0, 5) === "%PDF-", "PDF"],
  [/\.(docx|xlsx|pptx|xlsm)$/i, (b) => b[0] === 0x50 && b[1] === 0x4b, "ZIP-based Office"],
  [/\.gif$/i, (b) => b.toString("latin1", 0, 3) === "GIF", "GIF"],
  [/\.webp$/i, (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP", "WEBP"],
];

/**
 * Validate an inline file before upload. Returns the decoded bytes.
 * Throws InlineFileError with the direct cause and remedy.
 */
export function validateInlineFile(name: string, contentBase64: string): Buffer {
  const buf = decodeBase64Strict(contentBase64, name);
  if (buf.length === 0) throw new InlineFileError(`'${name}' decoded to 0 bytes.`);
  if (/\.png$/i.test(name)) checkPng(buf, name);
  else if (/\.(jpe?g)$/i.test(name)) checkJpeg(buf, name);
  else {
    for (const [re, ok, label] of SIGNATURES) {
      if (re.test(name) && !ok(buf)) {
        throw new InlineFileError(`'${name}' does not start with a ${label} signature; the bytes do not match the file type.`);
      }
    }
  }
  return buf;
}
