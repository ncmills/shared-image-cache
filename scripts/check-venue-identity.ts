/**
 * check-venue-identity — no generic photograph may wear a real property's name.
 *
 * The duplicate-fanout gate (scripts/check-duplicate-fanout.ts) forbids ONE
 * PHOTO ON MANY VENUES. It is structurally blind to the other half of the same
 * lie: ONE GENERIC PHOTO ON ONE VENUE. On 2026-08-20 the Phase 2 honesty cut
 * retired 116 named-venue keys at 16:42, and by 22:44 the fetcher's generic
 * `"{setting} corporate retreat venue landscape"` fallback had re-filled 30 of
 * them — every one of which PASSED the fan-out gate, because each anonymous
 * castle/lake/dune was now unique. Same lie, deduplicated.
 *
 * This gate closes that hole against the CACHE (the loader-side fix is
 * lib/query-policy.ts rule 1, which stops it being requested at all):
 *
 *   A. A venue query is unique to its venue BY CONSTRUCTION — it is the
 *      atlas's hand-authored `imageQuery` for that property. Two venue keys
 *      sharing one query string means the string names neither of them.
 *   B. The retired setting-level fallback pattern, named explicitly. Rule A
 *      alone lets a singleton through (there was exactly one `ski-resort`
 *      wearer and one `palace` wearer in the 2026-08-20 measurement), and a
 *      guard narrower than the thing it guards is not a guard.
 *
 * Usage:  npx tsx scripts/check-venue-identity.ts   (exit 1 on any wearer)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { isNamedVenueKey } from "../lib/fanout";
import type { Cache } from "../lib/types";

const REPO_ROOT = resolve(__dirname, "..");
const CACHE_PATH = resolve(REPO_ROOT, "cache.json");

/**
 * Setting-level query shapes that have historically been used as a venue
 * fallback. Written out rather than derived, because the loader line that
 * produced them is now deleted — this is the tripwire that proves it stays
 * deleted, so it must survive the removal of what it guards against.
 *
 * (Kept to the exact historical shape on purpose: a looser pattern like
 * `^<word> resort landscape$` would also condemn a legitimate one-word venue
 * name, and a guard that fails correct output gets switched off.)
 */
export const RETIRED_GENERIC_VENUE_PATTERNS: RegExp[] = [
  /\bcorporate retreat venue landscape$/i,
];

/**
 * "*a* castle" / "*a* desert retreat" — the finding names the setting the query
 * ACTUALLY asked for, read off the query itself.
 *
 * This used to be the hardcoded word "castle" for every finding, so a desert or
 * lake entry was reported as a castle. Harmless to the verdict, but the detail
 * line is the whole point of the finding: it is what tells a reader why the
 * entry is a lie, and a message that describes the wrong thing trains people to
 * skim it. Falls back to neutral wording when the setting can't be read, rather
 * than guessing.
 */
export function anySettingPhrase(query: string): string {
  let setting = query.trim();
  for (const re of RETIRED_GENERIC_VENUE_PATTERNS) setting = setting.replace(re, "").trim();
  const readable = setting.replace(/-/g, " ");
  if (!readable) return "*a* generic setting";
  const article = /^[aeiou]/i.test(readable) ? "an" : "a";
  return `*${article}* ${readable} retreat`;
}

export interface VenueIdentityFinding {
  rule: "shared-venue-query" | "generic-venue-query";
  detail: string;
  keys: string[];
}

export function checkVenueIdentity(cache: Cache): VenueIdentityFinding[] {
  const findings: VenueIdentityFinding[] = [];
  const venueKeys = Object.keys(cache).filter(isNamedVenueKey).sort();

  // ── A. one query string, several DIFFERENT named properties ──────────────
  // Grouped by the venue SLUG (everything after `<project>/venues/`), not by
  // the full key: `bestman/venues/charleston-sc/dining/0` and
  // `moh/venues/charleston-sc/dining/0` are the SAME marquee slot mirrored
  // into two projects by scripts/mirror-overrides.ts, carrying two different
  // hand-curated photographs. One property in two catalogues is not one photo
  // on two properties, and a gate that fails correct output gets switched off.
  const byQuery = new Map<string, Map<string, string[]>>();
  for (const key of venueKeys) {
    const q = (cache[key].query || "").trim();
    if (!q) continue;
    const slug = key.replace(/^[^/]+\/venues\//, "");
    let bySlug = byQuery.get(q);
    if (!bySlug) byQuery.set(q, (bySlug = new Map()));
    const list = bySlug.get(slug);
    if (list) list.push(key);
    else bySlug.set(slug, [key]);
  }
  for (const [query, bySlug] of byQuery) {
    if (bySlug.size < 2) continue;
    const keys = [...bySlug.values()].flat().sort();
    findings.push({
      rule: "shared-venue-query",
      keys,
      detail:
        `${bySlug.size} different named venues were filled by the SAME query "${query}" — ` +
        `a query that answers for more than one property names none of them: ${keys.join(", ")}`,
    });
  }

  // ── B. the named generic shapes ──────────────────────────────────────────
  for (const key of venueKeys) {
    const q = (cache[key].query || "").trim();
    if (RETIRED_GENERIC_VENUE_PATTERNS.some((re) => re.test(q))) {
      findings.push({
        rule: "generic-venue-query",
        keys: [key],
        detail:
          `${key} was filled by the generic setting-level query "${q}". A photograph of ` +
          `${anySettingPhrase(q)} is not a photograph of this property — delete the entry and ` +
          `let the branded fallback render, which is the design for an unphotographed venue.`,
      });
    }
  }

  return findings;
}

function main() {
  if (!existsSync(CACHE_PATH)) {
    console.error("✗ venue-identity: cache.json not found — a missing cache is not a pass");
    process.exit(1);
  }
  const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache;
  const venueCount = Object.keys(cache).filter(isNamedVenueKey).length;
  const findings = checkVenueIdentity(cache);

  console.log(
    `venue-identity: ${venueCount} named-venue entries scanned · ${findings.length} finding(s)`,
  );

  if (findings.length > 0) {
    console.error(`\n✗ venue-identity: ${findings.length} generic photo(s) wearing a property name:`);
    for (const f of findings.slice(0, 40)) console.error(`  [${f.rule}] ${f.detail}`);
    if (findings.length > 40) console.error(`  … and ${findings.length - 40} more`);
    console.error(
      `\nRemove the entry — do not replace it with another stock photo. Policy: ` +
        `lib/query-policy.ts rule 1.`,
    );
    process.exit(1);
  }

  console.log("✓ venue-identity: every named-venue photo was fetched by a query naming that venue");
}

if (require.main === module) main();
