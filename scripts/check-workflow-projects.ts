/**
 * check-workflow-projects — the YAML must know the same six projects the code
 * does.
 *
 * The workflows cannot import TypeScript, so `daily-maxout.yml` carries a
 * hardcoded shell list of project tokens and `fetch-images.yml` carries one
 * step per project. Those were the two of the four layers where friendsmoon
 * and engagedmoon were missing, and both failed in the quietest possible way:
 * a grep that never matches a token simply prints nothing, and a workflow with
 * no step for a project simply never fetches it.
 *
 * This is the two-lists-that-must-agree check. scripts/loaders.ts is the
 * source of truth; the YAML is compared against it as TEXT, because that is
 * the only thing the runner will actually execute.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECTS, HOOK_SECRET, CONSUMER_REPO, CONSUMER_SYNC } from "./loaders";

const REPO_ROOT = resolve(__dirname, "..");
const DAILY = resolve(REPO_ROOT, ".github/workflows/daily-maxout.yml");
const FETCH = resolve(REPO_ROOT, ".github/workflows/fetch-images.yml");
const PROPAGATE = resolve(REPO_ROOT, ".github/workflows/propagate-to-consumers.yml");

const problems: string[] = [];

// ── daily-maxout: the project-detection grep + one refresh call per project ─
const daily = readFileSync(DAILY, "utf8");
const grepMatch = daily.match(/grep -oE '"\(([^)]+)\)\//);
if (!grepMatch) {
  problems.push(
    `daily-maxout.yml: could not find the project-detection grep. If its shape changed, update ` +
      `this check with it — a project list nobody compares is how two sites went missing.`,
  );
} else {
  const inGrep = grepMatch[1].split("|");
  const missing = PROJECTS.filter((p) => !inGrep.includes(p));
  const extra = inGrep.filter((p) => !PROJECTS.includes(p));
  if (missing.length) {
    problems.push(
      `daily-maxout.yml deploy-hook grep is missing: ${missing.join(", ")} — a site that gains ` +
        `images but is not in this alternation is never rebuilt, and nothing says so.`,
    );
  }
  if (extra.length) {
    problems.push(`daily-maxout.yml deploy-hook grep names unknown project(s): ${extra.join(", ")}`);
  }
}

for (const p of PROJECTS) {
  if (!new RegExp(`refresh\\s+${p}\\b`).test(daily)) {
    problems.push(`daily-maxout.yml has no \`refresh ${p}\` call`);
  }
  if (!daily.includes(`${HOOK_SECRET[p]}:`)) {
    problems.push(
      `daily-maxout.yml does not pass ${HOOK_SECRET[p]} into the refresh step's env`,
    );
  }
}

// ── fetch-images: every project must be reachable by the fetch step ─────────
//
// Two shapes satisfy this, and the check tests the PROPERTY ("can this project
// be fetched?") rather than one shape of it. Asserting the shape is how a guard
// ends up failing a correct tree: this check demanded one `--project=<p>` step
// per project, so consolidating to a single global run — which fetches every
// project BY CONSTRUCTION, iterating the same loader registry this check reads
// from — would have been reported as six missing projects.
//
//   1. A global step with no `--project` filter. The fetcher walks LOADERS, so
//      a project cannot be omitted; adding one to loaders.ts is sufficient.
//   2. One `--project=<p>` step per project, the original shape. Still valid,
//      still checked per project, since that shape CAN silently omit one.
// ── propagate-to-consumers: the FIFTH layer of the same list ───────────────
//
// D85, 2026-08-28. This workflow carries a matrix of six `repo:` / `sync:`
// pairs, and YAML cannot import TypeScript, so it is the same
// two-lists-that-must-agree hazard that hid friendsmoon and engagedmoon in four
// places at once. It fails the same quiet way: a project with no matrix entry
// is simply never propagated, and a run that propagated five of six reports
// success.
//
// The repo string is compared too, not just the project token. `tdf`'s consumer
// is handicap-hq, not tour-de-fore — a personal site that consumes nothing from
// this cache — and the pair coming apart is the exact conflation HOOK_SECRET
// documents one map above. A matrix naming the wrong repo would open a pull
// request against a site that has no business receiving one.
const propagate = readFileSync(PROPAGATE, "utf8");
for (const p of PROJECTS) {
  if (!new RegExp(`- project: ${p}\\b`).test(propagate)) {
    problems.push(
      `propagate-to-consumers.yml has no matrix entry for \`${p}\` — that consumer is never ` +
        `offered a propagation PR, and the run still reports success.`,
    );
    continue;
  }
  if (!propagate.includes(`repo: ${CONSUMER_REPO[p]}`)) {
    problems.push(
      `propagate-to-consumers.yml does not name ${CONSUMER_REPO[p]} as \`${p}\`'s consumer repo ` +
        `(loaders.ts CONSUMER_REPO says it is). A wrong repo here opens a PR against a site ` +
        `that does not consume this cache.`,
    );
  }
  if (!propagate.includes(`sync: ${CONSUMER_SYNC[p]}`)) {
    problems.push(
      `propagate-to-consumers.yml does not run \`${CONSUMER_SYNC[p]}\` for \`${p}\` ` +
        `(loaders.ts CONSUMER_SYNC says it should). friendsmoon's is \`node\`, not tsx — a ` +
        `command that does not match means that consumer's projection never runs.`,
    );
  }
}

// The workflow must not be wired to the 2-hourly fetch tick. Each PR it opens
// wakes a PRIVATE repo's CI, and private Actions minutes are hard-capped at $20
// per budget after the account exhausted its 2,000 included minutes on
// 2026-08-25. A schedule tighter than daily here is a budget incident, and the
// cheapest place to catch it is before it merges.
const propCron = [...propagate.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]!);
for (const c of propCron) {
  if (/^\S+\s+\S*\*\/\d/.test(c) || /^\S+\s+\*\s/.test(c)) {
    problems.push(
      `propagate-to-consumers.yml has an hourly-or-tighter schedule (\`${c}\`). Every run of ` +
        `this workflow can open six pull requests against PRIVATE repos, each waking that ` +
        `repo's CI. Keep it daily or looser.`,
    );
  }
}

const fetchYml = readFileSync(FETCH, "utf8");
const fetchInvocations = [...fetchYml.matchAll(/npx tsx scripts\/fetch\.ts([^\n]*)/g)].map(
  (m) => m[1]!,
);

if (fetchInvocations.length === 0) {
  problems.push(`fetch-images.yml invokes scripts/fetch.ts nowhere — nothing is ever fetched`);
} else {
  // A global invocation is one whose project is unfiltered or supplied at
  // dispatch time (`$PROJECT_ARG`), not pinned to a literal project.
  const hasGlobal = fetchInvocations.some((args) => !/--project=(?!\$)/.test(args));
  if (!hasGlobal) {
    for (const p of PROJECTS) {
      if (!fetchYml.includes(`--project=${p}`)) {
        problems.push(
          `fetch-images.yml has no \`--project=${p}\` step and no global (unfiltered) fetch step — ` +
            `that project is never fetched`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ workflow-projects: ${problems.length} disagreement(s) with scripts/loaders.ts:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(
  `✓ workflow-projects: all three workflows (fetch, daily-maxout, propagate) cover all ${PROJECTS.length} projects (${PROJECTS.join(", ")})`,
);
