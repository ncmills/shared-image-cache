/**
 * Query loader for engagedmoon (engagedmoon.com).
 *
 * Engagedmoon's imagery brief is the opposite of every other project in this
 * cache. The siblings want a SCENE — a rooftop, a bar, a fairway, a boardroom.
 * This site wants the PLACE ITSELF at the hour it computes: Cathedral Rock at
 * dusk, Point Lobos' cypress coast, the Bethesda Terrace arcade.
 *
 * Deliberately NOT queried: "proposal", "engagement", "couple", "ring". Those
 * return staged stock — a kneeling silhouette against a purple gradient — which
 * is precisely the register the brand bans. It would also be a quiet lie: the
 * photo would depict a moment that did not happen at that spot. Landscape and
 * architecture of the real named place is both honest and better-looking.
 *
 * Queries are hand-written per spot rather than templated from `${name} ${city}`
 * because several spot names are administratively correct and photographically
 * useless — "Craggy Gardens, Blue Ridge Parkway MP 364" returns nothing, while
 * "Craggy Gardens Blue Ridge Parkway North Carolina" returns the ridgeline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ MICRO-LANDMARKS DO NOT SURVIVE A FALLBACK. Seven ids were removed on
 * 2026-08-07 after repeated wrong subjects, and the failure was always the
 * same shape: the primary query names a specific small place Unsplash has no
 * photograph of, the fallback widens to the city, and the city photograph then
 * ships under the small place's name. "Conservatory Garden, Central Park"
 * returned a Victorian glasshouse in Bangalore; "Bow Bridge" returned a frame
 * with a BETHESDA TERRACE sign in it; "White Point Garden" returned Broad
 * Street. All three were plausible-looking and all three were the wrong place.
 *
 * The rule that follows: a spot gets a query ONLY if the place is famous enough
 * to be photographed BY NAME. Everything else takes the gradient, which is a
 * designed state. Do not add a widening fallback to rescue coverage — coverage
 * is not the goal, being right is.
 *
 * ⚠️ `id` MUST equal the spot's id in engagedmoon's catalog, and a rename there
 * breaks every photograph on the site SILENTLY.
 *
 * This already happened once. On 2026-08-07 the catalog migrated into
 * shared-data and every id gained a city prefix — `schwabacher-landing` became
 * `jackson-hole-wy-schwabacher-landing`. All 13 keys orphaned at once, the
 * lookup missed on every one, and the site rendered its designed gradient
 * fallback everywhere. Nothing threw, no build failed, no test went red; the
 * photographs simply stopped appearing. The ids below were remapped ONE BY ONE
 * against the migrated catalog by matching the SUBJECT, never by string
 * similarity — four (Cathedral Rock, Airport Mesa, Fort Zachary Taylor, Skyline
 * Wilderness) had no successor and were deleted rather than reattached to a
 * neighbour, because Sedona kept only Bell Rock and Key West only Fort
 * Jefferson, which are different places.
 *
 * `npm run check:engagedmoon-keys` in the engagedmoon repo now fails the build
 * on an orphaned key, so the next rename is loud.
 */

import type { QueryItem } from "../../lib/types";

/**
 * Spot-level heroes. The `key` MUST match the spot `id` in engagedmoon's
 * `src/lib/proposal-spots.ts` — the site looks images up by that id, and a
 * mismatch renders a gap rather than throwing, so it fails silently.
 */
const SPOT_QUERIES: Array<{ id: string; query: string; fallbackQuery: string }> = [
  // Added 2026-08-07: the remaining reachable spots. Every one is a named,
  // heavily-photographed landmark, so these are queried by their own name
  // rather than by a city fallback — the fallback is what produced the Lone
  // Cypress under the Point Lobos key.
  {
    id: "jackson-hole-wy-oxbow-bend",
    query: "Oxbow Bend Snake River Grand Teton reflection",
    fallbackQuery: "Grand Teton Mount Moran river reflection sunrise",
  },
  {
    id: "carmel-ca-mcway-falls-overlook",
    query: "McWay Falls Julia Pfeiffer Burns State Park",
    fallbackQuery: "McWay Falls Big Sur waterfall cove",
  },
  {
    id: "carmel-ca-garrapata-soberanes-point",
    query: "Soberanes Point Garrapata State Park California",
    fallbackQuery: "Garrapata State Park Big Sur coastal bluff",
  },
  {
    id: "new-york-ny-bbp-granite-prospect",
    query: "Brooklyn Bridge Park Pier 1 Manhattan skyline",
    fallbackQuery: "Brooklyn Bridge Park East River Manhattan skyline dusk",
  },
  {
    id: "new-york-ny-bbp-pebble-beach",
    query: "Brooklyn Bridge Park Pebble Beach Manhattan Bridge",
    fallbackQuery: "Brooklyn Bridge Park shoreline Manhattan Bridge",
  },
  {
    id: "new-york-ny-gantry-plaza",
    query: "Gantry Plaza State Park Long Island City gantries",
    fallbackQuery: "Long Island City waterfront Manhattan skyline dusk",
  },
  {
    id: "savannah-ga-bonaventure-cemetery",
    query: "Bonaventure Cemetery Savannah live oaks",
    fallbackQuery: "Savannah cemetery Spanish moss oak avenue",
  },
  // Removed 2026-08-07: Cathedral Rock, Airport Mesa, Fort Zachary Taylor,
  // Skyline Wilderness and the Conservatory Garden no longer exist in the
  // migrated catalog. Chasing an id nothing renders just burns rate limit.
  {
    id: "new-york-ny-central-park-bethesda-terrace",
    query: "Bethesda Terrace Central Park New York",
    fallbackQuery: "Bow Bridge Central Park New York",
  },
  {
    id: "savannah-ga-forsyth-park",
    query: "Forsyth Park fountain Savannah Georgia",
    fallbackQuery: "Savannah Georgia live oaks Spanish moss",
  },
  {
    id: "carmel-ca-point-lobos",
    // Rejected on review 2026-08-07: the fallback "Carmel California rocky
    // coastline sunset" returned the LONE CYPRESS — a Pebble Beach landmark on
    // private 17-Mile Drive land, five miles from the state reserve. Beautiful,
    // and exactly the error this site cannot make: the entire product turns on
    // WHO MANAGES THE GROUND, and Pebble Beach and California State Parks are
    // not the same authority. Both queries now name the reserve, and the
    // fallback no longer widens to "Carmel" — the widening is what let it drift.
    query: "Point Lobos State Natural Reserve China Cove",
    fallbackQuery: "Point Lobos State Reserve Monterey cypress cove",
  },
  {
    id: "stateline-nv-sand-harbor-boulders",
    query: "Sand Harbor Lake Tahoe Nevada boulders",
    fallbackQuery: "Lake Tahoe Nevada clear water rocks shoreline",
  },
  {
    id: "lake-tahoe-ca-emerald-bay",
    query: "Emerald Bay Lake Tahoe California overlook",
    fallbackQuery: "Lake Tahoe California overlook island sunset",
  },
  {
    id: "asheville-nc-craggy-gardens",
    query: "Craggy Gardens Blue Ridge Parkway North Carolina",
    fallbackQuery: "Blue Ridge Parkway North Carolina mountain ridge sunset",
  },
  {
    id: "jackson-hole-wy-schwabacher-landing",
    query: "Schwabacher Landing Grand Teton reflection",
    fallbackQuery: "Grand Teton National Park Wyoming river reflection sunrise",
  },
  {
    id: "charleston-sc-waterfront-park-pineapple-fountain",
    query: "Waterfront Park Charleston South Carolina pineapple fountain",
    fallbackQuery: "Charleston South Carolina waterfront pier sunset",
  },
];

