import "@/utils/disposablePolyfill.ts";
import { Grid } from "healpix-geo";
import { createPinia, setActivePinia } from "pinia";
import { expect, it, vi } from "vitest";

import type { TFaceParts } from "@/lib/grids/healpixBlockFetch.ts";
import type { TViewFootprint } from "@/lib/projection/viewFootprint.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useAncestorFill } from "@/ui/grids/composables/useAncestorFill.ts";

vi.stubGlobal("localStorage", { getItem: () => null });

// fine, parent and grandparent orders, finest first
const ORDERS = [9, 8, 7];

// the level on screen
let selected = 0;
// whether the finest level is derived from leaf chunks
let finestDerived = false;

function sources(): TSources {
  const from = (dataset: string) => ({ store: "s.zarr", dataset });
  return {
    zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
    selectedLevel: selected,
    levels: ORDERS.map((order) => ({
      name: `order ${order}`,
      grid: from(`${order}`),
      time: from(`${order}`),
      datasources: { t: from(`${order}`) },
      resolution: 6_500_000 / 2 ** order,
      derived:
        finestDerived && order === ORDERS[0]
          ? { dataset: "leaf", refinement: 0 }
          : undefined,
    })),
  } as unknown as TSources;
}

/** A field over blocks of face 0 of a level (4096 cells each), as read. */
const parts = (...blocks: number[]): TFaceParts =>
  new Map([
    [
      0,
      (blocks.length > 0 ? blocks : [0]).map((block) => ({
        range: { start: 4096 * block, end: 4096 * (block + 1) },
        data: new Float32Array(4096),
        cells: Array.from({ length: 4096 }, (_, cell) => 4096 * block + cell),
      })),
    ],
  ]);

/** A level's grid, as `keep` is given it. */
const level = (index: number) => ({
  grid: new Grid({ scheme: "nested", level: ORDERS[index] }),
});

/** A range of one block of 4096 cells, on its face of order-3 blocks. */
const blockRange = (block: number) => ({
  start: 4096 * block,
  end: 4096 * (block + 1),
  face: Math.floor(block / 64),
  lon: block,
  lat: 0,
});

/** The fill over the three levels, each level's window as given. */
function ancestorFill(
  windows: Record<number, { blocks: number[]; cut: boolean; clipped: boolean }>,
  onRead?: () => void,
  cacheBytes?: number,
  fetchRange: (range: { start: number; end: number }) => Promise<{
    data: Float32Array;
    cells: number[];
  }> = async (range) => parts(range.start / 4096).get(0)![0]
) {
  setActivePinia(createPinia());
  selected = 0;
  finestDerived = false;
  const reads: number[] = [];
  const blocksRead: number[][] = [];
  const fill = useAncestorFill({
    getDatasources: sources,
    describe: async (from) => {
      const order = ORDERS[from.selectedLevel ?? 0];
      return {
        datavar: {
          shape: [12 * 4 ** order],
          chunks: [4096],
          attrs: {},
        } as never,
        grid: new Grid({ scheme: "nested", level: order }),
      };
    },
    window: (level) => windows[level.grid.level],
    read: async (level, blocks, seed) => {
      reads.push(level.grid.level);
      blocksRead.push(blocks);
      onRead?.();
      const read = parts(...blocks);
      for (const [face, held] of seed) {
        read.set(face, [...held, ...(read.get(face) ?? [])]);
      }
      return { parts: blocks.length > 0 ? read : seed, batches: [] };
    },
    show: vi.fn(),
    meshes: [],
    cacheBytes,
    ranges: (_, blocks) => blocks.map(blockRange),
    fetchRange: (_, range) => fetchRange(range),
    byView: () => true,
  });
  return { fill, reads, blocksRead };
}

it("draws a parent whose budget only trimmed its margin beneath", async () => {
  const { fill, reads } = ancestorFill({
    8: { blocks: [1, 2], cut: true, clipped: false },
    7: { blocks: [0], cut: false, clipped: false },
  });
  const beneath = await fill.loadBeneath([0], "k", () => true);
  expect(beneath?.index).toBe(1);
  expect(reads).toEqual([8]);
});

it("skips a parent whose budget cut into the view for the next coarser", async () => {
  const { fill, reads } = ancestorFill({
    8: { blocks: [1, 2], cut: true, clipped: true },
    7: { blocks: [0], cut: false, clipped: false },
  });
  const beneath = await fill.loadBeneath([0], "k", () => true);
  expect(beneath?.index).toBe(2);
  expect(reads).toEqual([7]);
});

it("keeps every level's blocks past the two on screen and beneath, within the bound", async () => {
  const { fill } = ancestorFill({
    8: { blocks: [0], cut: false, clipped: false },
    7: { blocks: [0], cut: false, clipped: false },
  });
  // order 9 on screen over order 7, from an earlier view
  for (const index of [0, 2]) {
    fill.keep(index, "k", level(index), parts(), []);
  }
  // the parent is now order 8, and then a zoom out to 8: 9 and 7 stay held
  expect((await fill.loadBeneath([0], "k", () => true))?.index).toBe(1);
  selected = 1;
  expect((await fill.loadBeneath([0], "k", () => true))?.index).toBe(2);
  fill.retain([1, 2]);
  for (const index of [0, 1, 2]) {
    expect(fill.take(index, "k", [0]).missing).toEqual([]);
  }
});

