/**
 * Re-export shim. The table moved to `lib/state-names.ts` so that
 * `lib/query-policy.ts` (which fails a query shipping a postal code) can read
 * it without `lib/` importing out of `scripts/`. Loaders keep this import path.
 */
export { STATE_NAMES } from "../../lib/state-names";
