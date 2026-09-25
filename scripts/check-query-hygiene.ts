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
import { checkQueries, checkFallbackGeoParity, type PolicyViolation } from "../lib/query-policy";
import { LOADERS } from "./loaders";

/**
 * POSITIVE CONTROL for rule 7 (fallback_drops_state).
 *
 * A gate that only ever reports "0 violations" is indistinguishable from a gate
 * whose rule stopped matching. This asserts, on every run, that the rule still
 * FIRES on the exact shape that shipped a Tucson photograph under Aiken SC on
 * 2026-09-03 — and still stays quiet on the corrected shape and on an
 * international destination that carries a country instead of a state.
 */
function selfTest(): void {
  const aiken = { addedBy: "selftest", label: "control" };
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["the 2026-09-03 defect", { ...aiken, key: "tdf/bachelorParty/aiken-sc", query: "Aiken South Carolina nightlife", fallbackQuery: "Aiken downtown" }, true],
    ["the corrected shape", { ...aiken, key: "tdf/bachelorParty/aiken-sc", query: "Aiken South Carolina nightlife", fallbackQuery: "Aiken South Carolina downtown" }, false],
    ["international, country not state", { ...aiken, key: "friendsmoon/destinations/ambergris-caye-bz", query: "Ambergris Caye Belize pier turquoise water", fallbackQuery: "Belize barrier reef caye palm dock" }, false],
  ];
  for (const [name, item, shouldFire] of cases) {
    const fired = checkFallbackGeoParity(item as never).length > 0;
    if (fired !== shouldFire) {
      console.error(
        `✗ query-hygiene SELF-TEST failed: "${name}" expected ${shouldFire ? "a violation" : "no violation"} and got ${fired ? "one" : "none"}.\n` +
          "  The rule is not measuring what it claims; a clean run below would mean nothing.",
      );
      process.exit(1);
    }
  }
  console.log("  self-test: fallback_drops_state fires on the Aiken defect, quiet on the fix and on international ✓");
}

async function main() {
  const listAll = process.argv.includes("--list");
  selfTest();
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
