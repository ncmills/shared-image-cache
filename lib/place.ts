/**
 * place.ts — which shared-data place a cached photo shows, and which brands
 * (site tags) may show it. Pure: no network, no model call.
 *
 * Two OPTIONAL fields on every cache row (lib/types.ts PlaceFields):
 *   placeId  the shared-data row id (src/row-ids.ts) of the place the key maps
 *            to, or explicit null ("looked, no place"). Absent on pre-existing
 *            rows that no rule maps.
 *   brands   string[] of site tags that may show it — the place's `wizards`
 *            tags; a row with no mapped place (or a place carrying no baked
 *            tags) falls back to [its own project] (the key prefix).
 *
 * Mapping rules (the ONLY key shapes that name a place unambiguously):
 *   <p>/{cities,destinations,bachelorParty}/<id>[/<category>]
 *        → destination <id>   (tdf → golf destination <id>: tdf rows are golf)
 *   offsite/venues/<id>        → residence <id>
 *   offsite/{experiences,outings}/<id>
 *        → oo experience / outing <id>; an id in BOTH tables is AMBIGUOUS
 *   engagedmoon/spots/<id>     → proposal spot <id>
 * Everything else (showcases, settings, guides, regions, atlas, site, and the
 * positional `<p>/venues/<city>/<cat>/<n>` keys, whose index is unstable) is
 * UNMAPPED: no placeId, brands = [project].
 */
import type { Cache } from "./types";

export type PlaceKind = "destination" | "golfDestination" | "residence" | "ooExperience" | "ooOuting" | "proposalSpot";

export interface PlaceIndex {
  note?: string;
  sharedData: { version: string; sha: string };
  places: Record<PlaceKind, Record<string, string[]>>;
}

export interface PlaceFields {
  placeId?: string | null;
  brands?: string[];
}

export type MapStatus = "mapped" | "unmapped" | "ambiguous";
export interface PlaceMapping {
  status: MapStatus;
  /** Present only when status === "mapped". */
  placeId?: string;
  brands: string[];
  kind?: PlaceKind;
}

const DEST_CATEGORIES = new Set(["cities", "destinations", "bachelorParty"]);

export function projectOf(key: string): string {
  return key.split("/")[0];
}

export function mapKeyToPlace(key: string, index: PlaceIndex): PlaceMapping {
  const parts = key.split("/");
  const [project, category, id] = parts;
  const own = [project];
  const unmapped: PlaceMapping = { status: "unmapped", brands: own };
  if (!id || parts.length > 4) return unmapped;

  const found = (kind: PlaceKind): PlaceMapping => {
    const wizards = index.places[kind][id];
    return { status: "mapped", placeId: id, kind, brands: wizards && wizards.length ? [...wizards] : own };
  };
  const has = (kind: PlaceKind) => Object.prototype.hasOwnProperty.call(index.places[kind], id);

  if (DEST_CATEGORIES.has(category)) {
    const kind: PlaceKind = project === "tdf" ? "golfDestination" : "destination";
    return has(kind) ? found(kind) : unmapped;
  }
  if (project === "offsite" && category === "venues" && parts.length === 3) return has("residence") ? found("residence") : unmapped;
  if (project === "offsite" && (category === "experiences" || category === "outings") && parts.length === 3) {
    const e = has("ooExperience");
    const o = has("ooOuting");
    if (e && o) return { status: "ambiguous", brands: own };
    if (category === "experiences") return e ? found("ooExperience") : unmapped;
    return o ? found("ooOuting") : unmapped;
  }
  if (project === "engagedmoon" && category === "spots" && parts.length === 3) return has("proposalSpot") ? found("proposalSpot") : unmapped;
  return unmapped;
}

/** The two fields a NEW row must carry, derived from its key. */
export function placeFieldsFor(key: string, index: PlaceIndex): Required<PlaceFields> {
  const m = mapKeyToPlace(key, index);
  return { placeId: m.status === "mapped" ? m.placeId! : null, brands: m.brands };
}

/** Writers call this on a freshly built row. Idempotent; never overwrites existing fields. */
export function withPlaceFields<T extends object>(key: string, entry: T, index: PlaceIndex): T & Required<PlaceFields> {
  const f = placeFieldsFor(key, index);
  const e = entry as T & PlaceFields;
  return { ...entry, placeId: e.placeId !== undefined ? e.placeId : f.placeId, brands: e.brands ?? f.brands };
}

export interface PlaceViolation {
  key: string;
  rule: "missing-placeId" | "missing-brands" | "bad-placeId" | "bad-brands";
  detail: string;
}

/**
 * The gate: a row NOT in `baseline` must carry placeId (string or explicit null)
 * and a non-empty brands string[]. Rows IN the baseline are only shape-checked
 * if they carry the fields (absent is allowed — they predate the rule).
 */
export function checkPlaceFields(cache: Cache, baseline: ReadonlySet<string>): PlaceViolation[] {
  const out: PlaceViolation[] = [];
  for (const [key, row] of Object.entries(cache)) {
    const r = row as unknown as PlaceFields;
    const isNew = !baseline.has(key);
    const hasPlace = Object.prototype.hasOwnProperty.call(r, "placeId");
    const hasBrands = r.brands !== undefined;
    if (isNew && !hasPlace) out.push({ key, rule: "missing-placeId", detail: "new row has no placeId (a string, or explicit null)" });
    if (isNew && !hasBrands) out.push({ key, rule: "missing-brands", detail: "new row has no brands[]" });
    if (hasPlace && r.placeId !== null && (typeof r.placeId !== "string" || r.placeId === "")) {
      out.push({ key, rule: "bad-placeId", detail: `placeId must be a non-empty string or null, got ${JSON.stringify(r.placeId)}` });
    }
    if (hasBrands && !(Array.isArray(r.brands) && r.brands.length > 0 && r.brands.every((b) => typeof b === "string" && b !== ""))) {
      out.push({ key, rule: "bad-brands", detail: `brands must be a non-empty string[], got ${JSON.stringify(r.brands)}` });
    }
  }
  return out;
}

export interface UnverifiedReport {
  /** venue-keyed rows (`<p>/venues/...`) per project. */
  total: Record<string, number>;
  /** …of which have no `match` verdict on their CURRENT photo in verdicts.json. */
  unverified: Record<string, number>;
}

/** REPORT only (never a gate): venue-keyed rows with no verified verdict. */
export function unverifiedVenueReport(
  cache: Cache,
  verdicts: ReadonlyArray<{ key: string; photoId: string; verdict: string }>,
): UnverifiedReport {
  const total: Record<string, number> = {};
  const unverified: Record<string, number> = {};
  for (const [key, row] of Object.entries(cache)) {
    if (!/^[^/]+\/venues\//.test(key)) continue;
    const p = projectOf(key);
    total[p] = (total[p] ?? 0) + 1;
    const pid = (row as unknown as { photoId?: string }).photoId;
    const ok = verdicts.some((v) => v.key === key && v.photoId === pid && v.verdict === "match");
    if (!ok) unverified[p] = (unverified[p] ?? 0) + 1;
  }
  return { total, unverified };
}
