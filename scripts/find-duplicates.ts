/**
 * Shared image cache duplicate detector.
 *
 * Scans cache.json for URLs that appear under multiple cache keys.
 * Duplicate URLs cause visible photo-collision bugs (e.g., the same
 * Nashville rooftop showing in 3 EditorialPhotoStrip slots) and weaken
 * the editorial-atlas brand promise. Surface them so they can be fixed
 * either by tightening the fallback query in the per-project query
 * generators, or by force-refetching specific keys with `fetch.ts --refetch`.
 *
 * Usage:
 *   npx tsx scripts/find-duplicates.ts                  # markdown report
 *   npx tsx scripts/find-duplicates.ts --threshold=3    # only 3+ uses
 *   npx tsx scripts/find-duplicates.ts --json           # machine-readable
 *   npx tsx scripts/find-duplicates.ts --evict-list     # prints keys to evict
 *
 * Output: stdout report + writes detailed manifest to /tmp/dedup-manifest.json
 * for downstream tooling (e.g., a future evict + refetch script).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CACHE_PATH = resolve(__dirname, "..", "cache.json");
const MANIFEST_PATH = "/tmp/dedup-manifest.json";

interface CacheEntry {
  url: string;
  query?: string;
  photographer?: string;
  fetchedAt?: string;
}

const args = process.argv.slice(2);
const threshold = (() => {
  const arg = args.find((a) => a.startsWith("--threshold="));
  return arg ? Math.max(2, parseInt(arg.split("=")[1], 10) || 2) : 2;
})();
const jsonMode = args.includes("--json");
const evictMode = args.includes("--evict-list");

const cache: Record<string, CacheEntry> = JSON.parse(readFileSync(CACHE_PATH, "utf8"));

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

const byUrl = new Map<string, string[]>();
for (const [key, entry] of Object.entries(cache)) {
  if (!entry?.url) continue;
  const norm = normalizeUrl(entry.url);
  if (!byUrl.has(norm)) byUrl.set(norm, []);
  byUrl.get(norm)!.push(key);
}

const dupes = Array.from(byUrl.entries())
  .filter(([, keys]) => keys.length >= threshold)
  .sort(([, a], [, b]) => b.length - a.length);

const totalDupedKeys = dupes.reduce((sum, [, keys]) => sum + keys.length - 1, 0);

if (evictMode) {
  // Print all-but-first cache key per duplicate group → these are the
  // candidates for eviction (the first key keeps the URL; the rest get
  // re-fetched with their original queries hoping for different results).
  for (const [, keys] of dupes) {
    for (const k of keys.slice(1)) console.log(k);
  }
  process.exit(0);
}

const manifest = dupes.map(([url, keys]) => ({
  url,
  keys,
  query: cache[keys[0]]?.query ?? null,
  count: keys.length,
}));
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

if (jsonMode) {
  console.log(JSON.stringify({
    totalEntries: Object.keys(cache).length,
    uniqueUrls: byUrl.size,
    duplicateGroups: dupes.length,
    duplicateServedKeys: totalDupedKeys,
    duplicates: manifest,
  }, null, 2));
  process.exit(0);
}

// Markdown report.
console.log(`# Image Cache Dedup Report\n`);
console.log(`Total cache entries: ${Object.keys(cache).length}`);
console.log(`Unique URLs: ${byUrl.size}`);
console.log(`Duplicate groups (used by ${threshold}+ keys): ${dupes.length}`);
console.log(`Cache keys served by a duplicate: ${totalDupedKeys}`);
console.log(`Manifest written to ${MANIFEST_PATH}`);

console.log(`\n## Top 20 most-duplicated photos\n`);
for (const [url, keys] of dupes.slice(0, 20)) {
  const photoId = url.split("/").pop()?.slice(0, 32) ?? url;
  console.log(`\n**${keys.length}× — ${photoId}**`);
  console.log(`  Query: \`${cache[keys[0]]?.query ?? "—"}\``);
  for (const k of keys) console.log(`  - ${k}`);
}

console.log(`\n## By project scope\n`);
const byScope = new Map<string, number>();
for (const [, keys] of dupes) {
  for (const k of keys.slice(1)) {
    const scope = k.split("/")[0];
    byScope.set(scope, (byScope.get(scope) ?? 0) + 1);
  }
}
for (const [scope, count] of Array.from(byScope.entries()).sort(([, a], [, b]) => b - a)) {
  console.log(`- ${scope}: ${count} duplicate-served keys`);
}

console.log(`\n## Next steps\n`);
console.log(`1. To force-refetch the duplicates with their existing queries (Unsplash`);
console.log(`   sometimes returns slightly different results on rerun):`);
console.log(`     \`npx tsx scripts/find-duplicates.ts --evict-list | xargs -I {} \\`);
console.log(`        npx tsx scripts/fetch.ts --refetch --key={}\` (per-key refetch`);
console.log(`        not yet supported; use --refetch on full project for now)`);
console.log(``);
console.log(`2. To prevent the duplicates from coming back, tighten the fallbackQuery`);
console.log(`   in the project's queries/<project>.ts so each city gets a unique`);
console.log(`   second-tier search instead of falling through to a generic state-level`);
console.log(`   query that hits the same Unsplash photo every time.`);
