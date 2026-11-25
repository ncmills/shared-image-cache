/**
 * gate:place — every cache.json row NOT in place-baseline.json carries placeId
 * (string or explicit null) and a non-empty brands string[] (lib/place.ts
 * checkPlaceFields). Also REPORTS (never fails) venue-keyed rows per project
 * with no `match` verdict on their current photo.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Cache } from "../lib/types";
import { checkPlaceFields, unverifiedVenueReport } from "../lib/place";

const ROOT = resolve(__dirname, "..");

function main() {
  const cache = JSON.parse(readFileSync(resolve(ROOT, "cache.json"), "utf8")) as Cache;
  const baseline = new Set((JSON.parse(readFileSync(resolve(ROOT, "place-baseline.json"), "utf8")) as { keys: string[] }).keys);
  const verdicts = JSON.parse(readFileSync(resolve(ROOT, "verdicts.json"), "utf8")) as { key: string; photoId: string; verdict: string }[];

  const rep = unverifiedVenueReport(cache, Array.isArray(verdicts) ? verdicts : []);
  console.log("gate:place — venue-keyed rows without a `match` verdict (report only):");
  for (const p of Object.keys(rep.total).sort()) console.log(`  · ${p}: ${rep.unverified[p] ?? 0} of ${rep.total[p]} unverified`);

  const violations = checkPlaceFields(cache, baseline);
  if (violations.length) {
    console.error(`✘ gate:place — ${violations.length} violation(s):`);
    for (const v of violations.slice(0, 40)) console.error(`  ${v.key}: [${v.rule}] ${v.detail}`);
    process.exit(1);
  }
  console.log(`✔ gate:place — ${Object.keys(cache).length} rows, ${baseline.size} baseline, 0 violations`);
}

if (require.main === module) main();
