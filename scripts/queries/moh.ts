/**
 * Query loader for maid-of-honor-hq (MOH).
 *
 * Five keys per city: a hero plus lodging / dining / bars / activities.
 *
 * The queries ask for the PLACE and the VENUE TYPE, never for the occasion.
 * "bachelorette glam" returns staged models at a party that never happened;
 * a photograph of a real bar in a real city is both honest and better-looking,
 * and the site's own design carries the occasion. Same ruling friendsmoon and
 * engagedmoon made. Policy: lib/query-policy.ts.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { QueryItem } from "../../lib/types";
import { STATE_NAMES } from "./state-names";
import { placePhrase } from "../../lib/query-policy";
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

  // ── QUERY SHAPE (rewritten 2026-08-20) ───────────────────────────────────
  // Every template here had all three of the defects the 199-image review
  // named. `stateName` was COMPUTED AND NEVER USED, so each query shipped a
  // postal abbreviation ("New Orleans LA ..."); friendsmoon had already proved
  // a postal code returns nothing. They were 5-6 term AND queries, and
  // `"Austin TX cocktail bar pink sunset"` returns ZERO while `"Austin
  // cocktail bar"` returns hundreds — a zero-result primary is what pushes a
  // key onto its fallback in the first place. And "bachelorette glam" /
  // "pink sunset" ask for staged models and lighting, which is how a well-lit
  // stock portrait outranks the city.
  //
  // Shape now: `<City> <State Name> <two-word scene>` primary, `<City>
  // <one-word scene>` fallback. The fallback stays scoped to the SAME CITY —
  // a state-level fallback is what collapsed four California cities onto one
  // photograph.
  for (const dest of allDestinations) {
    const stateName = STATE_NAMES[dest.state] || dest.state;
    const place = placePhrase(dest.city, stateName);

    // City-level hero (legacy single-photo key — kept for backward-compat
    // with existing consumers).
    queries.push({
      key: `moh/cities/${dest.id}`,
      query: `${place} skyline`,
      fallbackQuery: `${dest.city} downtown`,
      addedBy: "moh",
      label: `moh/${dest.city}, ${dest.state}`,
    });

    // Category fan-out — mirrors the BESTMAN HQ split.
    queries.push({
      key: `moh/cities/${dest.id}/lodging`,
      query: `${place} boutique hotel`,
      fallbackQuery: `${dest.city} hotel`,
      addedBy: "moh",
      label: `moh/${dest.city}, ${dest.state} — lodging`,
    });
    queries.push({
      key: `moh/cities/${dest.id}/dining`,
      query: `${place} restaurant interior`,
      fallbackQuery: `${dest.city} restaurant`,
      addedBy: "moh",
      label: `moh/${dest.city}, ${dest.state} — dining`,
    });
    queries.push({
      key: `moh/cities/${dest.id}/bars`,
      query: `${place} cocktail bar`,
      fallbackQuery: `${dest.city} bar`,
      addedBy: "moh",
      label: `moh/${dest.city}, ${dest.state} — bars`,
    });
    queries.push({
      key: `moh/cities/${dest.id}/activities`,
      query: `${place} spa`,
      fallbackQuery: `${dest.city} wellness`,
      addedBy: "moh",
      label: `moh/${dest.city}, ${dest.state} — activities`,
    });
  }

  return queries;
}
