/**
 * Query loader for tour-de-fore.
 *
 * Reads TDF's destination data files and emits one query per:
 *   - destination hero (city + state landscape)
 *   - bachelor-party hero (city nightlife)
 *   - guide hero (handpicked thematic)
 */

import { resolve } from "node:path";
import type { QueryItem } from "../../lib/types";
import { STATE_NAMES } from "./state-names";

const HOME = process.env.HOME || "/Users/bignick";
const TDF_DATA_DIR = resolve(HOME, "tour-de-fore/src/data");

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

  for (const dest of allDestinations) {
    const stateName = STATE_NAMES[dest.state] || dest.state;
    queries.push({
      key: `tdf/destinations/${dest.id}`,
      query: `${dest.city} ${dest.state} landscape`,
      fallbackQuery: `${stateName} landscape`,
      addedBy: "tdf",
      label: `${dest.city}, ${dest.state}`,
    });
  }

  // Bachelor party pages — only for destinations with 3+ bars and not tiny
  for (const dest of allDestinations) {
    if (dest.bars.length >= 3 && dest.population !== "tiny") {
      const stateName = STATE_NAMES[dest.state] || dest.state;
      queries.push({
        key: `tdf/bachelorParty/${dest.id}`,
        query: `${dest.city} nightlife skyline`,
        fallbackQuery: `${stateName} downtown night`,
        addedBy: "tdf",
        label: `${dest.city} bachelor`,
      });
    }
  }

  // Guides
  for (const [slug, query] of Object.entries(GUIDE_QUERIES)) {
    queries.push({
      key: `tdf/guides/${slug}`,
      query,
      addedBy: "tdf",
      label: `tdf guide:${slug}`,
    });
  }

  return queries;
}
