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
 *   npx tsx scripts/fetch.ts --dry-run      # print the queue; no network, no writes
 *   npx tsx scripts/fetch.ts --retry-misses # ignore miss tombstones this run
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
import {
  searchPexels,
  PexelsRateLimitError,
} from "../lib/pexels";
import type { Cache, CacheEntry, QueryItem } from "../lib/types";
import { wouldViolate, isNamedVenueKey } from "../lib/fanout";
import { stripVenueFallbacks } from "../lib/query-policy";
import { buildQueue } from "../lib/queue";
import {
  evaluateRunHealth,
  reportRunHealth,
  type RunStats,
  type SourceProbe,
} from "../lib/health";
import {
  clearMiss,
  isSuppressed,
  missStats,
  recordMiss,
  serializeMisses,
  MISS_TTL_DAYS,
  type Misses,
} from "../lib/misses";
import { LOADERS, PROJECTS } from "./loaders";

const REPO_ROOT = resolve(__dirname, "..");
const CACHE_PATH = resolve(REPO_ROOT, "cache.json");
const MISSES_PATH = resolve(REPO_ROOT, "misses.json");
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

// ── Miss tombstones (lib/misses.ts) ─────────────────────────────────

function loadMisses(): Misses {
  if (!existsSync(MISSES_PATH)) return {};
  try {
    return JSON.parse(readFileSync(MISSES_PATH, "utf8")) as Misses;
  } catch {
    return {};
  }
}

function saveMisses(misses: Misses): void {
  writeFileSync(MISSES_PATH, serializeMisses(misses), "utf8");
}

// ── Args ────────────────────────────────────────────────────────────

interface Args {
  limit: number;
  refetch: boolean;
  commit: boolean;
  project: string | null;
  /** Ignore miss tombstones for this run (a deliberate re-attempt). */
  retryMisses: boolean;
  /** Compute the queue and print it. No network, no writes, no budget spent. */
  dryRun: boolean;
}

