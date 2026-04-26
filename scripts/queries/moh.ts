/**
 * Query loader for maid-of-honor-hq (MOH).
 *
 * Bachelorette-themed hero queries: pool club / rooftop / glam aesthetic.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { QueryItem } from "../../lib/types";
import { STATE_NAMES } from "./state-names";
import { getQueriesFromSnapshot } from "./from-snapshot";

const HOME = process.env.HOME || "/Users/bignick";
const MOH_DATA_DIR = resolve(HOME, "maid-of-honor-hq/src/data");

interface PartyDestination {
  id: string;
  city: string;
  state: string;
}

export async function getMohQueries(): Promise<QueryItem[]> {
  if (!existsSync(MOH_DATA_DIR)) {
    const snap = getQueriesFromSnapshot("moh");
    if (snap) {
      console.log(`  ✓ MOH queries loaded from snapshot (${snap.length} entries)`);
      return snap;
    }
    console.warn(`  ⚠ MOH data dir missing and no snapshot available`);
    return [];
  }

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

    // City-level hero (legacy single-photo key — kept for backward-compat
    // with existing consumers; will be deprecated once category fan-out
    // is fully populated below).
    queries.push({
      key: `moh/cities/${dest.id}`,
      query: `${dest.city} ${dest.state} rooftop bachelorette glam`,
      fallbackQuery: `${stateName} skyline pink sunset`,
      addedBy: "moh",
      label: `moh/${dest.city}, ${dest.state}`,
    });

    // Category fan-out — added 2026-04-26 to mirror the BESTMAN HQ
    // bars/dining/lodging/activities split. Closes the MOH category gap
    // where every city used the same photo regardless of what section
    // was rendering.
    queries.push({
      key: `moh/cities/${dest.id}/lodging`,
      query: `${dest.city} ${dest.state} boutique hotel bachelorette suite`,
      fallbackQuery: `${dest.city} luxury hotel pool`,
      addedBy: "moh",
      label: `moh/${dest.city}, ${dest.state} — lodging`,
    });
    queries.push({
      key: `moh/cities/${dest.id}/dining`,
      query: `${dest.city} ${dest.state} editorial restaurant brunch`,
      fallbackQuery: `${stateName} restaurant farm-to-table`,
      addedBy: "moh",
      label: `moh/${dest.city}, ${dest.state} — dining`,
    });
    queries.push({
      key: `moh/cities/${dest.id}/bars`,
      query: `${dest.city} ${dest.state} cocktail bar pink sunset`,
      fallbackQuery: `${stateName} cocktail bar interior`,
      addedBy: "moh",
      label: `moh/${dest.city}, ${dest.state} — bars`,
    });
    queries.push({
      key: `moh/cities/${dest.id}/activities`,
      query: `${dest.city} ${dest.state} spa wellness retreat`,
      fallbackQuery: `${stateName} wellness retreat outdoor`,
      addedBy: "moh",
      label: `moh/${dest.city}, ${dest.state} — activities`,
    });
  }

  return queries;
}
