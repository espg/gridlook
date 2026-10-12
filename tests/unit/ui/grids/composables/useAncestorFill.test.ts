import "@/utils/disposablePolyfill.ts";
import { Grid } from "healpix-geo";
import { createPinia, setActivePinia } from "pinia";
import { expect, it, vi } from "vitest";

import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import { useAncestorFill } from "@/ui/grids/composables/useAncestorFill.ts";

vi.stubGlobal("localStorage", { getItem: () => null });

// fine, parent and grandparent orders, finest first
const ORDERS = [9, 8, 7];

function sources(): TSources {
  const from = (dataset: string) => ({ store: "s.zarr", dataset });
  return {
    zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
    selectedLevel: 0,
    levels: ORDERS.map((order) => ({
      name: `order ${order}`,
      grid: from(`${order}`),
      time: from(`${order}`),
      datasources: { t: from(`${order}`) },
      resolution: 6_500_000 / 2 ** order,
    })),
  } as unknown as TSources;
}

/** The fill over the three levels, each level's window as given. */
function ancestorFill(
  windows: Record<number, { blocks: number[]; cut: boolean; clipped: boolean }>
) {
  setActivePinia(createPinia());
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
      return { parts: new Map(), batches: [] };
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
