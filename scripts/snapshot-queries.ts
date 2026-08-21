/**
 * Snapshot every project's query loader into queries.snapshot.json, so the
 * fetcher can run on CI (or anywhere without the sibling repos checked out).
 *
 * ── WHY THIS FILE NOW RECORDS ITS OWN PROVENANCE ────────────────────────────
 * The committed snapshot was generated 2026-06-26 and held FOUR projects. On
 * CI every loader falls back to it, so for eight weeks the autonomous pipeline
 * fetched an eight-week-old query set — for offsite it knew 337 keys against
 * 619 live, and friendsmoon and engagedmoon were not in it at all, meaning two
 * of six sites had never been fetched by CI once. Nothing said so: a loader
 * reading a stale snapshot looks exactly like a loader reading fresh data.
 *
 * There is a trap in "just regenerate it on CI": on CI the sibling repos are
 * absent, so every loader would fall back to THE SNAPSHOT ITSELF and write it
 * straight back with a fresh timestamp. The file would look newly generated
 * forever while its contents aged, and a staleness check reading that
 * timestamp would be measuring its own tail.
 *
 * So each project slice records where it came from:
 *
 *   "sources": { "moh": { "from": "live", "generatedAt": "...", "count": 960 } }
 *
 * `from: "live"` means the sibling repo was present and the slice is real.
 * `from: "preserved"` means the loader could only see the snapshot, so the
 * slice AND its original timestamp are carried through untouched. That is what
 * lets scripts/check-snapshot-drift.ts say "the moh loader changed after the
 * moh slice was generated" and be right.
 *
 * Usage:
 *   npx tsx scripts/snapshot-queries.ts            # regenerate + write
 *   npx tsx scripts/snapshot-queries.ts --check    # verify only, write nothing
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { QueryItem } from "../lib/types";
import { LOADERS } from "./loaders";
import { wasLoadedFromSnapshot } from "./queries/from-snapshot";

const SNAPSHOT_PATH = resolve(__dirname, "..", "queries.snapshot.json");

export interface SnapshotSource {
  from: "live" | "preserved";
  generatedAt: string;
  count: number;
}

export interface Snapshot {
  generatedAt: string;
  projects: Record<string, QueryItem[]>;
  sources: Record<string, SnapshotSource>;
  totalQueries: number;
}

function readExisting(): Snapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

export async function buildSnapshot(now = new Date()): Promise<Snapshot> {
  const existing = readExisting();
  const projects: Record<string, QueryItem[]> = {};
  const sources: Record<string, SnapshotSource> = {};

  for (const [name, loader] of Object.entries(LOADERS)) {
    const queries = await loader();

    if (wasLoadedFromSnapshot(name)) {
      // The sibling repo is not here. Carry the existing slice AND its
      // original timestamp through unchanged — re-stamping it would launder
      // an old query set into a fresh-looking one.
      const prev = existing?.sources?.[name];
      projects[name] = existing?.projects?.[name] ?? queries;
      sources[name] = {
        from: "preserved",
        generatedAt: prev?.generatedAt ?? existing?.generatedAt ?? "1970-01-01T00:00:00.000Z",
        count: projects[name].length,
      };
      console.log(
        `  ${name.padEnd(12)} ${String(projects[name].length).padStart(4)} queries — PRESERVED ` +
          `(data dir absent; slice dated ${sources[name].generatedAt.slice(0, 10)})`,
      );
      continue;
    }

    projects[name] = queries;
    sources[name] = { from: "live", generatedAt: now.toISOString(), count: queries.length };
    console.log(`  ${name.padEnd(12)} ${String(queries.length).padStart(4)} queries — live`);
  }

  const totalQueries = Object.values(projects).reduce((n, q) => n + q.length, 0);
  return { generatedAt: now.toISOString(), projects, sources, totalQueries };
}

/** Stable serialization, so a no-op regeneration is byte-identical. */
export function serializeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify(snapshot, null, 2) + "\n";
}

async function main() {
  const check = process.argv.includes("--check");
  console.log(check ? "Verifying query snapshot...\n" : "Generating query snapshot...\n");

  const existing = readExisting();
  // In --check mode hold `generatedAt` fixed, so the only thing compared is
  // query CONTENT. A timestamp difference is not drift.
  const now = check && existing ? new Date(existing.generatedAt) : new Date();
  const snapshot = await buildSnapshot(now);

  const liveCount = Object.values(snapshot.sources).filter((s) => s.from === "live").length;
  console.log(
    `\n${snapshot.totalQueries} queries across ${Object.keys(snapshot.projects).length} projects ` +
      `(${liveCount} regenerated live, ${Object.keys(snapshot.sources).length - liveCount} preserved)`,
  );

  if (!check) {
    writeFileSync(SNAPSHOT_PATH, serializeSnapshot(snapshot), "utf8");
    console.log("✓ Wrote queries.snapshot.json — commit it so CI reads the same queries you do.");
    return;
  }

  if (!existing) {
    console.error("✗ snapshot --check: queries.snapshot.json is missing");
    process.exit(1);
  }

  const wanted = serializeSnapshot(snapshot);
  const have = serializeSnapshot({ ...existing, generatedAt: snapshot.generatedAt });
  if (wanted !== have) {
    const changed = Object.keys(snapshot.projects).filter(
      (p) => JSON.stringify(snapshot.projects[p]) !== JSON.stringify(existing.projects?.[p] ?? null),
    );
    console.error(
      `\n✗ snapshot --check: the committed snapshot does not match what the loaders emit` +
        (changed.length ? ` (differs for: ${changed.join(", ")})` : "") +
        `\n  Run \`npm run snapshot\` where the sibling repos are checked out, and commit the result.` +
        `\n  The snapshot is what the CI fetcher actually asks for — a snapshot that disagrees` +
        `\n  with its loaders means every cron run is fetching a query set nobody reviewed.`,
    );
    process.exit(1);
  }
  console.log("✓ snapshot --check: the committed snapshot matches the loaders");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("✘ Snapshot failed:", err);
    process.exit(1);
  });
}
