/**
 * One-time migration: pull existing image caches from each project into
 * the shared cache.json.
 *
 * Run once after creating the shared repo. After this, project fetchers
 * should write directly to the shared cache.
 *
 *   npx tsx scripts/seed-from-projects.ts
 *
 * Sources merged:
 *   - tour-de-fore/src/data/unsplash-cache.json (full attribution)
 *   - plan-my-party/src/data/showcase-images.json (URL-only, no attribution
 *     yet — re-fetch later to get photographer credit)
 *   - maid-of-honor-hq/src/data/showcase-images.json (currently empty)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Cache, CacheEntry } from "../lib/types";
import { toM6Entry } from "../lib/m6";

const HOME = process.env.HOME || "/Users/bignick";
const REPO_ROOT = resolve(__dirname, "..");
const CACHE_PATH = resolve(REPO_ROOT, "cache.json");

const TDF_CACHE = `${HOME}/tour-de-fore/src/data/unsplash-cache.json`;
const BESTMAN_CACHE = `${HOME}/plan-my-party/src/data/showcase-images.json`;
const MOH_CACHE = `${HOME}/maid-of-honor-hq/src/data/showcase-images.json`;

function loadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export interface TdfCache {
  destinations: Record<string, Omit<CacheEntry, "addedBy">>;
  bachelorParty: Record<string, Omit<CacheEntry, "addedBy">>;
  guides: Record<string, Omit<CacheEntry, "addedBy">>;
}

export type ShowcaseImagesFile = Record<string, Record<string, string>>;

export function migrateTdf(cache: Cache, tdf: TdfCache | null = loadJson<TdfCache>(TDF_CACHE)): number {
  if (!tdf) return 0;
  let count = 0;
  for (const [id, entry] of Object.entries(tdf.destinations || {})) {
    cache[`tdf/destinations/${id}`] = toM6Entry({ ...entry, addedBy: "tdf" });
    count++;
  }
  for (const [id, entry] of Object.entries(tdf.bachelorParty || {})) {
    cache[`tdf/bachelorParty/${id}`] = toM6Entry({ ...entry, addedBy: "tdf" });
    count++;
  }
  for (const [slug, entry] of Object.entries(tdf.guides || {})) {
    cache[`tdf/guides/${slug}`] = toM6Entry({ ...entry, addedBy: "tdf" });
    count++;
  }
  return count;
}

export function migrateShowcases(
  cache: Cache,
  data: ShowcaseImagesFile | null,
  project: string,
): number {
  if (!data) return 0;
  let count = 0;
  for (const [showcaseSlug, images] of Object.entries(data)) {
    for (const [imageType, url] of Object.entries(images)) {
      // BESTMAN/MOH stored only URLs without attribution. We migrate the
      // URL with empty attribution fields and a re-fetch flag (alt is
      // synthesized from the slug). Re-fetching later will populate the
      // photographer credit.
      const key = `${project}/showcases/${showcaseSlug}/${imageType}`;
      cache[key] = toM6Entry({
        url,
        alt: `${imageType} for ${showcaseSlug}`,
        photographerName: "",
        photographerUrl: "",
        unsplashUrl: "",
        query: `${showcaseSlug} ${imageType}`,
        fetchedAt: new Date(0).toISOString(),
        addedBy: project,
      });
      count++;
    }
  }
  return count;
}

function loadExistingSharedCache(): Cache {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache;
  } catch {
    return {};
  }
}

function saveCache(cache: Cache): void {
  const sorted: Cache = {};
  for (const k of Object.keys(cache).sort()) sorted[k] = cache[k];
  writeFileSync(CACHE_PATH, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

function main() {
  const cache = loadExistingSharedCache();
  const before = Object.keys(cache).length;

  const tdfCount = migrateTdf(cache);
  const bestmanCount = migrateShowcases(cache, loadJson<ShowcaseImagesFile>(BESTMAN_CACHE), "bestman");
  const mohCount = migrateShowcases(cache, loadJson<ShowcaseImagesFile>(MOH_CACHE), "moh");

  saveCache(cache);
  const after = Object.keys(cache).length;

  console.log(`Seed complete:`);
  console.log(`  tdf:     ${tdfCount} entries migrated`);
  console.log(`  bestman: ${bestmanCount} entries migrated`);
  console.log(`  moh:     ${mohCount} entries migrated`);
  console.log(`  total:   ${before} → ${after} entries in shared cache`);
}

// Guarded so the selftest can import the writers without running the migration.
if (require.main === module) main();
