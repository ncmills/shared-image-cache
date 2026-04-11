/**
 * Query loader for plan-my-party (BESTMAN HQ).
 *
 * Reads BESTMAN's destination data files and emits THREE hero queries per
 * city, one per itinerary section (lodging / dining / bars). This mirrors
 * the showcase pattern and lets the runtime generate-plan enrichment look
 * up per-section heroes without a live Unsplash call.
 *
 * Cache key shape:
 *   bestman/cities/<city-id>/lodging
 *   bestman/cities/<city-id>/dining
 *   bestman/cities/<city-id>/bars
 *
 * Runtime consumer: plan-my-party's scripts/sync-image-cache.ts projects
 * these entries into src/data/city-images.json, which image-service.ts
 * reads before falling back to the live Unsplash API.
 */

import { resolve } from "node:path";
import type { QueryItem } from "../../lib/types";
import { STATE_NAMES } from "./state-names";

const HOME = process.env.HOME || "/Users/bignick";
const BESTMAN_DATA_DIR = resolve(HOME, "plan-my-party/src/data");

interface PartyDestination {
  id: string;
  city: string;
  state: string;
}

export async function getBestmanQueries(): Promise<QueryItem[]> {
  let allDestinations: PartyDestination[] = [];
  try {
    const mod = require(resolve(BESTMAN_DATA_DIR, "index.ts"));
    allDestinations = mod.allDestinations || mod.default || [];
  } catch (err) {
    console.warn(`  ⚠ BESTMAN data not loadable: ${err instanceof Error ? err.message : err}`);
    return [];
  }

  const queries: QueryItem[] = [];

  for (const dest of allDestinations) {
    const stateName = STATE_NAMES[dest.state] || dest.state;

    // Lodging hero — the primary city hero, used on tier cards + lodging section
    queries.push({
      key: `bestman/cities/${dest.id}/lodging`,
      query: `${dest.city} ${dest.state} vacation rental house pool`,
      fallbackQuery: `${dest.city} skyline night`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state} — lodging`,
    });

    // Dining hero — used on the "Where to Eat" section
    queries.push({
      key: `bestman/cities/${dest.id}/dining`,
      query: `${dest.city} ${dest.state} steakhouse restaurant food`,
      fallbackQuery: `${stateName} restaurant food`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state} — dining`,
    });

    // Bars hero — used on the "The Bars" section
    queries.push({
      key: `bestman/cities/${dest.id}/bars`,
      query: `${dest.city} ${dest.state} rooftop bar nightlife`,
      fallbackQuery: `${stateName} bar nightlife`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state} — bars`,
    });
  }

  return queries;
}
