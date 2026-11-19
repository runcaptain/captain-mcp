import { z } from "zod";

/**
 * Optional `fields` projection for tools that return a list of chunks or
 * results as raw JSON. A document can carry hundreds of chunks, each with
 * text, location, regions and two metadata objects; a caller that only needs
 * the text and the page pays for all of it in tokens.
 *
 * Each tool names the list it projects (`results`, `chunks`) instead of this
 * module guessing it: a v3 query response carries several lists (`results`,
 * `warnings`, `boost`, `exclude_chunk_types`, `timing.stages`), and guessing
 * wrong would silently drop data. Only the items of that list are projected;
 * the envelope (`total_results`, `next_cursor`, `timing`, `query_id`, ...)
 * is never touched, so a caller still knows how much it did not see.
 */

export const fieldsParam = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe(
    "Keep only these keys on each returned item, e.g. [\"text\", \"location\"]. Ids are always kept and the " +
      "rest of the response is unchanged. Omit for the full items.",
  );

export interface FieldsNotice {
  /** Keys present on at least one item that the projection removed. */
  omitted?: string[];
  /** Requested keys that no item carries (a typo, or a key the endpoint does not return). */
  missing?: string[];
}

/**
 * Return `data` with every item of the list at `itemsPath` reduced to `fields`
 * plus the `always` keys (ids a caller needs for a follow-up call). Adds a
 * `fields_applied` notice naming what was removed and what was asked for but
 * absent, so nothing disappears silently.
 *
 * An `always` entry can name a nested id as `parent.child` (v3 search results
 * carry the document id as `document.id`): unless `parent` is requested, the
 * item keeps `{ parent: { child } }` and `parent` is still listed as omitted,
 * since the rest of it was removed.
 *
 * Pure and non-mutating. Tolerant by design: no `fields`, a payload that is not
 * an object, or a path that does not lead to a list returns `data` unchanged.
 * Keys are read at the first level of each item only; a dotted key such as
 * `document.filename` is reported as missing.
 */
export function selectFields(
  data: unknown,
  itemsPath: string,
  fields: readonly string[] | undefined,
  always: readonly string[] = [],
): unknown {
  if (!fields || fields.length === 0) return data;
  if (!isRecord(data)) return data;
  const items = data[itemsPath];
  if (!Array.isArray(items)) return data;

  const requested = [...new Set(fields)];
  const keep = new Set([...requested, ...always.filter((key) => !key.includes("."))]);
  const nested = always
    .filter((key) => key.includes("."))
    .map((key) => key.split(".", 2) as [string, string])
    .filter(([parent]) => !keep.has(parent));
  const rows = items.filter(isRecord);

  const omitted = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) if (!keep.has(key)) omitted.add(key);
  // An empty page proves nothing about which keys exist.
  const missing = rows.length ? requested.filter((f) => !rows.some((row) => Object.hasOwn(row, f))) : [];

  const projected = items.map((item) => {
    if (!isRecord(item)) return item;
    const kept: Record<string, unknown> = Object.fromEntries(Object.entries(item).filter(([key]) => keep.has(key)));
    for (const [parent, child] of nested) {
      const value = item[parent];
      if (Object.hasOwn(item, parent) && isRecord(value) && Object.hasOwn(value, child)) {
        kept[parent] = { ...(isRecord(kept[parent]) ? kept[parent] : {}), [child]: value[child] };
      }
    }
    return kept;
  });

  const notice: FieldsNotice = {};
  if (omitted.size) notice.omitted = [...omitted].sort();
  if (missing.length) notice.missing = missing;
  const out: Record<string, unknown> = { ...data, [itemsPath]: projected };
  if (notice.omitted || notice.missing) out.fields_applied = notice;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
