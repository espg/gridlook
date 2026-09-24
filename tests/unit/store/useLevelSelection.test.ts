import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { EARTH_RADIUS_METERS, CAMERA_VERTICAL_FOV_DEGREES } =
  await import("@/lib/camera/cameraSettings.ts");
const { DEFAULT_PIXELS_PER_CELL } = await import("@/lib/data/levels.ts");
const { PROJECTION_TYPES } =
  await import("@/lib/projection/projectionUtils.ts");
const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
const { useUrlParameterStore } = await import("@/store/paramStore.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { LEVEL_SWAP_SETTLE_MS, useLevelSelection } =
  await import("@/store/useLevelSelection.ts");

const VIEWPORT = { width: 1000, height: 1000 };

function resolution(order: number) {
  return (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 2 ** order;
}

function altitudeFor(order: number) {
  const halfFov = (CAMERA_VERTICAL_FOV_DEGREES * Math.PI) / 360;
  return String(
    (resolution(order) * VIEWPORT.height) /
      (2 * DEFAULT_PIXELS_PER_CELL * Math.tan(halfFov))
  );
}

function pyramid(orders: number[]) {
  return ref({
    zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
    levels: orders.map((order) => ({
      name: String(order),
      grid: { store: "s", dataset: String(order) },
      time: { store: "s", dataset: String(order) },
      datasources: {},
      resolution: resolution(order),
      cellCount: 12 * 4 ** order,
    })),
  });
}

async function settle() {
  await nextTick();
  vi.advanceTimersByTime(LEVEL_SWAP_SETTLE_MS);
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("picks the level from the settled camera altitude", async () => {
  const store = useGlobeControlStore();
  const params = useUrlParameterStore();
  const scope = effectScope();
  scope.run(() => useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT));
  try {
    params.paramCameraAlt = altitudeFor(8);
    await settle();
    expect(store.selectedLevel).toBe(1);
    expect(store.levelAuto).toBe(true);

    params.paramCameraAlt = altitudeFor(6);
    await settle();
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});

it("waits for the camera to rest before switching", async () => {
  const store = useGlobeControlStore();
  const params = useUrlParameterStore();
  const scope = effectScope();
  scope.run(() => useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT));
  try {
    params.paramCameraAlt = altitudeFor(8);
    await nextTick();
    vi.advanceTimersByTime(LEVEL_SWAP_SETTLE_MS / 2);
    expect(store.selectedLevel).toBe(0);
    vi.advanceTimersByTime(LEVEL_SWAP_SETTLE_MS / 2);
    expect(store.selectedLevel).toBe(1);
  } finally {
    scope.stop();
  }
});

it("keeps a manual pick until automatic selection is re-enabled", async () => {
  const store = useGlobeControlStore();
  const params = useUrlParameterStore();
  const scope = effectScope();
  scope.run(() => useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT));
  try {
    store.selectLevel(0);
    params.paramCameraAlt = altitudeFor(6);
    await settle();
    expect(store.selectedLevel).toBe(0);

    store.setLevelAuto(true);
    await nextTick();
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});

it("leaves the level alone on flat projections and single-level datasets", async () => {
  const store = useGlobeControlStore();
  const params = useUrlParameterStore();
  const scope = effectScope();
  const { pickLevel } = scope.run(() =>
    useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT)
  )!;
  try {
    store.projectionMode = PROJECTION_TYPES.MERCATOR;
    params.paramCameraAlt = altitudeFor(6);
    await settle();
    expect(store.selectedLevel).toBe(0);
    pickLevel();
    expect(store.selectedLevel).toBe(0);
  } finally {
    scope.stop();
  }

  const single = effectScope();
  const singleLevel = single.run(() =>
    useLevelSelection(pyramid([10]), () => VIEWPORT)
  )!;
  try {
    store.projectionMode = PROJECTION_TYPES.NEARSIDE_PERSPECTIVE;
    singleLevel.pickLevel();
    expect(store.selectedLevel).toBe(0);
  } finally {
    single.stop();
  }
});

it("picks from the globe's fitted framing before the URL has a camera", () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  const { pickLevel } = scope.run(() =>
    useLevelSelection(pyramid([12, 10, 8, 6]), () => VIEWPORT)
  )!;
  try {
    pickLevel();
    // A square 1000 px viewport frames the globe ~15 radii up: order-8 cells
    // are about two pixels there, and order 12 is over the renderer's cap anyway.
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});
