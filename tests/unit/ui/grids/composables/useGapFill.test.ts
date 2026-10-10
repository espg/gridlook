import type * as healpixGeo from "healpix-geo";
import { beforeEach, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { fillFaceGaps } = await import("@/lib/grids/healpixGapFill.ts");
const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useGapFill } = await import("@/ui/grids/composables/useGapFill.ts");

const NSIDE = 4;
const GRID = { nside: NSIDE } as healpixGeo.Grid;
const FACE = 2;
const OFFSET = FACE * NSIDE * NSIDE;

function variable(product: string) {
  return {
    store: "s",
    dataset: "8",
    attrs: { digest: { array: "h_tdigest_signal", product } },
  };
}
const sources = {
  zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
  levels: [
    {
      grid: { store: "s", dataset: "8" },
      time: { store: "s", dataset: "8" },
      datasources: {
        count: { store: "s", dataset: "8", attrs: {} },
        h_percentile_signal: variable("percentile"), // eslint-disable-line camelcase
        h_range_signal: variable("range"), // eslint-disable-line camelcase
      },
    },
  ],
};

// a whole face: heights on the nested cells 0 and 3, nothing elsewhere
const low = new Float32Array(NSIDE * NSIDE).fill(NaN);
const high = new Float32Array(NSIDE * NSIDE).fill(NaN);
low.set([100], 0);
low.set([110], 3);
high.set([130], 0);
high.set([170], 3);
const range = high.map((value, index) => value - low[index]);
const percentileField = async (percentile: number) =>
  percentile === 2 ? low : high;

function setup(varname: string) {
  const store = useGlobeControlStore();
  store.varnameSelector = varname;
  const reload = vi.fn();
  const gapFill = effectScope().run(() =>
    useGapFill({ getDatasources: () => sources, reload })
  )!;
  return { store, reload, gapFill };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

it("draws the face as read while smoothing is off", async () => {
  const { gapFill } = setup("h_percentile_signal");
  const shown = await gapFill.fill(FACE, NSIDE, { data: low }, percentileField);
  expect(shown.data).toBe(low);
  expect(shown.histogramSummary).toBeUndefined();
  expect(gapFill.interpolated(OFFSET + 1, GRID)).toBeUndefined();
});

it("fills a percentile and keeps the histogram of the values read", async () => {
  const { store, gapFill } = setup("h_percentile_signal");
  store.setGapFill(true);
  store.setGapFillSize(3);
  const shown = await gapFill.fill(FACE, NSIDE, { data: low }, percentileField);
  expect(shown.data).toEqual(fillFaceGaps({ data: low }, FACE, NSIDE, 3));
  expect(shown.data[0]).toBe(100);
  expect(shown.data[1]).toBeGreaterThan(100);
  expect(shown.data[1]).toBeLessThan(110);
  // two cells were read, whatever was filled around them
  expect(shown.histogramSummary).toMatchObject({ min: 100, max: 110 });
  expect(shown.histogramSummary!.bins.reduce((sum, bin) => sum + bin, 0)).toBe(
    2
  );
  expect(gapFill.interpolated(OFFSET + 1, GRID)).toEqual([
    { percentile: 50, value: shown.data[1] },
  ]);
  // a cell with data, another face, and a grid of another order
  expect(gapFill.interpolated(OFFSET, GRID)).toBeUndefined();
  expect(gapFill.interpolated(1, GRID)).toBeUndefined();
  expect(
    gapFill.interpolated(OFFSET + 1, { nside: 8 } as healpixGeo.Grid)
  ).toBeUndefined();
});

it("fills a percentile range as the difference of its two filled fields", async () => {
  const { store, gapFill } = setup("h_range_signal");
  store.setGapFill(true);
  store.setGapFillSize(3);
  const shown = await gapFill.fill(
    FACE,
    NSIDE,
    { data: range },
    percentileField
  );
  const filledLow = fillFaceGaps({ data: low }, FACE, NSIDE, 3);
  const filledHigh = fillFaceGaps({ data: high }, FACE, NSIDE, 3);
  expect(shown.data[0]).toBe(30);
  expect(shown.data[3]).toBe(60);
  expect(shown.data[1]).toBe(Math.fround(filledHigh[1] - filledLow[1]));
  // not the range field smoothed: the quantile order is kept cell by cell
  expect(gapFill.interpolated(OFFSET + 1, GRID)).toEqual([
    { percentile: 2, value: filledLow[1] },
    { percentile: 98, value: filledHigh[1] },
  ]);
  expect(shown.histogramSummary).toMatchObject({ min: 30, max: 60 });
});

it("recomputes on a toggle or a kernel change, for a digest variable only", async () => {
  const { store, reload } = setup("h_percentile_signal");
  store.setGapFillSize(9);
  await nextTick();
  // the kernel of a filter that is off
  expect(reload).not.toHaveBeenCalled();
  store.setGapFill(true);
  await nextTick();
  store.setGapFillSize(31);
  await nextTick();
  store.setGapFillSize(4);
  await nextTick();
  expect(store.gapFillSize).toBe(31);
  expect(reload).toHaveBeenCalledTimes(2);
  store.varnameSelector = "count";
  store.setGapFill(false);
  await nextTick();
  expect(reload).toHaveBeenCalledTimes(2);
});

it("leaves a count as read", async () => {
  const { store, gapFill } = setup("count");
  store.setGapFill(true);
  const shown = await gapFill.fill(FACE, NSIDE, { data: low }, percentileField);
  expect(shown.data).toBe(low);
});
