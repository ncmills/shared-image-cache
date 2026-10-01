/**
 * M6 image-corpus fields — the ONE derivation every writer goes through.
 *
 * CORPUS-M6 spec §2a (status/corpus-m6-spec-2026-09-25.md, R1 + R2 passed).
 *
 * Writers (all call `toM6Entry` on what they store):
 *   lib/unsplash.ts            searchUnsplash candidates
 *   lib/pexels.ts              searchPexels candidates
 *   scripts/fetch.ts           the chosen candidate, at the write site
 *   scripts/mirror-overrides.ts  BMHQ/MOH venue overrides
 *   scripts/seed-from-projects.ts  the one-time seed (tdf + showcases)
 * and the rewriter scripts/evict-duplicates.ts, which passes every survivor
 * through it. `toM6Entry` is pure and idempotent: every M6 field is derived
 * from the 8 legacy fields, never from a previous derivation, so a re-run
 * cannot drift and a hand edit to an M6 field is undone (and caught by the gate).
 *
 * What it will NOT do: invent a credit. A row with no photographer, no profile
 * page or no photo page is `credit.complete: false` with `text: ""`. The R0
 * "Photo on {Provider}" fallback was removed because it looked like a credit
 * and was not one.
 */
import type { CacheEntry, CacheEntryM6, Licence, M6Credit, M6Fields, Provider } from "./types";
import { photoIdFromUrl } from "./fanout";

export type LegacyFields = Omit<CacheEntry, "addedBy"> & { addedBy?: string };

const PROVIDER_BY_HOST: Record<string, Provider> = {
  "images.unsplash.com": "unsplash",
  "images.pexels.com": "pexels",
};
const LICENCE: Record<Provider, Licence> = { unsplash: "unsplash-api", pexels: "pexels-api" };
const PROVIDER_URL: Record<Provider, string> = {
  unsplash: "https://unsplash.com",
  pexels: "https://www.pexels.com",
};
const PROVIDER_WORD: Record<Provider, string> = { unsplash: "Unsplash", pexels: "Pexels" };

/** Profile pages, no query: the only shapes a complete credit may link to. */
const PROFILE_RE: Record<Provider, RegExp> = {
  unsplash: /^https:\/\/unsplash\.com\/@[A-Za-z0-9_.-]+$/,
  pexels: /^https:\/\/www\.pexels\.com\/@[A-Za-z0-9_.-]+$/,
};
/** Id-only photo pages, no slug, no query. */
const SOURCE_RE: Record<Provider, RegExp> = {
  unsplash: /^https:\/\/unsplash\.com\/photos\/[A-Za-z0-9_-]{11}$/,
  pexels: /^https:\/\/www\.pexels\.com\/photo\/(\d+)\/$/,
};

const M6_KEYS = ["provider", "photoId", "licence", "sourceUrl", "credit"] as const;
const CREDIT_KEYS = ["complete", "text", "photographerName", "photographerUrl", "providerUrl"] as const;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Provider from the CDN host. Throws on anything else — §1d sources are fenced out. */
export function providerOf(url: string): Provider {
  const host = parse(url)?.host ?? "";
  const p = PROVIDER_BY_HOST[host];
  if (!p) throw new Error(`toM6Entry: "${host || url}" is not a provider CDN (only images.unsplash.com / images.pexels.com may enter the cache)`);
  return p;
}

