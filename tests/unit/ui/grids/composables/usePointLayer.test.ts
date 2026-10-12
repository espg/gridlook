import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { computed, effectScope, nextTick, shallowRef } from "vue";

import { OBSERVATION_POINT_BUDGET } from "@/lib/points/pointBudget.ts";
import type { TPointChunk } from "@/lib/points/pointChunk.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";

const fake = vi.hoisted(() => ({
  // the window's chunks, in the order the view asks for them
  window: [] as number[],
  chunks: new Map<number, unknown>(),
  // the times sibling's words per chunk; none: the read finds nothing
  times: new Map<number, BigUint64Array>(),
  metadata: new Map<string, object>(),
  // a chunk held back until its gate is opened
  gates: new Map<number, Promise<void>>(),
}));

vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("@/ui/common/useLog.ts", () => ({
  useLog: () => ({ logError: vi.fn() }),
}));
vi.mock("@/lib/grids/healpixWindow.ts", async (original) => ({
  ...(await original<typeof import("@/lib/grids/healpixWindow.ts")>()),
  healpixViewBlocks: () => [...fake.window],
}));
// a chunk "decodes" to the point chunk its digest read returned
vi.mock("@/lib/points/pointChunk.ts", async (original) => ({
  ...(await original<typeof import("@/lib/points/pointChunk.ts")>()),
  decodePointChunk: (digest: unknown) => digest,
}));
vi.mock("@/lib/digest/digestField.ts", async (original) => ({
  ...(await original<typeof import("@/lib/digest/digestField.ts")>()),
  storeReaders: () => ({
    store: {
      get: async (key: string) => {
        const metadata = fake.metadata.get(key);
        return metadata
          ? new TextEncoder().encode(JSON.stringify(metadata))
          : undefined;
      },
    },
    digests: {
      array: async () => ({ chunkCells: 256 }),
      chunk: async (_path: string, index: number) => {
        await fake.gates.get(index);
        return fake.chunks.get(index);
      },
    },
    words: {
      chunk: async (path: string, index: number) => {
        if (!path.endsWith("_times")) {
          return { offsets: new Uint32Array(), words: new BigUint64Array() };
        }
        const words = fake.times.get(index);
        return words && { offsets: new Uint32Array(), words };
      },
    },
  }),
}));

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { usePointLayer } =
  await import("@/ui/grids/composables/usePointLayer.ts");

const R = 6378137;
const ARRAY = "/19/h_tdigest_signal/zarr.json";
const TIMES = "/19/h_tdigest_signal_times/zarr.json";

const sources = {
  zarr_format: 3, // eslint-disable-line camelcase
  levels: [
    {
      grid: { store: "hive+s://points", dataset: "17" },
      time: { store: "hive+s://points", dataset: "17" },
      datasources: {
        h: {
          store: "hive+s://points",
          dataset: "17",
          attrs: {
            digest: {
              array: "h_tdigest_signal",
              product: "percentile",
              stratum: "signal",
            },
          },
        },
      },
      derived: { dataset: "19", refinement: 2 },
    },
  ],
} as unknown as TSources;

/** `count` points at `origin` (a unit vector), at the heights `height(i)`. */
function chunkOf(
  count: number,
  height: (i: number) => number,
  origin: [number, number, number] = [1, 0, 0]
): TPointChunk {
  return {
    count,
    offsets: new Float32Array(3 * count),
    heights: Float32Array.from({ length: count }, (_, i) => height(i)),
    origin,
  };
}

