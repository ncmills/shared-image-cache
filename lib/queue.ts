/**
 * Queue construction — which keys this run may ask for, and in what order.
 *
 * Extracted from scripts/fetch.ts so the rule that unjams the queue is a pure
 * function with a test, rather than a filter buried in a 400-line main(). The
 * whole 2026-08-20 failure was invisible precisely because "pending" was an
 * expression nobody could run on its own.
 *
 * Two rules:
 *   1. A key is queueable when it is not cached AND not under a fresh miss
 *      tombstone (lib/misses.ts). The tombstone is what makes the head ADVANCE
 *      instead of re-asking the same ~55 keys every two hours.
 *   2. Lanes are round-robin interleaved by project prefix, so every project
 *      with pending work makes progress each run. A fixed concat starves
 *      whichever loader is concatenated last — which is how offsite sat at 0
 *      backfill behind ~1,600 other pending keys.
 */

import type { Cache, QueryItem } from "./types";
import { isSuppressed, type Misses } from "./misses";

export interface QueueOptions {
  /** Re-ask even for keys that already have a photo. */
  refetch?: boolean;
  /** Ignore tombstones for this run (a deliberate re-attempt). */
  retryMisses?: boolean;
  /** Injectable clock — tombstone expiry is time-dependent and must be testable. */
  now?: Date;
}

export interface QueueResult {
  /** Keys this run may ask for, interleaved across projects. */
  queue: QueryItem[];
  /** Keys skipped because a fresh tombstone says we already asked. */
  suppressed: QueryItem[];
}

export function buildQueue(
  items: QueryItem[],
  cache: Cache,
  misses: Misses,
  opts: QueueOptions = {},
): QueueResult {
  const now = opts.now ?? new Date();
  const suppressed: QueryItem[] = [];
  const pending: QueryItem[] = [];

  for (const item of items) {
    if (!opts.refetch && cache[item.key]) continue;
    if (!opts.refetch && !opts.retryMisses && isSuppressed(misses, item, now)) {
      suppressed.push(item);
      continue;
    }
    pending.push(item);
  }

  const lanes = new Map<string, QueryItem[]>();
  for (const q of pending) {
    const project = q.key.split("/")[0];
    const lane = lanes.get(project);
    if (lane) lane.push(q);
    else lanes.set(project, [q]);
  }
  const laneArr = [...lanes.values()];
  const queue: QueryItem[] = [];
  for (let i = 0; laneArr.some((l) => i < l.length); i++) {
    for (const lane of laneArr) if (i < lane.length) queue.push(lane[i]);
  }

  return { queue, suppressed };
}
