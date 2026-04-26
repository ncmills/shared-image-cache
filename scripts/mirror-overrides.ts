/**
 * Mirror per-venue image overrides from BMHQ + MOH into the shared cache.
 *
 * Reads each repo's `venue-image-overrides.json` and writes the entries
 * into `cache.json` under a new `<project>/venues/<destId>/<category>/<index>`
 * key shape so:
 *  - Other projects can pull these venue photos via the existing prebuild
 *    sync without re-fetching from Unsplash.
 *  - The 15+17 marquee photos shipped 2026-04-26 become reusable inventory.
 *
 * Idempotent — re-runs replace existing mirror entries with the latest
 * source data. Run from the shared-image-cache repo root:
 *
 *   npx tsx scripts/mirror-overrides.ts
 *   npx tsx scripts/mirror-overrides.ts --commit
 *
 * Source format (per venue-image-overrides.ts):
 *   { "<destId>::<category>::<index>": { url, credit, alt, addedAt } }
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import type { Cache, CacheEntry } from "../lib/types";

const HOME = process.env.HOME || "/Users/bignick";
const CACHE_PATH = resolve(__dirname, "..", "cache.json");

interface OverrideEntry {
  url: string;
  credit?: string;
  alt?: string;
  addedAt?: string;
}

const SOURCES: Array<{ project: string; path: string }> = [
  { project: "bestman", path: resolve(HOME, "plan-my-party/src/data/venue-image-overrides.json") },
  { project: "moh", path: resolve(HOME, "maid-of-honor-hq/src/data/venue-image-overrides.json") },
];

function parseAuthor(credit: string | undefined): { name: string; url?: string } {
  if (!credit) return { name: "Unknown" };
  // Format: "Photographer Name on Unsplash"
  const m = credit.match(/^(.+?)\s+on\s+Unsplash$/i);
  return { name: m ? m[1].trim() : credit };
}

function loadCache(): Cache {
  if (!existsSync(CACHE_PATH)) return {};
  return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache;
}

function saveCache(cache: Cache): void {
  const sorted: Cache = {};
  for (const k of Object.keys(cache).sort()) sorted[k] = cache[k];
  writeFileSync(CACHE_PATH, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

function main() {
  const cache = loadCache();
  let added = 0;
  let updated = 0;

  for (const { project, path } of SOURCES) {
    if (!existsSync(path)) {
      console.warn(`  ⚠ source missing: ${path}`);
      continue;
    }
    const overrides = JSON.parse(readFileSync(path, "utf8")) as Record<string, OverrideEntry>;
    const entries = Object.entries(overrides);
    console.log(`  ${project}: ${entries.length} overrides`);

    for (const [key, val] of entries) {
      // key shape: "<destId>::<category>::<index>"
      const parts = key.split("::");
      if (parts.length !== 3) {
        console.warn(`    skip malformed key: ${key}`);
        continue;
      }
      const [destId, category, index] = parts;
      const cacheKey = `${project}/venues/${destId}/${category}/${index}`;
      const author = parseAuthor(val.credit);

      const existing = cache[cacheKey];
      const entry: CacheEntry = {
        url: val.url,
        alt: val.alt ?? "Curated venue photo",
        photographerName: author.name,
        photographerUrl: author.url ?? `https://unsplash.com/?utm_source=shared_image_cache&utm_medium=referral`,
        unsplashUrl: val.url.split("?")[0] ?? val.url,
        query: `marquee venue override (${destId} / ${category} / ${index})`,
        fetchedAt: val.addedAt
          ? new Date(val.addedAt).toISOString()
          : new Date().toISOString(),
        addedBy: project,
      };

      cache[cacheKey] = entry;
      if (existing) updated++;
      else added++;
    }
  }

  saveCache(cache);
  console.log(`\n✓ mirrored: ${added} new, ${updated} updated. Cache total now ${Object.keys(cache).length} entries.`);

  if (process.argv.includes("--commit")) {
    try {
      execSync(`git add cache.json`, { cwd: resolve(__dirname, ".."), stdio: "inherit" });
      execSync(
        `git commit -m "feat: mirror ${added + updated} venue overrides from BMHQ + MOH"`,
        { cwd: resolve(__dirname, ".."), stdio: "inherit" },
      );
      execSync(`git push origin main`, { cwd: resolve(__dirname, ".."), stdio: "inherit" });
      console.log("✓ committed + pushed");
    } catch (err) {
      console.warn("commit/push failed:", (err as Error).message);
    }
  }
}

main();
