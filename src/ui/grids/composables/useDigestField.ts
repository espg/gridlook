import { watchDebounced } from "@vueuse/core";
import type * as zarr from "zarrita";

import { currentLevel } from "@/lib/data/levels.ts";
import { summedField } from "@/lib/digest/derivedLevel.ts";
import { digestField, levelSource } from "@/lib/digest/digestField.ts";
import {
  DIGEST_PRODUCTS,
  digestVariableOf,
} from "@/lib/digest/digestVariables.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

// A dragged slider recomputes the field this often at most.
const RECOMPUTE_DEBOUNCE_MS = 60;

/**
 * The variables computed in the browser as ordinary fields: those a level
 * derives from a t-digest (a percentile, a percentile range) and every
 * variable of a level derived from the leaves. `fetch` stands in for the
 * read of a stored variable, and a change of the percentiles calls `reload`,
 * which computes the field again from the digests in memory.
 */
// eslint-disable-next-line max-lines-per-function
export function useDigestField(options: {
  getDatasources: () => TSources | undefined;
  reload: () => unknown;
}) {
  const store = useGlobeControlStore();

  function derived(variable: string, sources = options.getDatasources()) {
    const source = sources && currentLevel(sources).datasources[variable];
    const digest = digestVariableOf(source?.attrs);
    return digest && source ? { digest, source } : undefined;
  }

  const params = () => ({
    percentile: store.digestPercentile,
    low: store.digestPercentileLow,
    high: store.digestPercentileHigh,
  });

  /**
   * The values of a computed variable over a selection whose last entry is
   * the slice of cells; undefined for a variable that is read as stored.
   * With `percentile`, the height at that percentile whatever the variable
   * (one of the two a percentile range is the difference of).
   */
  function fetch(
    selection: (number | zarr.Slice | null)[],
    variable: string,
    sources: TSources,
    percentile?: number
  ) {
    const level = currentLevel(sources);
    const source = level.datasources[variable];
    const digest = digestVariableOf(source?.attrs);
    const from =
      source && (digest || level.derived) && levelSource(level, source);
    const cells = selection.at(-1);
    if (!from || typeof cells !== "object" || cells === null) {
      return undefined;
    }
    const [start, end] = [cells.start ?? 0, cells.stop ?? 0];
    if (!digest) {
      // a variable of a derived level that is a sum of the leaves' (count)
      return from.dense.then((reader) =>
        summedField(reader, from.path(variable), from.group, start, end)
      );
    }
    const [product, at] =
      percentile === undefined
        ? [digest, params()]
        : [
            { product: DIGEST_PRODUCTS.PERCENTILE },
            { ...params(), percentile },
          ];
    return from.digests.then((reader) =>
      digestField(reader, from.path(digest.array), product, at, start, end)
    );
  }

  /** What a frame of the displayed variable depends on beside its cells. */
  function key() {
    return derived(store.varnameSelector) ? JSON.stringify(params()) : "";
  }

  if (derived(store.varnameSelector)) {
    // a percentile is comparable across levels, as a mean is
    store.setLevelRangeShared(true);
  }
  watchDebounced(
    key,
    () => {
      if (derived(store.varnameSelector)) {
        options.reload();
      }
    },
    { debounce: RECOMPUTE_DEBOUNCE_MS }
  );

  return { fetch, key };
}
