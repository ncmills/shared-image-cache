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
 */

import type { QueryItem } from "../../lib/types";

/**
 * Spot-level heroes. The `key` MUST match the spot `id` in engagedmoon's
 * `src/lib/proposal-spots.ts` — the site looks images up by that id, and a
 * mismatch renders a gap rather than throwing, so it fails silently.
 */
const SPOT_QUERIES: Array<{ id: string; query: string; fallbackQuery: string }> = [
  {
    id: "central-park-conservatory-garden",
    // Returned zero results on 2026-08-07 — the full formal name is too narrow
    // for Unsplash's index. Both queries widened to the garden's own features.
    query: "Central Park Conservatory Garden wisteria pergola",
    fallbackQuery: "New York formal garden hedges fountain autumn",
  },
  {
    id: "central-park-general",
    query: "Bethesda Terrace Central Park New York",
    fallbackQuery: "Bow Bridge Central Park New York",
  },
  {
    id: "forsyth-park",
    query: "Forsyth Park fountain Savannah Georgia",
    fallbackQuery: "Savannah Georgia live oaks Spanish moss",
  },
  {
    id: "point-lobos",
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
    id: "carmel-beach",
    // Rejected on review 2026-08-07: returned a lifeguard tower under flat
    // overcast. Not wrong, just dead — and a site selling the last hour of
    // light cannot illustrate it with a photograph that hasn't any.
    query: "Carmel Beach California white sand sunset silhouette",
    fallbackQuery: "Carmel by the Sea beach dusk cypress silhouette",
  },
  {
    id: "sand-harbor",
    query: "Sand Harbor Lake Tahoe Nevada boulders",
    fallbackQuery: "Lake Tahoe Nevada clear water rocks shoreline",
  },
  {
    id: "emerald-bay",
    query: "Emerald Bay Lake Tahoe California overlook",
    fallbackQuery: "Lake Tahoe California overlook island sunset",
  },
  {
    id: "fort-zachary-taylor",
    query: "Fort Zachary Taylor Key West beach sunset",
    fallbackQuery: "Key West Florida sunset palm beach",
  },
  {
    id: "cathedral-rock",
    query: "Cathedral Rock Sedona Arizona red rock sunset",
    fallbackQuery: "Sedona Arizona red rock formation dusk",
  },
  {
    id: "airport-mesa",
    query: "Airport Mesa overlook Sedona Arizona sunset",
    fallbackQuery: "Sedona Arizona canyon overlook golden hour",
  },
  {
    id: "craggy-gardens",
    query: "Craggy Gardens Blue Ridge Parkway North Carolina",
    fallbackQuery: "Blue Ridge Parkway North Carolina mountain ridge sunset",
  },
  {
    id: "schwabacher-landing",
    query: "Schwabacher Landing Grand Teton reflection",
    fallbackQuery: "Grand Teton National Park Wyoming river reflection sunrise",
  },
  {
    id: "skyline-wilderness",
    // Rejected on review 2026-08-07: returned a barn and a vineyard under
    // midday cloud — generic California wine country, and this spot is an oak
    // woodland around a small lake, rated privacy 5/5 precisely because it is
    // NOT the vineyard everyone photographs. Queries now name the terrain.
    query: "Napa California oak woodland lake golden hour",
    fallbackQuery: "Northern California oak hills small lake sunset",
  },
  {
    id: "waterfront-park-charleston",
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
  { id: "napa-valley-ca", query: "Napa Valley California vineyard golden hour", fallbackQuery: "Napa Valley vineyard rows sunset" },
  { id: "charleston-sc", query: "Charleston South Carolina harbor golden hour", fallbackQuery: "Charleston South Carolina historic street evening" },
];

export async function getEngagedmoonQueries(): Promise<QueryItem[]> {
  const queries: QueryItem[] = [];

  for (const s of SPOT_QUERIES) {
    queries.push({
      key: `engagedmoon/spots/${s.id}`,
      query: s.query,
      fallbackQuery: s.fallbackQuery,
      addedBy: "engagedmoon",
      label: `engagedmoon/spot ${s.id}`,
    });
  }

  for (const d of DESTINATION_QUERIES) {
    queries.push({
      key: `engagedmoon/destinations/${d.id}`,
      query: d.query,
      fallbackQuery: d.fallbackQuery,
      addedBy: "engagedmoon",
      label: `engagedmoon/dest ${d.id}`,
    });
  }

  console.log(`  ✓ Engagedmoon queries built (${queries.length} entries)`);
  return queries;
}
