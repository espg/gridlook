import { digestVariableOf, type TDigestVariable } from "./digestVariables.ts";

import type { TDataSource } from "@/lib/types/GlobeTypes.ts";

/**
 * The strata of a store's observations and the viewer's choice among them.
 * A zagg ATL03 store keeps two disjoint t-digests per cell, the photons the
 * ATBD calls signal (`h_tdigest_signal`) and the rest (`h_tdigest_noise`),
 * each with its own located and timed siblings. The store lists a variable
 * per stratum (`h_percentile_signal`, `h_percentile_noise`); the viewer
 * shows one height variable and a choice of stratum beside it, which
 * rewrites the digest array the variable reads: `signal` (the default) or
 * `noise` read that stratum's array, `both` reads the two and merges them
 * cell by cell. A URL that names a per-stratum variable still works: its
 * stratum seeds the choice.
 */

export const DIGEST_STRATA = {
  SIGNAL: "signal",
  NOISE: "noise",
  BOTH: "both",
} as const;
export type TStratumChoice = (typeof DIGEST_STRATA)[keyof typeof DIGEST_STRATA];
export const DEFAULT_STRATUM: TStratumChoice = DIGEST_STRATA.SIGNAL;

export function isStratumChoice(value: unknown): value is TStratumChoice {
  return Object.values(DIGEST_STRATA).includes(value as TStratumChoice);
}

/** The stratum a choice draws first, and reads alone when it is one. */
export function primaryStratum(choice: TStratumChoice): string {
  return choice === DIGEST_STRATA.BOTH ? DIGEST_STRATA.SIGNAL : choice;
}

/** `h` of `h_tdigest_signal`: the quantity a digest array holds. */
const quantityOf = (array: string) => array.replace(/_tdigest.*$/, "");

/** One digest array of a level: its name and the stratum it holds. */
export type TStratumArray = { array: string; stratum?: string };

/** The digest arrays of a level that hold `quantity`, keyed by stratum. */
function strataOf(
  datasources: Record<string, Pick<TDataSource, "attrs">>,
  quantity: string
) {
  const strata = new Map<string, TStratumArray>();
  for (const source of Object.values(datasources)) {
    const sibling = digestVariableOf(source.attrs);
    if (sibling?.stratum && quantityOf(sibling.array) === quantity) {
      strata.set(sibling.stratum, {
        array: sibling.array,
        stratum: sibling.stratum,
      });
    }
  }
  return strata;
}

/**
 * The digest arrays a choice reads for the variable derived from `digest`:
 * the level's arrays of the same quantity at the chosen strata, the signal
 * first under `both`. The variable's own array when the level has none at
 * the chosen stratum, so a store with one stratum reads as before.
 */
export function strataArrays(
  digest: Pick<TDigestVariable, "array" | "stratum">,
  datasources: Record<string, Pick<TDataSource, "attrs">>,
  choice: TStratumChoice
): TStratumArray[] {
  const strata = strataOf(datasources, quantityOf(digest.array));
  const wanted =
    choice === DIGEST_STRATA.BOTH
      ? [DIGEST_STRATA.SIGNAL, DIGEST_STRATA.NOISE]
      : [choice];
  const arrays = wanted.flatMap((stratum) => strata.get(stratum) ?? []);
  return arrays.length ? arrays : [digest];
}

/**
 * The variables the selector leaves out: those derived from a stratum other
 * than the default whose quantity and product the default stratum's array
 * also derives (the stratum choice stands in for them). The variable
 * selected stays listed, so a URL that names it reads as it says.
 */
export function duplicateStratumVariables(
  vars: Record<string, Pick<TDataSource, "attrs">>,
  selected?: string
) {
  const duplicates = new Set<string>();
  for (const [name, source] of Object.entries(vars)) {
    const digest = digestVariableOf(source.attrs);
    if (!digest?.stratum || digest.stratum === DEFAULT_STRATUM) {
      continue;
    }
    const sibling = strataOf(vars, quantityOf(digest.array)).get(
      DEFAULT_STRATUM
    );
    if (sibling && name !== selected) {
      duplicates.add(name);
    }
  }
  return duplicates;
}
