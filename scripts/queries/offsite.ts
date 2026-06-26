/**
 * Query loader for offsite-outpost.
 *
 * Reads the Offsite atlas (venues / experiences / outings) and emits one
 * query per record, plus a hero query per distinct retreat setting (used by
 * the /retreats/[setting] landing pages).
 *
 * Cache keys mirror exactly what offsite-outpost looks up at build time
 * (see offsite-outpost/src/lib/image-service.ts → shared-cache tier):
 *   offsite/venues/<id>
 *   offsite/experiences/<id>
 *   offsite/outings/<id>
 *   offsite/settings/<setting>
 *
 * Like the other loaders, falls back to queries.snapshot.json when the
 * offsite repo isn't checked out (e.g. on GitHub Actions).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { QueryItem } from "../../lib/types";
import { getQueriesFromSnapshot } from "./from-snapshot";

const HOME = process.env.HOME || "/Users/bignick";
const OFFSITE_ATLAS_DIR = resolve(HOME, "offsite-outpost/src/lib/atlas");

interface Venue {
  id: string;
  name: string;
  setting: string;
  region: string;
  country: string;
  imageQuery: string;
}
interface Experience {
  id: string;
  name: string;
  kind: string;
  imageQuery: string;
}
interface Outing {
  id: string;
  name: string;
  focus: string;
  settings: string[];
  region: string;
}

export async function getOffsiteQueries(): Promise<QueryItem[]> {
  if (!existsSync(OFFSITE_ATLAS_DIR)) {
    const snap = getQueriesFromSnapshot("offsite");
    if (snap) {
      console.log(`  ✓ Offsite queries loaded from snapshot (${snap.length} entries)`);
      return snap;
    }
    console.warn(`  ⚠ Offsite atlas dir missing and no snapshot available`);
    return [];
  }

  let venues: Venue[] = [];
  let experiences: Experience[] = [];
  let outings: Outing[] = [];
  try {
    // Dynamic require so the shared repo doesn't fail if offsite isn't present.
    const mod = require(resolve(OFFSITE_ATLAS_DIR, "index.ts"));
    venues = mod.ALL_VENUES || [];
    experiences = mod.ALL_EXPERIENCES || [];
    outings = mod.ALL_OUTINGS || [];
  } catch (err) {
    console.warn(`  ⚠ Offsite atlas not loadable: ${err instanceof Error ? err.message : err}`);
    return [];
  }

  const queries: QueryItem[] = [];

  // Venues — the search intent the atlas already carries is the primary query.
  for (const v of venues) {
    queries.push({
      key: `offsite/venues/${v.id}`,
      query: v.imageQuery || `${v.name} ${v.region}`,
      fallbackQuery: `${v.setting} corporate retreat venue landscape`,
      addedBy: "offsite",
      label: `${v.name} (${v.setting})`,
    });
  }

  // Experiences.
  for (const e of experiences) {
    queries.push({
      key: `offsite/experiences/${e.id}`,
      query: e.imageQuery || e.name,
      fallbackQuery: `${e.kind} corporate team experience outdoor`,
      addedBy: "offsite",
      label: `exp:${e.name}`,
    });
  }

  // Outings — no imageQuery on the type; mirror the page's runtime query.
  for (const o of outings) {
    queries.push({
      key: `offsite/outings/${o.id}`,
      query: `${o.name} ${o.focus} corporate outing`,
      fallbackQuery: `${o.focus} corporate event outdoor`,
      addedBy: "offsite",
      label: `outing:${o.name}`,
    });
  }

  // Setting landing-page heroes — one per distinct retreat setting.
  const settings = Array.from(new Set(venues.map((v) => v.setting))).sort();
  for (const s of settings) {
    queries.push({
      key: `offsite/settings/${s}`,
      query: `${s} luxury corporate retreat resort landscape`,
      fallbackQuery: `${s} resort landscape`,
      addedBy: "offsite",
      label: `setting:${s}`,
    });
  }

  return queries;
}
