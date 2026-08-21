/**
 * gap-report.ts — the image-gap identifier for the shared cache.
 *
 * Loads every project's query loader (the SAME source of truth the fetcher
 * uses), diffs the desired keys against cache.json, and reports — per project
 * and per category — exactly which images are still missing. This is the
 * "identify gaps" half of the daily loop: the fetcher pulls what's missing
 * (bounded, under the API ceiling) and the deploy hooks plug new images into
 * each site; this script makes the remaining gap visible and trackable so we
 * can watch the cache converge day over day.
 *
 * Pure read-only — no network, no writes (unless --write-summary is passed,
 * which appends a markdown table to $GITHUB_STEP_SUMMARY for the daily run).
 *
 * Usage:
 *   npx tsx scripts/gap-report.ts                 # human report to stdout
 *   npx tsx scripts/gap-report.ts --write-summary # also append GH step summary
 *   npx tsx scripts/gap-report.ts --list=offsite  # list every missing key for a project
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Cache, QueryItem } from "../lib/types";
import { isSuppressed, missStats, type Misses } from "../lib/misses";
import { getTdfQueries } from "./queries/tdf";
import { getOffsiteQueries } from "./queries/offsite";
import { getBestmanQueries } from "./queries/bestman";
import { getMohQueries } from "./queries/moh";

const REPO_ROOT = resolve(__dirname, "..");
const CACHE_PATH = resolve(REPO_ROOT, "cache.json");
const MISSES_PATH = resolve(REPO_ROOT, "misses.json");

const LOADERS: Record<string, () => Promise<QueryItem[]>> = {
  tdf: getTdfQueries,
  bestman: getBestmanQueries,
  moh: getMohQueries,
  offsite: getOffsiteQueries,
};

async function main() {
  const args = process.argv.slice(2);
  const listProject = args.find((a) => a.startsWith("--list="))?.slice(7);
  const writeSummary = args.includes("--write-summary");

  const cache: Cache = existsSync(CACHE_PATH)
    ? JSON.parse(readFileSync(CACHE_PATH, "utf8"))
    : {};

  const misses: Misses = existsSync(MISSES_PATH)
    ? JSON.parse(readFileSync(MISSES_PATH, "utf8"))
    : {};

  type ProjStat = {
    total: number;
    cached: number;
    missing: number;
    /** Missing AND held out of the queue by a fresh tombstone (lib/misses.ts). */
    suppressed: number;
    byCategory: Record<string, { total: number; missing: number }>;
    missingKeys: string[];
  };
  const stats: Record<string, ProjStat> = {};

  for (const [project, loader] of Object.entries(LOADERS)) {
    const queries = await loader();
    const s: ProjStat = {
      total: 0,
      cached: 0,
      missing: 0,
      suppressed: 0,
      byCategory: {},
      missingKeys: [],
    };
    for (const q of queries) {
      s.total++;
      const cat = q.key.split("/")[1] ?? "_";
      s.byCategory[cat] ??= { total: 0, missing: 0 };
      s.byCategory[cat].total++;
      if (cache[q.key]) {
        s.cached++;
      } else {
        s.missing++;
        s.byCategory[cat].missing++;
        s.missingKeys.push(q.key);
        if (isSuppressed(misses, q)) s.suppressed++;
      }
    }
    stats[project] = s;
  }

  // ── human report ─────────────────────────────────────────────────────
  let totalMissing = 0;
  const lines: string[] = [];
  lines.push("# Shared image-cache — gap report\n");
  lines.push("| Project | desired | cached | MISSING | tombstoned | queueable | coverage |");
  lines.push("|---|--:|--:|--:|--:|--:|--:|");
  let totalSuppressed = 0;
  for (const [project, s] of Object.entries(stats)) {
    totalMissing += s.missing;
    totalSuppressed += s.suppressed;
    const pct = s.total ? Math.round((s.cached / s.total) * 100) : 100;
    lines.push(
      `| ${project} | ${s.total} | ${s.cached} | ${s.missing} | ${s.suppressed} | ${s.missing - s.suppressed} | ${pct}% |`,
    );
  }
  lines.push("");
  for (const [project, s] of Object.entries(stats)) {
    if (s.missing === 0) continue;
    const cats = Object.entries(s.byCategory)
      .filter(([, c]) => c.missing > 0)
      .sort((a, b) => b[1].missing - a[1].missing)
      .map(([cat, c]) => `${cat}:${c.missing}`)
      .join(" · ");
    lines.push(`**${project}** — ${s.missing} missing by category: ${cats}`);
  }

  const ms = missStats(misses);
  lines.push("");
  lines.push(
    `_"tombstoned" = missing keys held out of the fetch queue by a fresh miss record ` +
      `(${ms.fresh} fresh / ${ms.total} recorded). "queueable" is what the next run can actually reach._`,
  );

  console.log(lines.join("\n"));
  console.log(
    `\nTotal missing across all sites: ${totalMissing} (${totalSuppressed} tombstoned, ` +
      `${totalMissing - totalSuppressed} queueable)`,
  );

  if (listProject && stats[listProject]) {
    console.log(`\n── every missing key for ${listProject} ──`);
    for (const k of stats[listProject].missingKeys) console.log("  " + k);
  }

  if (writeSummary && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      lines.join("\n") +
        `\n\n**Total missing: ${totalMissing}** (${totalSuppressed} tombstoned, ` +
        `${totalMissing - totalSuppressed} queueable)\n`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
