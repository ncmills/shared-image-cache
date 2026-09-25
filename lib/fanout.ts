/**
 * Duplicate fan-out rules — the ONE place the ceiling policy lives.
 *
 * Measured 2026-08-20 (report: ~/work/shared-image-cache/2026-08-20-duplicate-map.md):
 * 190 of 1,368 distinct photos served more than one key; 581 keys — a third of
 * the cache — wore a shared photo. The worst photo ("photography of lake
 * surrounded by green trees") backed TWENTY-FOUR different named lake venues.
 * Each wearer was apt-but-anonymous, so no single-key subject rule ever fired;
 * collectively a browse grid of six "different" venues in one photo reads as
 * fabricated inventory — the exact thing the portfolio's real-inventory design
 * thesis cannot afford.
 *
 * Policy (day-captain approved 2026-08-20):
 *   1. NAMED-VENUE keys (`<project>/venues/<slug>`): a photo is an IDENTITY
 *      claim. Ceiling = 1 wearer, cache-wide.
 *   2. Category / setting / city tiles: mood, not identity. Ceiling = 2
 *      wearers of one photo within one RENDERED SURFACE (same project + same
 *      category grid). Cross-site reuse is fine.
 *   3. A `verified` stamp binds to the PHOTO (its id), never the key: if the
 *      entry's URL no longer contains the verified photoId, the verification
 *      is STALE and the gate fails until it is re-verified or removed.
 *
 * Consumed by scripts/check-duplicate-fanout.ts (the gate) and by
 * scripts/fetch.ts (dedup-aware candidate selection, so the fetcher cannot
 * re-create the state the gate forbids).
 */
import type { Cache } from "./types";

/**
 * Stable photo identity from a CDN URL. Unsplash embeds `photo-<id>`;
 * Pexels uses `/photos/<numeric-id>/`. Anything else keys on the URL
 * stripped of query params (crop/ixid params vary per fetch — keying on the
 * raw URL undercounts duplicates, which is exactly how the first measurement
 * of this cache missed 281 of them).
 */
