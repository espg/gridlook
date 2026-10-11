import "@/utils/disposablePolyfill.ts";
import { Grid, type GridOptions } from "healpix-geo";
import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { effectScope, reactive, watch } from "vue";

import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

type TSource = { dataset: string };
type TLevelSources = {
  levels: { datasources: Record<string, TSource> }[];
  selectedLevel?: number;
};
type TStoredLevel = {
  level: number;
  cells?: number[];
  // a level derived from the chunks of finer cells: its cells per chunk
  derivedChunk?: number;
  // a stored level's cells per chunk (65536 unless given)
  chunk?: number;
  // reads land when the test releases them
  manual?: boolean;
};
type THoverLookup = (
  lat: number,
  lon: number
) => { value: number | null } | null;

const { beforeMount, scene, hover, fetches, stored } = vi.hoisted(() => ({
  beforeMount: [] as (() => Promise<void>)[],
  scene: { current: undefined as THREE.Scene | undefined },
  hover: { lookup: null as THoverLookup | null },
  fetches: [] as {
    dataset: string;
    variable: string;
    start: number;
    stop: number;
    release?: () => void;
  }[],
  // dataset name -> its order, and the cell ids it stores when it is sparse
  stored: {} as Record<string, TStoredLevel>,
}));

const COORDINATE_CHUNK = 65536;
const source = (sources: TLevelSources) =>
  sources.levels[sources.selectedLevel ?? 0].datasources.t;
const cellCount = ({ level, cells }: TStoredLevel) =>
  cells ? cells.length : 12 * 4 ** level;

function describeArray({ dataset }: TSource, variable: string) {
  const level = stored[dataset];
  if (variable === "cell") {
    if (!level.cells) {
      throw new Error("no cell coordinate");
    }
    return { shape: [cellCount(level)], chunks: [COORDINATE_CHUNK], attrs: {} };
  }
  if (variable === "crs") {
    return {
      // eslint-disable-next-line camelcase
      attrs: { healpix_nside: 2 ** level.level, healpix_order: "nest" },
    };
  }
  return {
    shape: [3, cellCount(level)],
    chunks: [1, level.derivedChunk ?? level.chunk ?? 65536],
    attrs: {},
  };
}

