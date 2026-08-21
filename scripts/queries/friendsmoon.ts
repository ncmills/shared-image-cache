/**
 * Query loader for friendsmoon (friendsmoon.com).
 *
 * ── THE BRIEF ──────────────────────────────────────────────────────────────
 * Friendsmoon plans the trip a just-married couple takes with their friends the
 * days after the wedding. Its brand asks for "the Sunday of a long weekend:
 * warm, unhurried, slightly sunburnt. Not a party site. Not a luxury site."
 *
 * ── WHY THESE QUERIES NAME PLACES, NOT PEOPLE ──────────────────────────────
 * The obvious query for this product is the scene — "friends long table dinner",
 * "group of friends beach house". Deliberately NOT used, for two reasons.
 *
 * First it looks wrong: those queries return staged stock, eight models
 * laughing at a salad, which is the register the brand bans and which every
 * visitor reads instantly as a stock photo.
 *
 * Second, and worse, it would be a quiet lie. A photo of a group who were never
 * there, on a page telling you what YOUR group's weekend will be like, is
 * manufactured social proof by another route — and this portfolio bans
 * fabricated testimonials, review counts and logos for exactly that reason. A
 * picture of Asheville is a true statement about Asheville. A picture of
 * strangers pretending to be your friends in Asheville is not.
 *
 * So every query asks for the PLACE at a warm hour, and the site's duotone
 * treatment does the work of making 200-odd different photographs read as one
 * register. Same ruling engagedmoon made when it refused to query "proposal".
 *
 * ── ORDERING IS LOAD-BEARING ───────────────────────────────────────────────
 * Unsplash allows 50 requests/hour and this loader emits ~250 queries, so a
 * single run cannot fill it. Queries are emitted most-visible-first — the site
 * hero, then the 30 hand-written Atlas entries, then regions, then the long
 * tail of destinations — so that a rate-limited partial run fills the pages a
 * human actually looks at rather than an alphabetical prefix of them.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { QueryItem } from "../../lib/types";
import { STATE_NAMES } from "./state-names";
import { getQueriesFromSnapshot } from "./from-snapshot";

const HOME = process.env.HOME || "/Users/bignick";

/**
 * The redesign runs in a worktree, and the worktree is where the current data
 * lives. Preferring it over the primary checkout is not a hack: a second
 * session hard-reset the primary tree mid-build, and a loader that silently
 * read the stale copy would produce a cache keyed to destinations the site no
 * longer has. First path that exists wins, and the choice is logged.
 */
const CANDIDATE_ROOTS = [
  resolve(HOME, "work/worktrees/friendsmoon-sunarc"),
  resolve(HOME, "friendsmoon"),
];

/** Scene descriptor per Atlas category. The category IS the landscape. */
// The lighting words are GONE (2026-08-20). "golden hour" is what returned a
// corgi for Sonoma, a puppy for Omaha, a cat for Memphis and a dog for
// Rehoboth Beach: pair a small place name with a lighting term and the
// libraries rank a well-lit portrait above a poorly-lit landscape. The scene
// noun does the work; the site's duotone treatment does the warmth.
const CATEGORY_SCENE: Record<string, string> = {
  "one-big-house": "countryside estate house",
  "coastal-slow": "coastline",
  "mountain-cabin": "mountains autumn ridge",
  "wine-and-table": "vineyard rows",
  "lake-and-boat": "lake dock summer",
  "island-ferry": "island harbour boats",
  "desert-quiet": "desert landscape",
  "city-weekend": "historic district",
};

const REGION_SCENE: Record<string, { query: string; fallback: string }> = {
  northeast: {
    query: "New England coastline autumn",
    fallback: "Maine harbour lobster boats",
  },
  south: {
    query: "Blue Ridge mountains autumn morning",
    fallback: "Savannah live oaks Spanish moss",
  },
  midwest: {
    query: "Great Lakes shoreline summer",
    fallback: "Michigan lake dunes",
  },
  west: {
    query: "Pacific coast highway",
    fallback: "Sierra Nevada lake granite",
  },
  international: {
    query: "Mediterranean coastal town terracotta rooftops",
    fallback: "Portugal coastline cliffs",
  },
};

interface AtlasTripRow {
  slug: string;
  destination: string;
  category: string;
}

