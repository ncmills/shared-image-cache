/**
 * selftest-m6 — offline assertions for the M6 image-corpus fields
 * (CORPUS-M6 spec §2a/§2b/§5 U2). Same harness style as selftest.ts: no deps,
 * NO NETWORK (the two API writers run against a stubbed `fetch`), no budget.
 *
 * Every rule here is asserted by CALLING the function the gate / writer / fetcher
 * calls, never a copy of its logic. Each rule has a control: a fixture built to
 * fail it, which must fail.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Cache, CacheEntry, CacheEntryM6, ImageVerdict } from "../lib/types";
import { toM6Entry, checkM6Entry, checkM6, hasM6Fields } from "../lib/m6";
import {
  verdictStatus,
  isDenied,
  validateVerdicts,
  checkAppendOnly,
  loadVerdicts,
  SURFACES,
} from "../lib/verdicts";
import { pickCandidate } from "../lib/select";
import { searchUnsplash } from "../lib/unsplash";
import { searchPexels } from "../lib/pexels";
import { mirrorProject } from "./mirror-overrides";
import { migrateShowcases, migrateTdf } from "./seed-from-projects";
import { planEviction, applyEviction } from "./evict-duplicates";
import { backfillM6, serializeCache } from "./backfill-m6";
import { ledgerGrowth } from "./check-m6";

let failures = 0;
let checks = 0;
let currentSuite = "";
function suite(name: string) {
  currentSuite = name;
  console.log(`\n── ${name} ──`);
}
function ok(condition: boolean, what: string, detail = "") {
  checks++;
  if (condition) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.error(`  ✗ ${currentSuite}: ${what}${detail ? `\n      ${detail}` : ""}`);
  }
}
function eq<T>(actual: T, expected: T, what: string) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const rules = (key: string, e: unknown) => checkM6Entry(key, e).map((v) => v.rule);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// Real rows from cache.json @ d1b7be0 (verbatim).
const PEXELS_ROW: CacheEntry = {
  url: "https://images.pexels.com/photos/20856613/pexels-photo-20856613.jpeg?auto=compress&cs=tinysrgb&h=650&w=940",
  alt: "Vintage El Vado Motel sign against a clear blue sky, evoking classic Americana.",
  photographerName: "Airam Dato-on",
  photographerUrl: "https://www.pexels.com/@airamdphoto",
  unsplashUrl: "https://www.pexels.com/photo/sign-of-the-el-vado-motel-in-albuquerque-20856613/",
  query: "Albuquerque New Mexico rooftop bar",
  fetchedAt: "2026-08-21T20:44:36.839Z",
  addedBy: "bestman",
};
const UNSPLASH_ROW: CacheEntry = {
  url: "https://images.unsplash.com/photo-1585531455743-0c272a0b8cd1?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1080",
  alt: "blue car parked in front of brown concrete building",
  photographerName: "Meritt Thomas",
  photographerUrl: "https://unsplash.com/@merittthomas?utm_source=shared_image_cache&utm_medium=referral",
  unsplashUrl:
    "https://unsplash.com/photos/blue-car-parked-in-front-of-brown-concrete-building-m-WhWVdsaEw?utm_source=shared_image_cache&utm_medium=referral",
  query: "Ambergris Caye Belize rooftop bar",
  fetchedAt: "2026-08-21T18:52:37.010Z",
  addedBy: "bestman",
};
// A mirror-overrides row: page = CDN url, profile = the unsplash.com homepage.
const MIRROR_ROW: CacheEntry = {
  url: "https://images.unsplash.com/photo-1646241651636-49549005a1a3?crop=entropy&w=1080",
  alt: "Craft brewery taproom with industrial decor",
  photographerName: "Growth + Co.",
  photographerUrl: "https://unsplash.com/?utm_source=shared_image_cache&utm_medium=referral",
  unsplashUrl: "https://images.unsplash.com/photo-1646241651636-49549005a1a3",
  query: "marquee venue override (asheville-nc / activities / 4)",
  fetchedAt: "2026-04-26T00:00:00.000Z",
  addedBy: "bestman",
};
const LEGACY_KEYS = ["url", "alt", "photographerName", "photographerUrl", "unsplashUrl", "query", "fetchedAt", "addedBy"] as const;

// ══ 1. toM6Entry derivation ═══════════════════════════════════════════════
suite("toM6Entry derives the §2a fields");
try {
  const p = toM6Entry(PEXELS_ROW);
  eq(p.provider, "pexels", "pexels: provider from the CDN host");
  eq(p.photoId, "pexels:20856613", "pexels: photoId = photoIdFromUrl(url)");
  eq(p.licence, "pexels-api", "pexels: licence");
  eq(p.sourceUrl, "https://www.pexels.com/photo/20856613/", "pexels: sourceUrl is id-only, no slug, no query");
  eq(p.credit, {
    complete: true,
    text: "Photo by Airam Dato-on on Pexels",
    photographerName: "Airam Dato-on",
    photographerUrl: "https://www.pexels.com/@airamdphoto",
    providerUrl: "https://www.pexels.com",
  }, "pexels: credit — complete, says Pexels");

  const u = toM6Entry(UNSPLASH_ROW);
  eq(u.provider, "unsplash", "unsplash: provider");
  eq(u.photoId, "unsplash:1585531455743-0c272a0b8cd1", "unsplash: photoId");
  eq(u.licence, "unsplash-api", "unsplash: licence");
  eq(u.sourceUrl, "https://unsplash.com/photos/m-WhWVdsaEw", "unsplash: sourceUrl = last 11 chars of the page path, no slug, no utm");
  eq(u.credit.photographerUrl, "https://unsplash.com/@merittthomas", "unsplash: profile URL with the baked utm DROPPED");
  eq(u.credit.text, "Photo by Meritt Thomas on Unsplash", "unsplash: credit text");
  eq(u.credit.complete, true, "unsplash: complete");

  for (const k of LEGACY_KEYS) eq((u as any)[k], (UNSPLASH_ROW as any)[k], `legacy field \`${k}\` kept verbatim`);

  eq(JSON.stringify(toM6Entry(toM6Entry(PEXELS_ROW))), JSON.stringify(p), "idempotent: toM6Entry(toM6Entry(x)) has identical bytes");

  const m = toM6Entry(MIRROR_ROW);
  eq(m.credit.complete, false, "mirror-shaped row (CDN as page, homepage as profile) is complete:false");
  eq(m.credit.text, "", "…its text is \"\" — never a fallback string");
  eq(m.sourceUrl, "", "…its sourceUrl is \"\" (no photo page known)");
  eq(m.credit.photographerUrl, "", "…and the homepage is NOT stored as a profile");

  const mismatched = toM6Entry({ ...PEXELS_ROW, unsplashUrl: "https://www.pexels.com/photo/some-slug-999/" });
  eq(mismatched.sourceUrl, "", "pexels page id ≠ CDN id → sourceUrl \"\" (never a guessed page)");
  eq(mismatched.credit.complete, false, "…and complete:false");

  for (const row of [p, u, m]) {
    const links = [row.sourceUrl, row.credit.photographerUrl, row.credit.providerUrl].filter(Boolean);
    ok(links.every((l) => !l.includes("?")), `no query on any new link (${row.photoId})`);
  }

  let threw = false;
  try {
    toM6Entry({ ...PEXELS_ROW, url: "https://lh3.googleusercontent.com/places/abc" });
  } catch {
    threw = true;
  }
  ok(threw, "a non-provider host (e.g. Google Places) THROWS — fenced out, cannot enter the cache");
} catch (e) {
  failures++;
  console.error(`  ✗ ${currentSuite}: threw ${e instanceof Error ? e.message : e}`);
}

// ══ 2. The gate (checkM6Entry / checkM6) ══════════════════════════════════
suite("gate:m6 rules, each with a control");
try {
  const good = toM6Entry(PEXELS_ROW);
  eq(rules("bestman/cities/x/bars", good), [], "a derived row passes");
  eq(rules("bestman/cities/x/bars", toM6Entry(UNSPLASH_ROW)), [], "a derived unsplash row passes");
  eq(rules("bestman/venues/x/a/1", toM6Entry(MIRROR_ROW)), [], "a derived complete:false row passes");

  const lie = clone(good);
  lie.credit.text = "Photo by Airam Dato-on on Unsplash";
  ok(rules("k", lie).includes("credit-provider-word"), "CONTROL: a pexels row whose credit says Unsplash FAILS");

  const textOnIncomplete = clone(toM6Entry(MIRROR_ROW));
  textOnIncomplete.credit.text = "Photo on Unsplash";
  ok(rules("k", textOnIncomplete).includes("incomplete-has-text"), "CONTROL: complete:false with a text FAILS");

  const homepageComplete = clone(good);
  homepageComplete.credit.photographerUrl = "https://www.pexels.com/";
  ok(rules("k", homepageComplete).includes("complete-invariant"), "CONTROL: complete:true with a non-profile URL FAILS");

  const noName = clone(good);
  noName.credit.photographerName = "";
  ok(rules("k", noName).includes("complete-invariant"), "CONTROL: complete:true with an empty name FAILS");

  const wrongProvider = clone(good) as any;
  wrongProvider.provider = "unsplash";
  ok(rules("k", wrongProvider).includes("provider-host"), "CONTROL: provider ≠ CDN host FAILS");

  const wrongPid = clone(good);
  wrongPid.photoId = "pexels:1";
  ok(rules("k", wrongPid).includes("photoid"), "CONTROL: photoId ≠ photoIdFromUrl(url) FAILS");

  const slugged = clone(good);
  slugged.sourceUrl = "https://www.pexels.com/photo/sign-of-the-el-vado-motel-in-albuquerque-20856613/";
  ok(rules("k", slugged).includes("source-url"), "CONTROL: a slugged sourceUrl FAILS");

  const queried = clone(good);
  queried.credit.photographerUrl = "https://www.pexels.com/@airamdphoto?utm_source=x";
  ok(rules("k", queried).includes("link-query"), "CONTROL: a query on a new link FAILS");

  const pidMismatch = clone(good);
  pidMismatch.sourceUrl = "https://www.pexels.com/photo/1/";
  ok(rules("k", pidMismatch).includes("source-url"), "CONTROL: pexels sourceUrl id ≠ CDN id FAILS");

  const noLicence = clone(good) as any;
  delete noLicence.licence;
  ok(rules("k", noLicence).length > 0, "CONTROL: remove one M6 field → FAILS");

  const verifiedInCache = { ...clone(good), verified: { photoId: good.photoId, subject: "x", verifiedAt: "2026-10-01" } };
  ok(rules("k", verifiedInCache).includes("verified-in-cache"), "CONTROL: a `verified` stamp inside cache.json FAILS (verdicts live in verdicts.json)");

  const cache = { "a/b/legacy": PEXELS_ROW, "a/b/new": PEXELS_ROW, "a/b/m6": good } as unknown as Cache;
  const r = checkM6(cache, new Set(["a/b/legacy"]));
  eq(r.violations.map((v) => `${v.key}:${v.rule}`), ["a/b/new:missing-m6"], "a legacy-shaped row FAILS unless its key is in the pre-M6 ledger");
  eq(r.legacyRemaining, 1, "…and the ledger rows still owed are counted");
  const half = { ...PEXELS_ROW, provider: "pexels" };
  eq(checkM6({ "a/b/legacy": half } as unknown as Cache, new Set(["a/b/legacy"])).violations.map((v) => v.rule), ["missing-m6"],
    "CONTROL: a HALF-written row (some M6 fields) is never grandfathered by the ledger");
  eq(ledgerGrowth(new Set(["a", "b"]), new Set(["a", "b", "c"])), [], "the ledger may shrink");
  eq(ledgerGrowth(new Set(["a", "z"]), new Set(["a", "b"])), ["z"], "CONTROL: a key ADDED to the ledger is reported (gate fails)");
} catch (e) {
  failures++;
  console.error(`  ✗ ${currentSuite}: threw ${e instanceof Error ? e.message : e}`);
}

// ══ 3. Every writer emits M6 rows ═════════════════════════════════════════
suite("all four writers + the evictor emit M6 rows");
try {
  const realFetch = globalThis.fetch;
  const fakeResponse = (body: unknown) =>
    ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === "x-ratelimit-remaining" ? "40" : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  {
    // Writer 1 — lib/unsplash.ts (stubbed fetch, no network)
    globalThis.fetch = (async () =>
      fakeResponse({
        total: 1,
        total_pages: 1,
        results: [
          {
            id: "m-WhWVdsaEw",
            alt_description: "blue car",
            description: null,
            urls: { raw: "", full: "", regular: UNSPLASH_ROW.url, small: "" },
            user: { name: "Meritt Thomas", username: "merittthomas", links: { html: "https://unsplash.com/@merittthomas" } },
            links: { html: "https://unsplash.com/photos/blue-car-parked-in-front-of-brown-concrete-building-m-WhWVdsaEw" },
          },
        ],
      })) as typeof fetch;
  }
  const us = (async () => searchUnsplash("q", "k"))();
  // Writer 2 — lib/pexels.ts
  const runPexels = async () => {
    globalThis.fetch = (async () =>
      fakeResponse({
        page: 1,
        per_page: 5,
        total_results: 1,
        photos: [
          {
            id: 20856613,
            width: 1,
            height: 1,
            url: PEXELS_ROW.unsplashUrl,
            photographer: "Airam Dato-on",
            photographer_url: "https://www.pexels.com/@airamdphoto",
            src: { original: "", large2x: "", large: PEXELS_ROW.url, medium: "", small: "" },
            alt: "El Vado",
          },
        ],
      })) as typeof fetch;
    return searchPexels("q", "k");
  };
  (globalThis as any).__m6_writers = Promise.all([us, us.then(runPexels)]).then(([u, p]) => {
    globalThis.fetch = realFetch;
    return { u, p };
  });
} catch (e) {
  failures++;
  console.error(`  ✗ ${currentSuite}: threw ${e instanceof Error ? e.message : e}`);
}

async function writersAsync() {
  suite("all four writers + the evictor emit M6 rows (async part)");
  const { u, p } = await (globalThis as any).__m6_writers;
  ok(u.entries.length === 1 && hasM6Fields(u.entries[0]) && rules("k", { ...u.entries[0], addedBy: "x" }).length === 0,
    "writer lib/unsplash.ts: candidate carries valid M6 fields");
  eq(u.entries[0]?.credit?.text, "Photo by Meritt Thomas on Unsplash", "…credit says Unsplash");
  ok(p.entries.length === 1 && hasM6Fields(p.entries[0]) && rules("k", { ...p.entries[0], addedBy: "x" }).length === 0,
    "writer lib/pexels.ts: candidate carries valid M6 fields");
  eq(p.entries[0]?.credit?.text, "Photo by Airam Dato-on on Pexels", "…credit says Pexels, not Unsplash");

  // Writer 3 — scripts/mirror-overrides.ts, on a fixture
  const mc: Cache = {};
  mirrorProject(mc, "bestman", {
    "asheville-nc::activities::4": { url: MIRROR_ROW.url, credit: "Growth + Co. on Unsplash", alt: "taproom", addedAt: "2026-04-26" },
  });
  const mrow = mc["bestman/venues/asheville-nc/activities/4"];
  ok(hasM6Fields(mrow) && rules("bestman/venues/asheville-nc/activities/4", mrow).length === 0, "writer mirror-overrides.ts: emits valid M6 fields");
  eq((mrow as CacheEntryM6).credit?.complete, false, "…complete:false (no page, no profile) — never invented");

  // Writer 4 — scripts/seed-from-projects.ts, on fixtures
  const sc: Cache = {};
  migrateShowcases(sc, { "andre-miami-fl": { bars: "https://images.unsplash.com/photo-1562517634-baa2da3acfbf?w=1080" } }, "bestman");
  migrateTdf(sc, { destinations: { "scottsdale-az": { ...UNSPLASH_ROW } as any }, bachelorParty: {}, guides: {} });
  const srow = sc["bestman/showcases/andre-miami-fl/bars"];
  ok(hasM6Fields(srow) && rules("k", srow).length === 0, "writer seed-from-projects.ts (showcases): emits valid M6 fields");
  eq((srow as CacheEntryM6).credit?.complete, false, "…complete:false with text \"\"");
  const trow = sc["tdf/destinations/scottsdale-az"];
  ok(hasM6Fields(trow) && rules("k", trow).length === 0, "writer seed-from-projects.ts (tdf): emits valid M6 fields");

  // Evictor — scripts/evict-duplicates.ts
  const m6a = toM6Entry(PEXELS_ROW);
  const ec = { "a/c/1": m6a, "a/c/2": { ...m6a, query: "x" }, "a/d/legacy": UNSPLASH_ROW } as unknown as Cache;
  const plan = planEviction(ec, 2);
  const after = applyEviction(ec, plan.evictKeys);
  eq(plan.evictKeys, ["a/c/2"], "evictor still evicts the shorter-query duplicate");
  eq(JSON.stringify(after["a/c/1"]), JSON.stringify(m6a), "evictor preserves an M6 survivor byte-for-byte");
  ok(hasM6Fields(after["a/d/legacy"]), "evictor writes every survivor through toM6Entry");

  // fetch.ts write site goes through toM6Entry (structural; the candidates themselves are tested above)
  const fetchSrc = readFileSync(resolve(__dirname, "fetch.ts"), "utf8");
  ok(/cache\[item\.key\]\s*=\s*toM6Entry\(/.test(fetchSrc), "fetch.ts stores the chosen candidate through toM6Entry");
}

// ══ 4. Verdicts — §2b status order ═════════════════════════════════════════
suite("verdictStatus (§2b order: denied > verified > stale > unverified)");
try {
  const v = (over: Partial<ImageVerdict>): ImageVerdict => ({
    key: "offsite/settings/alpine",
    photoId: "unsplash:aaa",
    verdict: "match",
    shows: "an alpine lodge",
    crop: { surface: "oo/setting-tile", w: 576, h: 360, fit: "cover" },
    verifiedBy: "offsite-outpost#52",
    verifiedAt: "2026-08-20",
    ...over,
  });
  const K = "offsite/settings/alpine";
  eq(verdictStatus([v({})], K, "unsplash:aaa", "oo/setting-tile"), "verified", "a match at the exact surface → verified");
  eq(
    verdictStatus([v({ verifiedAt: "2026-08-01" }), v({ verdict: "mismatch", verifiedAt: "2026-09-01" })], K, "unsplash:aaa", "oo/setting-tile"),
    "denied",
    "CONTROL (a): a match + a newer mismatch on the same photo → denied",
  );
  eq(
    verdictStatus([v({ verifiedAt: "2026-09-01" }), v({ verdict: "mismatch", verifiedAt: "2026-08-01", crop: { surface: "oo/experience-card", w: 4, h: 3, fit: "cover" } })], K, "unsplash:aaa", "oo/setting-tile"),
    "denied",
    "a mismatch on ANY surface beats a newer match",
  );
  eq(verdictStatus([v({})], K, "unsplash:aaa", "oo/venue-hero"), "unverified", "CONTROL (b): a setting-tile match read for venue-hero → unverified (no superset)");
  eq(verdictStatus([v({})], K, "unsplash:bbb", "oo/setting-tile"), "stale", "CONTROL (c): verdicts only for another photoId → stale");
  eq(verdictStatus([v({ verdict: "mismatch" })], K, "unsplash:bbb", "oo/setting-tile"), "stale", "a mismatch on an OLD photo does not deny the new one");
  eq(verdictStatus([], K, "unsplash:aaa", "oo/setting-tile"), "unverified", "no verdict → unverified");
  ok(isDenied([v({ verdict: "mismatch" })], K, "unsplash:aaa"), "isDenied: mismatch on this key+photo");
  ok(!isDenied([v({ verdict: "mismatch", key: "offsite/settings/castle" })], K, "unsplash:aaa"), "isDenied is per KEY (the same photo may be right elsewhere)");

  eq(validateVerdicts([v({})]), [], "a well-formed verdict validates");
  ok(validateVerdicts([v({ crop: { surface: "oo/anything", w: 1, h: 1, fit: "cover" } })]).length > 0, "CONTROL: a surface outside the closed list FAILS");
  ok(validateVerdicts([v({ verifiedBy: "scripts/fetch.ts" })]).length > 0, "CONTROL: verifiedBy naming a script FAILS");
  ok(validateVerdicts([v({ verdict: "maybe" as any })]).length > 0, "CONTROL: a verdict outside match|mismatch FAILS");
  ok(validateVerdicts([v({ photoId: "1585531455743" })]).length > 0, "CONTROL: a photoId without provider prefix FAILS");
  ok(validateVerdicts({}).length > 0, "CONTROL: verdicts.json that is not an array FAILS");
  ok(SURFACES.includes("fm/destination-hero") && SURFACES.includes("oo/setting-tile"), "the closed surface list carries the spec's surfaces");

  const a = v({}), b = v({ key: "offsite/settings/castle" });
  eq(checkAppendOnly([a], [a, b]), [], "append-only: appending passes");
  ok(checkAppendOnly([a, b], [a]).length > 0, "CONTROL: append-only — deleting a verdict FAILS");
  ok(checkAppendOnly([a], [{ ...a, verdict: "mismatch" }]).length > 0, "CONTROL: append-only — editing a verdict FAILS");

  const committed = loadVerdicts();
  ok(Array.isArray(committed) && validateVerdicts(committed).length === 0, `committed verdicts.json loads and validates (${committed.length} rows)`);

  // Nothing in lib/ or scripts/ writes verdicts.json (the fetcher must never).
  const writers: string[] = [];
  for (const dir of ["lib", "scripts"]) {
    for (const f of readdirSync(resolve(__dirname, "..", dir))) {
      if (!/\.(ts|sh)$/.test(f) || f === "selftest-m6.ts") continue;
      const src = readFileSync(join(resolve(__dirname, "..", dir), f), "utf8");
      if (/(writeFileSync|appendFileSync|renameSync|copyFileSync|createWriteStream)\([^)]*verdicts/i.test(src) || />>?\s*\S*verdicts\.json|git add[^\n"`]*verdicts/.test(src)) writers.push(`${dir}/${f}`);
    }
  }
  eq(writers, [], "no file in lib/ or scripts/ writes verdicts.json");
} catch (e) {
  failures++;
  console.error(`  ✗ ${currentSuite}: threw ${e instanceof Error ? e.message : e}`);
}

// ══ 5. The fetcher skips a denied photo ════════════════════════════════════
suite("fetcher candidate selection honours verdicts");
try {
  const KEY = "friendsmoon/destinations/gulfport-ms";
  const wrong = { url: "https://images.pexels.com/photos/39004104/pexels-photo-39004104.jpeg" };
  const right = { url: "https://images.pexels.com/photos/111/pexels-photo-111.jpeg" };
  const deny: ImageVerdict = {
    key: KEY,
    photoId: "pexels:39004104",
    verdict: "mismatch",
    shows: "New Orleans, not Gulfport",
    crop: { surface: "fm/destination-hero", w: 1200, h: 560, fit: "cover" },
    verifiedBy: "friendsmoon#42",
    verifiedAt: "2026-09-25",
  };
  eq(pickCandidate({}, KEY, [wrong, right]).chosen, wrong, "CONTROL: with no verdicts the top candidate is taken");
  const r = pickCandidate({}, KEY, [wrong, right], [deny]);
  eq(r.chosen, right, "a candidate with a mismatch on THIS key is skipped; the next is taken");
  eq(r.skippedDenied, 1, "…and counted as skippedDenied");
  eq(pickCandidate({}, "friendsmoon/destinations/biloxi-ms", [wrong], [deny]).chosen, wrong, "a mismatch on another key does not skip it here");
  const none = pickCandidate({}, KEY, [wrong], [deny]);
  ok(none.chosen === null && none.skippedDenied === 1, "every candidate denied → MISS (never the denied photo)");
  const fetchSrc = readFileSync(resolve(__dirname, "fetch.ts"), "utf8");
  ok(/pickCandidate\(/.test(fetchSrc) && /loadVerdicts\(/.test(fetchSrc), "fetch.ts selects through pickCandidate with the loaded verdicts");
} catch (e) {
  failures++;
  console.error(`  ✗ ${currentSuite}: threw ${e instanceof Error ? e.message : e}`);
}

// ══ 6. Backfill (pure; NOT run on committed data here) ═════════════════════
suite("backfill-m6");
try {
  const legacy = { "b/c/p": PEXELS_ROW, "b/c/u": UNSPLASH_ROW, "b/venues/m/a/1": MIRROR_ROW } as Cache;
  const once = backfillM6(clone(legacy));
  const twice = backfillM6(clone(once.cache));
  eq(serializeCache(twice.cache), serializeCache(once.cache), "backfill twice → identical bytes");
  ok(Object.values(once.cache).every((e) => hasM6Fields(e)), "every row gains the M6 fields");
  const proj = (c: Cache) => Object.fromEntries(Object.entries(c).map(([k, e]) => [k, LEGACY_KEYS.map((f) => (e as any)[f])]));
  eq(proj(once.cache), proj(legacy), "the old 8 fields are unchanged on every row");
  eq(Object.keys(once.cache), Object.keys(legacy), "no row added or removed");
  eq((once.counts as any).incomplete, 1, "counts: 1 complete:false row in the fixture");
  eq((once.counts as any).provider, { pexels: 1, unsplash: 2 }, "counts: provider split");
} catch (e) {
  failures++;
  console.error(`  ✗ ${currentSuite}: threw ${e instanceof Error ? e.message : e}`);
}

// ══ 7. Committed state ═════════════════════════════════════════════════════
suite("committed state (gate:m6 on cache.json + ledger)");
try {
  const cachePath = resolve(__dirname, "..", "cache.json");
  const ledgerPath = resolve(__dirname, "..", "m6-legacy-ledger.json");
  ok(existsSync(ledgerPath), "m6-legacy-ledger.json exists");
  if (existsSync(cachePath) && existsSync(ledgerPath)) {
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Cache;
    const ledger = new Set<string>(JSON.parse(readFileSync(ledgerPath, "utf8")).keys);
    const r = checkM6(cache, ledger);
    eq(r.violations.length, 0, `cache.json passes gate:m6 (${r.legacyRemaining} pre-M6 rows owed to U2-data)`);
  }
} catch (e) {
  failures++;
  console.error(`  ✗ ${currentSuite}: threw ${e instanceof Error ? e.message : e}`);
}

writersAsync()
  .catch((e) => {
    failures++;
    console.error(`  ✗ writers: threw ${e instanceof Error ? e.message : e}`);
  })
  .finally(() => {
    console.log(`\n${failures === 0 ? "✓" : "✗"} selftest-m6: ${checks - failures}/${checks} checks passed`);
    if (failures > 0) process.exit(1);
  });