vi.stubGlobal("localStorage", { getItem: () => null });
vi.mock("vue", async (original) => ({
  ...(await original<typeof import("vue")>()),
  onBeforeMount: (callback: () => Promise<void>) => beforeMount.push(callback),
  onBeforeUnmount: vi.fn(),
  useSSRContext: () => ({}),
}));
vi.mock("@/ui/common/useLog.ts", () => ({
  useLog: () => ({ logError: vi.fn() }),
}));
vi.mock("@/ui/grids/composables/gridHoverUtils.ts", () => ({
  useGridHoverLookup: () => ({
    clearHoverLookup: () => {
      hover.lookup = null;
    },
    setHoverLookup: (lookup: THoverLookup) => {
      hover.lookup = lookup;
    },
  }),
}));
vi.mock("@/ui/grids/composables/useGridCameraState.ts", () => ({
  useGridCameraState: vi.fn(),
}));
vi.mock("@/ui/grids/composables/useGridScene.ts", async () => {
  const { ref } = await import("vue");
  return {
    useGridScene: () => ({
      getScene: () => scene.current,
      getRenderer: () => undefined,
      redraw: vi.fn(),
      fitCameraToDataset: vi.fn(),
      hoveredGeoPoint: ref(null),
    }),
  };
});
vi.mock("@/ui/grids/composables/useGridOverlays.ts", () => ({
  getLayerRenderOrder: () => 0,
  useGridOverlays: () => ({
    updateLandSeaMask: vi.fn(),
    updateTextureLayers: vi.fn(),
  }),
}));
vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getDimensionNames: async () => ["time", "cell"],
    resolveVariablePath: (_variable: string, name: string) => name,
    getVariableInfo: async (from: TSource, variable: string) =>
      describeArray(from, variable),
    getVariableInfoByDatasetSources: async (
      sources: TLevelSources,
      variable: string
    ) => describeArray(source(sources), variable),
    getCRSInfo: async (sources: TLevelSources) =>
      describeArray(source(sources), "crs"),
    getDggsMetadata: async () => null,
    getDatasetSource: source,
  },
}));
vi.mock("@/lib/data/variableData.ts", () => ({
  getVariableDatasource: source,
  fetchDataVariable: async (_variable: string, sources: TLevelSources) =>
    describeArray(source(sources), "t"),
}));
vi.mock("@/lib/data/dimensionData.ts", () => ({
  fetchDimensionDetails: async () => [],
}));
// A cell's value is its id plus one; the coarse level is negative.
vi.mock("@/lib/grids/gridDataWorkerClient.ts", () => ({
  getGridVariableData: async (request: {
    source: TSource;
    variable: string;
    selection: ({ start: number; stop: number } | null)[];
  }) => {
    const { dataset } = request.source;
    const level = stored[dataset];
    const slice = request.selection.at(-1);
    const start = slice?.start ?? 0;
    const stop = Math.min(slice?.stop ?? cellCount(level), cellCount(level));
    const fetch: (typeof fetches)[number] = {
      dataset,
      variable: request.variable,
      start,
      stop,
    };
    fetches.push(fetch);
    await new Promise<void>((resolve) => {
      if (level.manual) {
        fetch.release = resolve;
      } else {
        setTimeout(resolve, 1);
      }
    });
    const id = (index: number) => level.cells?.[index] ?? index;
    return request.variable === "cell"
      ? Float64Array.from({ length: stop - start }, (_, i) => id(start + i))
      : Float32Array.from(
          { length: stop - start },
          (_, i) => (dataset === "coarse" ? -1 : 1) * (id(start + i) + 1)
        );
  },
  terminateGridDataWorker: vi.fn(),
}));
// The worker's build, run in place.
vi.mock("@/lib/grids/healpixWorkerClient.ts", async () => {
  const healpix = await import("healpix-geo");
  const { buildHealpixGeometry, buildHealpixTexture } =
    await import("@/lib/grids/healpixCalculations.ts");
  const { ProjectionHelper } =
    await import("@/lib/projection/projectionUtils.ts");
  return {
    terminateHealpixWorker: vi.fn(),
    buildHealpixFace: async (request: {
      grid: GridOptions;
      faceIndex: number;
      data: Float32Array;
      cells?: number[];
      projectionType: ConstructorParameters<typeof ProjectionHelper>[0];
      projectionCenter: ConstructorParameters<typeof ProjectionHelper>[1];
    }) => {
      const grid = new healpix.Grid(request.grid);
      if (request.data.length !== (request.cells?.length ?? grid.nside ** 2)) {
        throw new Error("HEALPix data length does not match the grid.");
      }
      const texture = buildHealpixTexture(
        request.data,
        request.faceIndex,
        grid.nside,
        request.cells
      );
      return {
        batchIndex: request.faceIndex,
        ...buildHealpixGeometry(
          grid.replace({ level: 0, scheme: "nested" }),
          BigInt(request.faceIndex),
          9,
          new ProjectionHelper(
            request.projectionType,
            request.projectionCenter
          ),
          texture.dataRect
        ),
        ...texture,
      };
    },
  };
});

const { createPinia, setActivePinia } = await import("pinia");
const { DEFAULT_MAX_VIEW_CELLS } = await import("@/lib/data/levels.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: Healpix } = await import("@/ui/grids/Healpix.vue");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(lat: number, lon: number) {
  beforeMount.length = 0;
  fetches.length = 0;
  hover.lookup = null;
  setActivePinia(createPinia());
  const store = useGlobeControlStore();
  store.varnameSelector = "t";
  // these tests draw the coarsest level beneath, which is opt-in
  store.setLevelBackdrop(true);
  store.viewFootprint = {
    latMin: lat - 1,
    latMax: lat + 1,
    lonStart: lon - 1,
    lonSpan: 2,
    centreLat: lat,
    centreLon: lon,
  };
  scene.current = new THREE.Scene();
  const from = (dataset: string) => ({ store: "s.zarr", dataset });
  const sources = reactive({
    zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
    selectedLevel: 0,
    levels: ["fine", "coarse"].map((name) => ({
      grid: from(name),
      time: from(name),
      datasources: { t: from(name) },
      resolution: 6_500_000 / 2 ** stored[name].level,
      ...(stored[name].derivedChunk
        ? { derived: { dataset: "leaves", refinement: 2 } }
        : {}),
    })),
  }) as unknown as TSources;
  const scope = effectScope();
  scope.run(() => {
    watch(
      () => store.varinfo?.bounds,
      (bounds) => bounds && store.updateBounds(bounds)
    );
    Healpix.setup!(
      { datasources: sources },
      { expose: vi.fn(), attrs: {}, slots: {}, emit: vi.fn() }
    );
  });
  await beforeMount[0]();
  return { store, sources, scope };
}

