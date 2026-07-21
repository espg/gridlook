/**
 * Root coverage-MOC parsing (mortie spec v1.0 section 7.3): the `ranges`
 * envelope a store/product root's coverage.moc declares -- inclusive
 * [first, last] runs of same-order shard cells within one base cell,
 * consecutive in base-4 digit-tail rank, endpoints as decimal STRINGS
 * (packed words exceed 2**53; JSON numbers would be float-mangled).
 *
 * Readers are MOC-first, always: the manifest plus this envelope yield
 * every leaf path arithmetically, and recursive enumeration is
 * out-of-contract for the viewer (issue #1 phase-6 amendment) -- there is
 * deliberately no LIST fallback here. The leaf bitmap tier (zstd) stays
 * server-side; the browser consumes the box/ranges tiers only.
 *
 * Posture split, mirroring moczarr: the envelope is a regenerable cache, so
 * an unusable payload PARSES as null (the caller reports no-coverage);
 * malformed ranges inside a well-formed envelope THROW (a corrupt cache
 * must never yield a plausible partial answer).
 */

import {
  decimalBase,
  decimalOrder,
  decimalRank,
  rankTail,
} from "@/lib/morton/decimal.ts";
import { leafPath } from "@/lib/morton/hive.ts";
import type { HiveManifest } from "@/lib/morton/manifest.ts";

/** Convention version of coverage envelopes. */
export const COVERAGE_SPEC = "morton-moc/1";
/** Root coverage object name at a store/product root. */
export const ROOT_COVERAGE_NAME = "coverage.moc";

export interface RootCoverage {
  spec: string;
  encoding: "ranges";
  /** Common HEALPix order of every range endpoint. */
  order: number;
  /** Inclusive [first, last] decimal-string runs. */
  ranges: [string, string][];
}

/**
 * A usable store-root coverage envelope, or null. Tolerant by design: a
 * non-object payload, an unknown spec, a non-"ranges" encoding, or missing
 * required keys read as absent (the root MOC is a regenerable cache).
 */
export function parseRootCoverage(payload: unknown): RootCoverage | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const order = raw["order"];
  const ranges = raw["ranges"];
  const usable =
    raw["spec"] === COVERAGE_SPEC &&
    raw["encoding"] === "ranges" &&
    typeof order === "number" &&
    Number.isInteger(order) &&
    Array.isArray(ranges);
  if (!usable) {
    return null;
  }
  return {
    spec: COVERAGE_SPEC,
    encoding: "ranges",
    order: order as number,
    ranges: ranges as [string, string][],
  };
}

/** Validated (base, loRank, hiRank) of one range; throws when malformed. */
function checkRange(
  lo: unknown,
  hi: unknown,
  order: number
): [string, number, number] {
  if (typeof lo !== "string" || typeof hi !== "string") {
    // Spec section 7.3: endpoints are decimal strings, never JSON numbers.
    throw new Error(
      `coverage range endpoints must be decimal strings (got [${lo}, ${hi}])`
    );
  }
  const base = decimalBase(lo);
  const loRank = decimalRank(lo);
  const hiRank = decimalRank(hi);
  const ok =
    decimalBase(hi) === base &&
    loRank <= hiRank &&
    decimalOrder(lo) === order &&
    decimalOrder(hi) === order;
  if (!ok) {
    throw new Error(
      `malformed coverage range [${lo}, ${hi}] at order ${order}`
    );
  }
  return [base, loRank, hiRank];
}

/**
 * The covered shard ids, expanded exactly from the envelope's ranges --
 * ascending within each range by construction (consecutive digit-tail
 * rank). O(covered shards); containment checks should use rangesContain.
 */
export function rangesShardIds(envelope: RootCoverage): string[] {
  const ids: string[] = [];
  for (const [lo, hi] of envelope.ranges) {
    const [base, loRank, hiRank] = checkRange(lo, hi, envelope.order);
    for (let r = loRank; r <= hiRank; r++) {
      ids.push(base + rankTail(r, envelope.order));
    }
  }
  return [...new Set(ids)];
}

/** Whether the envelope's ranges list one shard id -- O(ranges). */
export function rangesContain(
  envelope: RootCoverage,
  shardId: string
): boolean {
  if (decimalOrder(shardId) !== envelope.order) {
    return false;
  }
  const base = decimalBase(shardId);
  const rank = decimalRank(shardId);
  return envelope.ranges.some(([lo, hi]) => {
    const [rangeBase, loRank, hiRank] = checkRange(lo, hi, envelope.order);
    return rangeBase === base && loRank <= rank && rank <= hiRank;
  });
}

/**
 * The store-relative leaf path of every covered shard -- the MOC-first
 * arithmetic enumeration (manifest + root MOC, zero LISTs) the phase-6c
 * data path consumes. `window` selects the windowed leaf under /2 and /3
 * manifests.
 */
export function coveredLeafPaths(
  manifest: HiveManifest,
  envelope: RootCoverage,
  window?: string | null
): string[] {
  return rangesShardIds(envelope).map((id) => leafPath(manifest, id, window));
}
