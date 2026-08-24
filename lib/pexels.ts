/**
 * Pexels API helper — second free image source alongside Unsplash.
 *
 * Pexels free tier: 200 requests/hour, 20K/month. Different photo
 * library than Unsplash, so adding it as a fallback dramatically reduces
 * duplicate-photo collisions when Unsplash's top result for a generic
 * fallback query is the same across many cache keys.
 *
 * Triggered by fetch.ts only when both Unsplash primary + fallbackQuery
 * return empty (a fourth tier in the resolution chain). Free + permissive
 * licensing — Pexels photos are usable without attribution but the helper
 * stores photographer credit anyway for symmetry with Unsplash entries.
 *
 * Setup: drop `PEXELS_API_KEY=...` into shared-image-cache/.env.local.
 * Get a key at https://www.pexels.com/api/ (free, no credit card).
 */

import type { CacheEntry } from "./types";

interface PexelsApiPhoto {
  id: number;
  width: number;
  height: number;
  url: string; // page URL, e.g. https://www.pexels.com/photo/123/
  photographer: string;
  photographer_url: string;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
    small: string;
  };
  alt: string;
}

interface PexelsApiResponse {
  page: number;
  per_page: number;
  total_results: number;
  photos: PexelsApiPhoto[];
}

export interface PexelsSearchResult {
  /**
   * ALL landscape candidates the request paid for, best-first — not just the
   * top one. The request has always asked for `per_page=5`; returning only
   * `photos[0]` threw four already-purchased candidates away and left the
   * caller unable to walk past a photo that is already at the fan-out ceiling.
   * See the note on `searchPexels` below.
   */
  entries: Omit<CacheEntry, "addedBy">[];
  ratelimitRemaining: number;
}

export class PexelsRateLimitError extends Error {
  constructor(public remaining: number) {
    super(`Pexels rate limit exhausted (${remaining} remaining)`);
    this.name = "PexelsRateLimitError";
  }
}

/**
 * Search Pexels and return the landscape candidates, best-first, mapped to the
 * shared CacheEntry shape. The `unsplashUrl` field is repurposed as
 * the source page URL — same shape regardless of provider so existing
 * consumers don't need branching.
 *
 * ── WHY THIS RETURNS A LIST (2026-08-23) ────────────────────────────────────
 * This is the SAME bug the 2026-08-20 dedupe fixed on the Unsplash side and
 * never fixed here. Unsplash's `results[0]`-unconditionally was the root cause
 * of one lake photo backing 24 named venues; `fetch.ts` was taught to walk all
 * 5 candidates and take the first that would not become a fan-out violation.
 * Pexels kept returning exactly one, so `pickNonViolating([pex.entry])` had a
 * single-element array to walk: if that one photo was at ceiling, the key was
 * tombstoned for 30 days.
 *
 * The run log said so verbatim —
 *   `moh/Omaha, NE — dining — MISS: all 1 candidate(s) already at fan-out
 *    ceiling` (run 32533721921, Pexels live with 24,998 requests left)
 * — "all 1 candidate(s)" being the tell.
 *
 * Measured over the 39 ceiling-rejected TILE keys tombstoned on 2026-08-21:
 * 38 had a clean candidate waiting at photos[1..4] of the very same response,
 * and 0 were genuinely blocked. The candidates were already fetched and already
 * paid for; only the return type was throwing them away.
 */
export async function searchPexels(
  query: string,
  apiKey: string,
): Promise<PexelsSearchResult> {
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("per_page", "5");
  url.searchParams.set("size", "medium"); // bias toward web-suitable sizes

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: apiKey,
    },
  });

  // Pexels exposes X-Ratelimit-Remaining + X-Ratelimit-Limit + X-Ratelimit-Reset.
  const remainingHeader = res.headers.get("x-ratelimit-remaining");
  const ratelimitRemaining = remainingHeader ? parseInt(remainingHeader, 10) : Number.NaN;

  if (!res.ok) {
    if (res.status === 429 || (!Number.isNaN(ratelimitRemaining) && ratelimitRemaining <= 0)) {
      throw new PexelsRateLimitError(0);
    }
    throw new Error(`Pexels API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as PexelsApiResponse;
  const fetchedAt = new Date().toISOString();

  const entries = (data.photos ?? []).map((photo) => ({
    // Pexels `large` is ~940px wide — comparable to Unsplash `regular`.
    url: photo.src.large,
    alt: photo.alt || query,
    photographerName: photo.photographer,
    photographerUrl: photo.photographer_url,
    // Repurpose the `unsplashUrl` slot as the photo page URL across
    // providers. Existing consumers that read it still work; new ones
    // can branch on the URL host if they need provider-specific links.
    unsplashUrl: photo.url,
    query,
    fetchedAt,
  }));

  return { entries, ratelimitRemaining };
}