function parseArgs(): Args {
  let limit = DEFAULT_LIMIT;
  let refetch = false;
  let commit = false;
  let project: string | null = null;
  let retryMisses = false;
  let dryRun = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--refetch") refetch = true;
    else if (arg === "--commit") commit = true;
    else if (arg === "--retry-misses") retryMisses = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--limit=")) limit = parseInt(arg.slice(8), 10);
    else if (arg.startsWith("--project=")) project = arg.slice(10);
  }
  if (Number.isNaN(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  return { limit, refetch, commit, project, retryMisses, dryRun };
}

// ── Sleep ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Source probes (lib/health.ts) ───────────────────────────────────
//
// One cheap real request per configured credential, BEFORE the run. The
// 2026-06-29 incident spent three days of budget on 401s under green
// workflows because nothing ever asked a source whether it was listening.
// Costs (keys + 1) requests out of ~150; the alternative costs days.

const PROBE_QUERY = "mountain lake";

async function probeSources(
  unsplashKeys: string[],
  pexelsKey: string | null,
): Promise<SourceProbe[]> {
  const probes: SourceProbe[] = [];

  for (let i = 0; i < unsplashKeys.length; i++) {
    const name = `unsplash[${i + 1}]`;
    try {
      const res = await searchUnsplash(PROBE_QUERY, unsplashKeys[i]);
      probes.push({
        name,
        configured: true,
        ok: res.entries.length > 0,
        detail:
          res.entries.length > 0
            ? `${res.entries.length} results, ${res.ratelimitRemaining} requests left`
            : `answered but returned 0 results for "${PROBE_QUERY}" — a valid key always finds this`,
      });
    } catch (err) {
      probes.push({
        name,
        configured: true,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(SLEEP_MS);
  }

  if (!pexelsKey) {
    probes.push({
      name: "pexels",
      configured: false,
      ok: false,
      detail: "PEXELS_API_KEY not set in env or .env.local",
    });
  } else {
    try {
      const res = await searchPexels(PROBE_QUERY, pexelsKey);
      probes.push({
        name: "pexels",
        configured: true,
        ok: res.entries.length > 0,
        detail: res.entries.length
          ? `${res.entries.length} results, ${res.ratelimitRemaining} requests left`
          : `answered but returned 0 results for "${PROBE_QUERY}"`,
      });
    } catch (err) {
      probes.push({
        name: "pexels",
        configured: true,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const p of probes) {
    const mark = !p.configured ? "·" : p.ok ? "✓" : "✘";
    console.log(`  ${mark} ${p.name}: ${p.detail}`);
  }
  return probes;
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

  // Pexels — optional second source (free 200 req/hr, 20K/mo). When set,
  // fires only after Unsplash primary + fallbackQuery both miss. Drop
  // PEXELS_API_KEY=... in .env.local; key sign-up is free at
  // https://www.pexels.com/api/.
  const pexelsKey = env.PEXELS_API_KEY || process.env.PEXELS_API_KEY || null;
  let pexelsRemaining = 200; // optimistic — pexels reports actual via header
  if (pexelsKey) {
    console.log(`  Pexels secondary source enabled (rate-limited tracking via header)`);
  }

  const args = parseArgs();
  const cache = loadCache();
  const misses = loadMisses();

  // Gather queries from every project loader (scripts/loaders.ts is the ONE
  // registry — a project missing from it is missing from the fetcher, the gap
  // report and the snapshot at once, which is better than being missing from
  // three of them silently).
  if (args.project && !PROJECTS.includes(args.project)) {
    console.error(
      `✘ unknown --project=${args.project}. Known projects: ${PROJECTS.join(", ")}. ` +
        `A typo here used to fetch NOTHING and exit 0.`,
    );
    process.exit(1);
  }
  const allQueries: QueryItem[] = [];
  console.log("Loading project queries...");
  for (const [project, loader] of Object.entries(LOADERS)) {
    if (args.project && args.project !== project) continue;
    const loaded = await loader();
    if (loaded.length === 0) {
      console.log(`::warning::loader "${project}" returned 0 queries — its data source and the snapshot are both unavailable, so this project is invisible to this run`);
    }
    allQueries.push(...loaded);
  }

  // ── Named-venue keys get NO generic fallback, whatever the loader said ───
  // The rule lives in the loaders (lib/query-policy.ts rule 1), but the
  // fetcher is the write path and a rule enforced only at the source is a rule
  // that a stale queries.snapshot.json escapes — the snapshot in this repo was
  // eight weeks old and still carried `"{setting} corporate retreat venue
  // landscape"` on every offsite venue. Strip it here too, loudly.
  const { items: policedQueries, stripped } = stripVenueFallbacks(allQueries);
  if (stripped.length > 0) {
    console.log(
      `  ⚠ stripped a generic fallbackQuery from ${stripped.length} named-venue key(s) — ` +
        `a venue miss must stay a miss (e.g. ${stripped.slice(0, 3).join(", ")})`,
    );
  }

  // ── pending = not cached AND not under a fresh tombstone ────────────────
  // The second half is the fix for the dead queue head. Before it, a miss
  // wrote nothing, so the first N pending keys were re-asked (and re-missed)
  // every two hours forever while ~1,190 keys behind them were never attempted
  // once. A tombstone expires after MISS_TTL_DAYS or the moment the query text
  // changes — see lib/misses.ts. The rule itself lives in lib/queue.ts so it
  // can be run, and tested, on its own.
  const { queue, suppressed } = buildQueue(policedQueries, cache, misses, {
    refetch: args.refetch,
    retryMisses: args.retryMisses,
  });

  const stats = missStats(misses);
  console.log(
    `Shared cache fetch — ${policedQueries.length} total queries, ${queue.length} pending`,
  );
  console.log(`  cache currently holds ${Object.keys(cache).length} entries`);
  console.log(
    `  ${suppressed.length} key(s) held back by a fresh miss tombstone ` +
      `(${stats.fresh} fresh / ${stats.total} recorded, TTL ${MISS_TTL_DAYS}d)` +
      (args.retryMisses ? " — IGNORED this run (--retry-misses)" : ""),
  );

  if (args.dryRun) {
    console.log("\n-- DRY RUN: no network calls, no writes --");
    const byProject = new Map<string, number>();
    for (const q of queue) {
      const p = q.key.split("/")[0];
      byProject.set(p, (byProject.get(p) ?? 0) + 1);
    }
    for (const [p, n] of [...byProject].sort()) console.log(`  ${p}: ${n} pending`);
    console.log(`\n  next ${Math.min(args.limit, queue.length)} key(s) this run would ask for:`);
    for (const q of queue.slice(0, args.limit)) {
      console.log(`    ${q.key}  <- "${q.query}"${q.fallbackQuery ? `  (fallback: "${q.fallbackQuery}")` : ""}`);
    }
    return;
  }

  if (queue.length === 0) {
    console.log("✓ Nothing to fetch — every desired key is cached or tombstoned");
    if (args.commit) commitAndPush(0);
    return;
  }

  // Ask every configured source whether it is actually listening, BEFORE
  // spending the run on it. Health is entries added, not workflow green.
  console.log("\nProbing image sources...");
  const probes = await probeSources(keys, pexelsKey);
  const deadSource = probes.find((p) => p.configured && !p.ok);
  if (deadSource) {
    // Do not spend the budget against a source we already know is refusing.
    const verdict = evaluateRunHealth({
      processed: 0,
      added: 0,
      tombstoned: 0,
      pendingBefore: queue.length,
      zeroResultKeys: 0,
      ceilingRejectedKeys: 0,
      probes,
    });
    reportRunHealth(verdict, {
      processed: 0,
      added: 0,
      tombstoned: 0,
      pendingBefore: queue.length,
      zeroResultKeys: 0,
      ceilingRejectedKeys: 0,
      probes,
    });
    console.error("✘ Aborting before the run — fix the credential, do not spend the budget on it.");
    process.exit(1);
  }
  if (pexelsKey && !probes.find((p) => p.name === "pexels")?.ok) {
    pexelsRemaining = 0;
  }

  const batch = queue.slice(0, args.limit);
  console.log(`  processing up to ${batch.length} this run\n`);

  let processed = 0;
  let added = 0;
  let aborted = false;
  /**
   * Unsplash has no hourly budget left. NOT a reason to stop: Pexels carries a
   * separate 200/hr and 25k/month, and until 2026-08-21 the run aborted here
   * anyway — killing a fetch that still had ~24,900 Pexels requests in hand.
   * With Unsplash on the Demo tier (50/hr x 3 keys) that ceiling arrived after
   * ~75 keys and left 1,507 uncached. Exhausted means "stop asking Unsplash",
   * not "stop working".
   */
  let unsplashExhausted = false;
  let missesChanged = false;
  /** Keys where every source returned NOTHING — the silent-401 signature. */
  let zeroResultKeys = 0;
  /** Keys that found photos but all of them were already at the fan-out ceiling. */
  let ceilingRejectedKeys = 0;

  for (const item of batch) {
    processed++;
    try {
      // Ceiling-aware selection (lib/fanout.ts): walk the candidates
      // best-first and take the first photo that would NOT become a
      // duplicate-fanout violation. Taking results[0] unconditionally is the
      // root cause of the 2026-08-20 state — obscure named-venue queries all
      // collapse to the same popular generic photo, and one lake ended up as
      // 24 "different" venues. A miss beats a duplicate: if every candidate
      // is at ceiling, no entry is written and the key stays pending for a
      // better source (Pexels below, an override, or a human).
      let skippedAtCeiling = 0;
      const pickNonViolating = (
        entries: Omit<CacheEntry, "addedBy">[],
      ): Omit<CacheEntry, "addedBy"> | null => {
        for (const e of entries) {
          if (!wouldViolate(cache, item.key, e.url)) return e;
          skippedAtCeiling++;
        }
        return null;
      };

      // Tiers 1-2: Unsplash primary, then the fallback phrasing. Skipped
      // wholesale once Unsplash is out of budget — a request we know will 403
      // is a second of sleep and a log line, not a photograph.
      let result: { entries: Omit<CacheEntry, "addedBy">[]; ratelimitRemaining: number } = {
        entries: [],
        ratelimitRemaining: NaN,
      };
      let chosen: Omit<CacheEntry, "addedBy"> | null = null;
      let usedFallback = false;

      if (!unsplashExhausted) {
        try {
          const result0 = await searchUnsplash(item.query, nextKey());
          result = result0;
          chosen = pickNonViolating(result0.entries);

          if (
            !chosen &&
            item.fallbackQuery &&
            item.fallbackQuery !== item.query &&
            !Number.isNaN(result.ratelimitRemaining) &&
            result.ratelimitRemaining > RATELIMIT_FLOOR + 2
          ) {
            await sleep(SLEEP_MS);
            const fb = await searchUnsplash(item.fallbackQuery, nextKey());
            result = fb;
            const fbChosen = pickNonViolating(fb.entries);
            if (fbChosen) {
              chosen = fbChosen;
              usedFallback = true;
            }
          }
        } catch (err) {
          // A rate-limited Unsplash retires that SOURCE for the rest of the
          // run and falls through to Pexels for THIS key — the item is not
          // skipped and is not tombstoned, because "Unsplash ran out of
          // budget" is not evidence that no photograph exists. Any other
          // Unsplash error is genuine and rethrown to the per-item handler.
          if (err instanceof UnsplashRateLimitError) {
            unsplashExhausted = true;
            console.log(
              `\n⚠  Unsplash hourly budget spent — continuing on Pexels for the rest of this run\n`,
            );
          } else {
            throw err;
          }
        }
      }

      // Pexels — tier 3 normally, tier 1 once Unsplash is spent. A different
      // library, so it often resolves where Unsplash didn't: on the first pass
      // after the key landed it rescued 9 of 25 bestman keys, 8 of them already
      // tombstoned as "no results".
      //
      // WHICH PHRASING IT ASKS depends on why we got here, because those are
      // two different questions:
      //   · Unsplash was ASKED and found nothing -> the specific phrasing is
      //     already disproven for this subject, so go broad with the fallback.
      //   · Unsplash was SKIPPED (out of budget) -> nothing has been disproven.
      //     Ask the specific query first; a broad query here would trade
      //     subject accuracy for nothing and feed the fan-out ceiling generic
      //     photos it will then have to reject.
      let usedPexels = false;
      if (!chosen && pexelsKey && pexelsRemaining > 5) {
        const pexelsQueries = unsplashExhausted
          ? [item.query, item.fallbackQuery].filter((q): q is string => Boolean(q))
          : [item.fallbackQuery || item.query];

        for (const pq of pexelsQueries) {
          if (chosen || pexelsRemaining <= 5) break;
          await sleep(SLEEP_MS);
          try {
            const pex = await searchPexels(pq, pexelsKey);
            if (pex.entries.length) {
              // Pexels entries already match Omit<CacheEntry, "addedBy">; they
              // face the same ceiling check as every Unsplash candidate.
              //
              // NAMED VENUES DELIBERATELY GET ONLY THE TOP CANDIDATE. For a
              // tile, a deeper candidate is another equally-valid mood photo,
              // so walking the list is pure upside. For `<project>/venues/<x>`
              // the photo is an IDENTITY claim, and photos[3] is no more likely
              // to actually BE that property than photos[0] — walking would
              // only find a generic photo nobody else had used yet, i.e. the
              // "same lie, deduplicated" that check-venue-identity.ts exists to
              // stop (30 venues re-filled that way within 6h of the 2026-08-20
              // cut, every one of them passing the fan-out gate). For a venue,
              // a MISS is the correct answer, and Offsite already renders
              // photo-less venues as text rows rather than empty tiles.
              const pexCandidates = isNamedVenueKey(item.key)
                ? pex.entries.slice(0, 1)
                : pex.entries;
              const pexChosen = pickNonViolating(pexCandidates);
              if (pexChosen) {
                chosen = pexChosen;
                usedPexels = true;
              }
            }
            if (!Number.isNaN(pex.ratelimitRemaining)) {
              pexelsRemaining = pex.ratelimitRemaining;
            }
          } catch (err) {
            if (err instanceof PexelsRateLimitError) {
              console.log(`  ⚠ Pexels rate-limited; disabling for the rest of this run`);
              pexelsRemaining = 0;
              break;
            }
            console.error(`  Pexels error on "${pq}":`, err instanceof Error ? err.message : err);
          }
        }
      }

      if (chosen) {
        const entry: CacheEntry = { ...chosen, addedBy: item.addedBy };
        cache[item.key] = entry;
        added++;
        // A key that now HAS a photo has no business carrying a tombstone.
        if (clearMiss(misses, item.key)) missesChanged = true;
        const tag = usedPexels ? "⊕" : usedFallback ? "↻" : "✓";
        const sourceLabel = usedPexels ? `pexels: ${pexelsRemaining} left` : `${result.ratelimitRemaining} left`;
        console.log(
          `  [${processed}/${batch.length}] ${item.label || item.key} ${tag} (${sourceLabel})` +
            (usedFallback && !usedPexels ? `  fallback: "${item.fallbackQuery}"` : "") +
            (usedPexels ? `  via Pexels` : "") +
            (skippedAtCeiling > 0 ? `  (${skippedAtCeiling} candidate(s) skipped at fan-out ceiling)` : ""),
        );
      } else if (skippedAtCeiling > 0) {
        // A miss beats a duplicate — say so explicitly so a run's output
        // never reads as "the query found nothing".
        ceilingRejectedKeys++;
        const rec = recordMiss(misses, item, "all-candidates-at-ceiling");
        missesChanged = true;
        console.log(
          `  [${processed}/${batch.length}] ${item.label || item.key} — MISS: all ${skippedAtCeiling} candidate(s) already at fan-out ceiling for "${item.query}" (tombstoned, attempt ${rec.attempts}, retry in ${MISS_TTL_DAYS}d)`,
        );
      } else {
        zeroResultKeys++;
        const rec = recordMiss(misses, item, "no-results");
        missesChanged = true;
        console.log(
          `  [${processed}/${batch.length}] ${item.label || item.key} — no results for "${item.query}" (tombstoned, attempt ${rec.attempts}, retry in ${MISS_TTL_DAYS}d)`,
        );
      }

      saveCache(cache);
      if (missesChanged) saveMisses(misses);

      if (
        !unsplashExhausted &&
        !Number.isNaN(result.ratelimitRemaining) &&
        result.ratelimitRemaining < RATELIMIT_FLOOR
      ) {
        unsplashExhausted = true;
        console.log(
          `\n⚠  Unsplash down to ${result.ratelimitRemaining} requests — continuing on Pexels for the rest of this run\n`,
        );
      }

      // The run stops only when EVERY source is spent. Stopping while another
      // source still has budget is what left 1,507 keys uncached.
      if (unsplashExhausted && (!pexelsKey || pexelsRemaining <= 5)) {
        console.log(
          `\n⚠  Stopping early — every configured source is out of budget ` +
            `(unsplash spent, pexels ${pexelsKey ? `${pexelsRemaining} left` : "not configured"})`,
        );
        aborted = true;
        break;
      }
    } catch (err) {
      if (err instanceof UnsplashRateLimitError) {
        // Reached only from outside the Unsplash block above (it handles its
        // own). Retire the source; let the next item try Pexels.
        unsplashExhausted = true;
        console.log(`\n⚠  Unsplash hourly budget spent — continuing on Pexels\n`);
        continue;
      }
      console.error(
        `  ✘ ${item.label || item.key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (processed < batch.length) await sleep(SLEEP_MS);
  }

  saveCache(cache);
  saveMisses(misses);

  const remaining = queue.length - processed;
  const tombstoned = zeroResultKeys + ceilingRejectedKeys;
  console.log(
    `\n✓ Done — ${processed} processed, ${added} new entries added${aborted ? " (aborted early)" : ""}, ` +
      `${tombstoned} miss(es) tombstoned, ${remaining} left in this run's queue`,
  );

  const runStats: RunStats = {
    processed,
    added,
    tombstoned,
    pendingBefore: queue.length,
    zeroResultKeys,
    ceilingRejectedKeys,
    probes,
  };
  const verdict = evaluateRunHealth(runStats);
  reportRunHealth(verdict, runStats);

  // Commit when anything DURABLE changed. Gating on `added > 0` alone is what
  // made the tombstones pointless on CI: a run that adds nothing but records
  // 40 misses has moved the queue head forward, and throwing that away is
  // exactly the loop this change exists to break.
  if (args.commit && (added > 0 || missesChanged)) commitAndPush(added, tombstoned);
  if (remaining > 0) {
    console.log(`  Re-run \`npm run fetch\` after the rate-limit window resets (~1 hour)`);
  }

  // Exit non-zero LAST, after the commit: a run that recorded misses has done
  // real work and that work must land even when the run is judged unhealthy.
  if (verdict.status === "fail") process.exitCode = 1;
}

function commitAndPush(added: number, tombstoned = 0): void {
  // The cron workflows (fetch-images.yml, daily-maxout.yml) push to main
  // through THIS function, so the gate here is what makes the ceilings
  // un-bypassable on the write path: a violating cache never leaves the
  // runner. Selection above should make this unreachable; if it fires,
  // selection and gate disagree and THAT is the bug to fix.
  try {
    execSync("npm run --silent gate", {
      stdio: "inherit",
      cwd: REPO_ROOT,
    });
  } catch {
    console.error("✘ cache gates FAILED — refusing to commit/push this cache state");
    process.exitCode = 1;
    return;
  }
  try {
    process.chdir(REPO_ROOT);
    execSync("git add cache.json misses.json", { stdio: "inherit" });
    const status = execSync("git status --porcelain cache.json misses.json", {
      encoding: "utf8",
    });
    if (!status.trim()) {
      console.log("  (no cache changes to commit)");
      return;
    }
    const ts = new Date().toISOString();
    const what =
      tombstoned > 0
        ? `${added} new entries, ${tombstoned} miss(es) tombstoned`
        : `${added} new entries`;
    execSync(`git commit -m "fetch: ${what} @ ${ts}"`, { stdio: "inherit" });
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