export function photoIdFromUrl(url: string): string {
  // PEXELS IS TESTED FIRST, AND THE ORDER IS THE WHOLE FIX (2026-08-23).
  // A Pexels CDN path is `.../photos/32162989/pexels-photo-32162989.jpeg`,
  // which contains the substring `photo-32162989` — so the Unsplash pattern
  // matched it and 1,002 of the cache's 1,005 Pexels photos were labelled
  // `unsplash:<id>`. Grouping was never wrong (the numeric id is still stable
  // and unique, and short-numeric Pexels ids cannot collide with Unsplash's
  // long hex-and-dash ids), but every violation message, every debt-ledger
  // key and every report named the WRONG PROVIDER — and Pexels is now a third
  // of the cache, not a marginal tier. Verified before landing: same 2,485
  // groups with identical membership before and after, i.e. a pure relabel.
  const pexels = url.match(/pexels\.com\/photos\/(\d+)\//);
  if (pexels) return `pexels:${pexels[1]}`;
  const unsplash = url.match(/photo-([0-9a-f-]+)/);
  if (unsplash) return `unsplash:${unsplash[1]}`;
  return `url:${url.split("?")[0]}`;
}

/** `<project>/venues/<slug>` — a named venue; its photo claims identity. */
export function isNamedVenueKey(key: string): boolean {
  return /^[^/]+\/venues\//.test(key);
}

/** `<project>/experiences/<id>` — a named, priced product; likewise identity. */
export function isNamedExperienceKey(key: string): boolean {
  return /^[^/]+\/experiences\//.test(key);
}

/**
 * An IDENTITY key: its photo asserts "this is the thing named in the key".
 *
 * ── WHY EXPERIENCES JOINED VENUES (2026-08-23) ────────────────────────
 * `experiences` was classified as a mood-tile surface (ceiling 2) because its
 * keys are not `venues/`. But an Offsite experience is a named, priced product
 * on a public indexed grid — "Reindeer Sled & Sámi Camp", "The Company Cup —
 * Giant Slalom Race" — not a mood. The misclassification let ONE photo back
 * five of them.
 *
 * What it looked like in production: photo `1706310072149`, fetched by the
 * query `"winter corporate team experience outdoor"`, rendering at 564x423 on
 * four cards side by side at /experiences, each with `alt` set to its own
 * product name. Viewed at the production crop, the photograph is a posed
 * amateur POND-HOCKEY TEAM holding hockey sticks. Not one of the four products
 * is pond hockey. The cache `alt` ("a group of people standing next to each
 * other in the snow") and the query both read plausibly; only the pixels
 * showed it. See [[patterns/pattern_pixels_are_the_proof]].
 *
 * Identity keys get ceiling 1 cache-wide and take no generic fallback query.
 */
export function isIdentityKey(key: string): boolean {
  return isNamedVenueKey(key) || isNamedExperienceKey(key);
}

/**
 * The rendered surface a tile key belongs to. 4-part keys
 * (`bestman/cities/<city>/dining`, `bestman/showcases/<slug>/bars`) grid by
 * their trailing CATEGORY across records; 3-part keys
 * (`tdf/bachelorParty/<city>`, `offsite/settings/<s>`) grid by their middle
 * segment. Same surface id = tiles that can render side by side.
 */
export function surfaceOf(key: string): string {
  const parts = key.split("/");
  const project = parts[0];
  return parts.length >= 4 ? `${project}|${parts[3]}` : `${project}|${parts[1]}`;
}

export interface FanoutViolation {
  rule: "venue-ceiling" | "surface-ceiling" | "stale-verified";
  photoId: string;
  /** All offending keys (every wearer for ceilings; the one entry for stale). */
  keys: string[];
  surface?: string;
  detail: string;
}

export const VENUE_CEILING = 1;
export const SURFACE_CEILING = 2;

/** Pure rule evaluation over a cache snapshot. */
export function checkFanout(cache: Cache): FanoutViolation[] {
  const violations: FanoutViolation[] = [];
  const byPid = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(cache)) {
    const pid = photoIdFromUrl(entry.url);
    const list = byPid.get(pid);
    if (list) list.push(key);
    else byPid.set(pid, [key]);

    if (entry.verified && entry.verified.photoId !== pid) {
      violations.push({
        rule: "stale-verified",
        photoId: pid,
        keys: [key],
        detail:
          `${key}: verified.photoId=${entry.verified.photoId} but the entry's URL now resolves ${pid} — ` +
          `the photo changed under the verification. Re-verify at the production crop or drop the stamp.`,
      });
    }
  }

  for (const [pid, keys] of byPid) {
    if (keys.length < 2) continue;

    const identityKeys = keys.filter(isIdentityKey).sort();
    if (identityKeys.length > VENUE_CEILING) {
      violations.push({
        rule: "venue-ceiling",
        photoId: pid,
        keys: identityKeys,
        detail:
          `photo ${pid} backs ${identityKeys.length} named records (ceiling ${VENUE_CEILING}, cache-wide): ` +
          identityKeys.join(", "),
      });
    }

    const bySurface = new Map<string, string[]>();
    for (const k of keys) {
      if (isIdentityKey(k)) continue; // the identity rule owns these
      const s = surfaceOf(k);
      const list = bySurface.get(s);
      if (list) list.push(k);
      else bySurface.set(s, [k]);
    }
    for (const [surface, sKeys] of bySurface) {
      if (sKeys.length > SURFACE_CEILING) {
        violations.push({
          rule: "surface-ceiling",
          photoId: pid,
          keys: sKeys.sort(),
          surface,
          detail:
            `photo ${pid} appears ${sKeys.length}× on surface ${surface} (ceiling ${SURFACE_CEILING}): ` +
            sKeys.sort().join(", "),
        });
      }
    }
  }
  return violations;
}

/**
 * Would adding `url` at `key` create a NEW violation against the given cache?
 * Used by the fetcher to pick a non-violating candidate at selection time —
 * a miss beats a duplicate, and a duplicate the gate would reject must never
 * be written in the first place.
 */
export function wouldViolate(cache: Cache, key: string, url: string): boolean {
  const pid = photoIdFromUrl(url);
  let venueWearers = 0;
  let surfaceWearers = 0;
  const mySurface = surfaceOf(key);
  const iAmVenue = isIdentityKey(key);
  for (const [k, entry] of Object.entries(cache)) {
    if (k === key) continue;
    if (photoIdFromUrl(entry.url) !== pid) continue;
    if (iAmVenue) {
      // ANY existing wearer blocks a venue key: an identity photo must be
      // exclusive, and taking a photo already used as a tile still yields
      // two identical renders somewhere in the portfolio.
      return true;
    }
    if (isIdentityKey(k)) venueWearers++;
    else if (surfaceOf(k) === mySurface) surfaceWearers++;
  }
  if (venueWearers > 0) return true; // a tile must not wear a venue's identity photo
  return surfaceWearers >= SURFACE_CEILING;
}
