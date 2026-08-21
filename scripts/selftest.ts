/**
 * selftest — offline assertions for the rules that keep this pipeline honest.
 *
 * Deliberately dependency-free (no vitest/jest): this repo's whole runtime is
 * tsx + node, and the fetch workflows run `npm install` on every cron tick.
 * Run with `npm test`. NO NETWORK, NO API BUDGET — every source is simulated,
 * which is the only way a fetch-path test can run in CI at all.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Cache, CacheEntry, QueryItem } from "../lib/types";
import { buildQueue } from "../lib/queue";
import {
  clearMiss,
  isSuppressed,
  missStats,
  recordMiss,
  MISS_TTL_DAYS,
  type Misses,
} from "../lib/misses";
import { checkQueryItem, stripVenueFallbacks } from "../lib/query-policy";
import { evaluateRunHealth, type RunStats } from "../lib/health";
import { checkVenueIdentity } from "./check-venue-identity";

let failures = 0;
let checks = 0;
let currentSuite = "";

function suite(name: string) {
  currentSuite = name;
  console.log(`\n── ${name} ──`);
}

function ok(condition: boolean, what: string, detail = "") {
  checks++;
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    failures++;
    console.error(`  ✗ ${currentSuite}: ${what}${detail ? `\n      ${detail}` : ""}`);
  }
}

function eq<T>(actual: T, expected: T, what: string) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    what,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const q = (key: string, query: string, fallbackQuery?: string): QueryItem => ({
  key,
  query,
  addedBy: key.split("/")[0],
  ...(fallbackQuery ? { fallbackQuery } : {}),
});

const photo = (url: string, query: string): CacheEntry => ({
  url,
  alt: "simulated",
  photographerName: "Nobody",
  photographerUrl: "https://example.invalid",
  unsplashUrl: "https://example.invalid",
  query,
  fetchedAt: new Date().toISOString(),
  addedBy: "test",
});

const daysFrom = (base: Date, days: number) =>
  new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

// ══ 1. Change B — a miss must move the queue head ═════════════════════════
suite("miss tombstones unjam the queue (Change B)");
{
  // Five keys in one project, nothing cached, nothing tombstoned. This is the
  // 2026-08-20 shape in miniature: a run with limit=2 asks for the first two,
  // both miss, and before this change the NEXT run asked for the same two
  // again — forever, while keys 3..5 were never attempted once.
  const items = [1, 2, 3, 4, 5].map((n) => q(`moh/cities/city-${n}`, `City ${n} cocktail bar`));
  const cache: Cache = {};
  const misses: Misses = {};
  const t0 = new Date("2026-08-20T12:00:00.000Z");

  const run1 = buildQueue(items, cache, misses, { now: t0 });
  eq(run1.queue.map((i) => i.key), items.map((i) => i.key), "run 1 queues all five keys");

  const LIMIT = 2;
  for (const item of run1.queue.slice(0, LIMIT)) {
    recordMiss(misses, item, "no-results", t0);
  }
  eq(Object.keys(misses).length, 2, "two misses wrote two tombstones");

  const run2 = buildQueue(items, cache, misses, { now: daysFrom(t0, 1 / 12) });
  eq(
    run2.queue[0]?.key,
    "moh/cities/city-3",
    "run 2's queue HEAD ADVANCED past the tombstoned keys",
  );
  eq(run2.queue.length, 3, "run 2 sees only the three untried keys");
  eq(run2.suppressed.map((i) => i.key), ["moh/cities/city-1", "moh/cities/city-2"], "the two tombstoned keys are reported as suppressed, not silently dropped");

  // Without the fix, the head never moves. Prove the old behaviour is gone by
  // asking for it explicitly: --retry-misses reproduces it on demand only.
  const forced = buildQueue(items, cache, misses, { now: t0, retryMisses: true });
  eq(forced.queue[0]?.key, "moh/cities/city-1", "--retry-misses deliberately re-asks a tombstoned key");

  // TTL: 29 days still suppressed, 31 days back in the queue.
  const day29 = buildQueue(items, cache, misses, { now: daysFrom(t0, MISS_TTL_DAYS - 1) });
  eq(day29.queue[0]?.key, "moh/cities/city-3", `a ${MISS_TTL_DAYS - 1}-day-old tombstone still suppresses`);
  const day31 = buildQueue(items, cache, misses, { now: daysFrom(t0, MISS_TTL_DAYS + 1) });
  eq(day31.queue[0]?.key, "moh/cities/city-1", `a tombstone older than ${MISS_TTL_DAYS}d expires and the key returns`);

  // A rewritten query is a different question — it must not stay suppressed,
  // or a query-hygiene fix silently does nothing.
  const rewritten = items.map((i) =>
    i.key === "moh/cities/city-1" ? q(i.key, "City 1 rooftop bar") : i,
  );
  const afterRewrite = buildQueue(rewritten, cache, misses, { now: t0 });
  eq(afterRewrite.queue[0]?.key, "moh/cities/city-1", "changing the query text revives the key immediately");

  // A key that gains a photo drops its tombstone.
  cache["moh/cities/city-2"] = photo("https://images.unsplash.com/photo-abc", "City 2 cocktail bar");
  ok(clearMiss(misses, "moh/cities/city-2"), "a filled key clears its tombstone");
  ok(!isSuppressed(misses, items[1], t0), "and is no longer suppressed");
  eq(missStats(misses, t0).fresh, 1, "one fresh tombstone remains");

  // Round-robin across projects survives the new filter.
  const mixed = [
    q("moh/cities/a", "A bar"),
    q("moh/cities/b", "B bar"),
    q("bestman/cities/a", "A rooftop"),
  ];
  eq(
    buildQueue(mixed, {}, {}, { now: t0 }).queue.map((i) => i.key),
    ["moh/cities/a", "bestman/cities/a", "moh/cities/b"],
    "lanes still round-robin across projects",
  );
}

// ══ 2. Change A — a named venue never takes a generic fallback ════════════
suite("named-venue identity (Change A)");
{
  const venue = q("offsite/venues/ashford-castle", "Ashford Castle Ireland", "castle corporate retreat venue landscape");
  const setting = q("offsite/settings/castle", "castle luxury corporate retreat resort landscape", "castle resort landscape");

  const violations = checkQueryItem(venue).map((v) => v.rule);
  ok(violations.includes("venue-no-fallback"), "policy rejects a fallbackQuery on a venue key");
  eq(checkQueryItem(setting).filter((v) => v.rule === "venue-no-fallback").length, 0, "a settings key KEEPS its fallback — there the setting IS the subject");

  const { items, stripped } = stripVenueFallbacks([venue, setting]);
  eq(stripped, ["offsite/venues/ashford-castle"], "the write path strips a venue fallback a stale snapshot smuggled in");
  ok(items[0].fallbackQuery === undefined, "…and the item reaches the fetcher with no second query");
  ok(items[1].fallbackQuery !== undefined, "…while the settings item is untouched");

  // The cache-side gate.
  const laundered: Cache = {
    "offsite/venues/ashford-castle": photo("https://images.unsplash.com/photo-1", "castle corporate retreat venue landscape"),
  };
  eq(checkVenueIdentity(laundered).map((f) => f.rule), ["generic-venue-query"], "the gate catches a single generic photo on one named venue — which the fan-out ceiling cannot see");

  const shared: Cache = {
    "offsite/venues/one": photo("https://images.unsplash.com/photo-2", "lake resort"),
    "offsite/venues/two": photo("https://images.unsplash.com/photo-3", "lake resort"),
  };
  eq(checkVenueIdentity(shared).map((f) => f.rule), ["shared-venue-query"], "the gate catches one query answering for two different properties");

  const mirrored: Cache = {
    "bestman/venues/charleston-sc/dining/0": photo("https://images.unsplash.com/photo-4", "marquee venue override (charleston-sc / dining / 0)"),
    "moh/venues/charleston-sc/dining/0": photo("https://images.unsplash.com/photo-5", "marquee venue override (charleston-sc / dining / 0)"),
  };
  eq(checkVenueIdentity(mirrored), [], "one marquee slot mirrored into two projects is NOT a violation");

  const honest: Cache = {
    "offsite/venues/ashford-castle": photo("https://images.unsplash.com/photo-6", "Ashford Castle Ireland"),
  };
  eq(checkVenueIdentity(honest), [], "a venue photo fetched by the venue's own name passes");
}

// ══ 3. Query hygiene ══════════════════════════════════════════════════════
suite("query hygiene rules");
{
  const rules = (item: QueryItem) => checkQueryItem(item).map((v) => v.rule).sort();

  ok(rules(q("moh/cities/new-orleans-la", "New Orleans LA cocktail bar")).includes("postal-state-code"), "a postal state code fails");
  ok(rules(q("moh/cities/new-orleans-la", "New Orleans Louisiana cocktail bar")).length === 0, "the expanded state name passes");
  ok(rules(q("friendsmoon/destinations/sonoma-ca", "Sonoma California golden hour")).includes("lighting-word"), "'golden hour' fails — it ranked a corgi above a vineyard");
  ok(rules(q("bestman/cities/austin-tx", "Austin Texas rooftop bar nightlife")).length === 0, "'nightlife' is not the lighting word 'night'");
  ok(rules(q("moh/cities/austin-tx", "Austin Texas bachelorette glam")).includes("staged-emotion-word"), "staged-emotion words fail");
  ok(rules(q("moh/cities/austin-tx", "Austin Texas cocktail bar pink neon sunset")).includes("too-many-terms"), "a 7-term city query fails — it returns zero and falls through");
  ok(rules(q("moh/cities/austin-tx", "Austin Texas cocktail bar", "Texas bar")).includes("widening-fallback"), "a fallback that widens past the city fails");
  ok(rules(q("moh/cities/austin-tx", "Austin Texas cocktail bar", "Austin bar")).length === 0, "a city-scoped fallback passes");

  const curated: QueryItem = {
    ...q("engagedmoon/destinations/new-york-ny", "New York City skyline dusk golden hour", "Manhattan New York evening light"),
    curated: true,
  };
  eq(checkQueryItem(curated), [], "a curated, human-reviewed query is exempt — engagedmoon queries dusk on purpose");
  const properName: QueryItem = {
    ...q("offsite/venues/the-line-la-koreatown", "The LINE LA Koreatown Openaire greenhouse restaurant"),
    curated: true,
  };
  eq(checkQueryItem(properName), [], "a real hotel called 'The LINE LA' is not a postal-code defect");
  const productName: QueryItem = q("offsite/outings/casino-gaming-night", "Casino Gaming Night nightlife corporate outing");
  eq(checkQueryItem(productName), [], "'Night' capitalised inside a product's own name is not a lighting term");
  ok(
    checkQueryItem(q("moh/cities/austin-tx", "Austin Texas rooftop night")).map((v) => v.rule).includes("lighting-word"),
    "…while lowercase 'night' from a template still fails",
  );

  const curatedVenueFallback: QueryItem = {
    ...q("offsite/venues/ashford-castle", "Ashford Castle Ireland", "castle resort"),
    curated: true,
  };
  ok(
    checkQueryItem(curatedVenueFallback).map((v) => v.rule).includes("venue-no-fallback"),
    "`curated` never exempts rule 1 — review does not make a generic photo a photo of the property",
  );
}

// ══ 4. Change D — health is entries added, not workflow green ═════════════
suite("run health (Change D)");
{
  const base: RunStats = {
    processed: 0,
    added: 0,
    tombstoned: 0,
    pendingBefore: 0,
    zeroResultKeys: 0,
    ceilingRejectedKeys: 0,
    probes: [{ name: "unsplash[1]", configured: true, ok: true, detail: "5 results" }],
  };

  eq(evaluateRunHealth({ ...base, processed: 40, added: 37, pendingBefore: 900 }).status, "ok", "a run that adds entries is healthy");

  // The silent-401: every query returns nothing, the workflow goes green, and
  // three days of budget produce zero. That must be a FAILURE.
  const silent401 = evaluateRunHealth({
    ...base,
    processed: 40,
    added: 0,
    tombstoned: 40,
    zeroResultKeys: 40,
    pendingBefore: 700,
  });
  eq(silent401.status, "fail", "40 processed / 0 added / every query empty FAILS the run");

  // A run that adds nothing because every candidate was already at the fan-out
  // ceiling is CORRECT behaviour — a miss beats a duplicate. It must warn, not
  // fail: a guard that fails correct output gets switched off.
  const allCeiling = evaluateRunHealth({
    ...base,
    processed: 40,
    added: 0,
    tombstoned: 40,
    ceilingRejectedKeys: 40,
    pendingBefore: 700,
  });
  eq(allCeiling.status, "warn", "0 added because every candidate was at the ceiling warns, it does not fail");

  const deadHead = evaluateRunHealth({ ...base, processed: 40, added: 0, tombstoned: 0, pendingBefore: 700 });
  eq(deadHead.status, "fail", "processed 40, added 0, recorded 0 misses = the queue did not advance");

  const badPexels = evaluateRunHealth({
    ...base,
    processed: 40,
    added: 40,
    pendingBefore: 700,
    probes: [
      { name: "unsplash[1]", configured: true, ok: true, detail: "5 results" },
      { name: "pexels", configured: true, ok: false, detail: "HTTP 401" },
    ],
  });
  eq(badPexels.status, "fail", "a configured source that does not answer FAILS even on a run that added entries");
  ok(
    badPexels.reasons.some((r) => r.includes("pexels")),
    "…and says which source, in the reason",
  );

  const noPexels = evaluateRunHealth({
    ...base,
    processed: 10,
    added: 8,
    pendingBefore: 50,
    probes: [
      { name: "unsplash[1]", configured: true, ok: true, detail: "5 results" },
      { name: "pexels", configured: false, ok: false, detail: "PEXELS_API_KEY not set" },
    ],
  });
  eq(noPexels.status, "warn", "an UNCONFIGURED source warns — it is never silent");

  const smallRun = evaluateRunHealth({ ...base, processed: 5, added: 0, tombstoned: 5, zeroResultKeys: 5, pendingBefore: 20 });
  eq(smallRun.status, "ok", "a small tail-end run with nothing left to find is not an alarm");
}

// ══ 5. The committed cache still passes its own gates ═════════════════════
suite("committed state");
{
  const cachePath = resolve(__dirname, "..", "cache.json");
  if (existsSync(cachePath)) {
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Cache;
    eq(checkVenueIdentity(cache).length, 0, "cache.json holds no generic photo under a property name");
    const genericVenues = Object.keys(cache).filter(
      (k) => /^[^/]+\/venues\//.test(k) && / corporate retreat venue landscape$/.test(cache[k].query || ""),
    );
    eq(genericVenues.length, 0, "zero venue entries carry the retired setting-level query");
  } else {
    console.log("  · SKIP cache.json checks — file not present");
  }
}

console.log(
  `\n${failures === 0 ? "✓" : "✗"} selftest: ${checks - failures}/${checks} checks passed`,
);
if (failures > 0) process.exit(1);
