/**
 * Query loader for tour-de-fore.
 *
 * Reads TDF's destination data files and emits one query per:
 *   - destination hero (city + state landscape)
 *   - bachelor-party hero (city nightlife)
 *   - guide hero (handpicked thematic)
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { QueryItem } from "../../lib/types";
import { STATE_NAMES } from "./state-names";
import { placePhrase } from "../../lib/query-policy";
import { getQueriesFromSnapshot } from "./from-snapshot";

const HOME = process.env.HOME || "/Users/bignick";
// golf-trip planner (+ its destination data) split off tourdefore.com -> handicaphq.com 2026-07-02
const TDF_DATA_DIR = resolve(HOME, "handicap-hq/src/data");

interface TdfDestination {
  id: string;
  city: string;
  state: string;
  population: "tiny" | "small" | "medium";
  bars: { lateNight: boolean }[];
}

const GUIDE_QUERIES: Record<string, string> = {
  "how-to-plan-a-group-golf-trip": "group golf friends",
  "best-golf-trip-destinations-by-month": "golf course seasons",
  "best-walkable-golf-courses": "links golf walking",
  "golf-trip-budget-guide": "golf bag fairway",
  "golf-trip-packing-list": "golf travel bag",
  "best-golf-trips-under-500": "affordable golf course",
  "desert-vs-coastal-vs-mountain-golf": "desert golf course sunset",
  "best-golf-destinations-for-large-groups": "golf foursome celebration",
  "top-bucket-list-golf-courses": "iconic golf course aerial",
  "first-time-golf-trip-mistakes": "golfer thinking fairway",
  "best-golf-trips-near-airports": "golf course aerial landscape",
  "best-fall-golf-trip-destinations": "fall golf course leaves",
};

export async function getTdfQueries(): Promise<QueryItem[]> {
  if (!existsSync(TDF_DATA_DIR)) {
    const snap = getQueriesFromSnapshot("tdf");
    if (snap) {
      console.log(`  ✓ TDF queries loaded from snapshot (${snap.length} entries)`);
      return snap;
    }
    console.warn(`  ⚠ TDF data dir missing and no snapshot available`);
    return [];
  }

  // Dynamic require so the shared repo doesn't fail if TDF isn't installed.
  let allDestinations: TdfDestination[] = [];
  try {
    const mod = require(resolve(TDF_DATA_DIR, "index.ts"));
    allDestinations = mod.allDestinations || [];
  } catch (err) {
    console.warn(`  ⚠ TDF data not loadable: ${err instanceof Error ? err.message : err}`);
    return [];
  }

  const queries: QueryItem[] = [];

  // The postal code is dropped for the full state name, and the STATE-LEVEL
  // fallbacks are dropped entirely. `"${stateName} landscape"` is the exact
  // shape that puts one photograph on every city in a state — a destination
  // key names one town, and widening it to the state answers a question
  // nobody asked. A miss here renders ImageWithFallback, which is fine.
  for (const dest of allDestinations) {
    queries.push({
      key: `tdf/destinations/${dest.id}`,
      query: `${placePhrase(dest.city, STATE_NAMES[dest.state] || dest.state)} landscape`,
      addedBy: "tdf",
      label: `${dest.city}, ${dest.state}`,
    });
  }

  // Bachelor party pages — only for destinations with 3+ bars and not tiny
  for (const dest of allDestinations) {
    if (dest.bars.length >= 3 && dest.population !== "tiny") {
      queries.push({
        key: `tdf/bachelorParty/${dest.id}`,
        query: `${placePhrase(dest.city, STATE_NAMES[dest.state] || dest.state)} nightlife`,
        fallbackQuery: `${dest.city} downtown`,
        addedBy: "tdf",
        label: `${dest.city} bachelor`,
      });
    }
  }

  // Guides — hand-picked thematic strings, not templates.
  for (const [slug, query] of Object.entries(GUIDE_QUERIES)) {
    queries.push({
      key: `tdf/guides/${slug}`,
      query,
      addedBy: "tdf",
      label: `tdf guide:${slug}`,
      curated: true,
    });
  }

  return queries;
}
