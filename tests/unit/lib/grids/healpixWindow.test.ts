import { Grid } from "healpix-geo";
import { expect, it } from "vitest";

import "@/utils/disposablePolyfill.ts";
import { coveredBlocks } from "@/lib/data/hiveStore.ts";
import {
  blockDistances,
  blocksByDistance,
  cutWindowStale,
  digestWindowMargin,
  VIEW_WINDOW_MARGIN,
  healpixBlockDepth,
  healpixBlockLevel,
  healpixBlockRanges,
  healpixViewBlocks,
  healpixViewWindow,
  viewWindowMargin,
} from "@/lib/grids/healpixWindow.ts";
import { createSortedCells } from "@/lib/grids/sortedCells.ts";

const box = {
  latMin: 40,
  latMax: 41,
  lonStart: -100,
  lonSpan: 1,
  centreLat: 40.5,
  centreLon: -99.5,
};

it("covers a view with the blocks six orders above the level", () => {
  using grid = new Grid({ scheme: "nested", level: 12 });
  expect(healpixBlockLevel(12)).toBe(6);
  const blocks = healpixViewBlocks(grid, box);
  // an order-6 cell is about 0.9° wide: a 1° box touches a handful
  expect(blocks.length).toBeGreaterThanOrEqual(2);
  expect(blocks.length).toBeLessThanOrEqual(9);
  using blockGrid = new Grid({ scheme: "nested", level: 6 });
  const corners = Float64Array.of(-100, 40, -99, 41, -99.5, 40.5);
  for (const block of blockGrid.lonLatToHealpix(corners)) {
    expect(blocks).toContain(Number(block));
  }
  // the margin only ever adds blocks
  const wider = healpixViewBlocks(grid, box, 0.5);
  expect(wider.length).toBeGreaterThan(blocks.length);
  expect(blocks.every((block) => wider.includes(block))).toBe(true);
});

it("keeps the blocks nearest the view centre within the budget", () => {
  using grid = new Grid({ scheme: "nested", level: 12 });
  // the camera is over (20°N, 60°E), off the middle of the box
  const wide = {
    latMin: -60,
    latMax: 60,
    lonStart: -120,
    lonSpan: 240,
    centreLat: 20,
    centreLon: 60,
  };
  const blocks = healpixViewBlocks(grid, wide, 0.5, 16);
  expect(blocks).toHaveLength(16);
  using blockGrid = new Grid({ scheme: "nested", level: 6 });
  const below = Number(blockGrid.lonLatToHealpix(Float64Array.of(60, 20))[0]);
  expect(blocks).toContain(below);
});

it("reports a budget that cuts into the view, not one that trims the margin", () => {
  using grid = new Grid({ scheme: "nested", level: 12 });
  const whole = healpixViewWindow(grid, box, 0.5);
  expect(whole.cut).toBe(false);
  expect(whole.clipped).toBe(false);
  // room for the view and some of the margin: the margin goes first
  const inView = healpixViewWindow(grid, box, 0).blocks.length;
  const trimmed = healpixViewWindow(grid, box, 0.5, inView + 1);
  expect(trimmed.blocks).toHaveLength(inView + 1);
  expect(trimmed.cut).toBe(true);
  expect(trimmed.clipped).toBe(false);
  // less room than the view needs: cells in view are missing
  expect(inView).toBeGreaterThan(1);
  const cut = healpixViewWindow(grid, box, 0.5, 1);
  expect(cut.blocks).toHaveLength(1);
  expect(cut.clipped).toBe(true);
  // a wide view shrunk around the camera by area is cut too
  const wide = {
    latMin: -60,
    latMax: 60,
    lonStart: -120,
    lonSpan: 240,
    centreLat: 20,
    centreLon: 60,
  };
  expect(healpixViewWindow(grid, wide, 0.5, 16).clipped).toBe(true);
});

it("measures block distances in degrees, in the order blocks are ranked", () => {
  using blockGrid = new Grid({ scheme: "nested", level: 6 });
  const blocks = Array.from({ length: 40 }, (_, index) => 3000 + 7 * index);
  const distance = blockDistances(blockGrid, blocks, 60, 20);
  for (const d of distance) {
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(180);
  }
  const ranked = blocksByDistance(blockGrid, blocks, 60, 20);
  const byRank = ranked.map((block) => distance[blocks.indexOf(block)]);
  expect(byRank).toEqual([...byRank].sort((a, b) => a - b));
  // the block below the point is at most half a block side away
  const below = Number(blockGrid.lonLatToHealpix(Float64Array.of(60, 20))[0]);
  expect(blockDistances(blockGrid, [below], 60, 20)[0]).toBeLessThan(
    58.63 / 2 ** 6
  );
});

