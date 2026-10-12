import { sortCentroids } from "./derivedLevel.ts";
import {
  chunkBytes,
  createByteLru,
  type TDigestSource,
} from "./digestReader.ts";
import { digestVariableOf, type TDigestVariable } from "./digestVariables.ts";
import type { TDigestChunk } from "./tdigest.ts";

import type { TStrataBytes } from "@/lib/data/levels.ts";
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
 *
 * Merging two cells' digests is the operation a derived level pools its
 * leaf cells with (`poolDigestChunk`): the centroids concatenated and sorted
 * by mean, their weights kept, nothing compressed. Where the leaves are
 * lossless the merged digest is the exact sample of every photon.
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

/**
 * Bytes of the noise digest relative to the signal's, measured on the ATL03
 * v3 store over the Sierra Nevada: per cell of a stored level (order 13,
 * capped digests) and per leaf chunk (one centroid per photon, with the
 * located words the point tier reads beside), and what a choice costs
 * relative to the signal alone: `both` reads the two.
 */
export const NOISE_BYTES_RATIO: TStrataBytes = { cell: 1.2, chunk: 4 };
export function strataBytesFactor(choice: TStratumChoice): TStrataBytes {
  switch (choice) {
    case DIGEST_STRATA.NOISE:
      return NOISE_BYTES_RATIO;
    case DIGEST_STRATA.BOTH:
      return {
        cell: 1 + NOISE_BYTES_RATIO.cell,
        chunk: 1 + NOISE_BYTES_RATIO.chunk,
      };
    default:
      return { cell: 1, chunk: 1 };
  }
}

/** The arrays of a merged path, joined: `19/h_tdigest_signal|19/h_tdigest_noise`. */
const MERGED_SEPARATOR = "|";
export const mergedPath = (paths: string[]) => paths.join(MERGED_SEPARATOR);
const splitMergedPath = (path: string) => path.split(MERGED_SEPARATOR);

/**
 * The digests of `chunks` merged cell by cell: the centroids of a cell from
 * every chunk, sorted by mean with their weights, so the quantile law reads
 * the merged sample as it reads a pooled one. A chunk the store does not
 * have (null) adds nothing; null when none is there. One chunk is itself.
 */
function mergeDigestChunks(
  chunks: (TDigestChunk | null)[]
): TDigestChunk | null {
  const present = chunks.filter((chunk) => chunk !== null);
  if (present.length < 2) {
    return present[0] ?? null;
  }
  const cells = present[0].offsets.length - 1;
  if (present.some((chunk) => chunk.offsets.length !== cells + 1)) {
    throw new Error("the strata to merge differ in cells");
  }
  const offsets = new Uint32Array(cells + 1);
  for (let cell = 0; cell < cells; cell++) {
    let total = 0;
    for (const chunk of present) {
      total += chunk.offsets[cell + 1] - chunk.offsets[cell];
    }
    offsets[cell + 1] = offsets[cell] + total;
  }
  const means = new Float32Array(offsets[cells]);
  const weights = new Float32Array(offsets[cells]);
  for (let cell = 0; cell < cells; cell++) {
    let at = offsets[cell];
    for (const chunk of present) {
      const [from, to] = [chunk.offsets[cell], chunk.offsets[cell + 1]];
      means.set(chunk.means.subarray(from, to), at);
      weights.set(chunk.weights.subarray(from, to), at);
      at += to - from;
    }
    sortCentroids(means, weights, offsets[cell], offsets[cell + 1]);
  }
  return { offsets, means, weights };
}

/** One cell of a chunk as a chunk of its own. */
function cellChunk(chunk: TDigestChunk, cell: number): TDigestChunk {
  const [from, to] = [chunk.offsets[cell], chunk.offsets[cell + 1]];
  return {
    offsets: Uint32Array.of(0, to - from),
    means: chunk.means.subarray(from, to),
    weights: chunk.weights.subarray(from, to),
  };
}

/** The digests of some cells merged into one, as cell 0 of its chunk. */
export function mergeDigestCells(
  cells: { chunk: TDigestChunk; cell: number }[]
) {
  const merged = mergeDigestChunks(
    cells.map(({ chunk, cell }) => cellChunk(chunk, cell))
  );
  return merged && { chunk: merged, cell: 0 };
}

// a working set, as the pooled digests' (see derivedLevel)
const DEFAULT_MERGED_CACHE_BYTES = 32 * 2 ** 20;

/**
 * The digests of some arrays merged: `at(group)` reads like the pooled
 * source it wraps, and a path made of several arrays' paths (`mergedPath`)
 * reads each and merges them cell by cell. A single path passes through, so
 * one source serves every stratum choice. Merged chunks are kept, bounded
 * by bytes; `peek` merges only what is in memory for every array.
 */
/**
 * The parts merged, from `cache` when they were before; undefined while a
 * part is not in memory.
 */
function mergedParts(
  cache: ReturnType<typeof createByteLru<TDigestChunk>>,
  parts: (TDigestChunk | null | undefined)[],
  key: string
) {
  if (parts.some((part) => part === undefined)) {
    return undefined;
  }
  let chunk = cache.get(key);
  if (!chunk) {
    chunk = mergeDigestChunks(parts as (TDigestChunk | null)[]) ?? undefined;
    if (chunk) {
      cache.set(key, chunk);
    }
  }
  return chunk ?? null;
}

export function createMergedDigests(
  pooled: { at(group: number): TDigestSource },
  maxBytes = DEFAULT_MERGED_CACHE_BYTES
) {
  const cache = createByteLru<TDigestChunk>(maxBytes, chunkBytes);
  const merged = (parts: (TDigestChunk | null | undefined)[], key: string) =>
    mergedParts(cache, parts, key);

  function at(group: number): TDigestSource {
    const source = pooled.at(group);
    const key = (path: string, index: number, row: number) =>
      `${group}/${path}/${row}/${index}`;
    return {
      array: (path) => source.array(splitMergedPath(path)[0]),
      async chunk(path, index, row = 0) {
        const paths = splitMergedPath(path);
        if (paths.length === 1) {
          return source.chunk(path, index, row);
        }
        const kept = cache.get(key(path, index, row));
        if (kept) {
          return kept;
        }
        const parts = await Promise.all(
          paths.map((part) => source.chunk(part, index, row))
        );
        return merged(parts, key(path, index, row)) ?? null;
      },
      peek(path, index, row = 0) {
        const paths = splitMergedPath(path);
        return paths.length === 1
          ? source.peek(path, index, row)
          : merged(
              paths.map((part) => source.peek(part, index, row)),
              key(path, index, row)
            );
      },
    };
  }

  return { at };
}
