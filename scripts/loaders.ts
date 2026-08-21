/**
 * The project registry — ONE list of who is in this pipeline.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * friendsmoon and engagedmoon were absent from FOUR separate places at once:
 * `queries.snapshot.json`, `fetch-images.yml`'s per-project steps,
 * `gap-report.ts`'s own LOADERS map, and `daily-maxout.yml`'s deploy-hook
 * refresh grep (hardcoded `(offsite|bestman|moh|tdf)`). Every one of those
 * failed SILENTLY: the fetcher loaded a loader that returned 0 queries, the
 * gap report simply did not have a row, and the refresh step said nothing
 * about the site it never considered. Two of six sites were outside the
 * autonomous pipeline and nothing anywhere said so.
 *
 * Three of those four layers now read THIS map, so adding a project is one
 * edit rather than four. The fourth is a YAML list of shell tokens in
 * daily-maxout.yml, which cannot import TypeScript — `PROJECTS` below is the
 * list it must agree with, and `scripts/check-workflow-projects.ts` fails the
 * build when it does not.
 */

import type { QueryItem } from "../lib/types";
import { getTdfQueries } from "./queries/tdf";
import { getOffsiteQueries } from "./queries/offsite";
import { getBestmanQueries } from "./queries/bestman";
import { getMohQueries } from "./queries/moh";
import { getEngagedmoonQueries } from "./queries/engagedmoon";
import { getFriendsmoonQueries } from "./queries/friendsmoon";

export const LOADERS: Record<string, () => Promise<QueryItem[]>> = {
  tdf: getTdfQueries,
  bestman: getBestmanQueries,
  moh: getMohQueries,
  offsite: getOffsiteQueries,
  friendsmoon: getFriendsmoonQueries,
  engagedmoon: getEngagedmoonQueries,
};

/** Every project key, in the order the fetcher loads them. */
export const PROJECTS = Object.keys(LOADERS);

/** The repo secret holding each project's Vercel deploy hook. */
export const HOOK_SECRET: Record<string, string> = Object.fromEntries(
  PROJECTS.map((p) => [p, `HOOK_${p.toUpperCase()}`]),
);