it("leaves out the blocks a store holds nothing for, uncut", () => {
  using grid = new Grid({ scheme: "nested", level: 12 });
  using blockGrid = new Grid({ scheme: "nested", level: 6 });
  const below = Number(
    blockGrid.lonLatToHealpix(Float64Array.of(-99.5, 40.5))[0]
  );
  const only = healpixViewWindow(grid, box, 0.5, 1, undefined, (order) =>
    coveredBlocks({ nodeOrder: 6, ranks: new Set([below]) }, order)
  );
  expect(only.blocks).toEqual([below]);
  expect(only.cut).toBe(false);
  expect(only.clipped).toBe(false);
  expect(
    healpixViewWindow(grid, box, 0.5, 1, undefined, () => () => false).blocks
  ).toEqual([]);
});

it("cuts a polar view down around the camera, not around longitude 0", () => {
  using grid = new Grid({ scheme: "nested", level: 14 });
  // every longitude is in view; the camera is over 88.5°N 120°E
  const polar = {
    latMin: 86.6,
    latMax: 90,
    lonStart: -180,
    lonSpan: 360,
    centreLat: 88.5,
    centreLon: 120,
  };
  const blocks = healpixViewBlocks(grid, polar, 0.5, 192);
  expect(blocks.length).toBeLessThanOrEqual(192);
  using blockGrid = new Grid({ scheme: "nested", level: 8 });
  const below = Number(
    blockGrid.lonLatToHealpix(Float64Array.of(120, 88.5))[0]
  );
  expect(blocks).toContain(below);
});

it("uses whole faces for levels of at most six orders", () => {
  using grid = new Grid({ scheme: "nested", level: 4 });
  expect(healpixBlockLevel(4)).toBe(0);
  expect(healpixViewBlocks(grid, box)).toHaveLength(1);
});

it("merges neighbouring blocks into contiguous cell ranges", () => {
  expect(healpixBlockRanges([3, 4, 5, 9], 4096)).toEqual([
    { start: 3 * 4096, end: 6 * 4096 },
    { start: 9 * 4096, end: 10 * 4096 },
  ]);
});

it("searches a sorted cell coordinate chunk by chunk", async () => {
  const stored = Array.from({ length: 1000 }, (_, index) => 5000 + 3 * index);
  const reads: number[] = [];
  const cells = createSortedCells(stored.length, 64, async (start, end) => {
    reads.push(start / 64);
    return BigInt64Array.from(stored.slice(start, end), BigInt);
  });
  expect(await cells.lowerBound(5000)).toBe(0);
  expect(await cells.lowerBound(5301)).toBe(101);
  expect(await cells.lowerBound(9999)).toBe(1000);
  expect(await cells.slice(100, 103)).toEqual([5300, 5303, 5306]);
  expect(await cells.isAscending()).toBe(true);
  // 16 chunks, each read at most once
  expect(new Set(reads).size).toBe(reads.length);
  expect(reads.length).toBeLessThan(16);

  const shuffled = createSortedCells(4, 2, async (start) =>
    start === 0 ? [7, 3] : [1, 2]
  );
  expect(await shuffled.isAscending()).toBe(false);
});

it("finds a coordinate out of order in the chunks a search reads", async () => {
  // four sorted runs stored as A, C, B, D: the first and last chunk look fine
  const stored = [100, 101, 300, 301, 200, 201, 400, 401];
  const cells = createSortedCells(stored.length, 2, async (start, end) =>
    stored.slice(start, end)
  );
  expect(await cells.isAscending()).toBe(true);
  await expect(cells.lowerBound(200)).rejects.toThrow(/ascending/);
  expect(await cells.isAscending()).toBe(false);
});

it("gives a digest-derived variable a quarter-view margin", () => {
  expect(viewWindowMargin({ units: "m" })).toBe(VIEW_WINDOW_MARGIN);
  expect(viewWindowMargin(undefined)).toBe(0.5);
  expect(
    viewWindowMargin({
      digest: { array: "h_tdigest_signal", product: "percentile" },
    })
  ).toBe(digestWindowMargin());
  expect(digestWindowMargin()).toBe(0.1);
});

it("makes a block no larger than a chunk that is a square of cells", () => {
  // 256-cell chunks: blocks of 256 cells, four orders up
  expect(healpixBlockDepth(256)).toBe(4);
  // large chunks keep the 4^6 block
  expect(healpixBlockDepth(65536)).toBe(6);
  // a chunk that is no square keeps it too
  expect(healpixBlockDepth(1000)).toBe(6);
  // a derived level is windowed by chunk, whatever its size
  expect(healpixBlockDepth(16, true)).toBe(2);
  expect(healpixBlockDepth(16384, true)).toBe(7);
});

it("never merges blocks across a chunk boundary", () => {
  // blocks of 4096 cells in chunks of 8192: pairs at most
  expect(healpixBlockRanges([3, 4, 5, 6, 7], 4096, 8192)).toEqual([
    { start: 3 * 4096, end: 4 * 4096 },
    { start: 4 * 4096, end: 6 * 4096 },
    { start: 6 * 4096, end: 8 * 4096 },
  ]);
});

