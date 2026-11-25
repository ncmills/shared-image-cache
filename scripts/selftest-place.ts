/** selftest-place — offline assertions for lib/place.ts (mapping, writers, gate). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Cache } from "../lib/types";
import { mapKeyToPlace, placeFieldsFor, withPlaceFields, checkPlaceFields, unverifiedVenueReport, type PlaceIndex } from "../lib/place";
import { backfillPlace, stripPlace } from "./backfill-place-brands";
import { serializeCache } from "./backfill-m6";

let failures = 0;
let checks = 0;
function ok(c: boolean, what: string, detail = "") {
  checks++;
  if (c) console.log(`  ✓ ${what}`);
  else { failures++; console.error(`  ✗ ${what}${detail ? `\n      ${detail}` : ""}`); }
}
const eq = <T,>(a: T, b: T, w: string) => ok(JSON.stringify(a) === JSON.stringify(b), w, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const IDX: PlaceIndex = {
  sharedData: { version: "0", sha: "x" },
  places: {
    destination: { nola: ["bestman", "moh"], bare: [] },
    golfDestination: { pinehurst: ["tdf"] },
    residence: { villa1: ["offsite"] },
    ooExperience: { both: ["offsite"], exp1: ["offsite"] },
    ooOuting: { both: ["offsite"] },
    proposalSpot: { spot1: ["engagedmoon"] },
  },
};
const row = (extra = {}) => ({ url: "u", alt: "a", photographerName: "p", photographerUrl: "pu", unsplashUrl: "uu", query: "q", fetchedAt: "t", addedBy: "x", ...extra }) as never;

console.log("\n── mapping ──");
eq(mapKeyToPlace("bestman/cities/nola", IDX), { status: "mapped", placeId: "nola", kind: "destination", brands: ["bestman", "moh"] }, "city key maps to destination, brands = wizards");
eq(mapKeyToPlace("moh/destinations/nola/hero", IDX).placeId, "nola", "category suffix still maps");
eq(mapKeyToPlace("tdf/destinations/pinehurst", IDX).kind, "golfDestination", "tdf maps to golf destination");
eq(mapKeyToPlace("bestman/cities/bare", IDX).brands, ["bestman"], "mapped place with no baked tags falls back to [project]");
eq(mapKeyToPlace("offsite/venues/villa1", IDX).kind, "residence", "offsite venue maps to residence");
eq(mapKeyToPlace("engagedmoon/spots/spot1", IDX).kind, "proposalSpot", "proposal spot maps");
eq(mapKeyToPlace("offsite/experiences/exp1", IDX).kind, "ooExperience", "experience maps");
eq(mapKeyToPlace("offsite/experiences/both", IDX), { status: "ambiguous", brands: ["offsite"] }, "id in both oo tables is AMBIGUOUS");
eq(mapKeyToPlace("moh/showcases/x/hero", IDX).status, "unmapped", "showcase unmapped");
eq(mapKeyToPlace("bestman/cities/nowhere", IDX), { status: "unmapped", brands: ["bestman"] }, "unknown id unmapped, brands [project]");
eq(placeFieldsFor("bestman/cities/nowhere", IDX), { placeId: null, brands: ["bestman"] }, "unmapped -> explicit null placeId");

console.log("\n── writer helper ──");
const w = withPlaceFields("bestman/cities/nola", row(), IDX) as unknown as Record<string, unknown>;
eq([w.placeId, w.brands], ["nola", ["bestman", "moh"]], "withPlaceFields adds both fields");
const keep = withPlaceFields("bestman/cities/nola", row({ placeId: null, brands: ["z"] }), IDX) as unknown as Record<string, unknown>;
eq([keep.placeId, keep.brands], [null, ["z"]], "never overwrites existing fields");

console.log("\n── backfill ──");
const cache: Cache = { "bestman/cities/nola": row(), "moh/showcases/a/b": row(), "offsite/experiences/both": row() };
const { cache: bf, counts } = backfillPlace(cache, IDX);
eq(counts.perProject.offsite, { mapped: 0, unmapped: 0, ambiguous: 1 }, "counts per project incl. ambiguous");
eq(serializeCache(stripPlace(bf)), serializeCache(cache), "only placeId/brands added");
eq(serializeCache(backfillPlace(bf, IDX).cache), serializeCache(bf), "idempotent");

console.log("\n── gate ──");
const base = new Set(["old/key"]);
eq(checkPlaceFields({ "old/key": row() }, base), [], "baseline row without fields passes");
eq(checkPlaceFields({ "new/key": row() }, base).map((v) => v.rule).sort(), ["missing-brands", "missing-placeId"], "NEW row without fields FAILS");
eq(checkPlaceFields({ "new/key": row({ placeId: null, brands: ["new"] }) }, base), [], "new row with null + brands passes");
eq(checkPlaceFields({ "new/key": row({ placeId: "", brands: ["n"] }) }, base)[0]?.rule, "bad-placeId", "empty placeId fails");
eq(checkPlaceFields({ "new/key": row({ placeId: null, brands: [] }) }, base)[0]?.rule, "bad-brands", "empty brands fails");
const real = JSON.parse(readFileSync(resolve(__dirname, "..", "cache.json"), "utf8")) as Cache;
const realBase = new Set((JSON.parse(readFileSync(resolve(__dirname, "..", "place-baseline.json"), "utf8")) as { keys: string[] }).keys);
eq(checkPlaceFields(real, realBase), [], "committed cache passes the committed baseline");
const rep = unverifiedVenueReport({ "p/venues/a": row({ photoId: "1" }), "p/cities/b": row() }, [{ key: "p/venues/a", photoId: "1", verdict: "match" }]);
eq([rep.total.p, rep.unverified.p ?? 0], [1, 0], "report counts only venue keys; verdict clears unverified");

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
