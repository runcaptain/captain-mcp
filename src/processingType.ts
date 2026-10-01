import { z } from "zod";

// Parsing tiers the Captain API accepts on every indexing endpoint, every
// sync create and Parse documents. Keep this list in step with the API.
export const PROCESSING_TYPES = ["advanced", "basic", "auto"] as const;
export type ProcessingType = (typeof PROCESSING_TYPES)[number];

export const AUTO_PROCESSING_NOTE =
  "'auto' inspects each file and uses advanced only when it has photos, drawings, tables or scanned pages " +
  "(logos and signatures do not count), otherwise basic; each file bills at the tier it used.";

/** The processing_type enum, with a tool-specific lead-in followed by the 'auto' note. */
export function processingTypeEnum(lead: string) {
  return z.enum(PROCESSING_TYPES).describe(`${lead} ${AUTO_PROCESSING_NOTE}`);
}
