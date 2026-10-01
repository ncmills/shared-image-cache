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
import { toM6Entry } from "../lib/m6";

const HOME = process.env.HOME || "/Users/bignick";
const CACHE_PATH = resolve(__dirname, "..", "cache.json");

export interface OverrideEntry {
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

/**
 * Mirror one project's overrides into `cache` (pure: no fs, no git). Exported
 * so the selftest can run the real writer on fixtures.
 */
export function mirrorProject(
  cache: Cache,
  project: string,
  overrides: Record<string, OverrideEntry>,
  now: () => string = () => new Date().toISOString(),
): { added: number; updated: number; skipped: string[] } {
  let added = 0;
  let updated = 0;
  const skipped: string[] = [];
  for (const [key, val] of Object.entries(overrides)) {
    // key shape: "<destId>::<category>::<index>"
    const parts = key.split("::");
    if (parts.length !== 3) {
      skipped.push(key);
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
      fetchedAt: val.addedAt ? new Date(val.addedAt).toISOString() : now(),
      addedBy: project,
    };

    // Mirrored overrides carry no photo page and no profile, so they land
    // `credit.complete: false` — the derivation never invents a credit.
    cache[cacheKey] = toM6Entry(entry);
    if (existing) updated++;
    else added++;
  }
  return { added, updated, skipped };
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
    console.log(`  ${project}: ${Object.keys(overrides).length} overrides`);
    const r = mirrorProject(cache, project, overrides);
    for (const k of r.skipped) console.warn(`    skip malformed key: ${k}`);
    added += r.added;
    updated += r.updated;
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

if (require.main === module) main();
