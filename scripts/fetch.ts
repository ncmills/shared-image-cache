/**
 * Unified Unsplash fetcher writing to the shared image cache.
 *
 * Reads queries from every project loader (TDF, BESTMAN, MOH, ...) and
 * fetches anything missing from the cache. Idempotent — already-cached
 * keys are skipped. Bounded by --limit per run to respect Unsplash's
 * 50/hr rate limit.
 *
 * Usage:
 *   npx tsx scripts/fetch.ts                # default --limit=40
 *   npx tsx scripts/fetch.ts --limit=20
 *   npx tsx scripts/fetch.ts --project=tdf  # only fetch tdf queries
 *   npx tsx scripts/fetch.ts --refetch      # re-fetch already-cached entries
 *   npx tsx scripts/fetch.ts --commit       # auto git commit + push after run
 *
 * Reads UNSPLASH_ACCESS_KEY from env or .env.local in the repo root.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  searchUnsplash,
  UnsplashRateLimitError,
} from "../lib/unsplash";
import type { Cache, CacheEntry, QueryItem } from "../lib/types";
import { getTdfQueries } from "./queries/tdf";
import { getBestmanQueries } from "./queries/bestman";
import { getMohQueries } from "./queries/moh";

const REPO_ROOT = resolve(__dirname, "..");
const CACHE_PATH = resolve(REPO_ROOT, "cache.json");
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const SLEEP_MS = 1000;
const RATELIMIT_FLOOR = 5;
const DEFAULT_LIMIT = 40;

// ── Env loader ──────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const text = readFileSync(ENV_PATH, "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

// ── Cache I/O ───────────────────────────────────────────────────────

function loadCache(): Cache {
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

// ── Args ────────────────────────────────────────────────────────────

interface Args {
  limit: number;
  refetch: boolean;
  commit: boolean;
  project: string | null;
}

function parseArgs(): Args {
  let limit = DEFAULT_LIMIT;
  let refetch = false;
  let commit = false;
  let project: string | null = null;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--refetch") refetch = true;
    else if (arg === "--commit") commit = true;
    else if (arg.startsWith("--limit=")) limit = parseInt(arg.slice(8), 10);
    else if (arg.startsWith("--project=")) project = arg.slice(10);
  }
  if (Number.isNaN(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  return { limit, refetch, commit, project };
}

// ── Sleep ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();

  // Pool multiple Unsplash keys for higher throughput while keeping each
  // key well under its individual 50/hr demo limit. Keys are round-robined
  // per request. Add UNSPLASH_ACCESS_KEY_2, _3, etc. to .env.local.
  const keys: string[] = [];
  const primary = env.UNSPLASH_ACCESS_KEY || process.env.UNSPLASH_ACCESS_KEY;
  if (primary) keys.push(primary);
  for (let i = 2; i <= 5; i++) {
    const extra = env[`UNSPLASH_ACCESS_KEY_${i}`] || process.env[`UNSPLASH_ACCESS_KEY_${i}`];
    if (extra) keys.push(extra);
  }
  if (keys.length === 0) {
    console.error("✘ UNSPLASH_ACCESS_KEY not found in .env.local or environment");
    process.exit(1);
  }
  let keyIdx = 0;
  function nextKey(): string {
    const k = keys[keyIdx % keys.length];
    keyIdx++;
    return k;
  }
  console.log(`  Using ${keys.length} Unsplash key${keys.length > 1 ? "s" : ""} (round-robin pool)`);

  const args = parseArgs();
  const cache = loadCache();

  // Gather queries from every project loader
  const allQueries: QueryItem[] = [];
  console.log("Loading project queries...");
  if (!args.project || args.project === "tdf") {
    allQueries.push(...(await getTdfQueries()));
  }
  if (!args.project || args.project === "bestman") {
    allQueries.push(...(await getBestmanQueries()));
  }
  if (!args.project || args.project === "moh") {
    allQueries.push(...(await getMohQueries()));
  }

  // Filter out already-cached entries
  const queue = allQueries.filter((q) => args.refetch || !cache[q.key]);

  console.log(
    `Shared cache fetch — ${allQueries.length} total queries, ${queue.length} pending`,
  );
  console.log(`  cache currently holds ${Object.keys(cache).length} entries`);

  if (queue.length === 0) {
    console.log("✓ Nothing to fetch — cache is up to date");
    if (args.commit) commitAndPush(0);
    return;
  }

  const batch = queue.slice(0, args.limit);
  console.log(`  processing up to ${batch.length} this run\n`);

  let processed = 0;
  let added = 0;
  let aborted = false;

  for (const item of batch) {
    processed++;
    try {
      let result = await searchUnsplash(item.query, nextKey());
      let usedFallback = false;

      if (
        !result.entry &&
        item.fallbackQuery &&
        item.fallbackQuery !== item.query &&
        !Number.isNaN(result.ratelimitRemaining) &&
        result.ratelimitRemaining > RATELIMIT_FLOOR + 2
      ) {
        await sleep(SLEEP_MS);
        const fb = await searchUnsplash(item.fallbackQuery, nextKey());
        if (fb.entry) {
          result = fb;
          usedFallback = true;
        } else {
          result = { entry: null, ratelimitRemaining: fb.ratelimitRemaining };
        }
      }

      if (result.entry) {
        const entry: CacheEntry = { ...result.entry, addedBy: item.addedBy };
        cache[item.key] = entry;
        added++;
        const tag = usedFallback ? "↻" : "✓";
        console.log(
          `  [${processed}/${batch.length}] ${item.label || item.key} ${tag} (${result.ratelimitRemaining} left)` +
            (usedFallback ? `  fallback: "${item.fallbackQuery}"` : ""),
        );
      } else {
        console.log(
          `  [${processed}/${batch.length}] ${item.label || item.key} — no results for "${item.query}"`,
        );
      }

      saveCache(cache);

      if (
        !Number.isNaN(result.ratelimitRemaining) &&
        result.ratelimitRemaining < RATELIMIT_FLOOR
      ) {
        console.log(
          `\n⚠  Stopping early — only ${result.ratelimitRemaining} requests left in the hourly budget`,
        );
        aborted = true;
        break;
      }
    } catch (err) {
      if (err instanceof UnsplashRateLimitError) {
        console.log(`\n⚠  Rate limit hit — try again in an hour`);
        aborted = true;
        break;
      }
      console.error(
        `  ✘ ${item.label || item.key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (processed < batch.length) await sleep(SLEEP_MS);
  }

  saveCache(cache);

  const remaining = queue.length - processed;
  console.log(
    `\n✓ Done — ${processed} processed, ${added} new entries added${aborted ? " (aborted early)" : ""}, ${remaining} still pending`,
  );

  if (args.commit && added > 0) commitAndPush(added);
  if (remaining > 0) {
    console.log(`  Re-run \`npm run fetch\` after the rate-limit window resets (~1 hour)`);
  }
}

function commitAndPush(added: number): void {
  try {
    process.chdir(REPO_ROOT);
    execSync("git add cache.json", { stdio: "inherit" });
    const status = execSync("git status --porcelain cache.json", { encoding: "utf8" });
    if (!status.trim()) {
      console.log("  (no cache changes to commit)");
      return;
    }
    const ts = new Date().toISOString();
    execSync(
      `git commit -m "fetch: ${added} new entries @ ${ts}"`,
      { stdio: "inherit" },
    );
    execSync("git push origin main", { stdio: "inherit" });
    console.log("✓ Committed + pushed to origin/main");
  } catch (err) {
    console.error(
      `  ⚠ git commit/push failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
