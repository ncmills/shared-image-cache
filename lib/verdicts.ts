/**
 * verdicts.json — human-viewed judgments of a photo at a production crop.
 *
 * CORPUS-M6 spec §2b. Append-only. NEVER written by the fetcher or any script
 * in this repo (selftest-m6 asserts no file in lib/ or scripts/ writes it): a
 * verdict is only ever added by a human who VIEWED the rendered pixels at the
 * production crop, in a reviewed PR. Keeping judgments out of cache.json means
 * a re-fetch or an auto-commit can never write, clobber or forge one.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ImageVerdict, VerdictStatus } from "./types";

export const VERDICTS_PATH = resolve(__dirname, "..", "verdicts.json");

/**
 * The closed list of surfaces a verdict may name. A surface is part of the
 * claim: a 16:10 tile verdict says nothing about the same photo as a 21:9 hero.
 * Add a surface here (with its crop) in the same PR as the first verdict on it.
 */
export const SURFACES: readonly string[] = [
  "oo/experience-card",
  "oo/setting-tile",
  "oo/venue-hero",
  "oo/sample-hero",
  "fm/destination-hero",
];

export function loadVerdicts(path: string = VERDICTS_PATH): ImageVerdict[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as ImageVerdict[];
}

/**
 * Status of (key, current photoId) on `surface`, in the §2b order:
 *   1. denied     — any mismatch on THIS photo, on ANY surface, whatever the dates
 *   2. verified   — a match on this photo at EXACTLY this surface (no superset)
 *   3. stale      — verdicts exist for this key, but only for other photos
 *   4. unverified — otherwise
 */
export function verdictStatus(verdicts: ImageVerdict[], key: string, photoId: string, surface: string): VerdictStatus {
  const forKey = verdicts.filter((v) => v.key === key);
  const forPhoto = forKey.filter((v) => v.photoId === photoId);
  if (forPhoto.some((v) => v.verdict === "mismatch")) return "denied";
  if (forPhoto.some((v) => v.verdict === "match" && v.crop?.surface === surface)) return "verified";
  if (forKey.length > 0 && forPhoto.length === 0) return "stale";
  return "unverified";
}

/** The fetcher's question: has a human said this photo is wrong for this key? */
export function isDenied(verdicts: ImageVerdict[], key: string, photoId: string): boolean {
  return verdicts.some((v) => v.key === key && v.photoId === photoId && v.verdict === "mismatch");
}

const PHOTO_ID_RE = /^(unsplash|pexels):[A-Za-z0-9_-]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
/** verifiedBy names a session or PR, never a script. */
const SCRIPTISH_RE = /(^|\/)scripts\/|\.(ts|js|sh|py)$|\bbot\b|fetch/i;

export function validateVerdicts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ["verdicts.json must be a JSON array"];
  const errs: string[] = [];
  raw.forEach((v: any, i) => {
    const at = `verdicts[${i}]${v?.key ? ` (${v.key})` : ""}`;
    if (!v || typeof v !== "object") return errs.push(`${at}: not an object`);
    if (typeof v.key !== "string" || !/^[a-z0-9-]+\/.+/.test(v.key)) errs.push(`${at}: key must be a cache key or offsite-override/<name>`);
    if (typeof v.photoId !== "string" || !PHOTO_ID_RE.test(v.photoId)) errs.push(`${at}: photoId must be <unsplash|pexels>:<id>`);
    if (v.verdict !== "match" && v.verdict !== "mismatch") errs.push(`${at}: verdict must be match|mismatch`);
    if (typeof v.shows !== "string" || !v.shows.trim()) errs.push(`${at}: shows (what the viewed frame shows) is required`);
    const c = v.crop;
    if (!c || !SURFACES.includes(c.surface)) errs.push(`${at}: crop.surface "${c?.surface}" is not in the closed list (lib/verdicts.ts SURFACES)`);
    if (!c || !(c.w > 0) || !(c.h > 0) || (c.fit !== "cover" && c.fit !== "contain")) errs.push(`${at}: crop needs w>0, h>0, fit cover|contain`);
    if (typeof v.verifiedBy !== "string" || !v.verifiedBy.trim() || SCRIPTISH_RE.test(v.verifiedBy)) errs.push(`${at}: verifiedBy must name a session or PR, never a script`);
    if (typeof v.verifiedAt !== "string" || !ISO_DATE_RE.test(v.verifiedAt)) errs.push(`${at}: verifiedAt must be an ISO date`);
  });
  return errs;
}

/** `after` must start with every row of `before`, byte-identical and in order. */
export function checkAppendOnly(before: ImageVerdict[], after: ImageVerdict[]): string[] {
  const errs: string[] = [];
  if (after.length < before.length) errs.push(`verdicts.json shrank: ${before.length} → ${after.length} rows (append-only)`);
  before.forEach((b, i) => {
    if (i < after.length && JSON.stringify(b) !== JSON.stringify(after[i])) errs.push(`verdicts[${i}] (${b.key}) was edited (append-only: add a new verdict instead)`);
  });
  return errs;
}
