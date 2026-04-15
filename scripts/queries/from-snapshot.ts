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
  return snapshot.projects[project] ?? null;
}
