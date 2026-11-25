/**
 * backfill-place-brands — add placeId + brands (lib/place.ts) to every
 * cache.json row. Pure: no network, no model call. Fields only ADDED.
 *
 *   npx tsx scripts/backfill-place-brands.ts            # DRY RUN: counts only
 *   npx tsx scripts/backfill-place-brands.ts --write    # rewrite cache.json
 *
 * Rows that already carry the fields are left as they are. Mapped rows get the
 * place id + the place's wizards tags; unmapped / ambiguous rows get
 * placeId null + brands [project].
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Cache } from "../lib/types";
import { mapKeyToPlace, projectOf, withPlaceFields, type PlaceIndex } from "../lib/place";
import { serializeCache } from "./backfill-m6";

const REPO_ROOT = resolve(__dirname, "..");
const CACHE_PATH = resolve(REPO_ROOT, "cache.json");
const INDEX_PATH = resolve(REPO_ROOT, "place-index.json");

export interface PlaceCounts {
  perProject: Record<string, { mapped: number; unmapped: number; ambiguous: number }>;
  total: number;
}

export function backfillPlace(cache: Cache, index: PlaceIndex): { cache: Cache; counts: PlaceCounts } {
  const out: Cache = {};
  const perProject: PlaceCounts["perProject"] = {};
  for (const [key, row] of Object.entries(cache)) {
    const p = projectOf(key);
    const c = (perProject[p] ??= { mapped: 0, unmapped: 0, ambiguous: 0 });
    c[mapToCount(mapKeyToPlace(key, index).status)]++;
    out[key] = withPlaceFields(key, row, index);
  }
  return { cache: out, counts: { perProject, total: Object.keys(cache).length } };
}

function mapToCount(s: "mapped" | "unmapped" | "ambiguous") {
  return s;
}

/** Strip the two fields; used to prove nothing else changed. */
export function stripPlace(cache: Cache): Cache {
  const out: Cache = {};
  for (const [k, row] of Object.entries(cache)) {
    const { placeId: _p, brands: _b, ...rest } = row as unknown as Record<string, unknown>;
    void _p; void _b;
    out[k] = rest as never;
  }
  return out;
}

function main() {
  const write = process.argv.includes("--write");
  const raw = readFileSync(CACHE_PATH, "utf8");
  const cache = JSON.parse(raw) as Cache;
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as PlaceIndex;

  if (serializeCache(cache) !== raw) throw new Error("backfill-place: cache.json does not round-trip through serializeCache; refusing");
  const { cache: next, counts } = backfillPlace(cache, index);
  if (Object.keys(next).length !== Object.keys(cache).length) throw new Error("backfill-place: row count changed");
  if (serializeCache(stripPlace(next)) !== serializeCache(stripPlace(cache))) throw new Error("backfill-place: something other than placeId/brands changed");
  const again = backfillPlace(next, index).cache;
  if (serializeCache(again) !== serializeCache(next)) throw new Error("backfill-place: not idempotent");

  console.log(`backfill-place-brands (${write ? "WRITE" : "DRY RUN"}): ${counts.total} rows`);
  const rows = Object.entries(counts.perProject).sort();
  let m = 0, u = 0, a = 0;
  for (const [p, c] of rows) {
    console.log(`  ${p.padEnd(14)} mapped ${String(c.mapped).padStart(5)}  unmapped ${String(c.unmapped).padStart(5)}  ambiguous ${String(c.ambiguous).padStart(3)}`);
    m += c.mapped; u += c.unmapped; a += c.ambiguous;
  }
  console.log(`  ${"TOTAL".padEnd(14)} mapped ${String(m).padStart(5)}  unmapped ${String(u).padStart(5)}  ambiguous ${String(a).padStart(3)}`);
  console.log("only placeId/brands added; idempotent; byte round-trip OK");
  if (write) {
    writeFileSync(CACHE_PATH, serializeCache(next), "utf8");
    console.log("cache.json written");
  }
}

if (require.main === module) main();
