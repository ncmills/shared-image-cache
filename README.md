# shared-image-cache

A single Unsplash image cache shared across every project Nick maintains. One rate-limit budget, deduplicated requests, no per-project API hits.

## What's in here

- `cache.json` — flat dict of cached image entries, keyed by `<project>/<category>/<key>`. Every key in here HAS a photograph.
- `misses.json` — miss tombstones: keys that were asked for and came back empty. Keeps `cache.json` meaning only "has a photo", and stops the fetcher re-asking the same dead keys forever.
- `queries.snapshot.json` — what the loaders emit, committed so CI (which has no sibling repos) asks the same questions you do. Regenerate with `npm run snapshot`.
- `lib/` — pure, testable policy: `fanout.ts` (which photo may sit on which key), `query-policy.ts` (what we may ask for), `queue.ts` (what this run may fetch), `misses.ts`, `health.ts`, plus the Unsplash/Pexels helpers.
- `scripts/queries/` — per-project query loaders that read each project's data files
- `scripts/loaders.ts` — **the one project registry.** Add a project here and the fetcher, the gap report and the snapshot all see it.
- `scripts/fetch.ts` — unified fetcher that reads queries from every project, fetches missing entries, writes to `cache.json`
- `scripts/seed-from-projects.ts` — one-time migration from existing per-project caches

## Cache key shape

```
<project>/<category>/<key>
<project>/<category>/<key>/<subkey>   (for showcase-style entries with multiple images per record)
```

Examples:
```
tdf/destinations/scottsdale-az
tdf/bachelorParty/scottsdale-az
tdf/guides/golf-trip-budget-guide
bestman/cities/austin-tx
bestman/showcases/derek-nashville-tn/bars
bestman/showcases/derek-nashville-tn/lodging
moh/cities/nashville-tn
```

## Cache entry shape

```typescript
{
  url: string;                  // Unsplash CDN URL
  alt: string;                  // alt text
  photographerName: string;     // TOS-required credit
  photographerUrl: string;      // photographer profile + utm tracking
  unsplashUrl: string;          // photo page + utm tracking
  query: string;                // the search query that produced this
  fetchedAt: string;            // ISO timestamp
  addedBy: string;              // source project tag (tdf, bestman, moh, ...)
}
```

## M6 fields (provider, licence, credit) and verdicts

CORPUS-M6 spec §2 (`~/ops/canon/status/corpus-m6-spec-2026-09-25.md`). **Additive:**
the 8 fields above stay verbatim; every row gains five more.

```typescript
{
  provider: "unsplash" | "pexels";   // from the CDN host — only these two can enter
  photoId: string;                   // photoIdFromUrl(url), e.g. "pexels:6944344"
  licence: "unsplash-api" | "pexels-api";
  sourceUrl: string;                 // ID-ONLY photo page, no slug, no query; "" if none known
                                     //   https://www.pexels.com/photo/<cdn id>/
                                     //   https://unsplash.com/photos/<11-char id>
  credit: {
    complete: boolean;               // name + profile page + sourceUrl all present
    text: string;                    // "Photo by {name} on {Unsplash|Pexels}", or "" — never a fallback
    photographerName: string;
    photographerUrl: string;         // profile page, no query ("" if the row has none)
    providerUrl: string;             // https://unsplash.com | https://www.pexels.com
  };
}
```

- **One derivation.** Every writer stores rows through `toM6Entry()` (`lib/m6.ts`):
  `lib/unsplash.ts`, `lib/pexels.ts`, the write site in `scripts/fetch.ts`,
  `scripts/mirror-overrides.ts`, `scripts/seed-from-projects.ts`, and the rewriter
  `scripts/evict-duplicates.ts`. It is pure and idempotent and derives only from the
  8 legacy fields, so a hand edit to an M6 field is caught (`not-derived`).
- **`unsplashUrl` is deprecated.** On Pexels rows it holds a pexels.com page — the
  misname that credited Pexels photos "on Unsplash". Read `sourceUrl` and `credit`.
  Links in the new fields carry no utm: the consumer sets `utm_source=<app>` and
  `utm_medium=referral` on unsplash.com links (set, not append) and none on pexels.com.
- **Never invented.** A row with no photographer, profile page or photo page is
  `credit.complete: false` with `text: ""`. 122 rows are like that today (BMHQ/MOH
  showcases and mirrored venue overrides, all Unsplash).