function cellAt(level: number, lat: number, lon: number) {
  using grid = new Grid({ scheme: "nested", level });
  return Number(grid.lonLatToHealpix(Float64Array.of(lon, lat))[0]);
}

function fetchedCells(variable: string) {
  let cells = 0;
  for (const fetch of fetches) {
    if (fetch.dataset === "fine" && fetch.variable === variable) {
      cells += fetch.stop - fetch.start;
    }
  }
  return cells;
}

it("loads the blocks in view of a dense level over the coarsest level", async () => {
  stored.fine = { level: 9 };
  stored.coarse = { level: 3 };
  const { store, sources, scope } = await mount(11, 31);

  // a few blocks of the 3.1M cells, and the coarse level whole
  expect(fetchedCells("t")).toBeGreaterThan(0);
  expect(fetchedCells("t")).toBeLessThanOrEqual(DEFAULT_MAX_VIEW_CELLS / 4);
  expect(store.viewLoading).toBe(true);
  const meshes = scene.current!.children as THREE.Mesh[];
  expect(meshes.some((mesh) => mesh.renderOrder === -0.5)).toBe(true);
  expect(store.varinfo!.bounds.high).toBeLessThan(0);

  // hover reads the fine cell in view, and no cell where nothing is loaded
  expect(hover.lookup!(11, 31)!.value).toBe(cellAt(9, 11, 31) + 1);
  expect(hover.lookup!(-40, 170)?.value ?? null).toBeNull();

  // a view elsewhere loads its own blocks in place
  store.viewFootprint = {
    latMin: -42,
    latMax: -40,
    lonStart: 170,
    lonSpan: 2,
    centreLat: -41,
    centreLon: 171,
  };
  await wait(150);
  expect(hover.lookup!(-41, 171)!.value).toBe(cellAt(9, -41, 171) + 1);

  // the coarsest level is loaded whole, with nothing beneath it
  sources.selectedLevel = 1;
  await wait(150);
  expect(
    (scene.current!.children as THREE.Mesh[]).every(
      (mesh) => mesh.renderOrder === 0
    )
  ).toBe(true);
  expect(hover.lookup!(-41, 171)!.value).toBe(-(cellAt(3, -41, 171) + 1));
  scope.stop();
});

it("loads a derived level by view, one chunk per block, however small", async () => {
  // 12 · 4^6 cells: a stored level of this size is loaded whole
  stored.fine = { level: 6, derivedChunk: 16 };
  stored.coarse = { level: 3 };
  const { store, scope } = await mount(11, 31);

  expect(12 * 4 ** 6).toBeLessThan(DEFAULT_MAX_VIEW_CELLS);
  expect(store.viewLoading).toBe(true);
  expect(store.wholeLevels).toEqual([]);
  // blocks of one chunk (16 cells, an order-4 cell), not of 4^6 cells
  const fine = fetches.filter(({ dataset }) => dataset === "fine");
  expect(fine.length).toBeGreaterThan(0);
  for (const { start, stop } of fine) {
    expect(start % 16).toBe(0);
    expect(stop % 16).toBe(0);
  }
  expect(fetchedCells("t")).toBeLessThan(4 ** 6);
  expect(hover.lookup!(11, 31)!.value).toBe(cellAt(6, 11, 31) + 1);
  expect(hover.lookup!(-40, 170)?.value ?? null).toBeNull();
  scope.stop();
});

it("searches a sorted cell coordinate instead of reading it whole", async () => {
  // order 12 below one order-2 cell: 4^10 stored cells, over the view budget
  // (ids small enough for the float32 values to hold them exactly)
  const parent = 2 * 4 ** 10;
  stored.fine = {
    level: 12,
    cells: Array.from({ length: 4 ** 10 }, (_, index) => parent + index),
  };
  stored.coarse = { level: 3 };
  using parents = new Grid({ scheme: "nested", level: 2 });
  const [lon, lat] = parents.healpixToLonLat(BigUint64Array.of(2n));
  const { store, scope } = await mount(lat, lon);

  expect(store.wholeLevels).toEqual([]);
  expect(fetchedCells("t")).toBeGreaterThan(0);
  expect(fetchedCells("t")).toBeLessThanOrEqual(DEFAULT_MAX_VIEW_CELLS);
  // some coordinate chunks, not all sixteen
  expect(fetchedCells("cell")).toBeLessThan(4 ** 10);
  // a point off the corner the four middle cells share
  expect(hover.lookup!(lat + 0.01, lon + 0.013)!.value).toBe(
    cellAt(12, lat + 0.01, lon + 0.013) + 1
  );
  scope.stop();
});

