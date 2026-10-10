import type * as healpixGeo from "healpix-geo";
import { ref, watch } from "vue";

import { currentLevel } from "@/lib/data/levels.ts";
import {
  DIGEST_PRODUCTS,
  digestVariableOf,
} from "@/lib/digest/digestVariables.ts";
import {
  filledCells,
  filledValues,
  fillFaceGaps,
  type TFilledCells,
} from "@/lib/grids/healpixGapFill.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { buildHistogramSummary } from "@/utils/histogram.ts";

type TFace = { data: Float32Array; cells?: number[] };

/** The histogram of a face's own values, as the face worker builds it. */
function histogramOf(data: Float32Array) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of data) {
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return min > max
    ? buildHistogramSummary(data, NaN, NaN)
    : buildHistogramSummary(data, min, max);
}

/**
 * Gap filling of a variable derived from a t-digest, one HEALPix face at a
 * time: the blank cells of the field displayed take a Gaussian-weighted mean
 * of the values around them. What is smoothed is the field (a height at one
 * percentile), never the digests; a percentile range is the difference of
 * its two percentile fields, each filled on its own. The colour range and
 * the histogram stay those of the values observed. Toggling or resizing the
 * kernel calls `reload`, which fills again from the digests in memory.
 */
// eslint-disable-next-line max-lines-per-function
export function useGapFill(options: {
  getDatasources: () => TSources | undefined;
  reload: () => unknown;
}) {
  const store = useGlobeControlStore();
  // the cells filled on each face of the frame last computed
  const faces = new Map<number, TFilledCells & { percentiles: number[] }>();
  const revision = ref(0);

  function displayed() {
    const sources = options.getDatasources();
    return digestVariableOf(
      sources && currentLevel(sources).datasources[store.varnameSelector]?.attrs
    );
  }

  /**
   * The face to draw and, when cells were filled, the histogram of the face
   * as read. `percentileField` is the height at one percentile over the
   * cells of `face`.
   */
  async function fill(
    faceIndex: number,
    nside: number,
    face: TFace,
    percentileField: (percentile: number) => Promise<Float32Array>
  ) {
    const digest = displayed();
    faces.delete(faceIndex);
    if (!store.gapFill || !digest || face.data.length === 0) {
      revision.value++;
      return { data: face.data, histogramSummary: undefined };
    }
    const isRange = digest.product === DIGEST_PRODUCTS.RANGE;
    const percentiles = isRange
      ? [store.digestPercentileLow, store.digestPercentileHigh]
      : [store.digestPercentile];
    const fields = isRange
      ? await Promise.all(percentiles.map(percentileField))
      : [face.data];
    const filled = fields.map((data) =>
      fillFaceGaps(
        { data, cells: face.cells },
        faceIndex,
        nside,
        store.gapFillSize
      )
    );
    const faceOffset = faceIndex * nside * nside;
    faces.set(faceIndex, {
      percentiles,
      ...filledCells(face.data, filled, nside, (index) =>
        face.cells ? face.cells[index] : faceOffset + index
      ),
    });
    revision.value++;
    return {
      data: isRange
        ? face.data.map((value, index) =>
            Number.isNaN(value) ? filled[1][index] - filled[0][index] : value
          )
        : filled[0],
      histogramSummary: histogramOf(face.data),
    };
  }

  /** The heights a filled cell was given; undefined for any other cell. */
  function interpolated(cell: number, grid: healpixGeo.Grid) {
    const face = faces.get(Math.floor(cell / grid.nside ** 2));
    const values =
      face?.nside === grid.nside ? filledValues(face, cell) : undefined;
    return values?.map((value, index) => ({
      percentile: face!.percentiles[index],
      value,
    }));
  }

  watch(
    [() => store.gapFill, () => store.gapFillSize],
    ([enabled], [wasEnabled]) => {
      if (displayed() && (enabled || wasEnabled)) {
        options.reload();
      }
    }
  );

  return { fill, interpolated, revision };
}
