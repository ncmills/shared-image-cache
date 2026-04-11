/**
 * Query loader for maid-of-honor-hq (MOH).
 *
 * Bachelorette-themed hero queries: pool club / rooftop / glam aesthetic.
 */

import { resolve } from "node:path";
import type { QueryItem } from "../../lib/types";
import { STATE_NAMES } from "./state-names";

const HOME = process.env.HOME || "/Users/bignick";
const MOH_DATA_DIR = resolve(HOME, "maid-of-honor-hq/src/data");

interface PartyDestination {
  id: string;
  city: string;
  state: string;
}

export async function getMohQueries(): Promise<QueryItem[]> {
  let allDestinations: PartyDestination[] = [];
  try {
    const mod = require(resolve(MOH_DATA_DIR, "index.ts"));
    allDestinations = mod.allDestinations || mod.bacheloretteDestinations || mod.default || [];
  } catch (err) {
    console.warn(`  ⚠ MOH data not loadable: ${err instanceof Error ? err.message : err}`);
    return [];
  }

  const queries: QueryItem[] = [];

  for (const dest of allDestinations) {
    const stateName = STATE_NAMES[dest.state] || dest.state;
    queries.push({
      key: `moh/cities/${dest.id}`,
      query: `${dest.city} ${dest.state} rooftop bachelorette glam`,
      fallbackQuery: `${stateName} skyline pink sunset`,
      addedBy: "moh",
      label: `moh/${dest.city}, ${dest.state}`,
    });
  }

  return queries;
}
