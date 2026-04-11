/**
 * Query loader for plan-my-party (BESTMAN HQ).
 *
 * Reads BESTMAN's destination data files and emits one hero query per city.
 * Bachelor-party themed: nightlife skyline.
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
    queries.push({
      key: `bestman/cities/${dest.id}`,
      query: `${dest.city} ${dest.state} bachelor party nightlife`,
      fallbackQuery: `${stateName} skyline night`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state}`,
    });
  }

  return queries;
}
