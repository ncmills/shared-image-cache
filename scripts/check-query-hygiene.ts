/**
 * check-query-hygiene — runs every loader and applies lib/query-policy.ts.
 *
 * The queries are the input to the whole pipeline, and a bad query does not
 * fail: it returns a confident photograph of the wrong thing, which then costs
 * a human review pass to find. Every rule here was learned that expensive way
 * (see lib/query-policy.ts for the incident behind each one).
 *
 * Runs on the loaders' LIVE output where the sibling repos are checked out,
 * and on queries.snapshot.json where they are not (CI) — which is the same
 * source of truth the fetcher uses, so the gate cannot pass on data the
 * fetcher will not see.
 *
 * Usage:
 *   npx tsx scripts/check-query-hygiene.ts
 *   npx tsx scripts/check-query-hygiene.ts --list   # print every violation
 */
import type { QueryItem } from "../lib/types";
import { checkQueries, type PolicyViolation } from "../lib/query-policy";
import { LOADERS } from "./loaders";

async function main() {
  const listAll = process.argv.includes("--list");
  let total = 0;
  const all: PolicyViolation[] = [];

  for (const [project, loader] of Object.entries(LOADERS)) {
    const queries: QueryItem[] = await loader();
    const violations = checkQueries(queries);
    total += queries.length;
    all.push(...violations);
    console.log(
      `  ${project.padEnd(12)} ${String(queries.length).padStart(4)} queries · ` +
        `${violations.length} violation(s)`,
    );
  }

  if (total === 0) {
    // Six loaders that emit nothing is a broken checkout, not a clean gate.
    console.error("✗ query-hygiene: 0 queries loaded from 6 loaders — that is not a pass");
    process.exit(1);
  }

  if (all.length > 0) {
    console.error(`\n✗ query-hygiene: ${all.length} violation(s) across ${total} queries:`);
    const show = listAll ? all : all.slice(0, 25);
    for (const v of show) console.error(`  [${v.rule}] ${v.key}: ${v.detail}`);
    if (!listAll && all.length > show.length) {
      console.error(`  … and ${all.length - show.length} more (--list for all)`);
    }
    console.error("\nPolicy + the incident behind each rule: lib/query-policy.ts");
    process.exit(1);
  }

  console.log(`✓ query-hygiene: ${total} queries across 6 loaders, 0 violations`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
