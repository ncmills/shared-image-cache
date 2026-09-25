/**
 * projection-delta — say what a propagation PR actually changes, removals first.
 *
 * D85. The reason this exists rather than "read the diff": a projected image
 * file is thousands of lines of URLs, and the ONE thing a reviewer must not
 * miss is a REMOVAL. An added photo that is wrong is a bad photo on a page; a
 * removed photo is a page that had an image and now does not, or a venue whose
 * hero silently changes to something else. offsite-outpost's first propagation
 * is expected to carry 7 evicted wrong-subject venue heroes as removals — those
 * are the whole point of the review, and in a 3,000-line diff they are invisible.
 *
 * So every removed key is listed BY NAME and in full, never summarised as a
 * count, however many there are. Additions are counted and sampled, because
 * "184 new cities" is a number a person can act on and 184 URLs is not.
 *
 * "Before" is `origin/main`'s copy of the file, read through git — not a
 * directory copied aside. The committed file IS the before, by definition, and
 * asking git removes any chance of comparing against a stale scratch copy.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repoDir = arg("repo", "consumer");
const project = arg("project", "?");
const files = arg("files")
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

type Json = Record<string, unknown>;

/** The committed copy, from git. `null` when the file is new in this PR. */
function before(file: string): Json | null {
  try {
    const text = execFileSync("git", ["show", `origin/main:${file}`], {
      cwd: repoDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

function after(file: string): Json | null {
  const p = join(repoDir, file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Json;
  } catch {
    return null;
  }
}

const out: string[] = [];
out.push(
  `Projection of \`ncmills/shared-image-cache\` into this repo's \`${project}\` slice, ` +
    `opened by that repo's \`propagate-to-consumers\` workflow (D85).`,
  "",
  "This is the file your `prebuild` already computes on every build and then throws away.",
  "Committing it is what makes the image set this site serves reproducible, revertible, and",
  "reviewable — in particular its **removals**, which until now happened silently on a deploy.",
  "",
);

let anyRemoval = false;

for (const file of files) {
  const a = before(file);
  const b = after(file);
  out.push(`## \`${file}\``, "");

  if (b === null) {
    out.push("> ⚠️ unreadable after the sync — review this file by hand.", "");
    continue;
  }
  if (a === null) {
    out.push(`New file. ${Object.keys(b).length} entries.`, "");
    continue;
  }

  const ak = new Set(Object.keys(a));
  const bk = new Set(Object.keys(b));
  const added = [...bk].filter((k) => !ak.has(k)).sort();
  const removed = [...ak].filter((k) => !bk.has(k)).sort();
  const changed = [...bk]
    .filter((k) => ak.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort();

  out.push(
    `| | count |`,
    `|---|---|`,
    `| committed now | ${ak.size} |`,
    `| after this PR | ${bk.size} |`,
    `| added | ${added.length} |`,
    `| changed | ${changed.length} |`,
    `| **removed** | **${removed.length}** |`,
    "",
  );

  if (removed.length) {
    anyRemoval = true;
    // EVERY removal, never a sample. A removal is the direction that takes an
    // image off a live page, and a truncated list is how the one that mattered
    // gets missed.
    out.push(
      `### ⚠️ Removed — ${removed.length}, listed in full`,
      "",
      "Each of these is a key this site currently has a photo for and will not after this",
      "merge. Confirm each is an intended eviction and not upstream having lost it.",
      "",
      ...removed.map((k) => `- \`${k}\``),
      "",
    );
  }

  if (changed.length) {
    out.push(
      `### Changed — ${changed.length}`,
      "",
      "Same key, different photo. An eviction and a re-fetch look identical here.",
      "",
      ...changed.slice(0, 40).map((k) => `- \`${k}\``),
      ...(changed.length > 40 ? [`- …and ${changed.length - 40} more (see the diff)`] : []),
      "",
    );
  }

  if (added.length) {
    out.push(
      `### Added — ${added.length}`,
      "",
      ...added.slice(0, 20).map((k) => `- \`${k}\``),
      ...(added.length > 20 ? [`- …and ${added.length - 20} more (see the diff)`] : []),
      "",
    );
  }
}

out.push(
  "---",
  "",
  anyRemoval
    ? "**This PR removes entries.** Read the removal list above before merging — that is the half of a photo pipeline nobody sees."
    : "No entries are removed by this PR.",
);

console.log(out.join("\n"));
