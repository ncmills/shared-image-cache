/**
 * Unsplash API helper — single source of truth across all projects.
 *
 * The shared cache deduplicates requests across every project that uses
 * Unsplash, so your 50/hr (or 5000/hr in production tier) is one budget,
 * not one-per-project. Run the fetcher in this repo and every project
 * benefits.
 *
 * TOS compliance:
 *   - Photographer credit + Unsplash link (with utm tracking) is stored
 *     on every entry. Render via the consumer project's hero component.
 *   - Both links must use ?utm_source=<project>&utm_medium=referral.
 */

import type { CacheEntry } from "./types";

const UTM = "utm_source=shared_image_cache&utm_medium=referral";

interface UnsplashApiPhoto {
  id: string;
  alt_description: string | null;
  description: string | null;
  urls: { raw: string; full: string; regular: string; small: string };
  user: {
    name: string;
    username: string;
    links: { html: string };
  };
  links: { html: string };
}

interface UnsplashApiResponse {
  total: number;
  total_pages: number;
  results: UnsplashApiPhoto[];
}

export interface SearchResult {
  /** Top candidate — kept for back-compat; always `entries[0] ?? null`. */
  entry: Omit<CacheEntry, "addedBy"> | null;
  /**
   * ALL returned candidates, best-first. The fetcher walks these and takes
   * the first one that doesn't violate the duplicate-fanout ceilings
   * (lib/fanout.ts) — result[0] unconditionally is how one generic lake
   * photo came to back 24 named venues: obscure-venue queries collapse to
   * the same popular top result, and only the alternates differ.
   */
  entries: Omit<CacheEntry, "addedBy">[];
  ratelimitRemaining: number;
}

export class UnsplashRateLimitError extends Error {
  constructor(public remaining: number) {
    super(`Unsplash rate limit exhausted (${remaining} remaining)`);
    this.name = "UnsplashRateLimitError";
  }
}

/**
 * Search Unsplash and return the top landscape result, plus the current
 * X-Ratelimit-Remaining count so the caller can stop early.
 */
export async function searchUnsplash(
  query: string,
  accessKey: string,
): Promise<SearchResult> {
  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("per_page", "5");
  url.searchParams.set("content_filter", "high");

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Client-ID ${accessKey}`,
      "Accept-Version": "v1",
    },
  });

  const remainingHeader = res.headers.get("x-ratelimit-remaining");
  const ratelimitRemaining = remainingHeader ? parseInt(remainingHeader, 10) : Number.NaN;

  if (!res.ok) {
    if (res.status === 403 && !Number.isNaN(ratelimitRemaining) && ratelimitRemaining <= 0) {
      throw new UnsplashRateLimitError(0);
    }
    throw new Error(`Unsplash API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as UnsplashApiResponse;
  const entries = data.results.map((photo) => ({
    url: photo.urls.regular,
    alt: photo.alt_description || photo.description || query,
    photographerName: photo.user.name,
    photographerUrl: `https://unsplash.com/@${photo.user.username}?${UTM}`,
    unsplashUrl: `${photo.links.html}?${UTM}`,
    query,
    fetchedAt: new Date().toISOString(),
  }));

  return { entry: entries[0] ?? null, entries, ratelimitRemaining };
}
