/**
 * Query policy — the ONE place the rules about QUERY TEXT live.
 *
 * lib/fanout.ts governs which PHOTO may sit on which key. This file governs
 * what we are allowed to ASK FOR in the first place, which is the upstream
 * half of the same problem: a bad query does not fail, it returns a confident
 * photograph of something else.
 *
 * Every rule below is a lesson already paid for:
 *
 *  1. NAMED-VENUE KEYS TAKE NO GENERIC FALLBACK. A `<project>/venues/<slug>`
 *     photo is an identity claim about a real property. `"castle corporate
 *     retreat venue landscape"` is a photograph of *a* castle, and shipping it
 *     under "Ashford Castle" is the same falsehood the 2026-08-20 honesty cut
 *     removed — the fan-out ceiling cannot see it, because one generic photo on
 *     one named venue is not a duplicate. A named-venue miss must STAY a miss
 *     and render the branded fallback. (Owner decision, 2026-08-20: the branded
 *     fallback IS the design for an unphotographed venue.)
 *     `settings/*` keeps its fallback — there the setting genuinely IS the
 *     subject, so a setting photograph makes no false claim.
 *
 *  2. NO POSTAL STATE CODES. "NC" matches nothing on Unsplash; friendsmoon
 *     learned this when two San Juan images had to be dropped. `STATE_NAMES`
 *     has existed in this repo the whole time and MOH computed `stateName`
 *     without ever using it, so every MOH query shipped a postal abbreviation.
 *
 *  3. NO LIGHTING WORDS in a templated query. "golden hour" is a lighting
 *     term and the stock libraries are full of portrait and pet work shot in
 *     it: it ranked a corgi above a vineyard for Sonoma, a puppy for Omaha, a
 *     cat for Memphis, a dog for Rehoboth Beach — four of 199 in one review.
 *
 *  4. NO STAGED-EMOTION WORDS. "proposal", "couple", "ring", "bachelorette
 *     glam" return staged stock: models performing a moment that never
 *     happened at that place. Off-brand, and a quiet lie of the same family as
 *     fabricated testimonials. Query the PLACE or the ACTIVITY.
 *
 *  5. 2–4 TERMS, NOT 6, on a templated city/destination query. `"Austin TX
 *     cocktail bar pink sunset"` returns zero results; `"Austin cocktail bar"`
 *     returns hundreds. A query that returns zero falls through to the
 *     fallback, which is how a generic photo ends up on a specific page.
 *
 *  6. NO WIDENING FALLBACK on a key that names a place. A state-level fallback
 *     is what put one photo on eight cities, and a city-level fallback under a
 *     micro-landmark's name is what put a Bangalore glasshouse on Central
 *     Park's Conservatory Garden. A fallback for a place key must stay scoped
 *     to that same place.
 *
 * ── `curated` ───────────────────────────────────────────────────────────────
 * Rules 3–6 police TEMPLATES — strings a loop generates for hundreds of
 * records that nobody will ever read individually. A query a human wrote and
 * reviewed at the production crop is a different object: engagedmoon queries
 * "dusk" ON PURPOSE (its whole subject is the last hour of light) and its
 * curated set is frozen by the owner. Those items set `curated: true`, which
 * exempts them from 2–6. Rule 1 — a named venue takes no generic fallback —
 * applies to EVERYTHING: no amount of human review makes a generic photograph
 * into a photograph of a named property.
 */

import type { QueryItem } from "./types";
import { isNamedVenueKey } from "./fanout";
import { STATE_NAMES } from "./state-names";

/**
 * Lighting words. Matched on whole words (so "nightlife" is not "night") and
 * CASE-SENSITIVELY, which is not fussiness: the lighting terms a loader adds
 * are lowercase by construction ("golden hour", "pink sunset"), while a
 * capitalised one arrived inside a proper name we did not write — OO's
 * "The Sunrise Summit" and "Casino Gaming Night" are the names of real
 * products, and "Ring of Kerry" is a real place. Condemning those would be a
 * guard failing correct output.
 */
export const LIGHTING_WORDS = [
  "golden hour",
  "blue hour",
  "magic hour",
  "sunset",
  "sunrise",
  "dusk",
  "twilight",
  "backlit",
  "moonlight",
  "night",
  "evening",
];

/** Staged-emotion words — they return models, not places. Same casing rule. */
export const STAGED_EMOTION_WORDS = [
  "proposal",
  "engagement",
  "couple",
  "couples",
  "ring",
  "bachelorette",
  "bachelor party",
  "glam",
  "bridal",
  "bride",
  "romantic",
  "romance",
];

/**
 * Categories whose key names a real place, where a widening fallback ships the
 * wrong place's photograph under the right place's name.
 */
export const PLACE_CATEGORIES = new Set([
  "cities",
  "destinations",
  "bachelorParty",
  "atlas",
  "spots",
  "venues",
]);

/** Categories that are a TEMPLATED city query — rule 5's 2–4 term ceiling. */
export const TEMPLATED_PLACE_CATEGORIES = new Set([
  "cities",
  "destinations",
  "bachelorParty",
]);

/** Max whitespace tokens in a templated city/destination query (rule 5). */
export const MAX_TEMPLATED_TERMS = 6;

/**
 * The place half of a templated query: `<City> <State Name>`, minus the cases
 * where adding the state makes the query WORSE.
 *
 *   · The city already contains it — "New York City New York boutique hotel"
 *     is seven terms of which two are redundant.
 *   · The city name is three-plus words — "Lake of the Ozarks" is unambiguous
 *     on its own, and every extra term narrows an AND query toward zero.
 *
 * Everything else gets the FULL STATE NAME, never the postal code: "NC"
 * matches nothing in the photo libraries, and Portland OR / Portland ME are a
 * real collision.
 */
