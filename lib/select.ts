/**
 * Candidate selection for the fetcher — extracted from scripts/fetch.ts so the
 * selftest runs the REAL selection offline (no network, no budget).
 *
 * Walk the candidates best-first and take the first one that
 *   1. has no human `mismatch` verdict for THIS key (verdicts.json, spec §2b) —
 *      without this skip, deleting a wrong-subject row just re-fetches the same
 *      wrong photo on the next drain, because the query is unchanged (U4); and
 *   2. would not become a duplicate-fanout violation (lib/fanout.ts).
 * A miss beats a denied photo and beats a duplicate.
 */
import type { Cache, ImageVerdict } from "./types";
import { photoIdFromUrl, wouldViolate } from "./fanout";
import { isDenied } from "./verdicts";

export interface Pick<T> {
  chosen: T | null;
  skippedAtCeiling: number;
  skippedDenied: number;
}

export function pickCandidate<T extends { url: string }>(
  cache: Cache,
  key: string,
  entries: T[],
  verdicts: ImageVerdict[] = [],
): Pick<T> {
  let skippedAtCeiling = 0;
  let skippedDenied = 0;
  for (const e of entries) {
    if (isDenied(verdicts, key, photoIdFromUrl(e.url))) {
      skippedDenied++;
      continue;
    }
    if (wouldViolate(cache, key, e.url)) {
      skippedAtCeiling++;
      continue;
    }
    return { chosen: e, skippedAtCeiling, skippedDenied };
  }
  return { chosen: null, skippedAtCeiling, skippedDenied };
}