it("seeds a window from blocks an earlier, non-overlapping window read", async () => {
  const windows = { 8: { blocks: [0], cut: false, clipped: false } };
  const { fill, blocksRead } = ancestorFill(windows);
  await fill.loadBeneath([0], "k", () => true);
  windows[8] = { blocks: [5], cut: false, clipped: false };
  await fill.loadBeneath([0], "k", () => true);
  // back over block 0: nothing is read, block 0 comes from the cache
  windows[8] = { blocks: [0, 5], cut: false, clipped: false };
  await fill.loadBeneath([0], "k", () => true);
  expect(blocksRead).toEqual([[0], [5], []]);
  const { seed, missing } = fill.take(1, "k", [0, 5, 6]);
  expect(missing).toEqual([6]);
  expect(seed.get(0)!.map(({ range }) => range.start)).toEqual([0, 5 * 4096]);
});

it("misses every block once the field key changes", () => {
  const { fill } = ancestorFill({});
  fill.keep(0, "k", level(0), parts(0, 1), []);
  expect(fill.take(0, "k", [0, 1]).missing).toEqual([]);
  expect(fill.take(0, "other", [0, 1]).missing).toEqual([0, 1]);
  fill.keep(0, "other", level(0), parts(2), []);
  expect(fill.take(0, "k", [0, 1]).missing).toEqual([0, 1]);
});

it("lets the blocks farthest from the camera go past the bound, never the window on screen", () => {
  // 4096 cells cost 48 KiB: room for three blocks
  const { fill } = ancestorFill({}, undefined, 3 * 48 * 1024);
  const store = useGlobeControlStore();
  using blockGrid = new Grid({ scheme: "nested", level: 3 });
  const centre = blockGrid.healpixToLonLat(BigUint64Array.of(0n));
  store.viewFootprint = {
    centreLon: centre[0],
    centreLat: centre[1],
  } as TViewFootprint;
  // blocks of face 0 at order 9: 0 under the camera, 63 the farthest
  fill.keep(0, "k", level(0), parts(0, 1, 2, 63), []);
  // all four are on screen: none goes
  expect(fill.take(0, "k", [0, 1, 2, 63]).missing).toEqual([]);
  // the window moves on to a level beneath; the old one is free to go
  fill.keep(1, "k", level(1), parts(0), []);
  fill.retain([1]);
  // two of order 9's go, the farthest (63) among them, the nearest (0) not
  const { missing } = fill.take(0, "k", [0, 1, 2, 63]);
  expect(missing).toHaveLength(2);
  expect(missing).toContain(63);
  expect(missing).not.toContain(0);
  expect(fill.take(1, "k", [0]).missing).toEqual([]);
});

it("reads the next finer level's blocks ahead into the cache only, for the next zoom to take", async () => {
  const fetched: number[] = [];
  const { fill, reads } = ancestorFill(
    { 9: { blocks: [3, 1, 2], cut: false, clipped: false } },
    undefined,
    undefined,
    async (range) => {
      fetched.push(range.start / 4096);
      return parts(range.start / 4096).get(0)![0];
    }
  );
  // order 8 on screen: order 9 is next finer
  selected = 1;
  fill.keep(0, "k", level(0), parts(1), []);
  expect(await fill.prefetch([0], "k", () => true)).toBe(2);
  // block 1 was held: only 2 and 3 are read, and nothing is drawn
  expect(fetched.sort()).toEqual([2, 3]);
  expect(reads).toEqual([]);
  expect(fill.take(0, "k", [1, 2, 3]).missing).toEqual([]);
  expect(fill.take(0, "other", [2]).missing).toEqual([2]);
});

it("yields the moment a new load starts, and keeps nothing that lands after", async () => {
  const landed: (() => void)[] = [];
  const started: number[] = [];
  let current = true;
  const blocks = Array.from({ length: 20 }, (_, block) => block);
  const { fill } = ancestorFill(
    { 9: { blocks, cut: false, clipped: false } },
    undefined,
    undefined,
    (range) =>
      new Promise((resolve) => {
        started.push(range.start / 4096);
        landed.push(() => resolve(parts(range.start / 4096).get(0)![0]));
      })
  );
  selected = 1;
  const prefetch = fill.prefetch([0], "k", () => current);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const inFlight = started.length;
  expect(inFlight).toBeLessThan(blocks.length);
  // a camera move starts a load: what is in flight lands, unkept
  current = false;
  landed.forEach((land) => land());
  expect(await prefetch).toBe(0);
  expect(started).toHaveLength(inFlight);
  expect(fill.take(0, "k", blocks).missing).toEqual(blocks);
});

it("reads nothing ahead when the next finer level is derived, or under manual picks", async () => {
  const fetchRange = vi.fn(
    async (range: { start: number }) => parts(range.start / 4096).get(0)![0]
  );
  const { fill } = ancestorFill(
    { 9: { blocks: [0], cut: false, clipped: false } },
    undefined,
    undefined,
    fetchRange
  );
  selected = 1;
  finestDerived = true;
  expect(await fill.prefetch([0], "k", () => true)).toBe(0);
  finestDerived = false;
  useGlobeControlStore().levelAuto = false;
  expect(await fill.prefetch([0], "k", () => true)).toBe(0);
  // the finest level on screen has nothing finer
  useGlobeControlStore().levelAuto = true;
  selected = 0;
  expect(await fill.prefetch([0], "k", () => true)).toBe(0);
  expect(fetchRange).not.toHaveBeenCalled();
});