/**
 * Destination-level heroes, used on `/spots`, `/plan` and the month pages where
 * the unit is a city rather than a single spot. Queried at dusk on purpose —
 * this site's whole subject is the last hour of light, and a midday photograph
 * under the hero headline "down to the light" contradicts the copy.
 */
const DESTINATION_QUERIES: Array<{ id: string; query: string; fallbackQuery: string }> = [
  // napa-valley-ca removed 2026-08-07: not a destinationId in the migrated
  // catalog. Leaving it here meant any full-project fetch re-created the key,
  // which then failed engagedmoon's deploy — a dead query is not inert.
  { id: "new-york-ny", query: "New York City skyline dusk golden hour", fallbackQuery: "Manhattan New York evening light" },
  // savannah-ga rejected on review 2026-08-07: returned a single Victorian
  // house under harsh midday sun. A city hero has to carry a city.
  { id: "savannah-ga", query: "Savannah Georgia oak avenue Spanish moss golden hour", fallbackQuery: "Savannah Georgia riverfront evening light" },
  { id: "carmel-ca", query: "Carmel by the Sea California coastline golden hour", fallbackQuery: "Big Sur California coast sunset" },
  { id: "lake-tahoe-ca", query: "Lake Tahoe shoreline golden hour mountains", fallbackQuery: "Lake Tahoe sunset pine shoreline" },
  { id: "key-west-fl", query: "Key West Florida sunset ocean pier", fallbackQuery: "Florida Keys sunset palm ocean" },
  { id: "sedona-az", query: "Sedona Arizona red rocks golden hour", fallbackQuery: "Sedona Arizona desert buttes sunset" },
  { id: "asheville-nc", query: "Asheville North Carolina blue ridge mountains sunset", fallbackQuery: "Blue Ridge Mountains North Carolina layered ridges dusk" },
  { id: "jackson-hole-wy", query: "Jackson Hole Wyoming Teton range golden hour", fallbackQuery: "Grand Teton Wyoming mountains evening light" },
  { id: "charleston-sc", query: "Charleston South Carolina harbor golden hour", fallbackQuery: "Charleston South Carolina historic street evening" },
];

export async function getEngagedmoonQueries(): Promise<QueryItem[]> {
  const queries: QueryItem[] = [];

  // Every string in this file was hand-written against a named landmark and
  // reviewed — `curated` marks them exempt from the TEMPLATE hygiene rules in
  // lib/query-policy.ts (no lighting words, ≤6 terms). This site asks for dusk
  // ON PURPOSE: its whole subject is the last hour of light, and a midday
  // photograph under the hero headline "down to the light" contradicts the
  // copy. The curated set of 24 is FROZEN by the owner (2026-08-20) — the ~120
  // spots with no query render the sky gradient by design, and a
  // coverage-driven agent must not "fix" that number.
  for (const s of SPOT_QUERIES) {
    queries.push({
      key: `engagedmoon/spots/${s.id}`,
      query: s.query,
      fallbackQuery: s.fallbackQuery,
      addedBy: "engagedmoon",
      label: `engagedmoon/spot ${s.id}`,
      curated: true,
    });
  }

  for (const d of DESTINATION_QUERIES) {
    queries.push({
      key: `engagedmoon/destinations/${d.id}`,
      query: d.query,
      fallbackQuery: d.fallbackQuery,
      addedBy: "engagedmoon",
      label: `engagedmoon/dest ${d.id}`,
      curated: true,
    });
  }

  console.log(`  ✓ Engagedmoon queries built (${queries.length} entries)`);
  return queries;
}