/** The id-only photo page, or "" when the stored page cannot give one. */
function deriveSourceUrl(provider: Provider, pageUrl: string, photoId: string): string {
  const u = parse(pageUrl);
  if (!u) return "";
  const segs = u.pathname.split("/").filter(Boolean);
  if (provider === "unsplash") {
    // https://unsplash.com/photos/<slug>-<shortId>  (shortId = last 11 chars; measured 1,880/1,880)
    if (u.host !== "unsplash.com" || segs[0] !== "photos" || segs.length !== 2) return "";
    const shortId = segs[1].slice(-11);
    return /^[A-Za-z0-9_-]{11}$/.test(shortId) ? `https://unsplash.com/photos/${shortId}` : "";
  }
  // https://www.pexels.com/photo/<slug>-<id>/  — use the id only when it equals the CDN id (1,015/1,015)
  if (u.host !== "www.pexels.com" || segs[0] !== "photo" || segs.length !== 2) return "";
  const pageId = segs[1].match(/(\d+)$/)?.[1];
  const cdnId = photoId.startsWith("pexels:") ? photoId.slice("pexels:".length) : "";
  return pageId && pageId === cdnId ? `https://www.pexels.com/photo/${cdnId}/` : "";
}

/** The profile URL with its query dropped, or "" when it is not a profile page. */
function deriveProfileUrl(provider: Provider, raw: string): string {
  const u = parse(raw);
  if (!u) return "";
  const bare = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "");
  return PROFILE_RE[provider].test(bare) ? bare : "";
}

/**
 * Add the M6 fields to a row. Keeps every existing field verbatim (the 8
 * legacy fields and anything else present), replaces only the 5 M6 fields.
 */
export function toM6Entry<T extends LegacyFields>(e: T): T & M6Fields {
  const provider = providerOf(e.url);
  const photoId = photoIdFromUrl(e.url);
  const sourceUrl = deriveSourceUrl(provider, e.unsplashUrl ?? "", photoId);
  const photographerName = (e.photographerName ?? "").trim();
  const photographerUrl = deriveProfileUrl(provider, e.photographerUrl ?? "");
  const complete = Boolean(photographerName && photographerUrl && sourceUrl);
  const credit: M6Credit = {
    complete,
    text: complete ? `Photo by ${photographerName} on ${PROVIDER_WORD[provider]}` : "",
    photographerName,
    photographerUrl,
    providerUrl: PROVIDER_URL[provider],
  };
  return { ...e, provider, photoId, licence: LICENCE[provider], sourceUrl, credit };
}

export function hasM6Fields(e: unknown): e is CacheEntryM6 {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  if (!M6_KEYS.every((k) => k in o)) return false;
  const c = o.credit as Record<string, unknown> | null;
  return !!c && typeof c === "object" && CREDIT_KEYS.every((k) => k in c);
}

export interface M6Violation {
  key: string;
  rule:
    | "missing-m6"
    | "provider-host"
    | "photoid"
    | "licence"
    | "source-url"
    | "link-query"
    | "complete-invariant"
    | "incomplete-has-text"
    | "credit-provider-word"
    | "not-derived"
    | "verified-in-cache";
  detail: string;
}

/**
 * Check ONE row against the §2a invariants. Independent of `toM6Entry` for
 * every rule except `not-derived`, so a bug in the derivation cannot certify
 * itself: each invariant is restated here from the spec.
 */
