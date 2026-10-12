import "@/utils/disposablePolyfill.ts";
import { Grid } from "healpix-geo";
import { createPinia, setActivePinia } from "pinia";
import { expect, it, vi } from "vitest";
import { effectScope, nextTick, shallowRef } from "vue";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import type { THoverGeoPoint } from "@/ui/grids/composables/gridHoverUtils.ts";

// the cells of each level's digests that are decoded, by dataset
const { inMemory } = vi.hoisted(() => ({
  inMemory: {} as Record<string, Set<number>>,
}));

vi.mock("@vueuse/core", async () => {
  const { watch } = await import("vue");
  return {
    watchThrottled: (
      source: () => unknown,
      callback: (value: unknown) => void
    ) => watch(source, callback),
  };
});
vi.mock("@/ui/common/useLog.ts", () => ({
  useLog: () => ({ logError: vi.fn() }),
}));
vi.mock("@/lib/digest/digestField.ts", () => ({
  levelSource: (_level: unknown, source: { dataset: string }) => ({
    digests: Promise.resolve(source.dataset),
  }),
  digestCell: async (
    dataset: string,
    _path: string,
    cell: number,
    cachedOnly: boolean
  ) =>
    cachedOnly && !inMemory[dataset]?.has(cell)
      ? undefined
      : { chunk: { dataset }, cell },
}));

const { useGlobeControlStore } = await import("@/store/store.ts");
const { useDigestProbe } =
  await import("@/ui/grids/composables/useDigestProbe.ts");

function cellAt(level: number, lat: number, lon: number) {
  using grid = new Grid({ scheme: "nested", level });
  return Number(grid.lonLatToHealpix(Float64Array.of(lon, lat))[0]);
}

const hover = (lat: number, lon: number) => ({
  lat,
  lon,
  value: 1,
  status: "value" as const,
  screenX: 0,
  screenY: 0,
});

/** A level of digests, as the probe reads it. */
function level(dataset: string) {
  return {
    grid: { store: "s.zarr", dataset },
    time: { store: "s.zarr", dataset },
    datasources: {
      t: {
        store: "s.zarr",
        dataset,
        attrs: {
          digest: {
            array: "h_tdigest_signal",
            product: "percentile",
            stratum: "signal",
          },
        },
      },
    },
  };
}

const settle = async () => {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 20));
};

it("follows the cursor from the level beneath when the level on screen is not in memory", async () => {
  setActivePinia(createPinia());
  const store = useGlobeControlStore();
  store.varnameSelector = "t";
  const sources = {
    zarr_format: 3, // eslint-disable-line camelcase
    selectedLevel: 0,
    levels: [level("fine"), level("coarse")],
  } as unknown as TSources;
  const fine = new Grid({ scheme: "nested", level: 10 });
  const coarse = new Grid({ scheme: "nested", level: 9 });
  inMemory.fine = new Set([cellAt(10, -41, 171)]);
  inMemory.coarse = new Set([cellAt(9, 11, 31), cellAt(9, -41, 171)]);
  const scope = effectScope();
  scope.run(() =>
    useDigestProbe({
      getDatasources: () => sources,
      getGrid: () => fine,
      clickedGeoPoint: shallowRef<THoverGeoPoint | null>(null),
      getInterpolated: () => undefined,
      filledRevision: shallowRef(0),
      getBeneath: () => ({
        grid: coarse,
        sources: { ...sources, selectedLevel: 1 },
      }),
    })
  );

  // only the coarse cell is decoded here: the panel shows it, at its order
  store.setHoveredGridPoint(hover(11, 31));
  await settle();
  expect(store.digestProbe?.order).toBe(9);
  expect(store.digestProbe?.cell).toBe(cellAt(9, 11, 31));
  expect(store.digestProbe?.strata[0].digest).toEqual({
    chunk: { dataset: "coarse" },
    cell: cellAt(9, 11, 31),
  });

  // the level on screen comes first where it is in memory
  store.setHoveredGridPoint(hover(-41, 171));
  await settle();
  expect(store.digestProbe?.order).toBe(10);
  expect(store.digestProbe?.cell).toBe(cellAt(10, -41, 171));

  // with neither in memory, what is shown stays
  store.setHoveredGridPoint(hover(60, -100));
  await settle();
  expect(store.digestProbe?.order).toBe(10);
  scope.stop();
});
