/**
 * check-duplicate-fanout — the gate that keeps one photo from wearing many names.
 *
 * Rules live in lib/fanout.ts (venue ceiling 1 cache-wide; tile ceiling 2 per
 * rendered surface; stale `verified` stamps fail). This script applies them to
 * cache.json and exits non-zero on any violation NOT grandfathered in
 * dedupe-baseline.json.
 *
 * ── The baseline is a debt ledger, not an allowlist ──
 * Today's cache holds 190 shared photos (581 keys) that predate the gate;
 * Phase 2 (the honesty cut) retires them. Until then they are recorded in
 * dedupe-baseline.json so the gate can hold the line at TODAY's state: any NEW
 * wearer of any photo fails immediately, while the known debt is reported
 * loudly on every run — a grandfathered violation is still a violation, it is
 * just one somebody has already been told about. When Phase 2 lands, the
 * baseline shrinks with it; an empty baseline is the goal state.
 *
 * A violation is grandfathered ONLY if every offending key already appears in
 * the baseline for that photo+rule. One new key on an old photo = FAIL.
 *
 * Usage:
 *   npx tsx scripts/check-duplicate-fanout.ts                    # gate (exit 1 on new violations)
 *   npx tsx scripts/check-duplicate-fanout.ts --write-baseline   # snapshot current violations as the debt ledger
 *
 * Wired so it cannot be bypassed on the write path: scripts/fetch.ts runs this
 * before its --commit push (both GitHub cron workflows commit through there),
 * and .github/workflows/dedupe-gate.yml runs it on every push and PR.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkFanout, type FanoutViolation } from "../lib/fanout";
import type { Cache } from "../lib/types";

const REPO_ROOT = resolve(__dirname, "..");
const CACHE_PATH = resolve(REPO_ROOT, "cache.json");
const BASELINE_PATH = resolve(REPO_ROOT, "dedupe-baseline.json");

type Baseline = Record<string, string[]>; // `<rule>|<photoId>|<surface?>` -> sorted offending keys

const violationId = (v: FanoutViolation): string =>
  [v.rule, v.photoId, v.surface ?? ""].join("|");

function main() {
  const writeBaseline = process.argv.includes("--write-baseline");
  const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache;
  const violations = checkFanout(cache);

  if (writeBaseline) {
    const baseline: Baseline = {};
    for (const v of violations) {
      if (v.rule === "stale-verified") continue; // staleness is never acceptable debt
      baseline[violationId(v)] = [...v.keys].sort();
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf8");
    console.log(
      `wrote ${Object.keys(baseline).length} grandfathered violations to dedupe-baseline.json — ` +
        `this is recorded DEBT for the Phase 2 honesty cut, not acceptance.`,
    );
    return;
  }

  const baseline: Baseline = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline)
    : {};

  const fresh: FanoutViolation[] = [];
  let grandfathered = 0;
  for (const v of violations) {
    const known = baseline[violationId(v)];
    if (v.rule !== "stale-verified" && known && v.keys.every((k) => known.includes(k))) {
      grandfathered++;
      continue;
    }
    fresh.push(v);
  }

  const entries = Object.keys(cache).length;
  console.log(
    `duplicate-fanout: ${entries} entries scanned · ${violations.length} violations · ` +
      `${grandfathered} grandfathered (pre-gate debt, retired by Phase 2) · ${fresh.length} NEW`,
  );
  if (entries === 0) {
    // An empty cache measuring nothing must not read as clean.
    console.error("✗ duplicate-fanout: cache.json is empty — 0 entries scanned is not a pass");
    process.exit(1);
  }

  if (fresh.length > 0) {
    console.error(`\n✗ duplicate-fanout: ${fresh.length} NEW violation(s):`);
    for (const v of fresh.slice(0, 40)) console.error(`  [${v.rule}] ${v.detail}`);
    if (fresh.length > 40) console.error(`  … and ${fresh.length - 40} more`);
    console.error(
      `\nA new wearer of an already-used photo makes "different" records render identically — ` +
        `record a miss (no image) instead, or pick a different candidate. ` +
        `Policy: lib/fanout.ts · debt ledger: dedupe-baseline.json`,
    );
    process.exit(1);
  }

  console.log("✓ duplicate-fanout: no NEW violations (the grandfathered debt above still awaits Phase 2)");
}

main();