export function checkM6Entry(key: string, e: unknown): M6Violation[] {
  const out: M6Violation[] = [];
  const v = (rule: M6Violation["rule"], detail: string) => out.push({ key, rule, detail });
  const row = e as Partial<CacheEntryM6> & { verified?: unknown };

  if (row && "verified" in row && row.verified !== undefined) {
    v("verified-in-cache", "human judgments live in verdicts.json, never in cache.json (spec §2a)");
  }
  if (!hasM6Fields(row)) {
    const missing = [...M6_KEYS.filter((k) => !(row && k in row)), ...(row?.credit ? CREDIT_KEYS.filter((k) => !(k in (row.credit as object))).map((k) => `credit.${k}`) : [])];
    v("missing-m6", `missing ${missing.join(", ") || "credit"}`);
    return out;
  }

  let hostProvider: Provider | null = null;
  try {
    hostProvider = providerOf(row.url);
  } catch (err) {
    v("provider-host", (err as Error).message);
  }
  if (hostProvider && row.provider !== hostProvider) v("provider-host", `provider=${row.provider} but the CDN host says ${hostProvider}`);
  const pid = photoIdFromUrl(row.url);
  if (row.photoId !== pid) v("photoid", `photoId=${row.photoId} but photoIdFromUrl(url)=${pid}`);
  if (hostProvider && !pid.startsWith(`${hostProvider}:`)) v("photoid", `photoId prefix ≠ provider ${hostProvider}`);
  if (hostProvider && row.licence !== LICENCE[hostProvider]) v("licence", `licence=${row.licence}, expected ${LICENCE[hostProvider]}`);

  const c = row.credit;
  for (const [name, link] of [["sourceUrl", row.sourceUrl], ["credit.photographerUrl", c.photographerUrl], ["credit.providerUrl", c.providerUrl]] as const) {
    if (typeof link === "string" && (link.includes("?") || link.includes("#"))) v("link-query", `${name} carries a query: ${link}`);
  }
  if (hostProvider) {
    if (row.sourceUrl !== "") {
      const m = SOURCE_RE[hostProvider].exec(row.sourceUrl);
      if (!m) v("source-url", `sourceUrl is not an id-only ${hostProvider} photo page: ${row.sourceUrl}`);
      else if (hostProvider === "pexels" && `pexels:${m[1]}` !== pid) v("source-url", `sourceUrl id ${m[1]} ≠ CDN id ${pid}`);
    }
    if (c.providerUrl !== PROVIDER_URL[hostProvider]) v("credit-provider-word", `providerUrl=${c.providerUrl}`);
    const word = PROVIDER_WORD[hostProvider];
    const other = hostProvider === "pexels" ? "Unsplash" : "Pexels";
    if (c.text.includes(other)) v("credit-provider-word", `a ${hostProvider} row credits "${other}": ${c.text}`);
    if (c.complete) {
      if (!c.photographerName.trim()) v("complete-invariant", "complete:true with an empty photographerName");
      if (!PROFILE_RE[hostProvider].test(c.photographerUrl)) v("complete-invariant", `complete:true but photographerUrl is not a profile page: ${c.photographerUrl}`);
      if (row.sourceUrl === "") v("complete-invariant", "complete:true with no sourceUrl");
      if (c.text !== `Photo by ${c.photographerName} on ${word}`) v("credit-provider-word", `text "${c.text}" ≠ "Photo by {name} on ${word}"`);
    } else if (c.text !== "") {
      v("incomplete-has-text", `complete:false must have text "", got "${c.text}"`);
    }
    if (out.length === 0) {
      // Last: the stored fields must be exactly what the one derivation gives.
      const d = toM6Entry(row as CacheEntryM6);
      const pick = (x: M6Fields) => JSON.stringify([x.provider, x.photoId, x.licence, x.sourceUrl, x.credit]);
      if (pick(d) !== pick(row as CacheEntryM6)) v("not-derived", "M6 fields differ from toM6Entry(legacy fields) — hand-edited or written by another path");
    }
  }
  return out;
}

/**
 * Check a whole cache. A row without M6 fields fails unless its key is in the
 * pre-M6 ledger (m6-legacy-ledger.json) — the 3,017 rows that predate U2 and
 * are owed to the U2-data backfill. Any NEW legacy-shaped row fails.
 */
export function checkM6(cache: Record<string, unknown>, legacy: Set<string>): { violations: M6Violation[]; legacyRemaining: number } {
  const violations: M6Violation[] = [];
  let legacyRemaining = 0;
  for (const [key, e] of Object.entries(cache)) {
    const vs = checkM6Entry(key, e);
    if (vs.length === 1 && vs[0].rule === "missing-m6" && legacy.has(key) && !hasAnyM6Field(e)) {
      legacyRemaining++;
      continue;
    }
    violations.push(...vs);
  }
  return { violations, legacyRemaining };
}

/** A half-written row (some M6 fields, not all) is never grandfathered. */
function hasAnyM6Field(e: unknown): boolean {
  return !!e && typeof e === "object" && M6_KEYS.some((k) => k in (e as object));
}
