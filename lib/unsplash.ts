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
  entry: Omit<CacheEntry, "addedBy"> | null;
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
  const photo = data.results[0];

  if (!photo) return { entry: null, ratelimitRemaining };

  return {
    entry: {
      url: photo.urls.regular,
      alt: photo.alt_description || photo.description || query,
      photographerName: photo.user.name,
      photographerUrl: `https://unsplash.com/@${photo.user.username}?${UTM}`,
      unsplashUrl: `${photo.links.html}?${UTM}`,
      query,
      fetchedAt: new Date().toISOString(),
    },
    ratelimitRemaining,
  };
}
