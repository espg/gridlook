import { watchDebounced } from "@vueuse/core";
import type * as zarr from "zarrita";

import { currentLevel } from "@/lib/data/levels.ts";
import { digestField, digestReaderFor } from "@/lib/digest/digestField.ts";
import { digestVariableOf } from "@/lib/digest/digestVariables.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

// A dragged slider recomputes the field this often at most.
const RECOMPUTE_DEBOUNCE_MS = 60;

/**
 * The variables a level derives from a t-digest (a percentile, a percentile
 * range) as ordinary fields: `fetch` stands in for the read of a stored
 * variable, and a change of the percentiles calls `reload`, which computes
 * the field again from the digests in memory.
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
   * The values of a derived variable over a selection whose last entry is
   * the slice of cells; undefined for a variable that is stored.
   */
  function fetch(
    selection: (number | zarr.Slice | null)[],
    variable: string,
    sources: TSources
  ) {
    const target = derived(variable, sources);
    const reader = target && digestReaderFor(target.source.store);
    const cells = selection.at(-1);
    if (!target || !reader || typeof cells !== "object" || cells === null) {
      return undefined;
    }
    const { digest, source } = target;
    const path = [source.dataset, digest.array].filter(Boolean).join("/");
    return reader.then((opened) =>
      digestField(
        opened,
        path,
        digest,
        params(),
        cells.start ?? 0,
        cells.stop ?? 0
      )
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
