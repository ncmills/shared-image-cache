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
import { PROJECTS, HOOK_SECRET } from "./loaders";

const REPO_ROOT = resolve(__dirname, "..");
const DAILY = resolve(REPO_ROOT, ".github/workflows/daily-maxout.yml");
const FETCH = resolve(REPO_ROOT, ".github/workflows/fetch-images.yml");

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

// ── fetch-images: one fetch step per project ────────────────────────────────
const fetchYml = readFileSync(FETCH, "utf8");
for (const p of PROJECTS) {
  if (!fetchYml.includes(`--project=${p}`)) {
    problems.push(`fetch-images.yml has no \`--project=${p}\` step — that project is never fetched`);
  }
}

if (problems.length > 0) {
  console.error(`✗ workflow-projects: ${problems.length} disagreement(s) with scripts/loaders.ts:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(
  `✓ workflow-projects: both workflows cover all ${PROJECTS.length} projects (${PROJECTS.join(", ")})`,
);
