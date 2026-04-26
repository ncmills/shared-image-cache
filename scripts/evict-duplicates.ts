/**
 * Duplicate eviction — companion to find-duplicates.ts.
 *
 * For each group of cache keys sharing a URL, keep the FIRST key and
 * delete the rest from cache.json. The next fetch.ts run (manual or
 * via the GitHub Actions cron) will repopulate the evicted keys with
 * fresh Unsplash queries — by then the improved city-specific
 * fallbackQuery in queries/<project>.ts is in effect, so the refetch
 * pulls genuinely different photos instead of collapsing back to the
 * same generic state-level fallback that caused the dupes in the
 * first place.
 *
 * Usage:
 *   npx tsx scripts/evict-duplicates.ts                 # dry-run report
 *   npx tsx scripts/evict-duplicates.ts --apply         # actually evict
 *   npx tsx scripts/evict-duplicates.ts --apply --commit  # + git commit + push
 *   npx tsx scripts/evict-duplicates.ts --threshold=3   # only 3+ uses
 *
 * After --apply: run `npx tsx scripts/fetch.ts --limit=120` to backfill,
 * or wait ~3 hours for the cron to backfill at 80/run × 50/hr demo limit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(__dirname, "..");
const CACHE_PATH = resolve(REPO_ROOT, "cache.json");

interface CacheEntry {
  url: string;
  query?: string;
  photographer?: string;
  fetchedAt?: string;
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const commit = args.includes("--commit");
const threshold = (() => {
  const arg = args.find((a) => a.startsWith("--threshold="));
  return arg ? Math.max(2, parseInt(arg.split("=")[1], 10) || 2) : 2;
})();

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

const dupes = Array.from(byUrl.entries()).filter(([, keys]) => keys.length >= threshold);
const evictKeys: string[] = [];
const winners: { url: string; keptKey: string; evictedKeys: string[] }[] = [];

for (const [url, keys] of dupes) {
  // Stable sort: prefer the entry with the longest (most-specific) query
  // string as the "winner" — it's the one most likely to have been a
  // real, intentional fetch rather than a fallback collision. Tiebreak
  // alphabetically by key for determinism.
  const sortedKeys = [...keys].sort((a, b) => {
    const qa = (cache[a]?.query ?? "").length;
    const qb = (cache[b]?.query ?? "").length;
    if (qa !== qb) return qb - qa;
    return a.localeCompare(b);
  });
  const [keep, ...evict] = sortedKeys;
  winners.push({ url, keptKey: keep, evictedKeys: evict });
  evictKeys.push(...evict);
}

console.log(`Cache entries: ${Object.keys(cache).length}`);
console.log(`Duplicate groups (${threshold}+ uses): ${dupes.length}`);
console.log(`Keys to evict: ${evictKeys.length}`);
console.log(`Cache after eviction: ${Object.keys(cache).length - evictKeys.length}`);

if (!apply) {
  console.log(`\n(dry-run — pass --apply to actually evict)\n`);
  console.log(`Sample of what would be evicted (first 10):`);
  for (const w of winners.slice(0, 10)) {
    const photoId = w.url.split("/").pop()?.slice(0, 32);
    console.log(`\n  Photo: ${photoId}`);
    console.log(`    Keep:   ${w.keptKey} — query: "${cache[w.keptKey]?.query ?? "—"}"`);
    for (const k of w.evictedKeys) {
      console.log(`    Evict:  ${k} — query: "${cache[k]?.query ?? "—"}"`);
    }
  }
  console.log(`\nNext step: \`npx tsx scripts/evict-duplicates.ts --apply\``);
  process.exit(0);
}

// Apply: delete evict keys from cache, save.
for (const k of evictKeys) {
  delete cache[k];
}
writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
console.log(`\n✓ Evicted ${evictKeys.length} duplicate cache keys.`);
console.log(`Cache size: ${Object.keys(cache).length}`);
console.log(`\nNext step: \`npx tsx scripts/fetch.ts --limit=${Math.min(evictKeys.length + 5, 200)}\``);
console.log(`           (or wait for the GitHub Actions cron to backfill at ~80/run × 50/hr Unsplash demo limit)`);

if (commit) {
  console.log(`\nCommitting + pushing...`);
  try {
    execSync(`git add cache.json`, { cwd: REPO_ROOT, stdio: "inherit" });
    const summary = `evict ${evictKeys.length} duplicates (${dupes.length} groups, ${threshold}+ uses)`;
    execSync(
      `git commit -m "chore(cache): ${summary}\n\nDuplicates were cache keys all serving the same Unsplash photo —\n7 California cities sharing one bar photo, 6 Texas cities sharing\none BBQ photo, etc. Root cause was state-level fallbackQuery in\nqueries/*.ts which has now been tightened to city-specific terms\n(176a6ce). Evicting forces a refetch with the new queries on the\nnext fetch.ts run.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"`,
      { cwd: REPO_ROOT, stdio: "inherit" }
    );
    execSync(`git push origin main`, { cwd: REPO_ROOT, stdio: "inherit" });
    console.log(`\n✓ Committed + pushed.`);
  } catch (err) {
    console.error(`Commit/push failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
