/**
 * check-snapshot-drift — the committed snapshot must not be older than the
 * loaders that produced it.
 *
 * On CI the sibling project repos are not checked out, so EVERY loader falls
 * back to queries.snapshot.json. That file is therefore the real input to the
 * autonomous fetcher, and it had been sitting at 2026-06-26 with four of six
 * projects in it for eight weeks while people edited the loaders. Nothing
 * failed. The fetcher simply asked June's questions.
 *
 * Two failures here:
 *
 *   1. MISSING PROJECT — a loader exists but has no slice in the snapshot, so
 *      on CI that project emits zero queries and is invisible. This is exactly
 *      how friendsmoon and engagedmoon were never fetched by CI at all.
 *   2. STALE SLICE — a project's loader was committed AFTER the snapshot was
 *      last committed. The loader changed; the questions CI asks did not.
 *
 * The comparison is COMMIT-TO-COMMIT (`git log -1 --format=%cI -- <file>`),
 * never file mtimes (all "now" on a fresh checkout) and never the snapshot's
 * own `generatedAt`. Regenerating always happens slightly BEFORE the commit
 * that lands it, so comparing a generation timestamp against a commit
 * timestamp would fail every correct re-snapshot — a guard that fails correct
 * work is one somebody deletes. Landing both files in one commit gives equal
 * timestamps, which passes; touching a loader afterwards does not.
 *
 * ── FAIL OPEN ON MISSING HISTORY ────────────────────────────────────────────
 * A shallow clone has no per-file history, and `git log` then returns nothing.
 * That is the CHECK being unable to run, not the repo being wrong, so it
 * reports SKIP with the reason rather than failing — an infra-dependent guard
 * that fails closed gets disabled, and a disabled guard checks nothing. It
 * still fails loudly on rule 1, which needs no history at all.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOADERS } from "./loaders";
import type { Snapshot } from "./snapshot-queries";

const REPO_ROOT = resolve(__dirname, "..");
const SNAPSHOT_PATH = resolve(REPO_ROOT, "queries.snapshot.json");

/** Files that change what a loader emits, beyond the loader itself. */
const SHARED_LOADER_FILES = [
  "lib/query-policy.ts",
  "lib/state-names.ts",
  "scripts/queries/from-snapshot.ts",
];

function lastCommitISO(relPath: string): string | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", relPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function main() {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.error("✗ snapshot-drift: queries.snapshot.json is missing — CI would fetch nothing");
    process.exit(1);
  }
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;
  const projects = Object.keys(LOADERS);

  // ── 1. every loader has a slice ──────────────────────────────────────────
  const missing = projects.filter((p) => !snapshot.projects?.[p]);
  const empty = projects.filter((p) => snapshot.projects?.[p]?.length === 0);
  if (missing.length > 0 || empty.length > 0) {
    console.error(
      `✗ snapshot-drift: ${[...missing, ...empty].join(", ")} ` +
        `${missing.length + empty.length === 1 ? "has" : "have"} no queries in the snapshot. ` +
        `On CI that project emits ZERO queries and is silently outside the pipeline — which is ` +
        `precisely how friendsmoon and engagedmoon went unfetched for eight weeks.\n` +
        `  Fix: run \`npm run snapshot\` with that project's repo checked out, and commit.`,
    );
    process.exit(1);
  }

  // ── 2. no loader committed after the snapshot was last committed ────────
  const snapshotAt = lastCommitISO("queries.snapshot.json");
  let skipped = 0;
  const stale: string[] = [];

  if (!snapshotAt) {
    console.log(
      "  · SKIP the staleness half — no git history for queries.snapshot.json " +
        "(shallow clone?). The check cannot run here; it is not reporting a pass.",
    );
    skipped = projects.length;
  } else {
    for (const project of projects) {
      const watched = [`scripts/queries/${project}.ts`, ...SHARED_LOADER_FILES];
      const newer = watched
        .map((f) => ({ f, at: lastCommitISO(f) }))
        .filter((x) => x.at && x.at > snapshotAt!)
        .sort((a, b) => (a.at! < b.at! ? 1 : -1));

      const source = snapshot.sources?.[project];
      if (newer.length > 0) {
        stale.push(
          `${project}: ${newer[0].f} was committed ${newer[0].at!.slice(0, 16)}, after the ` +
            `snapshot's last commit ${snapshotAt.slice(0, 16)}`,
        );
      } else {
        console.log(
          `  ✓ ${project}: ${source ? `${source.count} queries (${source.from}, generated ` +
            `${source.generatedAt.slice(0, 10)})` : "slice present"} — no loader change since ` +
            `the snapshot was committed`,
        );
      }
    }
  }

  if (stale.length > 0) {
    console.error(`\n✗ snapshot-drift: ${stale.length} slice(s) older than the code behind them:`);
    for (const s of stale) console.error(`  ${s}`);
    console.error(
      `\nCI reads the SNAPSHOT, not the loaders. Until it is regenerated, every cron run asks ` +
        `the old questions.\n  Fix: \`npm run snapshot\` where the sibling repos are checked out, then commit.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ snapshot-drift: ${projects.length} projects, ${snapshot.totalQueries} queries, ` +
      `no slice older than its loader` + (skipped ? ` (${skipped} skipped, see above)` : ""),
  );
}

main();