interface DestinationRow {
  id: string;
  city: string;
  state: string;
  region: string;
}

export async function getFriendsmoonQueries(): Promise<QueryItem[]> {
  const root = CANDIDATE_ROOTS.find((p) => existsSync(resolve(p, "src/data")));

  if (!root) {
    const snap = getQueriesFromSnapshot("friendsmoon");
    if (snap) {
      console.log(
        `  ✓ friendsmoon queries loaded from snapshot (${snap.length} entries)`,
      );
      return snap;
    }
    console.warn(`  ⚠ friendsmoon data dir missing and no snapshot available`);
    return [];
  }
  console.log(`  · friendsmoon data root: ${root}`);

  const queries: QueryItem[] = [];

  // ── 1. The site hero ─────────────────────────────────────────────────────
  // The one image on the site that is not a specific place.
  //
  // REJECTED ON REVIEW 2026-08-07: "long wooden table outdoor dinner string
  // lights evening" returned a deserted municipal picnic shelter at night — bare
  // bulb, empty benches, a trash can in the foreground. A public park after
  // everyone went home, on the site whose entire proposition is that nobody
  // wants to go home yet. The query read fine, the fetch returned 200 and the
  // label ("tables illuminated at night") was plausible; only looking at the
  // pixels at the production crop caught it.
  //
  // The replacement asks for the HOUSE at golden hour, which is both the thing
  // this product actually finds you and a subject that cannot come back empty
  // and institutional. "evening" and "night" are out of both queries — they are
  // what pulled the first one into the dark.
  queries.push({
    key: "friendsmoon/site/hero",
    query: "large beach house porch golden hour summer",
    fallbackQuery: "coastal cottage deck sunset warm light",
    addedBy: "friendsmoon",
    label: "friendsmoon/site hero",
    // One image, written and LOOKED AT after the first attempt shipped a
    // deserted municipal picnic shelter. Reviewed strings are not templates.
    curated: true,
  });

  // ── 2. The Atlas — 30 hand-written weekends ──────────────────────────────
  let trips: AtlasTripRow[] = [];
  try {
    const mod = require(resolve(root, "src/data/atlas-trips.ts"));
    trips = mod.ATLAS_TRIPS ?? mod.default ?? [];
  } catch (err) {
    console.warn(
      `  ⚠ friendsmoon atlas not loadable: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Two Atlas entries need a hand-written query. Reviewed on the contact sheet
  // 2026-08-07: the templated `${city} ${state} ${scene}` put a generic
  // palm-and-white-sand Caribbean beach on Key West (whose beaches are small,
  // coral and nothing like it) and a large institutional building on the West
  // Village (which is low-rise brownstones). Both landed in the right CITY,
  // so neither is the Santorini-class error — but "somewhere in the right
  // city" is a lower bar than this brand should clear on the 30 pages a human
  // actually wrote. Named landmarks return the place itself.
  const ATLAS_OVERRIDE: Record<string, { query: string; fallbackQuery: string }> = {
    "key-west-conch-house-bikes-included-catamaran-at-sunset": {
      query: "Key West Florida Duval Street conch houses",
      fallbackQuery: "Key West Florida Mallory Square sunset",
    },
    "new-york-west-village-townhouse-and-a-broadway-night": {
      query: "West Village New York brownstone tree-lined street",
      fallbackQuery: "Greenwich Village New York townhouses autumn",
    },
  };

  // An override keyed to a slug that does not exist is a silent no-op — it looks
  // like a fix, changes nothing, and nothing ever says so. (The first draft of
  // this table had exactly that: a guessed Key West slug ending "-afternoon"
  // against a real one ending "-at-sunset".) Two lists that must agree get
  // compared.
  const slugs = new Set(trips.map((t) => t.slug));
  for (const key of Object.keys(ATLAS_OVERRIDE)) {
    if (!slugs.has(key)) {
      throw new Error(
        `friendsmoon: ATLAS_OVERRIDE key "${key}" matches no Atlas trip slug. ` +
          `Fix the key — an override that never fires is worse than none.`,
      );
    }
  }

  for (const t of trips) {
    // `destination` is "Asheville, NC" — the state code is useless to Unsplash
    // and actively harmful ("NC" matches nothing), so it is expanded.
    const [city, code] = t.destination.split(",").map((s) => s.trim());
    const stateName = STATE_NAMES[code] ?? code ?? "";
    const scene = CATEGORY_SCENE[t.category] ?? "golden hour";
    const override = ATLAS_OVERRIDE[t.slug];
    queries.push({
      key: `friendsmoon/atlas/${t.slug}`,
      query: override?.query ?? `${city} ${stateName} ${scene}`,
      fallbackQuery: override?.fallbackQuery ?? `${city} ${stateName}`,
      addedBy: "friendsmoon",
      label: `friendsmoon/atlas ${t.destination} (${t.category})`,
      // Contact-sheet reviewed on 2026-08-07; the templated ones are not.
      ...(override ? { curated: true } : {}),
    });
  }

  // ── 3. Regions ───────────────────────────────────────────────────────────
  for (const [key, scene] of Object.entries(REGION_SCENE)) {
    queries.push({
      key: `friendsmoon/regions/${key}`,
      query: scene.query,
      fallbackQuery: scene.fallback,
      addedBy: "friendsmoon",
      label: `friendsmoon/region ${key}`,
      // Five hand-written strings for five pages, not a template.
      curated: true,
    });
  }

  // ── 4. The long tail — every destination ─────────────────────────────────
  let dests: DestinationRow[] = [];
  try {
    const mod = require(resolve(root, "src/lib/catalog.ts"));
    dests = mod.allDestinations ? mod.allDestinations() : [];
  } catch (err) {
    console.warn(
      `  ⚠ friendsmoon catalog not loadable: ${err instanceof Error ? err.message : err}`,
    );
  }

  /**
   * Destinations whose templated `${city} ${state} golden hour` query missed.
   * Reviewed on contact sheets 2026-08-07, 100 of 199 destinations examined.
   *
   * One was a genuine WRONG PLACE: "Hamptons New York golden hour" returned the
   * Manhattan skyline. The Hamptons are a hundred miles east of it and not being
   * the city is the entire point of going — that is the Santorini-class error,
   * and the only one in the hundred.
   *
   * ── THE SYSTEMATIC CAUSE: "golden hour" ─────────────────────────────────
   * Four destinations came back as PET PHOTOGRAPHY — a white cat for Memphis, a
   * puppy for Omaha, a dog for Rehoboth Beach, a corgi for Sonoma. That is not
   * four flukes: "golden hour" is a lighting term, and Unsplash is full of
   * portrait and pet work shot in it. Pairing a small city name with a lighting
   * term ranks a well-lit corgi above a poorly-lit vineyard. Every override
   * below names a LANDMARK or a specific geography instead, and drops the
   * lighting word entirely.
   *
   * The rest returned somewhere real but unusable: a derelict concrete lot for
   * Ambergris Caye, a blurred figure for Iowa City, a near-blank sky for
   * Killington, a vintage car for Knoxville, an interior window for Cincinnati,
   * a brick facade for Denver. Named landmarks and specific geography fix all of
   * them; "golden hour" is what let a generic frame through.
   */
  const DEST_OVERRIDE: Record<string, { query: string; fallbackQuery: string }> = {
    "hamptons-ny": {
      // NOT Montauk Point Lighthouse — `montauk-ny` already renders exactly
      // that, and two destinations wearing the same landmark is its own kind of
      // wrong. Shingle-style houses and dunes are the Hamptons and nowhere else
      // on this list.
      query: "Southampton New York shingled beach house dunes",
      fallbackQuery: "Long Island Hamptons beach grass dunes houses",
    },
    "ambergris-caye-bz": {
      query: "Ambergris Caye Belize pier turquoise water",
      fallbackQuery: "Belize barrier reef caye palm dock",
    },
    "aruba-aw": {
      query: "Aruba Eagle Beach divi divi tree",
      fallbackQuery: "Aruba Caribbean coastline turquoise",
    },
    "iowa-city-ia": {
      query: "Iowa City Old Capitol building",
      fallbackQuery: "Iowa City Iowa downtown pedestrian mall",
    },
    "killington-vt": {
      query: "Killington Vermont green mountains autumn",
      fallbackQuery: "Vermont ski resort mountain autumn foliage",
    },
    "knoxville-tn": {
      query: "Knoxville Tennessee Sunsphere downtown",
      fallbackQuery: "Knoxville Tennessee riverfront skyline",
    },
    "cincinnati-oh": {
      query: "Cincinnati Ohio Roebling Bridge skyline",
      fallbackQuery: "Cincinnati Ohio riverfront downtown",
    },
    "denver-co": {
      query: "Denver Colorado skyline Rocky Mountains",
      fallbackQuery: "Denver Colorado downtown union station",
    },
    "memphis-tn": {
      query: "Beale Street Memphis Tennessee neon",
      fallbackQuery: "Memphis Tennessee Mississippi River bridge downtown",
    },
    "omaha-ne": {
      query: "Omaha Nebraska Old Market downtown",
      fallbackQuery: "Omaha Nebraska skyline Missouri River",
    },
    "rehoboth-beach-de": {
      query: "Rehoboth Beach Delaware boardwalk",
      fallbackQuery: "Delaware coast boardwalk beach town",
    },
    "sonoma-ca": {
      query: "Sonoma County vineyard rows hills",
      fallbackQuery: "Sonoma California wine country vines",
    },
    "park-city-ut": {
      query: "Park City Utah Main Street historic",
      fallbackQuery: "Park City Utah Wasatch mountains town",
    },
    "sioux-falls-sd": {
      query: "Sioux Falls South Dakota waterfall park",
      fallbackQuery: "Sioux Falls South Dakota downtown river",
    },
    "shreveport-la": {
      query: "Shreveport Louisiana riverfront downtown",
      fallbackQuery: "Red River Louisiana bridge city",
    },
    "stowe-vt": {
      query: "Stowe Vermont church autumn foliage",
      fallbackQuery: "Vermont village white church fall colors",
    },
    "taos-nm": {
      query: "Taos New Mexico adobe pueblo",
      fallbackQuery: "Taos New Mexico Sangre de Cristo mountains adobe",
    },
    "st-augustine-fl": {
      query: "St Augustine Florida Castillo de San Marcos",
      fallbackQuery: "St Augustine Florida historic old town street",
    },
    "tempe-az": {
      query: "Tempe Arizona Town Lake downtown",
      fallbackQuery: "Tempe Arizona Hayden Butte desert city",
    },
    "prescott-az": {
      query: "Prescott Arizona Whiskey Row courthouse",
      fallbackQuery: "Prescott Arizona pine mountains town",
    },
    "santa-fe-nm": {
      query: "Santa Fe New Mexico adobe plaza",
      fallbackQuery: "Santa Fe New Mexico adobe architecture street",
    },
    "saratoga-springs-ny": {
      query: "Saratoga Springs New York racetrack grandstand",
      fallbackQuery: "Saratoga Springs New York Broadway victorian downtown",
    },
  };

  // Same assertion the Atlas table gets: a key that matches no destination id is
  // a silent no-op that looks exactly like a fix.
  const destIds = new Set(dests.map((d) => d.id));
  for (const key of Object.keys(DEST_OVERRIDE)) {
    if (!destIds.has(key)) {
      throw new Error(
        `friendsmoon: DEST_OVERRIDE key "${key}" matches no destination id.`,
      );
    }
  }

  for (const d of dests) {
    const stateName = STATE_NAMES[d.state] ?? d.state;
    const override = DEST_OVERRIDE[d.id];
    queries.push({
      key: `friendsmoon/destinations/${d.id}`,
      // The templated tail is now just the PLACE. It used to be `<City>
      // <State> golden hour`, and the comment here argued that adding a scene
      // noun would over-narrow — which is right, and is why nothing was added.
      // What was removed is the lighting term, the one thing on this line the
      // review had already convicted: four of the 199 came back as pet
      // photography because "golden hour" is a portrait-lighting term. The
      // fallback that used to sit here was `<City> <State>` — identical to this
      // primary once the lighting word is gone, so it is dropped rather than
      // kept as a second identical request. A miss renders nothing, by design.
      query: override?.query ?? `${d.city} ${stateName}`,
      ...(override ? { fallbackQuery: override.fallbackQuery, curated: true } : {}),
      addedBy: "friendsmoon",
      label: `friendsmoon/${d.city}, ${d.state}`,
    });
  }

  console.log(
    `  ✓ friendsmoon: ${queries.length} queries ` +
      `(1 hero, ${trips.length} atlas, ${Object.keys(REGION_SCENE).length} regions, ${dests.length} destinations)`,
  );
  return queries;
}
