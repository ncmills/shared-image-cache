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
import { placePhrase } from "../../lib/query-policy";
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

  // ── QUERY SHAPE (rewritten 2026-08-20) ───────────────────────────────────
  // Same three defects as MOH: `stateName` was computed and never used, so
  // every query shipped a postal code; the primaries ran to six terms, which
  // returns zero for most cities and pushes the key onto its fallback; and the
  // resulting URLs showed state-level text on city keys ("North Carolina
  // restaurant food" under asheville-nc/dining), which is the mechanism that
  // puts one photo on eight cities. Primary = `<City> <State> <two-word
  // scene>`; fallback = `<City> <scene>`, never wider than the city.
  for (const dest of allDestinations) {
    const place = placePhrase(dest.city, STATE_NAMES[dest.state] || dest.state);

    // Lodging hero — also the primary city hero on tier cards.
    queries.push({
      key: `bestman/cities/${dest.id}/lodging`,
      query: `${place} vacation rental`,
      fallbackQuery: `${dest.city} downtown architecture`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state} — lodging`,
    });

    // Dining hero — the "Where to Eat" section.
    queries.push({
      key: `bestman/cities/${dest.id}/dining`,
      query: `${place} steakhouse`,
      fallbackQuery: `${dest.city} restaurant`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state} — dining`,
    });

    // Bars hero — "The Bars".
    queries.push({
      key: `bestman/cities/${dest.id}/bars`,
      query: `${place} rooftop bar`,
      fallbackQuery: `${dest.city} cocktail lounge`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state} — bars`,
    });

    // Activities hero — "What to Do".
    queries.push({
      key: `bestman/cities/${dest.id}/activities`,
      query: `${place} outdoor adventure`,
      fallbackQuery: `${dest.city} outdoor recreation`,
      addedBy: "bestman",
      label: `bestman/${dest.city}, ${dest.state} — activities`,
    });
  }

  return queries;
}