/** A gate on chunk `index`: its read waits until `open()`. */
function hold(index: number) {
  let open = () => {};
  fake.gates.set(
    index,
    new Promise<void>((resolve) => {
      open = resolve;
    })
  );
  return () => open();
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** The digest array's metadata, with a times sibling when `timed`. */
function declareArrays(timed: boolean) {
  fake.metadata.set(ARRAY, {
    attributes: {
      ragged: { locations: "h_tdigest_signal_locations" },
      ...(timed ? { times: "h_tdigest_signal_times" } : {}),
    },
  });
  fake.metadata.set(TIMES, {
    attributes: {
      temporal: {
        spec: "zagg-toc/1",
        shape: "per-centroid",
        grammar: "mortie-toc/1",
      },
    },
  });
}

function setup(timed = false) {
  setActivePinia(createPinia());
  const store = useGlobeControlStore();
  store.varnameSelector = "h";
  store.viewFootprint = {
    centreLat: 0,
    centreLon: 0,
  } as typeof store.viewFootprint;
  declareArrays(timed);
  const scene = new THREE.Scene();
  const pivot = {
    enter: vi.fn(),
    leave: vi.fn(),
    tiltTo: vi.fn(),
    setHeight: vi.fn(),
    setLeftDrag: vi.fn(),
    ground: shallowRef<{ lat: number; lon: number } | null>({ lat: 0, lon: 0 }),
    at: new THREE.Vector3(1, 0, 0),
    direction: () => pivot.at.clone(),
    distance: () => 3000 / R,
  };
  const options = {
    getDatasources: () => sources,
    getScene: () => scene,
    redraw: vi.fn(),
    registerUpdateLOD: vi.fn(),
    onColormapChange: vi.fn(),
    updateColormap: vi.fn(),
    updateHistogram: vi.fn(),
    restoreHistogram: vi.fn(),
    projectionHelper: computed(() => ({ isFlat: false })),
    pointPivot: pivot,
  };
  const scope = effectScope();
  scope.run(() =>
    usePointLayer(options as unknown as Parameters<typeof usePointLayer>[0])
  );
  return { store, scene, pivot, options, scope };
}

/** The drawn points' objects. */
function pointsOf(scene: THREE.Scene) {
  return scene.children.filter(
    (child): child is THREE.Points => child instanceof THREE.Points
  );
}

function drawnCount(scene: THREE.Scene) {
  return pointsOf(scene).reduce(
    (total, points) => total + points.geometry.getAttribute("position").count,
    0
  );
}

afterEach(() => {
  fake.window = [];
  fake.chunks.clear();
  fake.times.clear();
  fake.metadata.clear();
  fake.gates.clear();
});

it("draws nothing a chunk brings in after the tier was left or the window moved on", async () => {
  fake.window = [0, 1];
  fake.chunks.set(
    0,
    chunkOf(10, () => 300)
  );
  fake.chunks.set(
    1,
    chunkOf(10, () => 400)
  );
  const release = hold(1);
  const { store, scene, scope } = setup();
  store.setPointTier(true);
  await settle();
  expect(pointsOf(scene)).toHaveLength(1);
  // left while chunk 1 is on its way
  store.setPointTier(false);
  await nextTick();
  release();
  await settle();
  expect(pointsOf(scene)).toHaveLength(0);
  expect(store.pointTierBounds).toBeUndefined();
  // and a newer window wins over an older one still landing
  const late = hold(1);
  store.setPointTier(true);
  await settle();
  fake.chunks.set(
    2,
    chunkOf(10, () => 500)
  );
  fake.window = [0, 2];
  store.viewFootprint = {
    centreLat: 1,
    centreLon: 0,
  } as typeof store.viewFootprint;
  await settle();
  late();
  await settle();
  const heights = pointsOf(scene).map(
    (points) => points.geometry.getAttribute("height").array[0]
  );
  expect(heights.sort()).toEqual([300, 500]);
  scope.stop();
});

it("keeps the drawn points within the budget as chunks of uneven size land", async () => {
  const sizes = [150_000, 40_000, 90_000, 120_000, 7_000];
  fake.window = sizes.map((_, index) => index);
  const releases = sizes.map((size, index) => {
    fake.chunks.set(
      index,
      chunkOf(size, (i) => i % 500)
    );
    return hold(index);
  });
  const { store, scene, scope } = setup();
  store.setPointTier(true);
  await settle();
  for (const release of releases) {
    release();
    await settle();
    expect(drawnCount(scene)).toBeLessThanOrEqual(OBSERVATION_POINT_BUDGET);
  }
  expect(pointsOf(scene)).toHaveLength(sizes.length);
  expect(store.pointTierStats!.stride).toBe(2);
  scope.stop();
});

it("takes everything down on leaving, and gives the level its histogram back", async () => {
  fake.window = [0, 1, 2];
  for (const index of fake.window) {
    fake.chunks.set(
      index,
      chunkOf(100, (i) => 300 + i)
    );
  }
  const { store, scene, pivot, options, scope } = setup();
  store.setPointTier(true);
  store.userBoundsLow = 310;
  store.userBoundsHigh = 360;
  await settle();
  expect(pivot.enter).toHaveBeenCalledOnce();
  expect(pointsOf(scene)).toHaveLength(3);
  expect(store.pointTierBounds).toBeDefined();
  expect(store.pointTierStats!.loaded).toBe(3);
  pivot.leave.mockClear();
  store.setPointTier(false);
  await nextTick();
  expect(pivot.leave).toHaveBeenCalledOnce();
  expect(pointsOf(scene)).toHaveLength(0);
  expect(store.pointTierStats).toBeUndefined();
  expect(store.pointTierBounds).toBeUndefined();
  expect(options.restoreHistogram).toHaveBeenCalledOnce();
  // a custom range is the user's
  expect([store.userBoundsLow, store.userBoundsHigh]).toEqual([310, 360]);
  scope.stop();
});

it("moves the datum with the pivot, with or without photons in reach", async () => {
  // a valley track at 80 m and, 6 km east, a ridge at 1 000 m
  const ridge: [number, number, number] = [
    Math.cos(6000 / R),
    Math.sin(6000 / R),
    0,
  ];
  fake.window = [0, 1];
  fake.chunks.set(
    0,
    chunkOf(50, (i) => 80 + i / 10)
  );
  fake.chunks.set(
    1,
    chunkOf(50, (i) => 1000 + i / 10, ridge)
  );
  const { store, scene, pivot, scope } = setup();
  store.setPointTier(true);
  await settle();
  const datum = () =>
    (pointsOf(scene)[0].material as THREE.ShaderMaterial).uniforms
      .heightReference.value;
  expect(datum()).toBeCloseTo(80, 0);
  // panned to the ridge: no chunk lands, the datum follows
  pivot.at.set(...ridge);
  pivot.ground.value = { lat: 0, lon: 0.054 };
  await nextTick();
  expect(datum()).toBeCloseTo(1000, 0);
  // between the two, nothing within reach: the window's, never 0
  pivot.at.set(Math.cos(3000 / R), Math.sin(3000 / R), 0);
  pivot.ground.value = { lat: 0, lon: 0.027 };
  await nextTick();
  expect(datum()).toBeCloseTo(80, 0);
  // and leaving forgets it
  const material = pointsOf(scene)[0].material as THREE.ShaderMaterial;
  store.setPointTier(false);
  await nextTick();
  expect(material.uniforms.heightReference.value).toBe(0);
  scope.stop();
});

it("colours by time only with the times at hand, never mixing them with heights", async () => {
  // chunk 0 has its times (days 100..109), chunk 1's read finds none
  fake.window = [0, 1];
  fake.chunks.set(
    0,
    chunkOf(10, (i) => 300 + i)
  );
  fake.chunks.set(
    1,
    chunkOf(10, (i) => 400 + i)
  );
  const epoch = BigInt(Date.UTC(2018, 0, 1) - Date.UTC(1850, 0, 1)) * 1000000n;
  fake.times.set(
    0,
    BigUint64Array.from({ length: 10 }, (_, i) => {
      const ns = epoch + BigInt(100 + i) * 86_400_000_000_000n;
      return ((ns >> 31n) << 32n) | (1n << 31n) | (ns & 0x7fffffffn);
    })
  );
  const { store, scene, scope } = setup(true);
  store.setPointTier(true);
  await settle();
  expect(store.pointTierTimed).toBe(true);
  expect(store.pointTierColouredByTime()).toBe(false);
  expect(store.pointTierBounds!.high).toBeGreaterThan(400);
  store.setPointTierColour("time");
  await settle();
  expect(store.pointTierColouredByTime()).toBe(true);
  // chunk 1 is not drawn in days' company, and the range is days
  expect(pointsOf(scene)).toHaveLength(1);
  expect(store.pointTierBounds!.low).toBeGreaterThan(99);
  expect(store.pointTierBounds!.high).toBeLessThan(110);
  // back to heights: both chunks, in metres
  store.setPointTierColour("height");
  await settle();
  expect(pointsOf(scene)).toHaveLength(2);
  expect(store.pointTierBounds!.high).toBeGreaterThan(400);
  scope.stop();
});

it("falls back to heights on a source without times, and labels them so", async () => {
  fake.window = [0];
  fake.chunks.set(
    0,
    chunkOf(10, (i) => 300 + i)
  );
  const { store, scope } = setup(false);
  store.setPointTierColour("time");
  store.setPointTier(true);
  await settle();
  expect(store.pointTierTimed).toBe(false);
  expect(store.pointTierColour).toBe("height");
  expect(store.pointTierColouredByTime()).toBe(false);
  expect(store.pointTierBounds!.low).toBeGreaterThanOrEqual(300);
  scope.stop();
});
