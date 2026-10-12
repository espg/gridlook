import "@/utils/disposablePolyfill.ts";
import { Grid } from "healpix-geo";
import { createPinia, setActivePinia } from "pinia";
import { expect, it, vi } from "vitest";

import type { TFaceParts } from "@/lib/grids/healpixBlockFetch.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import { useAncestorFill } from "@/ui/grids/composables/useAncestorFill.ts";

vi.stubGlobal("localStorage", { getItem: () => null });

// fine, parent and grandparent orders, finest first
const ORDERS = [9, 8, 7];

// the level on screen
let selected = 0;

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
    })),
  } as unknown as TSources;
}

/** A field over block 0 of a level, as read. */
const parts = () =>
  new Map([[0, [{ range: { start: 0, end: 4096 } }]]]) as unknown as TFaceParts;

/** The fill over the three levels, each level's window as given. */
function ancestorFill(
  windows: Record<number, { blocks: number[]; cut: boolean; clipped: boolean }>,
  onRead?: () => void
) {
  setActivePinia(createPinia());
  selected = 0;
  const reads: number[] = [];
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
    read: async (level) => {
      reads.push(level.grid.level);
      onRead?.();
      return { parts: parts(), batches: [] };
    },
    show: vi.fn(),
    meshes: [],
  });
  return { fill, reads };
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

it("holds two fields at most, the level's and its parent's, from before the parent is read", async () => {
  const counts: number[] = [];
  // a level's field is held when it covers block 0 of the level
  const held = () =>
    ORDERS.filter((_, index) => fill.take(index, "k", [0]).missing.length === 0)
      .length;
  const { fill } = ancestorFill(
    {
      8: { blocks: [0], cut: false, clipped: false },
      7: { blocks: [0], cut: false, clipped: false },
    },
    () => counts.push(held())
  );
  // order 9 on screen over order 7, from an earlier view
  for (const index of [0, 2]) {
    fill.keep(
      index,
      "k",
      { grid: new Grid({ scheme: "nested", level: ORDERS[index] }) },
      parts(),
      []
    );
  }
  expect(held()).toBe(2);
  // the parent is now order 8: order 7 goes before 8 is read
  expect((await fill.loadBeneath([0], "k", () => true))?.index).toBe(1);
  expect(held()).toBe(2);
  // a zoom out to 8, whose own load never lands: 7 is read beneath it, and
  // 9 goes first
  selected = 1;
  expect((await fill.loadBeneath([0], "k", () => true))?.index).toBe(2);
  expect(fill.take(0, "k", [0]).missing).toEqual([0]);
  expect(held()).toBe(2);
  expect(counts).toEqual([1, 1]);
});