- **Pre-M6 rows.** `m6-legacy-ledger.json` lists the keys allowed to lack the fields
  until the backfill lands. It only shrinks (`gate:m6` fails a key added to it).
  `npm run backfill:m6` is a dry run; `-- --write` rewrites `cache.json` and empties
  the ledger.

### `verdicts.json` — human judgments, append-only

A verdict records that a person VIEWED a photo at a production crop and judged it
`match` or `mismatch` for a key. It binds to the `photoId`, never just the key, and
names its surface from the closed list in `lib/verdicts.ts`. Nothing in this repo
writes the file; a verdict lands only in a reviewed PR. `verdictStatus(key, photoId,
surface)` resolves in this order: **denied** (any mismatch on this photo, any surface,
any date) → **verified** (a match at exactly this surface) → **stale** (verdicts
only for other photos) → **unverified**. The fetcher skips any candidate with a
`mismatch` on that key (`lib/select.ts`), so a wrong photo that is deleted does not
come back on the next fetch.

`gate:m6` (`scripts/check-m6.ts`) fails on a row missing the fields outside the
ledger, any broken invariant above, a malformed verdict, or a verdict edited or
removed versus the base ref. `npm test` runs `scripts/selftest-m6.ts`, which runs
each writer offline on fixtures and has a failing control for every rule.

## How a project consumes the cache

**At build time**, fetch the latest `cache.json` from the jsDelivr CDN and write it to a local file the project's pages import:

```js
// scripts/sync-image-cache.js (in any consumer project)
const fs = require("fs");
const url = "https://cdn.jsdelivr.net/gh/ncmills/shared-image-cache@main/cache.json";
fetch(url).then(r => r.text()).then(t => {
  fs.writeFileSync("src/data/.image-cache.json", t);
});
```

```json
// package.json
{
  "scripts": {
    "prebuild": "node scripts/sync-image-cache.js",
    "build": "next build"
  }
}
```

Then in pages:
```typescript
import cache from "@/data/.image-cache.json";
const hero = cache["tdf/destinations/scottsdale-az"];
// hero.url, hero.photographerName, hero.unsplashUrl, ...
```

**Rendering rules:** every consumer must show photographer credit per Unsplash TOS. See TDF's `UnsplashHero.tsx` for a reference component.

## Adding a new project

