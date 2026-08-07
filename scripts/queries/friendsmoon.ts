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
const CATEGORY_SCENE: Record<string, string> = {
  "one-big-house": "countryside estate house golden hour",
  "coastal-slow": "coastline golden hour",
  "mountain-cabin": "mountains autumn ridge",
  "wine-and-table": "vineyard rows golden hour",
  "lake-and-boat": "lake dock summer evening",
  "island-ferry": "island harbour boats",
  "desert-quiet": "desert landscape dusk",
  "city-weekend": "historic district golden hour",
};

const REGION_SCENE: Record<string, { query: string; fallback: string }> = {
  northeast: {
    query: "New England coastline autumn golden hour",
    fallback: "Maine harbour lobster boats",
  },
  south: {
    query: "Blue Ridge mountains autumn morning",
    fallback: "Savannah live oaks Spanish moss",
  },
  midwest: {
    query: "Great Lakes shoreline summer evening",
    fallback: "Michigan lake dunes sunset",
  },
  west: {
    query: "Pacific coast highway golden hour",
    fallback: "Sierra Nevada lake granite",
  },
  international: {
    query: "Mediterranean coastal town terracotta rooftops",
    fallback: "Portugal coastline cliffs sunset",
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

  for (const d of dests) {
    const stateName = STATE_NAMES[d.state] ?? d.state;
    queries.push({
      key: `friendsmoon/destinations/${d.id}`,
      // "<City> <State> golden hour" reliably returns the place. Adding a scene
      // noun here ("waterfront", "downtown") narrows it enough that small
      // cities return nothing and silently fall through to the fallback, which
      // is how a destination ends up wearing a generic stock landscape.
      query: `${d.city} ${stateName} golden hour`,
      fallbackQuery: `${d.city} ${stateName}`,
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
