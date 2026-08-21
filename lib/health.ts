/**
 * Run health — "N entries added", never "the workflow went green".
 *
 * ── THE LESSON THIS ENCODES ─────────────────────────────────────────────────
 * 2026-06-29: the three Unsplash keys in the GitHub Actions secrets were
 * invalid. Every request came back 401, every run added ZERO images, and every
 * workflow reported SUCCESS. Three days of the whole portfolio's image budget
 * produced nothing, and nothing said so — the failure was loud in the run log
 * and silent everywhere a human would look. `reference_shared_image_cache_ops`
 * has said "health is not workflow-succeeded, it is entries-added > 0" ever
 * since, and until now nothing enforced it.
 *
 * Two mechanisms:
 *
 *   1. PROBE, DON'T ASSUME. Before the run, ask each configured source one
 *      cheap question. A key that is set but does not answer is a FAILURE, not
 *      a fallback — that is the exact 401 shape. A source that is not
 *      configured at all is a WARNING with the variable named: "no Pexels key"
 *      must never be indistinguishable from "Pexels found nothing".
 *
 *   2. JUDGE THE RUN BY WHAT IT PRODUCED. A big run that adds nothing while a
 *      large backlog waits is the signature of a broken pipeline.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT FAIL ────────────────────────────────────
 * A run can correctly add zero. If every candidate for every key was already
 * at the duplicate-fanout ceiling, refusing to write is the RIGHT behaviour —
 * a miss beats a duplicate. That warns. A guard that fails correct output is a
 * guard somebody switches off, and then it guards nothing.
 *
 * The failing shapes are:
 *   · a configured source that will not answer (silent 401), or
 *   · a big run where every single query came back EMPTY (auth or query-shape
 *     breakage — the libraries do not simultaneously lose every city), or
 *   · a big run that added nothing AND recorded no misses, meaning the queue
 *     head did not move at all.
 */

export interface SourceProbe {
  /** e.g. "unsplash[2]", "pexels". */
  name: string;
  /** Is a credential present for this source? */
  configured: boolean;
  /** Did it answer a real query? Meaningless when `configured` is false. */
  ok: boolean;
  /** Evidence — result count, or the error the probe got back. */
  detail: string;
}

export interface RunStats {
  processed: number;
  added: number;
  /** Misses recorded this run (the queue head moved by this much). */
  tombstoned: number;
  /** Queue depth before the run — how much backlog was waiting. */
  pendingBefore: number;
  /** Keys where every source returned nothing at all. */
  zeroResultKeys: number;
  /** Keys that found photos, all of which were already at the fan-out ceiling. */
  ceilingRejectedKeys: number;
  probes: SourceProbe[];
}

export interface HealthVerdict {
  status: "ok" | "warn" | "fail";
  reasons: string[];
}

/** A run smaller than this is the converged tail, not an alarm. */
export const HEALTH_MIN_PROCESSED = 20;
/** Below this much backlog, adding nothing means there was little to find. */
export const HEALTH_MIN_PENDING = 100;

export function evaluateRunHealth(stats: RunStats): HealthVerdict {
  const fails: string[] = [];
  const warns: string[] = [];

  // ── 1. sources ───────────────────────────────────────────────────────────
  for (const probe of stats.probes) {
    if (!probe.configured) {
      warns.push(
        `${probe.name} is NOT CONFIGURED — that tier is disabled for this run (${probe.detail}). ` +
          `Not an error, but it is never silent: an absent key and an empty library look identical in the totals.`,
      );
      continue;
    }
    if (!probe.ok) {
      fails.push(
        `${probe.name} is configured but did not answer: ${probe.detail}. This is the 2026-06-29 ` +
          `silent-401 shape — three days of budget spent on 401s under a green workflow.`,
      );
    }
  }

  // ── 2. what the run produced ─────────────────────────────────────────────
  const bigRun =
    stats.processed > HEALTH_MIN_PROCESSED && stats.pendingBefore > HEALTH_MIN_PENDING;

  if (bigRun && stats.added === 0) {
    if (stats.processed > 0 && stats.zeroResultKeys === stats.processed) {
      fails.push(
        `${stats.processed} keys processed, 0 added, and EVERY query returned nothing ` +
          `(${stats.pendingBefore} still pending). The photo libraries do not simultaneously ` +
          `lose every city — this is auth or query-shape breakage, not a coverage plateau.`,
      );
    } else if (stats.tombstoned === 0) {
      fails.push(
        `${stats.processed} keys processed, 0 added, 0 misses recorded, ${stats.pendingBefore} ` +
          `still pending — the queue head did not move. That is the loop that burned the API ` +
          `budget every two hours for zero images.`,
      );
    } else {
      warns.push(
        `${stats.processed} keys processed, 0 added, ${stats.tombstoned} miss(es) recorded ` +
          `(${stats.ceilingRejectedKeys} of them rejected at the fan-out ceiling). Adding nothing ` +
          `can be correct — a miss beats a duplicate — but a second run like this means the ` +
          `queries, not the pipeline, need the work.`,
      );
    }
  }

  const status: HealthVerdict["status"] =
    fails.length > 0 ? "fail" : warns.length > 0 ? "warn" : "ok";
  return { status, reasons: [...fails, ...warns] };
}

/** GitHub Actions annotations, so a bad run is visible without reading logs. */
export function reportRunHealth(verdict: HealthVerdict, stats: RunStats): void {
  const headline =
    `run health: ${stats.added} added · ${stats.tombstoned} tombstoned · ` +
    `${stats.processed} processed · ${stats.pendingBefore} were pending`;
  for (const reason of verdict.reasons) {
    console.log(`::${verdict.status === "fail" ? "error" : "warning"}::${reason}`);
  }
  if (verdict.status === "fail") {
    console.error(`✘ ${headline} — UNHEALTHY`);
  } else if (verdict.status === "warn") {
    console.log(`⚠ ${headline} — healthy with warnings`);
  } else {
    console.log(`✓ ${headline} — healthy`);
  }
}
