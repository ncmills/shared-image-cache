/**
 * Snapshot the current state of every project's query loader into a single
 * JSON file at queries.snapshot.json. This lets the fetcher run on CI (or
 * any environment without the sibling project repos checked out) by reading
 * the snapshot instead of walking sibling filesystems.
 *
 * Usage:
 *   npx tsx scripts/snapshot-queries.ts
 *
 * Re-run this whenever you add/remove a destination in BESTMAN, MOH, or TDF.
 * The snapshot is committed to this repo; the GitHub Actions fetcher reads
 * from it automatically.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { QueryItem } from "../lib/types";
import { getBestmanQueries } from "./queries/bestman";
import { getMohQueries } from "./queries/moh";
import { getTdfQueries } from "./queries/tdf";

const SNAPSHOT_PATH = resolve(__dirname, "..", "queries.snapshot.json");

interface Snapshot {
  generatedAt: string;
  projects: Record<string, QueryItem[]>;
  totalQueries: number;
}

async function main() {
  console.log("Generating query snapshot...\n");

  const projects: Record<string, QueryItem[]> = {
    bestman: await getBestmanQueries(),
    moh: await getMohQueries(),
    tdf: await getTdfQueries(),
  };

  let total = 0;
  for (const [name, queries] of Object.entries(projects)) {
    console.log(`  ${name}: ${queries.length} queries`);
    total += queries.length;
  }

  const snapshot: Snapshot = {
    generatedAt: new Date().toISOString(),
    projects,
    totalQueries: total,
  };

  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(`\n✓ Wrote ${total} queries across ${Object.keys(projects).length} projects to queries.snapshot.json`);
  console.log("  Commit this file so the GitHub Actions fetcher can read it.");
}

main().catch((err) => {
  console.error("✘ Snapshot failed:", err);
  process.exit(1);
});
