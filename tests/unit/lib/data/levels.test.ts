import { describe, expect, it } from "vitest";

import {
  CAMERA_VERTICAL_FOV_DEGREES,
  EARTH_RADIUS_METERS,
} from "@/lib/camera/cameraSettings.ts";
import {
  cellsInView,
  coarserLevels,
  coarsestLevel,
  currentLevel,
  DEFAULT_HYSTERESIS_ORDERS,
  DEFAULT_MAX_LEVEL_CELLS,
  DEFAULT_MAX_VIEW_CELLS,
  DEFAULT_PIXELS_PER_CELL,
  DEFAULT_VIEW_BUDGET_BYTES,
  DIGEST_CHUNK_BYTES,
  digestCellBytes,
  FINE_DIGEST_PIXELS_PER_CELL,
  pixelFloorOf,
  exceedsCellCap,
  finerLevel,
  finestLevel,
  groundMetersPerPixel,
  healpixOrderOf,
  LEVEL_SLACK,
  POINT_TIER_PIXELS_PER_CELL,
  selectPointTier,
  selectViewLevel,
  type TLevelSelectionCamera,
  windowBlocks,
  windowCost,
} from "@/lib/data/levels.ts";
import { DIGEST_WINDOW_MARGIN } from "@/lib/grids/healpixWindow.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

// both strata: 2.2 cells' worth per cell of a stored level, 4 chunks' worth
// per leaf chunk (the ratios the store measures are in strata.ts)
const BOTH = { cell: 2.2, chunk: 4 };

