import type { TDigestCell } from "./digestField.ts";
import { digestVariableOf } from "./digestVariables.ts";
import {
  digestCumulativeWeight,
  digestQuantile,
  digestWeight,
} from "./tdigest.ts";

import type { TDataSource } from "@/lib/types/GlobeTypes.ts";

/** A t-digest array of a level: one stratum of its observations. */
export type TDigestStratum = {
  /** `signal`, `noise`; the array's name when it names no stratum. */
  name: string;
  /** The array's path in the store. */
  path: string;
};

/** The distributions of one cell, as the panel shows them. */
export type TDigestProbe = {
  /** The cell's centre. */
  lat: number;
  lon: number;
  /** The cell's nested index at `order`. */
  cell: number;
  order: number;
  /** Shown until another cell is clicked, not the cell under the cursor. */
  pinned: boolean;
  /**
   * The cell has no observations and is drawn with a value filled from its
   * neighbours: the heights at the percentiles displayed.
   */
  interpolated?: { percentile: number; value: number }[];
  strata: {
    name: string;
    /** Null: the cell has no digest. Undefined: it was not read. */
    digest: TDigestCell | null | undefined;
  }[];
};

export type TDigestPlot = {
  /** The values (bin edges) the densities lie between. */
  x: Float32Array;
  curves: {
    name: string;
    /** Observations per unit of `x` in each bin. */
    density: Float32Array;
  }[];
  /** The largest density of any curve. */
  peak: number;
};

const TARGET_STRATUM = "signal";
// The plot reaches this fraction of the value range past either end.
const PLOT_PADDING = 0.04;

/**
 * The digest arrays of a level, from the variables derived from them; the
 * signal first, as it sets the range of the plot. `dataset` is the group
 * they are read in when it is not the level's own (a derived level).
 */
export function digestStrata(
  datasources: Record<string, TDataSource>,
  dataset?: string
): TDigestStratum[] {
  const strata = new Map<string, TDigestStratum>();
  for (const source of Object.values(datasources)) {
    const digest = digestVariableOf(source.attrs);
    if (digest) {
      strata.set(digest.array, {
        name: digest.stratum ?? digest.array,
        path: [dataset ?? source.dataset, digest.array]
          .filter(Boolean)
          .join("/"),
      });
    }
  }
  return [...strata.values()].sort(
    (a, b) =>
      Number(b.name === TARGET_STRATUM) - Number(a.name === TARGET_STRATUM)
  );
}

/** A probe's strata that hold observations. */
export function probeDigests(probe: TDigestProbe) {
  return probe.strata.flatMap(({ name, digest }) =>
    digest && digestWeight(digest.chunk, digest.cell) > 0
      ? [{ name, digest }]
      : []
  );
}

/**
 * The densities of a probe's strata over `bins` bins spanning the first
 * stratum with data (the signal, when the cell has any), all in
 * observations per unit, so that the curves compare. Undefined for a cell
 * without data.
 */
export function digestPlot(
  probe: TDigestProbe,
  bins = 96
): TDigestPlot | undefined {
  const digests = probeDigests(probe);
  if (digests.length === 0) {
    return undefined;
  }
  const { chunk, cell } = digests[0].digest;
  const first = chunk.means[chunk.offsets[cell]];
  const last = chunk.means[chunk.offsets[cell + 1] - 1];
  const padding = (last - first) * PLOT_PADDING || 1;
  const min = first - padding;
  const step = (last + padding - min) / bins;
  const x = Float32Array.from({ length: bins + 1 }, (_, i) => min + i * step);
  let peak = 0;
  const curves = digests.map(({ name, digest }) => {
    const cumulative = digestCumulativeWeight(digest.chunk, digest.cell, x);
    const density = new Float32Array(bins);
    for (let bin = 0; bin < bins; bin++) {
      density[bin] = (cumulative[bin + 1] - cumulative[bin]) / step;
      peak = Math.max(peak, density[bin]);
    }
    return { name, density };
  });
  return { x, curves, peak };
}

/**
 * The values at `percentiles` (0..100) of one stratum of a probe: `stratum`
 * when the cell has data in it, else the first stratum that has.
 */
export function probePercentiles(
  probe: TDigestProbe,
  percentiles: number[],
  stratum?: string
) {
  const digests = probeDigests(probe);
  const source = digests.find(({ name }) => name === stratum) ?? digests[0];
  if (!source) {
    return undefined;
  }
  return {
    stratum: source.name,
    weight: digestWeight(source.digest.chunk, source.digest.cell),
    values: percentiles.map((percentile) => ({
      percentile,
      value: digestQuantile(
        source.digest.chunk,
        source.digest.cell,
        percentile / 100
      ),
    })),
  };
}
