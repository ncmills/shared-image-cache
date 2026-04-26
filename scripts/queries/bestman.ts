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

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { QueryItem } from "../../lib/types";
import { STATE_NAMES } from "./state-names";
import { getQueriesFromSnapshot } from "./from-snapshot";

const HOME = process.env.HOME || "/Users/bignick";
const BESTMAN_DATA_DIR = resolve(HOME, "plan-my-party/src/data");

interface PartyDestination {
  id: string;
  city: string;
  state: string;
}

export async function getBestmanQueries(): Promise<QueryItem[]> {
  // CI / sibling-repo-missing path: read from queries.snapshot.json.
  if (!existsSync(BESTMAN_DATA_DIR)) {
    const snap = getQueriesFromSnapshot("bestman");
    if (snap) {
      console.log(`  ✓ BESTMAN queries loaded from snapshot (${snap.length} entries)`);
      return snap;
    }
    console.warn(`  ⚠ BESTMAN data dir missing and no snapshot available`);
    return [];
  }

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
      // Fallback: city-specific architecture descriptor (was the generic
      // `${dest.city} skyline night`, which collapsed nearby cities to the
      // same skyline photo). Updated 2026-04-26 dedup pass to break those
      // collisions while staying city-grounded.
      fallbackQuery: `${dest.city} downtown architecture historic`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state} — lodging`,
    });

    // Dining hero — used on the "Where to Eat" section
    queries.push({
      key: `bestman/cities/${dest.id}/dining`,
      query: `${dest.city} ${dest.state} steakhouse restaurant food`,
      // Fallback: city-specific (was `${stateName} restaurant food` which
      // collapsed all Texas cities to the same Austin BBQ photo).
      fallbackQuery: `${dest.city} chef tasting menu interior`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state} — dining`,
    });

    // Bars hero — used on the "The Bars" section
    queries.push({
      key: `bestman/cities/${dest.id}/bars`,
      query: `${dest.city} ${dest.state} rooftop bar nightlife`,
      // Fallback: city-specific (was `${stateName} bar nightlife` which
      // served the same photo to 7 California + 6 Texas cities).
      fallbackQuery: `${dest.city} cocktail lounge speakeasy interior`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state} — bars`,
    });

    // Activities hero — covers the "What to Do" section.
    queries.push({
      key: `bestman/cities/${dest.id}/activities`,
      query: `${dest.city} ${dest.state} adventure outdoor sport`,
      // Fallback: city-specific (was `${stateName} outdoor adventure
      // landscape` — too generic).
      fallbackQuery: `${dest.city} outdoor recreation landscape`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state} — activities`,
    });
  }

  return queries;
}