// HEALPix cell size halves per order: sqrt(4π / (12 · 4^order)) radians.
function resolution(order: number) {
  return (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 2 ** order;
}

function healpixLevel(order: number) {
  return { resolution: resolution(order), cellCount: 12 * 4 ** order };
}

const derived = (order: number) => ({
  ...healpixLevel(order),
  derived: { dataset: "19", refinement: 19 - order },
});

// a 1500 × 900 screen
const VIEWPORT_PIXELS = 1_350_000;

/** The ground scale at which a cell of `order` spans `pixels` on screen. */
function scaleFor(order: number, pixels: number) {
  return resolution(order) / pixels;
}

// The ladder a hive store gives, finest first, every level loaded by view:
// derived 17..14 over the leaves, stored 13..4.
const ORDERS = [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4];
const HIVE = ORDERS.map((order) => ({
  ...(order > 13 ? derived(order) : healpixLevel(order)),
  byView: true,
}));
const at = (order: number) => ORDERS.indexOf(order);

describe("currentLevel", () => {
  const sources: TSources = {
    zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
    levels: [
      {
        grid: { store: "s", dataset: "0" },
        time: { store: "s", dataset: "0" },
        datasources: {},
      },
      {
        grid: { store: "s", dataset: "1" },
        time: { store: "s", dataset: "1" },
        datasources: {},
      },
    ],
  };

  it("reads the first level while nothing is selected", () => {
    expect(currentLevel(sources)).toBe(sources.levels[0]);
  });

  it("reads the selected level", () => {
    expect(currentLevel({ ...sources, selectedLevel: 1 })).toBe(
      sources.levels[1]
    );
  });

  it("reads the finest level for an index the list does not have", () => {
    // kept from a list with the leaves on it, or from a longer pyramid
    expect(currentLevel({ ...sources, selectedLevel: 2 })).toBe(
      sources.levels[0]
    );
  });
});

describe("groundMetersPerPixel", () => {
  it("scales with the camera height and the field of view", () => {
    const halfFov = (CAMERA_VERTICAL_FOV_DEGREES * Math.PI) / 360;
    const oneRadiusUp = {
      altitudeMeters: EARTH_RADIUS_METERS,
      viewportHeightPx: 1000,
    };
    expect(groundMetersPerPixel(oneRadiusUp)).toBeCloseTo(
      (2 * EARTH_RADIUS_METERS * Math.tan(halfFov)) / 1000,
      6
    );
    expect(
      groundMetersPerPixel({
        ...oneRadiusUp,
        altitudeMeters: 2 * EARTH_RADIUS_METERS,
      })
    ).toBeCloseTo(2 * groundMetersPerPixel(oneRadiusUp), 6);
    expect(
      groundMetersPerPixel({ ...oneRadiusUp, fovDegrees: 15 })
    ).toBeGreaterThan(groundMetersPerPixel(oneRadiusUp));
  });

  it("stays finite at the surface and on a zero-height viewport", () => {
    expect(
      groundMetersPerPixel({ altitudeMeters: 0, viewportHeightPx: 1000 })
    ).toBeGreaterThan(0);
    expect(
      Number.isFinite(
        groundMetersPerPixel({ altitudeMeters: 1e6, viewportHeightPx: 0 })
      )
    ).toBe(true);
  });
});

it("lists the stored levels coarser than a level, the finest first", () => {
  const levels = [
    { resolution: 100 },
    { resolution: 800 },
    { resolution: 200 },
    { resolution: 400, derived: { dataset: "19", refinement: 2 } },
  ];
  // the next coarser stored level first; a derived level is never beneath
  expect(coarserLevels(levels, 0)).toEqual([2, 1]);
  expect(coarserLevels(levels, 2)).toEqual([1]);
  expect(coarserLevels(levels, 3)).toEqual([1]);
  expect(coarserLevels(levels, 1)).toEqual([]);
  // nothing to walk without a resolution on every level
  expect(coarserLevels([{ resolution: 100 }, {}], 0)).toEqual([]);
});

it("names the next finer level, derived or not, the one a zoom in reaches", () => {
  const levels = [
    { resolution: 100 },
    { resolution: 400 },
    { resolution: 200 },
    { resolution: 50, derived: { dataset: "leaf", refinement: 1 } },
  ];
  expect(finerLevel(levels, 1)).toBe(2);
  expect(finerLevel(levels, 2)).toBe(0);
  expect(finerLevel(levels, 0)).toBe(3);
  expect(finerLevel(levels, 3)).toBeUndefined();
  expect(finerLevel([{ resolution: 100 }, {}], 0)).toBeUndefined();
});

it("names the coarsest level, when every level states its resolution", () => {
  expect(
    coarsestLevel([
      { resolution: 100 },
      { resolution: 400 },
      { resolution: 200 },
    ])
  ).toBe(1);
  expect(coarsestLevel([{ resolution: 100 }])).toBeUndefined();
  expect(coarsestLevel([{ resolution: 100 }, {}])).toBeUndefined();
});

// eslint-disable-next-line max-lines-per-function
describe("selectViewLevel", () => {
  it("picks the finest level whose cells are not sub-pixel when every window fits", () => {
    // a count: cells are bytes, every window in view fits the cap
    const stored = HIVE.slice(at(13));
    // order-12 cells at 1.5 px are under the floor; order 11 at 3 px is not
    const scale = scaleFor(12, 1.5);
    expect(selectViewLevel(scale, VIEWPORT_PIXELS, stored, at(4))).toBe(
      stored.findIndex((level) => level.resolution === resolution(11))
    );
    // close in, the finest stored level
    expect(
      selectViewLevel(scaleFor(13, 8), VIEWPORT_PIXELS, stored, at(4))
    ).toBe(0);
  });

  it("prices a digest variable in bytes and stops where the window would not fit", () => {
    // a 1500 × 900 view of order 12 at 1.5 px per cell: 600 000 cells of
    // 2 KB, with the quarter-view margin 1.9 GB, over the 1 GB budget;
    // order 11 at 3 px is 150 000 cells, 470 MB with the margin
    const scale = scaleFor(12, 1.5);
    const cells = cellsInView(resolution(12), scale, VIEWPORT_PIXELS);
    expect(cells).toBeCloseTo(600_000, -4);
    expect(windowCost(healpixLevel(12), cells, true)).toBeGreaterThan(1);
    expect(windowCost(healpixLevel(12), cells, false)).toBeLessThan(1);
    const options = { digest: true };
    expect(selectViewLevel(scale, VIEWPORT_PIXELS, HIVE, at(4), options)).toBe(
      at(11)
    );
    // closer in, order 13 comes on at its floor, where its window fits too:
    // 216 000 cells at 2.5 px, 570 MB with the margin
    const close = scaleFor(13, 2.5);
    expect(
      windowCost(
        healpixLevel(13),
        cellsInView(resolution(13), close, VIEWPORT_PIXELS),
        true
      )
    ).toBeLessThan(1);
    expect(selectViewLevel(close, VIEWPORT_PIXELS, HIVE, at(4), options)).toBe(
      at(13)
    );
  });

  it("prices every stratum the choice reads, and picks a coarser level for it", () => {
    // order 13 at 2.5 px fits the budget for the signal alone (570 MB with
    // the margin) and not with the noise beside it (2.2× that)
    const close = scaleFor(13, 2.5);
    const cells = cellsInView(resolution(13), close, VIEWPORT_PIXELS);
    const signal = windowCost(healpixLevel(13), cells, true);
    expect(
      windowCost(healpixLevel(13), cells, true, undefined, BOTH)
    ).toBeCloseTo(signal * 2.2);
    expect(windowCost(healpixLevel(13), cells, false, undefined, BOTH)).toBe(
      windowCost(healpixLevel(13), cells, false)
    );
    expect(windowCost(derived(15), cells, true, undefined, BOTH)).toBeCloseTo(
      windowCost(derived(15), cells, true) * 4
    );
    expect(digestCellBytes(13, 2.2)).toBeCloseTo(1700 * 2.2);
    expect(
      selectViewLevel(close, VIEWPORT_PIXELS, HIVE, at(4), { digest: true })
    ).toBe(at(13));
    expect(
      selectViewLevel(close, VIEWPORT_PIXELS, HIVE, at(4), {
        digest: true,
        strata: BOTH,
      })
    ).toBe(at(12));
  });

  it("brings the derived levels on at the one floor, once their chunks fit", () => {
    const options = { digest: true };
    // a derived level costs a leaf chunk per cell of ground whatever its
    // order: at 2 px per order-14 cell the view holds 337 000 of them, over
    // 121 000 chunks with the margin, far over the budget
    const scale = scaleFor(14, DEFAULT_PIXELS_PER_CELL);
    const cells = cellsInView(resolution(14), scale, VIEWPORT_PIXELS);
    expect(windowCost(derived(14), cells, true)).toBeCloseTo(
      (((cells * (1 + 2 * DIGEST_WINDOW_MARGIN) ** 2) / 4) *
        DIGEST_CHUNK_BYTES) /
        DEFAULT_VIEW_BUDGET_BYTES,
      6
    );
    expect(windowCost(derived(14), cells, true)).toBeGreaterThan(1);
    expect(selectViewLevel(scale, VIEWPORT_PIXELS, HIVE, at(13), options)).toBe(
      at(13)
    );
    // past order 13 a digest level waits for 8 px a cell: at 5.2 px per
    // order-14 cell, where 2 px would have taken 15, it is still 13
    expect(
      selectViewLevel(scaleFor(15, 2.6), VIEWPORT_PIXELS, HIVE, at(13), options)
    ).toBe(at(13));
    // once the chunks fit, the finest derived level over its floor: at 10
    // px per order-15 cell (20 per order-14 cell) that is 15, not 14
    const fits = scaleFor(15, 10);
    expect(
      windowCost(
        derived(15),
        cellsInView(resolution(15), fits, VIEWPORT_PIXELS),
        true
      )
    ).toBeLessThan(1);
    expect(selectViewLevel(fits, VIEWPORT_PIXELS, HIVE, at(13), options)).toBe(
      at(15)
    );
    // a count is priced the same, per leaf chunk: at derived 15's floor the
    // half-view window is 337 000 chunks, so the finest stored level shows
    const floor15 = scaleFor(15, DEFAULT_PIXELS_PER_CELL);
    const count15 = cellsInView(resolution(15), floor15, VIEWPORT_PIXELS);
    expect(windowCost(derived(15), count15, false)).toBeCloseTo(
      (((count15 * 2 ** 2) / 4 ** 2) * DIGEST_CHUNK_BYTES) /
        DEFAULT_VIEW_BUDGET_BYTES,
      6
    );
    expect(windowCost(derived(15), count15, false)).toBeGreaterThan(1);
    expect(selectViewLevel(floor15, VIEWPORT_PIXELS, HIVE, at(13))).toBe(
      at(13)
    );
    // very close in, derived 17; never the leaves (not in the ladder)
    for (const order of [17, 18, 19, 22]) {
      const scale = scaleFor(order, FINE_DIGEST_PIXELS_PER_CELL);
      expect(
        selectViewLevel(scale, VIEWPORT_PIXELS, HIVE, at(4), options)
      ).toBe(0);
    }
  });

  it("keeps the active level within its slack", () => {
    const stored = HIVE.slice(at(13));
    // order 11 just over the floor is picked; zooming out a little under the
    // floor keeps it, zooming out past the slack drops to 10
    const floor = scaleFor(11, DEFAULT_PIXELS_PER_CELL);
    const eleven = stored.findIndex((l) => l.resolution === resolution(11));
    const ten = eleven + 1;
    expect(selectViewLevel(floor, VIEWPORT_PIXELS, stored, ten)).toBe(eleven);
    expect(selectViewLevel(floor * 1.2, VIEWPORT_PIXELS, stored, eleven)).toBe(
      eleven
    );
    expect(selectViewLevel(floor * 1.2, VIEWPORT_PIXELS, stored, ten)).toBe(
      ten
    );
    expect(
      selectViewLevel(
        floor * LEVEL_SLACK * 1.01,
        VIEWPORT_PIXELS,
        stored,
        eleven
      )
    ).toBe(ten);
  });

  it("keeps a level loaded whole under the cell cap, and falls back to the coarsest", () => {
    // orders 12..9 loaded whole: 12 and 11 are over the whole-level cap
    const whole = [12, 11, 10, 9].map(healpixLevel);
    expect(selectViewLevel(scaleFor(12, 4), VIEWPORT_PIXELS, whole, 3)).toBe(2);
    expect(exceedsCellCap(healpixLevel(11))).toBe(true);
    expect(exceedsCellCap(healpixLevel(10))).toBe(false);
    // the same levels loaded by view are not capped
    const byView = whole.map((level) => ({ ...level, byView: true }));
    expect(selectViewLevel(scaleFor(12, 4), VIEWPORT_PIXELS, byView, 3)).toBe(
      0
    );
    // nothing fits: the coarsest is the least harmful
    const tooFine = [12, 11].map(healpixLevel);
    expect(selectViewLevel(scaleFor(12, 4), VIEWPORT_PIXELS, tooFine, 0)).toBe(
      1
    );
    // a window of a count that would exceed the view cap is out too
    const wide = scaleFor(12, 0.5);
    expect(cellsInView(resolution(12), wide, VIEWPORT_PIXELS)).toBeGreaterThan(
      DEFAULT_MAX_VIEW_CELLS
    );
    expect(selectViewLevel(wide, VIEWPORT_PIXELS, HIVE, at(4))).toBe(at(10));
  });

  it("counts the cells a sparse level stores, not the full sphere", () => {
    // a regional pyramid at orders 16..12 holding 2 million cells per level
    // is loadable whole, under the whole-level cap
    const regional = [16, 15, 14, 13, 12].map((order) => ({
      resolution: resolution(order),
      cellCount: 2_000_000,
    }));
    expect(2_000_000).toBeLessThan(DEFAULT_MAX_LEVEL_CELLS);
    expect(selectViewLevel(scaleFor(16, 4), VIEWPORT_PIXELS, regional, 4)).toBe(
      0
    );
  });

  it("changes nothing for a single level or levels without a resolution", () => {
    expect(selectViewLevel(1, VIEWPORT_PIXELS, [healpixLevel(8)], 0)).toBe(0);
    expect(selectViewLevel(1, VIEWPORT_PIXELS, [{}, healpixLevel(8)], 0)).toBe(
      0
    );
  });

  it("reads the order back from a resolution", () => {
    for (const order of ORDERS) {
      expect(healpixOrderOf(resolution(order))).toBe(order);
    }
  });
});

describe("a level derived from the leaves", () => {
  // the finest level is derived 17: 18 and the leaves are the point tier's
  it.each([14, 15, 16, 17])("is never whole-loadable at order %i", (order) => {
    const level = derived(order);
    // over the cap of a level loaded whole, and of a view: always a window
    expect(exceedsCellCap(level)).toBe(true);
    expect(exceedsCellCap(level, DEFAULT_MAX_VIEW_CELLS)).toBe(true);
    // never the backdrop, the one level that is always loaded whole
    expect(coarsestLevel([level, healpixLevel(13)])).toBe(1);
    expect(coarsestLevel([level, derived(order - 1)])).toBeUndefined();
    expect(coarsestLevel([level, healpixLevel(13), healpixLevel(12)])).toBe(2);
  });

  it("is kept out of automatic selection while it would be loaded whole", () => {
    const levels = [...[14, 15, 16, 17].map(derived), healpixLevel(8)];
    for (const order of [14, 15, 16, 17]) {
      const scale = scaleFor(order, DEFAULT_PIXELS_PER_CELL);
      expect(selectViewLevel(scale, VIEWPORT_PIXELS, levels, 4)).toBe(4);
    }
  });
});

describe("pixelFloorOf", () => {
  it("is 8 px for a digest level past order 13, else the default", () => {
    expect(pixelFloorOf(resolution(13), true)).toBe(DEFAULT_PIXELS_PER_CELL);
    expect(pixelFloorOf(resolution(14), true)).toBe(
      FINE_DIGEST_PIXELS_PER_CELL
    );
    expect(pixelFloorOf(resolution(16), true)).toBe(8);
    expect(pixelFloorOf(resolution(14), false)).toBe(DEFAULT_PIXELS_PER_CELL);
  });
});

describe("windowBlocks", () => {
  it("prices a stored level per cell and a derived level per leaf chunk", () => {
    // order 13 in 256-cell chunks: the budget over the chunks' bytes
    expect(windowBlocks({}, 13, 256, true)).toBe(
      Math.floor(DEFAULT_VIEW_BUDGET_BYTES / (digestCellBytes(13) * 256))
    );
    // an order-12 cell costs a little more than an order-13 one
    expect(windowBlocks({}, 12, 64, true)).toBeLessThan(
      windowBlocks({}, 13, 64, true)
    );
    // both strata: 2.2 cells' worth per cell, 2.2 chunks' worth per chunk
    expect(
      windowBlocks({}, 13, 256, true, DEFAULT_VIEW_BUDGET_BYTES, BOTH)
    ).toBe(Math.floor(DEFAULT_VIEW_BUDGET_BYTES / (1700 * 2.2 * 256)));
    expect(
      windowBlocks(
        { derived: { dataset: "19", refinement: 4 } },
        15,
        256,
        true,
        DEFAULT_VIEW_BUDGET_BYTES,
        BOTH
      )
    ).toBe(Math.floor(DEFAULT_VIEW_BUDGET_BYTES / (DIGEST_CHUNK_BYTES * 4)));
    // a derived level costs a leaf chunk per block whatever its order
    const derived = { derived: { dataset: "leaf", refinement: 2 } };
    expect(windowBlocks(derived, 15, 256, true)).toBe(
      Math.floor(DEFAULT_VIEW_BUDGET_BYTES / DIGEST_CHUNK_BYTES)
    );
    expect(windowBlocks(derived, 17, 16, true)).toBe(
      windowBlocks(derived, 15, 256, true)
    );
    // a derived level is priced per leaf chunk for every variable, a stored
    // one's count per cell against the view cap
    expect(windowBlocks(derived, 15, 16, false)).toBe(
      windowBlocks(derived, 15, 16, true)
    );
    // the stratum choice prices only a digest variable's chunks
    expect(
      windowBlocks(derived, 15, 16, false, DEFAULT_VIEW_BUDGET_BYTES, BOTH)
    ).toBe(windowBlocks(derived, 15, 16, false));
    expect(windowBlocks({}, 13, 256, false)).toBe(
      Math.floor(DEFAULT_MAX_VIEW_CELLS / 256)
    );
    // a budget below one block still loads one
    expect(windowBlocks({}, 13, 256, true, 1)).toBe(1);
  });
});

describe("finestLevel", () => {
  it("is the level with the smallest cells, whatever the order listed", () => {
    expect(finestLevel(HIVE)).toBe(0);
    expect(finestLevel([...HIVE].reverse())).toBe(HIVE.length - 1);
    expect(finestLevel([{ resolution: 100 }, {}])).toBe(0);
    expect(finestLevel([{}, {}])).toBeUndefined();
    expect(finestLevel([])).toBeUndefined();
  });
});

describe("selectPointTier", () => {
  const order17 = resolution(17);
  /** The ground scale at which an order-17 cell spans `pixels`. */
  const scaleAt = (pixels: number) => order17 / pixels;

  it("comes on where a finest cell spans 64 pixels", () => {
    expect(POINT_TIER_PIXELS_PER_CELL).toBe(64);
    expect(selectPointTier(scaleAt(63), order17, false)).toBe(false);
    expect(selectPointTier(scaleAt(64), order17, false)).toBe(true);
    expect(selectPointTier(scaleAt(300), order17, false)).toBe(true);
  });

  it("stays on through the hysteresis band and goes off below it", () => {
    const leave = POINT_TIER_PIXELS_PER_CELL / 2 ** DEFAULT_HYSTERESIS_ORDERS;
    expect(leave).toBeCloseTo(50.2, 1);
    for (const pixels of [63, 55, 51]) {
      expect(selectPointTier(scaleAt(pixels), order17, true)).toBe(true);
      expect(selectPointTier(scaleAt(pixels), order17, false)).toBe(false);
    }
    expect(selectPointTier(scaleAt(49), order17, true)).toBe(false);
    expect(selectPointTier(scaleAt(49), order17, true, 0)).toBe(false);
    expect(selectPointTier(scaleAt(63), order17, true, 0)).toBe(false);
    expect(selectPointTier(scaleAt(33), order17, true, 1)).toBe(true);
  });

  it("reads the camera as groundMetersPerPixel does, and never comes on without a scale", () => {
    /** The camera at which an order-17 cell spans `pixels` on screen. */
    const cameraAt = (pixels: number): TLevelSelectionCamera => ({
      altitudeMeters:
        (scaleAt(pixels) * 900) /
        (2 * Math.tan((CAMERA_VERTICAL_FOV_DEGREES * Math.PI) / 360)),
      viewportHeightPx: 900,
    });
    expect(groundMetersPerPixel(cameraAt(63))).toBeCloseTo(scaleAt(63));
    expect(selectPointTier(cameraAt(63), order17, false)).toBe(false);
    expect(selectPointTier(cameraAt(64), order17, false)).toBe(true);
    expect(selectPointTier(0, order17, true)).toBe(false);
    expect(selectPointTier(scaleAt(300), NaN, true)).toBe(false);
  });
});