it("keeps every covered block that fits the budget, however far off-centre", () => {
  using grid = new Grid({ scheme: "nested", level: 12 });
  using blockGrid = new Grid({ scheme: "nested", level: 6 });
  // a store with nodes only in one corner of a wide view
  const ranks = new Set<number>();
  for (let lat = 35; lat <= 40; lat += 0.1) {
    for (let lon = -95; lon <= -85; lon += 0.1) {
      ranks.add(
        Number(blockGrid.lonLatToHealpix(Float64Array.of(lon, lat))[0])
      );
    }
  }
  const covers = (order: number) =>
    coveredBlocks({ nodeOrder: 6, ranks }, order);
  const wide = {
    latMin: 20,
    latMax: 60,
    lonStart: -160,
    lonSpan: 80,
    centreLat: 40,
    centreLon: -120,
  };
  const all = healpixViewWindow(grid, wide, 0.5, Infinity, undefined, covers);
  expect(all.blocks).toHaveLength(ranks.size);
  expect(ranks.size).toBeLessThan(80);
  const window = healpixViewWindow(grid, wide, 0.5, 80, undefined, covers);
  expect(window).toEqual({ blocks: all.blocks, cut: false, clipped: false });
  // over the budget, the covered blocks nearest the camera are kept
  const cut = healpixViewWindow(grid, wide, 0.5, 20, undefined, covers);
  expect(cut.blocks).toHaveLength(20);
  expect(cut.cut).toBe(true);
  expect(cut.clipped).toBe(true);
  expect(cut.blocks.every((block) => ranks.has(block))).toBe(true);
});

/** A footprint moved `dLon`, `dLat` degrees. */
function shifted(
  footprint: typeof box,
  dLon: number,
  dLat: number
): typeof box {
  return {
    latMin: footprint.latMin + dLat,
    latMax: footprint.latMax + dLat,
    lonStart: footprint.lonStart + dLon,
    lonSpan: footprint.lonSpan,
    centreLat: footprint.centreLat + dLat,
    centreLon: footprint.centreLon + dLon,
  };
}

it("calls a cut window stale once the camera has moved a block", () => {
  using grid = new Grid({ scheme: "nested", level: 12 });
  const side = 58.63 / 2 ** 6;
  const wide = {
    latMin: 30,
    latMax: 50,
    lonStart: -125,
    lonSpan: 50,
    centreLat: 40,
    centreLon: -100,
  };
  const loaded = healpixViewWindow(grid, wide, 0.5, 100);
  expect(loaded.cut).toBe(true);
  const stale = (view: typeof box) =>
    cutWindowStale(
      grid,
      loaded.blocks,
      healpixViewWindow(grid, view, 0, 100).blocks.filter(
        (block) => !loaded.blocks.includes(block)
      ),
      view,
      wide
    );
  expect(stale(wide)).toBe(false);
  expect(stale(shifted(wide, 0.1 * side, 0))).toBe(false);
  expect(stale(shifted(wide, 0, -0.1 * side))).toBe(false);
  expect(stale(shifted(wide, 3 * side, 0))).toBe(true);
  expect(stale(shifted(wide, 0, 3 * side))).toBe(true);
});

it("calls a cut window that loaded nothing stale once blocks are in view", () => {
  using grid = new Grid({ scheme: "nested", level: 12 });
  const inView = healpixViewWindow(grid, box, 0).blocks;
  expect(inView.length).toBeGreaterThan(0);
  expect(cutWindowStale(grid, [], inView, box, box)).toBe(true);
  expect(cutWindowStale(grid, [], [], box, box)).toBe(false);
});

it("does not call a cut window at a pole stale at the camera it loaded at", () => {
  using grid = new Grid({ scheme: "nested", level: 12 });
  const side = 58.63 / 2 ** 6;
  const polar = {
    latMin: 70,
    latMax: 90,
    lonStart: -180,
    lonSpan: 360,
    centreLat: 84,
    centreLon: 30,
  };
  const loaded = healpixViewWindow(grid, polar, 0.5, 100).blocks;
  // the window at the view is another shape: blocks in view are missing
  const missing = healpixViewWindow(grid, polar, 0, 100).blocks.filter(
    (block) => !loaded.includes(block)
  );
  expect(missing.length).toBeGreaterThan(0);
  expect(cutWindowStale(grid, loaded, missing, polar, polar)).toBe(false);
  const nudged = { ...polar, centreLat: polar.centreLat - 0.1 * side };
  expect(cutWindowStale(grid, loaded, missing, nudged, polar)).toBe(false);
  const moved = { ...polar, centreLat: polar.centreLat - 3 * side };
  expect(cutWindowStale(grid, loaded, missing, moved, polar)).toBe(true);
});
