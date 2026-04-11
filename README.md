# shared-image-cache

A single Unsplash image cache shared across every project Nick maintains. One rate-limit budget, deduplicated requests, no per-project API hits.

## What's in here

- `cache.json` — flat dict of cached image entries, keyed by `<project>/<category>/<key>`
- `lib/` — pure types + Unsplash API helper (no Node-specific code)
- `scripts/queries/` — per-project query loaders that read each project's data files
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
2. Wire it into `scripts/fetch.ts` main loop
3. Run `npx tsx scripts/fetch.ts --project=<projectname>` to populate

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
```

The fetcher is idempotent (skips already-cached entries), bounded per invocation by `--limit` (default 40), spaces calls 1s apart, and aborts when the Unsplash rate-limit budget drops below 5.

## Stats

```bash
npm run stats
```

## Adding new images vs existing pattern

The old per-project caches (`tour-de-fore/src/data/unsplash-cache.json`, `plan-my-party/src/data/showcase-images.json`, etc.) should be considered **deprecated**. Every new fetch goes here. Consumer projects re-pull this cache at build time.
