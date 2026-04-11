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

interface TdfCache {
  destinations: Record<string, Omit<CacheEntry, "addedBy">>;
  bachelorParty: Record<string, Omit<CacheEntry, "addedBy">>;
  guides: Record<string, Omit<CacheEntry, "addedBy">>;
}

type ShowcaseImagesFile = Record<string, Record<string, string>>;

function migrateTdf(cache: Cache): number {
  const tdf = loadJson<TdfCache>(TDF_CACHE);
  if (!tdf) return 0;
  let count = 0;
  for (const [id, entry] of Object.entries(tdf.destinations || {})) {
    cache[`tdf/destinations/${id}`] = { ...entry, addedBy: "tdf" };
    count++;
  }
  for (const [id, entry] of Object.entries(tdf.bachelorParty || {})) {
    cache[`tdf/bachelorParty/${id}`] = { ...entry, addedBy: "tdf" };
    count++;
  }
  for (const [slug, entry] of Object.entries(tdf.guides || {})) {
    cache[`tdf/guides/${slug}`] = { ...entry, addedBy: "tdf" };
    count++;
  }
  return count;
}

function migrateShowcases(
  cache: Cache,
  path: string,
  project: string,
): number {
  const data = loadJson<ShowcaseImagesFile>(path);
  if (!data) return 0;
  let count = 0;
  for (const [showcaseSlug, images] of Object.entries(data)) {
    for (const [imageType, url] of Object.entries(images)) {
      // BESTMAN/MOH stored only URLs without attribution. We migrate the
      // URL with empty attribution fields and a re-fetch flag (alt is
      // synthesized from the slug). Re-fetching later will populate the
      // photographer credit.
      const key = `${project}/showcases/${showcaseSlug}/${imageType}`;
      cache[key] = {
        url,
        alt: `${imageType} for ${showcaseSlug}`,
        photographerName: "",
        photographerUrl: "",
        unsplashUrl: "",
        query: `${showcaseSlug} ${imageType}`,
        fetchedAt: new Date(0).toISOString(),
        addedBy: project,
      };
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

const cache = loadExistingSharedCache();
const before = Object.keys(cache).length;

const tdfCount = migrateTdf(cache);
const bestmanCount = migrateShowcases(cache, BESTMAN_CACHE, "bestman");
const mohCount = migrateShowcases(cache, MOH_CACHE, "moh");

saveCache(cache);
const after = Object.keys(cache).length;

console.log(`Seed complete:`);
console.log(`  tdf:     ${tdfCount} entries migrated`);
console.log(`  bestman: ${bestmanCount} entries migrated`);
console.log(`  moh:     ${mohCount} entries migrated`);
console.log(`  total:   ${before} → ${after} entries in shared cache`);