it("loads a level with an unsorted cell coordinate whole", async () => {
  const cells = Array.from({ length: 4 ** 10 }, (_, index) => index);
  [cells[0], cells[1]] = [cells[1], cells[0]];
  stored.fine = { level: 12, cells };
  stored.coarse = { level: 3 };
  const { store, scope } = await mount(0, 45);

  expect(store.wholeLevels).toEqual([0]);
  expect(fetchedCells("t")).toBe(4 ** 10);
  scope.stop();
});

/** The main meshes drawn (the backdrop is drawn at -0.5). */
function drawnFaces() {
  return (scene.current!.children as THREE.Mesh[]).filter(
    (mesh) => mesh.renderOrder === 0
  );
}

function texels(mesh: THREE.Mesh) {
  const texture = (mesh.material as THREE.ShaderMaterial).uniforms.data
    .value as THREE.DataTexture;
  return Array.from(texture.image.data as Float32Array);
}

/** Let the reads of a dataset land, until none is waiting. */
async function release(dataset: string) {
  for (;;) {
    const waiting = fetches.filter(
      (fetch) => fetch.dataset === dataset && fetch.release
    );
    if (waiting.length === 0) {
      return;
    }
    for (const fetch of waiting) {
      fetch.release!();
      fetch.release = undefined;
    }
    await wait(30);
  }
}

it("draws a window as its blocks land, the block under the camera first", async () => {
  // 256-cell chunks: the window is made of blocks of one chunk
  stored.fine = { level: 9, chunk: 256, manual: true };
  stored.coarse = { level: 3 };
  const mounting = mount(11, 31);
  await wait(200);
  const issued = fetches.filter(({ dataset }) => dataset === "fine");
  // a few reads in flight, the one under the camera first
  expect(issued.length).toBeGreaterThanOrEqual(2);
  expect(issued.length).toBeLessThanOrEqual(8);
  const under = cellAt(9, 11, 31);
  expect(issued[0].start).toBeLessThanOrEqual(under);
  expect(issued[0].stop).toBeGreaterThan(under);
  expect(issued[0].stop - issued[0].start).toBe(256);
  expect(drawnFaces()).toHaveLength(0);

  // the first block lands: its face is drawn with that block alone
  issued[0].release!();
  issued[0].release = undefined;
  await wait(50);
  expect(drawnFaces()).toHaveLength(1);
  const partial = texels(drawnFaces()[0]);
  expect(partial).toHaveLength(256);
  expect(partial.every(Number.isFinite)).toBe(true);
  expect(partial).toContain(under + 1);

  await release("fine");
  await mounting;
  // the window is in: every cell read is drawn (the view straddles faces)
  const whole = drawnFaces().flatMap((mesh) =>
    texels(mesh).filter(Number.isFinite)
  );
  expect(whole.length).toBeGreaterThan(256);
  expect(whole.length).toBe(fetchedCells("t"));
  expect(hover.lookup!(11, 31)!.value).toBe(under + 1);
});

it("stops reading a window the view has left and draws nothing of it", async () => {
  stored.fine = { level: 9, chunk: 256, manual: true };
  stored.coarse = { level: 3 };
  const mounting = mount(11, 31);
  await wait(100);
  const store = useGlobeControlStore();
  const first = new Set(
    fetches.filter(({ dataset }) => dataset === "fine").map((f) => f.start)
  );
  expect(first.size).toBeGreaterThan(0);
  // the view moves on before anything has landed
  store.viewFootprint = {
    latMin: -42,
    latMax: -40,
    lonStart: 170,
    lonSpan: 2,
    centreLat: -41,
    centreLon: 171,
  };
  await wait(50);
  await release("fine");
  await mounting;
  await release("fine");
  await wait(100);
  // nothing more of the first window was read after the view left it: the
  // reads around the first place are those that were already in flight
  const near = (start: number) =>
    Math.floor(start / 4 ** 9) === Math.floor(cellAt(9, 11, 31) / 4 ** 9);
  const stale = fetches.filter(
    ({ dataset, start }) => dataset === "fine" && near(start)
  );
  expect(stale.length).toBeGreaterThan(0);
  expect(stale.every(({ start }) => first.has(start))).toBe(true);
  // and none of it is drawn
  expect(hover.lookup!(11, 31)?.value ?? null).toBeNull();
  expect(hover.lookup!(-41, 171)!.value).toBe(cellAt(9, -41, 171) + 1);
  expect(drawnFaces()).toHaveLength(1);
});
