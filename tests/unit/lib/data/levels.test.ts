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
  DEFAULT_MAX_LEVEL_CELLS,
  DEFAULT_MAX_VIEW_CELLS,
  DEFAULT_PIXELS_PER_CELL,
  DEFAULT_VIEW_BUDGET_BYTES,
  DIGEST_CHUNK_BYTES,
  digestCellBytes,
  digestWindowBlocks,
  exceedsCellCap,
  groundMetersPerPixel,
  healpixOrderOf,
  LEVEL_SLACK,
  selectViewLevel,
  windowCost,
} from "@/lib/data/levels.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

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

  it("brings the derived levels on at the one floor, once their chunks fit", () => {
    const options = { digest: true };
    // a derived level costs a leaf chunk per cell of ground whatever its
    // order: at 2 px per order-14 cell the view holds 337 000 of them, over
    // 130 000 chunks with the margin, far over the budget
    const scale = scaleFor(14, DEFAULT_PIXELS_PER_CELL);
    const cells = cellsInView(resolution(14), scale, VIEWPORT_PIXELS);
    expect(windowCost(derived(14), cells, true)).toBeCloseTo(
      (((cells * 1.5 ** 2) / 4) * DIGEST_CHUNK_BYTES) /
        DEFAULT_VIEW_BUDGET_BYTES,
      6
    );
    expect(windowCost(derived(14), cells, true)).toBeGreaterThan(1);
    expect(selectViewLevel(scale, VIEWPORT_PIXELS, HIVE, at(13), options)).toBe(
      at(13)
    );
    // once the chunks fit, the finest derived level over the floor: at 2.6
    // px per order-15 cell (5.2 per order-14 cell) that is 15, not 14
    const fits = scaleFor(15, 2.6);
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
    // very close in, derived 17; never the leaves (not in the ladder)
    for (const order of [17, 18, 19, 22]) {
      const scale = scaleFor(order, DEFAULT_PIXELS_PER_CELL);
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

describe("digestWindowBlocks", () => {
  it("prices a stored level per cell and a derived level per leaf chunk", () => {
    // order 13 in 256-cell chunks: the budget over the chunks' bytes
    expect(digestWindowBlocks({}, 13, 256)).toBe(
      Math.floor(DEFAULT_VIEW_BUDGET_BYTES / (digestCellBytes(13) * 256))
    );
    // an order-12 cell costs a little more than an order-13 one
    expect(digestWindowBlocks({}, 12, 64)).toBeLessThan(
      digestWindowBlocks({}, 13, 64)
    );
    // a derived level costs a leaf chunk per block whatever its order
    const derived = { derived: { dataset: "leaf", refinement: 2 } };
    expect(digestWindowBlocks(derived, 15, 256)).toBe(
      Math.floor(DEFAULT_VIEW_BUDGET_BYTES / DIGEST_CHUNK_BYTES)
    );
    expect(digestWindowBlocks(derived, 17, 16)).toBe(
      digestWindowBlocks(derived, 15, 256)
    );
    // a budget below one block still loads one
    expect(digestWindowBlocks({}, 13, 256, 1)).toBe(1);
  });
});
