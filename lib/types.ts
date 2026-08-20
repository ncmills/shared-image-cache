/**
 * Shared image cache types — used by every project that consumes the cache.
 *
 * Cache keys follow the pattern: `<project>/<category>/<key>` (or with an
 * optional `/<subkey>` for showcase-style entries with multiple images).
 *
 * Examples:
 *   tdf/destinations/scottsdale-az
 *   tdf/bachelorParty/scottsdale-az
 *   tdf/guides/golf-trip-budget-guide
 *   bestman/showcases/derek-nashville-tn/bars
 *   bestman/showcases/derek-nashville-tn/lodging
 *   bestman/cities/austin-tx
 *   moh/cities/nashville-tn
 *   peptide/heroes/semaglutide
 *
 * Different projects use different key shapes — the cache doesn't enforce.
 * Projects that need to look up an image just import the JSON and read by key.
 */

export interface CacheEntry {
  /** Direct CDN URL to the optimized image. */
  url: string;
  /** Alt text — from Unsplash API or the search query. */
  alt: string;
  /** Photographer's display name (Unsplash TOS requirement). */
  photographerName: string;
  /** Link to photographer profile, with utm tracking. */
  photographerUrl: string;
  /** Link to the photo page on Unsplash, with utm tracking. */
  unsplashUrl: string;
  /** The query string that produced this result. */
  query: string;
  /** ISO timestamp of when the entry was fetched. */
  fetchedAt: string;
  /**
   * Source project that requested this entry — useful for re-fetch decisions
   * (e.g., re-query if the source project's content has shifted).
   */
  addedBy: string;
  /**
   * Human verification that the PHOTO shows what the key claims — OO#52's
   * setting-tile contract generalized upstream. The stamp binds to the photo
   * id (`photoIdFromUrl(entry.url)` at verification time, e.g.
   * `unsplash:1446038202205-1c9643...`), NEVER to the key: if a re-fetch
   * swaps the photo, `verified.photoId` no longer matches the URL and every
   * consumer must treat the entry as UNVERIFIED (render its fallback rather
   * than unreviewed pixels). The gate (scripts/check-duplicate-fanout.ts)
   * fails a stale stamp so it cannot linger. A stamp is only ever written by
   * a human who VIEWED the rendered pixels at the production crop — never
   * from a filename, an alt text, or a 200 OK
   * (feedback_verify_image_subject_matches_label).
   */
  verified?: {
    /** photoIdFromUrl(url) at the moment of verification. */
    photoId: string;
    /** What the viewed photo actually shows, stated as evidence. */
    subject: string;
    /** ISO date of the viewing. */
    verifiedAt: string;
  };
}

/**
 * The shared cache is a flat dict — every entry is keyed by its full path.
 * This makes lookups O(1) and serialization trivial.
 */
export type Cache = Record<string, CacheEntry>;

/**
 * A query item to feed the fetcher — describes what to look up and where
 * to store the result.
 */
export interface QueryItem {
  /** Full cache key, e.g. `tdf/destinations/scottsdale-az`. */
  key: string;
  /** Primary search query. */
  query: string;
  /** Optional fallback query if the primary returns no results. */
  fallbackQuery?: string;
  /** Source project tag (stored on the entry). */
  addedBy: string;
  /** Human-readable label for log lines. */
  label?: string;
}
