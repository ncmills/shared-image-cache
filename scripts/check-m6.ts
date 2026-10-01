/**
 * gate:m6 — every cache.json row carries valid M6 fields (CORPUS-M6 spec §2a),
 * and verdicts.json is well-formed and append-only (§2b).
 *
 * Fails on:
 *   · a row without the M6 fields whose key is NOT in m6-legacy-ledger.json
 *     (the pre-U2 rows owed to the U2-data backfill; the ledger only shrinks)
 *   · any §2a invariant broken (lib/m6.ts checkM6Entry): provider ≠ host ≠
 *     photoId prefix, a Pexels row credited "on Unsplash", complete:true
 *     without a name / profile / id-only page, text on a complete:false row,
 *     a query on a new link, fields that differ from toM6Entry's derivation,
 *     a `verified` stamp inside cache.json
 *   · verdicts.json malformed, or a verdict edited/removed versus the base ref
 *
 * Reports (does not fail on): pre-M6 rows still owed, and `stale` verdicts —
 * a re-fetch legitimately swaps photos, and failing on that is how a guard
 * gets switched off.
 *
 * The base for the append-only check: $M6_VERDICTS_BASE if set, else the
 * merge-base with origin/main (PRs), else HEAD~1 when HEAD is origin/main
 * (pushes). On a shallow clone with no base it prints SKIP — the fetch crons
 * check out depth 1 and never touch verdicts.json.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import type { Cache, ImageVerdict } from "../lib/types";
import { checkM6, hasM6Fields } from "../lib/m6";
import { checkAppendOnly, loadVerdicts, validateVerdicts, verdictStatus } from "../lib/verdicts";
import { photoIdFromUrl } from "../lib/fanout";

const REPO_ROOT = resolve(__dirname, "..");

function git(cmd: string): string | null {
  try {
    // maxBuffer: cache.json at a base ref is several MB; the 1 MB default made
    // `git show <ref>:cache.json` throw, and the ledger check skip SILENTLY.
    return execSync(`git ${cmd}`, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

function baseRef(): string | null {
  let ref = process.env.M6_VERDICTS_BASE || null;
  if (!ref) {
    const head = git("rev-parse HEAD");
    const main = git("rev-parse origin/main");
    if (head && main && head === main) ref = git("rev-parse HEAD~1");
    else if (head && main) ref = git("merge-base HEAD origin/main");
  }
  // An unreadable ref must SKIP out loud, never compare against an empty base.
  if (!ref || !git(`rev-parse --verify --quiet ${ref}^{commit}`)) return null;
  return ref;
}

function baseVerdicts(ref: string): ImageVerdict[] {
  const txt = git(`show ${ref}:verdicts.json`);
  return txt === null ? [] : (JSON.parse(txt) as ImageVerdict[]);
}

/**
 * The ledger only shrinks: every key in it must already be in the base ledger
 * (or, before the ledger existed, in the base cache.json). A key added to the
 * ledger would be a way to land a new row without M6 fields.
 */
export function ledgerGrowth(ledger: Set<string>, baseLedger: Set<string>): string[] {
  return [...ledger].filter((k) => !baseLedger.has(k));
}

function baseLedger(ref: string): Set<string> | null {
  const l = git(`show ${ref}:m6-legacy-ledger.json`);
  if (l !== null) return new Set<string>(JSON.parse(l).keys);
  const c = git(`show ${ref}:cache.json`);
  return c === null ? null : new Set(Object.keys(JSON.parse(c)));
}

function main() {
  let failed = false;
  const cache = JSON.parse(readFileSync(resolve(REPO_ROOT, "cache.json"), "utf8")) as Cache;
  const ledgerPath = resolve(REPO_ROOT, "m6-legacy-ledger.json");
  const ledger = new Set<string>(existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")).keys : []);

  const { violations, legacyRemaining } = checkM6(cache, ledger);
  if (violations.length) {
    failed = true;
    console.error(`✘ gate:m6 — ${violations.length} row violation(s):`);
    for (const v of violations.slice(0, 40)) console.error(`  ${v.key}  [${v.rule}]  ${v.detail}`);
    if (violations.length > 40) console.error(`  … ${violations.length - 40} more`);
  }

  const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, "verdicts.json"), "utf8")) as unknown;
  const verrs = validateVerdicts(raw);
  if (verrs.length) {
    failed = true;
    console.error(`✘ gate:m6 — verdicts.json invalid:`);
    for (const e of verrs) console.error(`  ${e}`);
  }
  const verdicts = verrs.length ? [] : loadVerdicts();
  const ref = baseRef();
  if (ref) {
    const aerrs = checkAppendOnly(baseVerdicts(ref), verdicts);
    if (aerrs.length) {
      failed = true;
      console.error(`✘ gate:m6 — verdicts.json is append-only (base ${ref.slice(0, 7)}):`);
      for (const e of aerrs) console.error(`  ${e}`);
    }
    const bl = baseLedger(ref);
    if (!bl) console.log(`  · SKIP ledger-shrink check — neither m6-legacy-ledger.json nor cache.json readable at ${ref.slice(0, 7)}`);
    const grown = bl ? ledgerGrowth(ledger, bl) : [];
    if (grown.length) {
      failed = true;
      console.error(`✘ gate:m6 — m6-legacy-ledger.json only shrinks; ${grown.length} key(s) added vs ${ref.slice(0, 7)}: ${grown.slice(0, 5).join(", ")}`);
    }
  } else {
    console.log("  · SKIP append-only checks (verdicts, ledger) — no base ref (shallow clone)");
  }

  // Report-only: verdicts that no longer describe the photo the key carries.
  let stale = 0;
  for (const key of new Set(verdicts.map((v) => v.key))) {
    const e = cache[key];
    if (e && verdictStatus(verdicts, key, photoIdFromUrl(e.url), "") === "stale") stale++;
  }

  const total = Object.keys(cache).length;
  const withM6 = Object.values(cache).filter((e) => hasM6Fields(e)).length;
  const summary =
    `${total} rows: ${withM6} with M6 fields, ${legacyRemaining} pre-M6 (ledger, owed to U2-data); ` +
    `${verdicts.length} verdict(s), ${stale} stale key(s)`;
  if (failed) {
    console.error(`✘ gate:m6 FAILED — ${summary}`);
    process.exit(1);
  }
  console.log(`✓ gate:m6 — ${summary}`);
}

if (require.main === module) main();