1. Create `scripts/queries/<projectname>.ts` exporting `getXxxQueries(): Promise<QueryItem[]>`
2. Add it to `LOADERS` in `scripts/loaders.ts` — that one edit covers the fetcher, `gap-report.ts` and the snapshot
3. Add a `--project=<name>` step to `fetch-images.yml` and a `refresh <name> "$HOOK_<NAME>" HOOK_<NAME>` line plus the grep token in `daily-maxout.yml` (YAML can't import TS; `npm run gate:workflows` fails until they agree)
4. Create the Vercel deploy hook and store it as the repo secret `HOOK_<NAME>`
5. `npm run snapshot` and commit, so CI can see the project at all
6. `npx tsx scripts/fetch.ts --project=<projectname>` to populate

Two of six projects were missing from steps 2-5 for eight weeks and nothing
reported it, which is why each of those layers now has a gate.

## Running the fetcher

```bash
# First-time setup
echo "UNSPLASH_ACCESS_KEY=..." > .env.local

# Default: fetch up to 40 missing entries across all projects
npm run fetch

# Smaller batch
npx tsx scripts/fetch.ts --limit=20

# Single project
npx tsx scripts/fetch.ts --project=tdf

# Re-fetch even if cached (for re-querying with better keywords)
npx tsx scripts/fetch.ts --refetch --project=moh

# Auto-commit + push after run
npx tsx scripts/fetch.ts --commit

# Print the queue and spend nothing — no network, no API budget
npx tsx scripts/fetch.ts --dry-run

# Ignore miss tombstones for one run (a deliberate re-attempt)
npx tsx scripts/fetch.ts --retry-misses
```

The fetcher is idempotent (skips already-cached entries), bounded per invocation by `--limit` (default 40), spaces calls 1s apart, and aborts when the Unsplash rate-limit budget drops below 5.

## Misses, and why the queue used to stand still

A miss used to write nothing, so `pending` (`allQueries.filter(q => !cache[q.key])`)
returned the same keys every run. Every 2-hourly run re-asked the same ~55 keys,
missed them again, and reported the identical numbers forever while ~1,190 keys
behind them were never attempted once.

A miss now writes `misses.json`:

```json
{ "moh/cities/foo/bars": { "query": "...", "at": "2026-08-20T...", "reason": "no-results", "attempts": 1 } }
```

`pending` skips a key whose tombstone was written for the SAME query text and is
younger than 30 days. Two things revive a key: the TTL expiring, or the query text
changing — a rewritten query is a different question. Filling a key clears its
tombstone. `gap-report` shows `MISSING`, `tombstoned` and `queueable` separately,
so a queue that has stopped advancing is visible rather than inferred.

## Health = entries added

Never "the workflow went green". In June 2026 three invalid Unsplash keys 401'd
every request for three days under green workflows. `lib/health.ts` now:

- probes every configured credential before the run and ABORTS if one is set but
  does not answer (naming the source and the error);
- warns, naming the variable, when a source is not configured at all — "no Pexels
  key" must not look like "Pexels found nothing";
- fails a big run that added nothing when every query came back empty, or when it
  recorded no misses either (the queue did not move);
- only WARNS when a run adds nothing because every candidate was already at the
  fan-out ceiling. That is correct behaviour, and a guard that fails correct
  output is one somebody switches off.

## Query policy

`lib/query-policy.ts` is the one place the rules about query TEXT live, each with
the incident that produced it: no generic fallback on a named-venue key; no postal
state codes; no lighting words ("golden hour" ranked a corgi above a vineyard); no
staged-emotion words; 2-4 terms on a templated city query; no widening fallback on
a key that names a place. `curated: true` marks a string a human wrote and reviewed
at the production crop and exempts it from the TEMPLATE rules — never from the
named-venue rule. Gate: `npm run gate:queries`.

## Stats

```bash
npm run stats
```

## Adding new images vs existing pattern

The old per-project caches (`tour-de-fore/src/data/unsplash-cache.json`, `plan-my-party/src/data/showcase-images.json`, etc.) should be considered **deprecated**. Every new fetch goes here. Consumer projects re-pull this cache at build time.

## Duplicate-fanout policy (2026-08-20)

One photo wearing many names reads as fabricated inventory (measured: one lake photo backed 24
"different" named venues). Policy lives in `lib/fanout.ts`; the gate is `npm run gate`
(`scripts/check-duplicate-fanout.ts`), enforced in CI (`dedupe-gate.yml`) and inside `fetch.ts`
before any auto-commit:

- **Named-venue keys** (`*/venues/*`): a photo is an identity claim — ceiling **1 wearer, cache-wide**.
- **Category/setting/city tiles**: ceiling **2 wearers per rendered surface** (same project + grid);
  cross-site reuse is fine.
- **`verified: {photoId, subject, verifiedAt}`** on an entry records that a HUMAN viewed the photo
  at the production crop. It binds to the photo id, so a re-fetch that swaps the photo makes the
  stamp stale — consumers must then treat the entry as unverified, and the gate fails until it's
  re-verified or dropped.
- `dedupe-baseline.json` is the grandfathered pre-gate debt (retired by the Phase 2 honesty cut);
  any NEW wearer fails immediately. The fetcher walks all candidates and records a MISS rather
  than writing a duplicate — a missing image beats a wrong or duplicated one.

### The other half: one generic photo on ONE named venue

The fan-out ceiling is blind to it — a single anonymous castle under "Ashford
Castle" is not a duplicate. It is still the same false claim, and on 2026-08-20 it
re-filled 30 of the keys the honesty cut had just retired, through the offsite
loader's `"{setting} corporate retreat venue landscape"` fallback, in five hours.

**A named venue takes no generic fallback, and a named-venue miss stays a miss.**
The branded fallback IS the design for an unphotographed venue (owner decision,
2026-08-20) — do not source a stand-in. Enforced in the loader, again on the write
path (`stripVenueFallbacks`), and against the cache by
`scripts/check-venue-identity.ts` (`npm run gate:venues`).

## Gates

`npm run gate` runs all six, and `fetch.ts` runs it before every auto-commit, so
nothing lands from either path without passing:

| command | what it refuses |
|---|---|
| `gate:fanout` | one photo wearing many names |
| `gate:venues` | a generic photo wearing a real property's name |
| `gate:queries` | a query shape already known to return the wrong subject |
| `gate:snapshot` | a snapshot older than its loaders, or missing a project |
| `gate:workflows` | workflow YAML that does not know all six projects |
| `gate:m6` | a row without valid M6 fields, a credit that names the wrong provider, a bad or rewritten verdict |

`npm test` (`scripts/selftest.ts`) asserts the same rules offline — no network, no
API budget — including that a simulated miss advances the queue head.
