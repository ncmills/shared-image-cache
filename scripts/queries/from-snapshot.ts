/**
 * Snapshot fallback reader — shared between all project loaders.
 *
 * When a project's filesystem data dir isn't available (e.g., running on
 * GitHub Actions where only this repo is checked out), loaders fall back
 * to queries.snapshot.json. The snapshot is generated locally by
 * scripts/snapshot-queries.ts and committed to the repo.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { QueryItem } from "../../lib/types";

const SNAPSHOT_PATH = resolve(__dirname, "..", "..", "queries.snapshot.json");

interface Snapshot {
  generatedAt: string;
  projects: Record<string, QueryItem[]>;
  totalQueries: number;
}

let cached: Snapshot | null = null;

/**
 * Which projects fell back to the snapshot in THIS process.
 *
 * snapshot-queries.ts needs to know: a loader that read the snapshot must not
 * have its slice re-stamped as freshly generated, or the file looks eternally
 * current while its contents age. Recording it here, at the one place the
 * fallback actually happens, means no caller has to duplicate the loaders'
 * data-dir knowledge to find out.
 */
const loadedFromSnapshot = new Set<string>();

export function wasLoadedFromSnapshot(project: string): boolean {
  return loadedFromSnapshot.has(project);
}

function loadSnapshot(): Snapshot | null {
  if (cached) return cached;
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    cached = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;
    return cached;
  } catch {
    return null;
  }
}

export function getQueriesFromSnapshot(project: string): QueryItem[] | null {
  const snapshot = loadSnapshot();
  if (!snapshot) return null;
  const queries = snapshot.projects[project] ?? null;
  if (queries) loadedFromSnapshot.add(project);
  return queries;
}
