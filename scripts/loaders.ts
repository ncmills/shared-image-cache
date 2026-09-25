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

/**
 * The repo secret holding each project's Vercel deploy hook.
 *
 * Derived from the project key by default, with ONE deliberate exception: a
 * cache-key prefix names a QUERY SET, not a Vercel project, and for `tdf` those
 * two came apart when the golf planner split out of tour-de-fore on 2026-07-02.
 * The `tdf/*` keys are generated from handicap-hq's data and consumed by
 * handicap-hq — the only one of the pair with a `prebuild` sync-image-cache
 * step. `tour-de-fore` is a separate PERSONAL site that consumes nothing here,
 * so the image pipeline must never rebuild it, and a secret named HOOK_TDF
 * deploying HHQ is exactly the conflation that hid this.
 *
 * Renaming the prefix itself would orphan 419 cached keys, so the override
 * lives here instead — one line, next to the rule it bends.
 */
const HOOK_SECRET_OVERRIDES: Record<string, string> = {
  tdf: "HOOK_HANDICAP",
};

/**
 * The GitHub repo that CONSUMES each project's slice, and the command that
 * projects the shared cache into that repo's own tracked data file.
 *
 * D85, 2026-08-28. Propagation already exists — `daily-maxout.yml` pings each
 * site's Vercel deploy hook when it gains images — but it propagates as a
 * REBUILD, never as a commit. The consumer's tracked JSON is only ever written
 * during a build, on a machine that then throws the result away, so the image
 * set a site actually serves exists in NO COMMIT and cannot be reproduced or
 * reviewed. Measured 2026-08-28: offsite-outpost ships 218 committed entries
 * where this cache projects 572, and plan-my-party 106 cities where it
 * projects 213. Nobody chose either number.
 *
 * `propagate-to-consumers.yml` is the committing half, and this is the list it
 * must agree with — the FIFTH layer, checked by check-workflow-projects.ts for
 * the same reason as the other four.
 *
 * THE COMMAND IS THE CONSUMER'S OWN SCRIPT, deliberately. Reimplementing six
 * projections here would create a second definition of each one, and two
 * definitions of the same projection drift — which is the whole failure this
 * repo keeps meeting. The consumer owns the shape of its own data file; this
 * pipeline only decides when to ask.
 *
 * friendsmoon's is `.js` run by `node`, not tsx. That is not an oversight to
 * normalise from here: it is that repo's choice, and the command names it.
 */
export const CONSUMER_REPO: Record<string, string> = {
  tdf: "ncmills/handicap-hq",   // NOT tour-de-fore — see HOOK_SECRET_OVERRIDES above
  bestman: "ncmills/plan-my-party",
  moh: "ncmills/maid-of-honor-hq",
  offsite: "ncmills/offsite-outpost",
  friendsmoon: "ncmills/friendsmoon",
  engagedmoon: "ncmills/engagedmoon",
};

export const CONSUMER_SYNC: Record<string, string> = {
  tdf: "npx -y tsx scripts/sync-image-cache.ts",
  bestman: "npx -y tsx scripts/sync-image-cache.ts",
  moh: "npx -y tsx scripts/sync-image-cache.ts",
  offsite: "npx -y tsx scripts/sync-image-cache.ts",
  friendsmoon: "node scripts/sync-image-cache.js",
  engagedmoon: "npx -y tsx scripts/sync-image-cache.ts",
};

export const HOOK_SECRET: Record<string, string> = Object.fromEntries(
  PROJECTS.map((p) => [p, HOOK_SECRET_OVERRIDES[p] ?? `HOOK_${p.toUpperCase()}`]),
);
