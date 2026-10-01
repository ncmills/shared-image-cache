/**
 * backfill-m6 — add the M6 fields (lib/m6.ts) to every cache.json row.
 *
 * Pure: no network, no API budget, fields only ADDED (the 8 legacy fields are
 * kept verbatim; no row added or removed). Idempotent: twice → identical bytes.
 *
 *   npx tsx scripts/backfill-m6.ts            # DRY RUN (default): counts only, writes nothing
 *   npx tsx scripts/backfill-m6.ts --write    # rewrite cache.json + empty the pre-M6 ledger
 *
 * The --write run against committed data is its own unit (U2-data), not U2.
 * After it lands, m6-legacy-ledger.json is `{"keys": []}` and gate:m6 then
 * fails ANY row without the M6 fields.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Cache, CacheEntryM6 } from "../lib/types";
import { toM6Entry } from "../lib/m6";

const REPO_ROOT = resolve(__dirname, "..");
const CACHE_PATH = resolve(REPO_ROOT, "cache.json");
const LEDGER_PATH = resolve(REPO_ROOT, "m6-legacy-ledger.json");

/** Same serialization as fetch.ts / mirror-overrides.ts saveCache (sorted keys). */
export function serializeCache(cache: Cache): string {
  const sorted: Cache = {};
  for (const k of Object.keys(cache).sort()) sorted[k] = cache[k];
  return JSON.stringify(sorted, null, 2) + "\n";
}

export interface BackfillCounts {
  total: number;
  provider: { pexels: number; unsplash: number };
  complete: number;
  incomplete: number;
  /** complete:false rows by `<project>/<category>` */
  incompleteBy: Record<string, number>;
  /** complete:false rows by provider */
  incompleteProvider: { pexels: number; unsplash: number };
  /** rows whose new links (sourceUrl, credit.photographerUrl, credit.providerUrl) carry a query — must be 0 */
  newLinksWithQuery: number;
  /** rows whose legacy unsplashUrl/photographerUrl carried a baked utm (kept in the old field only) */
  legacyBakedUtm: Record<string, number>;
}

export function backfillM6(cache: Cache): { cache: Cache; counts: BackfillCounts } {
  const out: Cache = {};
  const counts: BackfillCounts = {
    total: 0,
    provider: { pexels: 0, unsplash: 0 },
    complete: 0,
    incomplete: 0,
    incompleteBy: {},
    incompleteProvider: { pexels: 0, unsplash: 0 },
    newLinksWithQuery: 0,
    legacyBakedUtm: {},
  };
  for (const [key, e] of Object.entries(cache)) {
    const m: CacheEntryM6 = toM6Entry(e);
    out[key] = m;
    counts.total++;
    counts.provider[m.provider]++;
    if (m.credit.complete) counts.complete++;
    else {
      counts.incomplete++;
      counts.incompleteProvider[m.provider]++;
      const bucket = key.split("/").slice(0, 2).join("/");
      counts.incompleteBy[bucket] = (counts.incompleteBy[bucket] ?? 0) + 1;
    }
    if ([m.sourceUrl, m.credit.photographerUrl, m.credit.providerUrl].some((l) => l.includes("?"))) counts.newLinksWithQuery++;
    const utm = `${e.unsplashUrl} ${e.photographerUrl}`.match(/utm_source=([A-Za-z0-9_-]+)/)?.[1];
    if (utm) counts.legacyBakedUtm[utm] = (counts.legacyBakedUtm[utm] ?? 0) + 1;
  }
  return { cache: out, counts };
}

function main() {
  const write = process.argv.includes("--write");
  const raw = readFileSync(CACHE_PATH, "utf8");
  const before = JSON.parse(raw) as Cache;
  const once = backfillM6(before);
  const twice = backfillM6(JSON.parse(serializeCache(once.cache)) as Cache);
  const idempotent = serializeCache(once.cache) === serializeCache(twice.cache);

  const legacyKeys = ["url", "alt", "photographerName", "photographerUrl", "unsplashUrl", "query", "fetchedAt", "addedBy"] as const;
  let legacyChanged = 0;
  for (const [k, e] of Object.entries(before)) {
    const a = once.cache[k] as unknown as Record<string, unknown>;
    if (legacyKeys.some((f) => JSON.stringify(a?.[f]) !== JSON.stringify((e as unknown as Record<string, unknown>)[f]))) legacyChanged++;
  }
  const keysSame = JSON.stringify(Object.keys(before).sort()) === JSON.stringify(Object.keys(once.cache).sort());

  console.log(`backfill-m6 ${write ? "WRITE" : "DRY RUN (nothing written)"}`);
  console.log(JSON.stringify(once.counts, null, 2));
  console.log(`rows whose legacy 8 fields changed: ${legacyChanged}`);
  console.log(`key set unchanged: ${keysSame}`);
  console.log(`twice → identical bytes: ${idempotent}`);

  if (legacyChanged || !keysSame || !idempotent || once.counts.newLinksWithQuery) {
    console.error("✘ backfill invariants failed — refusing to write");
    process.exit(1);
  }
  if (write) {
    writeFileSync(CACHE_PATH, serializeCache(once.cache), "utf8");
    writeFileSync(LEDGER_PATH, JSON.stringify({ note: LEDGER_NOTE, keys: [] }, null, 2) + "\n", "utf8");
    console.log(`✓ wrote cache.json (${once.counts.total} rows) and emptied m6-legacy-ledger.json`);
  }
}

export const LEDGER_NOTE =
  "Keys allowed to lack the M6 fields (pre-U2 rows owed to the U2-data backfill). Only ever shrinks; empty after backfill-m6 --write.";

if (require.main === module) main();