export function placePhrase(city: string, stateName: string): string {
  const c = city.trim();
  if (!stateName) return c;
  if (c.toLowerCase().includes(stateName.toLowerCase())) return c;
  if (c.split(/\s+/).length >= 3) return c;
  return `${c} ${stateName}`;
}

export interface PolicyViolation {
  key: string;
  rule: string;
  detail: string;
}

const categoryOf = (key: string): string => key.split("/")[1] ?? "";

const hasWord = (haystack: string, needle: string): boolean =>
  new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(haystack);

const firstToken = (s: string): string => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

/**
 * Apply the policy to one query item. Pure — no I/O — so the gate, the
 * fetcher and the self-test all evaluate exactly the same rules.
 */
export function checkQueryItem(item: QueryItem): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  const cat = categoryOf(item.key);
  const texts: Array<[string, string]> = [["query", item.query]];
  if (item.fallbackQuery) texts.push(["fallbackQuery", item.fallbackQuery]);

  // ── 1. named venue: no fallback, ever ────────────────────────────────────
  if (isNamedVenueKey(item.key) && item.fallbackQuery) {
    out.push({
      key: item.key,
      rule: "venue-no-fallback",
      detail:
        `named-venue key carries fallbackQuery "${item.fallbackQuery}". A generic photo under a ` +
        `real property's name is an identity claim we cannot make — a venue miss must stay a miss ` +
        `and render the branded fallback.`,
    });
  }

  // ── 2. postal state codes ────────────────────────────────────────────────
  // Non-curated only, and for the same reason as the casing rule above: a
  // TEMPLATE shipping `${dest.state}` is the defect this catches, while a
  // hand-written name legitimately contains those two letters — "The LINE LA
  // Koreatown" is a real hotel, and LA/IN/OK/OR/ME/HI are all state codes.
  for (const [field, text] of item.curated ? [] : texts) {
    const code = text
      .split(/\s+/)
      .find((t) => /^[A-Z]{2}$/.test(t) && STATE_NAMES[t] !== undefined);
    if (code) {
      out.push({
        key: item.key,
        rule: "postal-state-code",
        detail: `${field} "${text}" ships the postal code "${code}" — expand it via STATE_NAMES ("${STATE_NAMES[code]}"). A two-letter code matches nothing in the photo libraries.`,
      });
    }
  }

  // A human-written, pixel-reviewed string is not a template. Rules 3-6 exist
  // to police strings a loop generated for hundreds of records nobody reads.
  if (item.curated) return out;

  // ── 3. lighting words ────────────────────────────────────────────────────
  for (const [field, text] of texts) {
    const hit = LIGHTING_WORDS.find((w) => hasWord(text, w));
    if (hit) {
      out.push({
        key: item.key,
        rule: "lighting-word",
        detail: `${field} "${text}" contains the lighting term "${hit}" — it ranks well-lit portrait and pet work above the place. Name the place or a landmark instead.`,
      });
    }
  }

  // ── 4. staged-emotion words ──────────────────────────────────────────────
  for (const [field, text] of texts) {
    const hit = STAGED_EMOTION_WORDS.find((w) => hasWord(text, w));
    if (hit) {
      out.push({
        key: item.key,
        rule: "staged-emotion-word",
        detail: `${field} "${text}" contains "${hit}" — that returns staged models, not a place. Query the place or the activity.`,
      });
    }
  }

  // ── 5. term ceiling on templated city queries ────────────────────────────
  if (TEMPLATED_PLACE_CATEGORIES.has(cat)) {
    for (const [field, text] of texts) {
      const terms = text.trim().split(/\s+/).length;
      if (terms > MAX_TEMPLATED_TERMS) {
        out.push({
          key: item.key,
          rule: "too-many-terms",
          detail: `${field} "${text}" is ${terms} terms (max ${MAX_TEMPLATED_TERMS}). A 6-term AND query returns zero for most cities and falls through to the fallback.`,
        });
      }
    }
  }

  // ── 6. no widening fallback on a place key ───────────────────────────────
  if (
    item.fallbackQuery &&
    PLACE_CATEGORIES.has(cat) &&
    firstToken(item.fallbackQuery) !== firstToken(item.query)
  ) {
    out.push({
      key: item.key,
      rule: "widening-fallback",
      detail:
        `fallbackQuery "${item.fallbackQuery}" does not start with the same place as query ` +
        `"${item.query}" — a fallback that widens past the place ships the wrong place's photo ` +
        `under this key's name.`,
    });
  }

  return out;
}

export function checkQueries(items: QueryItem[]): PolicyViolation[] {
  return items.flatMap(checkQueryItem);
}

/**
 * Belt-and-braces for rule 1 on the WRITE path: whatever a loader (or a stale
 * snapshot generated before this policy existed) hands the fetcher, a named
 * venue never gets a generic second query. A rule enforced only in the six
 * loaders is a rule that a seventh loader — or a June snapshot — quietly
 * escapes.
 */
export function stripVenueFallbacks(items: QueryItem[]): {
  items: QueryItem[];
  stripped: string[];
} {
  const stripped: string[] = [];
  const out = items.map((item) => {
    if (isNamedVenueKey(item.key) && item.fallbackQuery) {
      stripped.push(item.key);
      const { fallbackQuery: _drop, ...rest } = item;
      return rest;
    }
    return item;
  });
  return { items: out, stripped };
}
