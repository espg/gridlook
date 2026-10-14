import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { EARTH_RADIUS_METERS, CAMERA_VERTICAL_FOV_DEGREES } =
  await import("@/lib/camera/cameraSettings.ts");
const { DEPLOYMENT_DEFAULTS } = await import("@/lib/config/deployment.ts");
const { DEFAULT_PIXELS_PER_CELL } = await import("@/lib/data/levels.ts");
const POINT_TIER_PIXELS_PER_CELL = DEPLOYMENT_DEFAULTS.pointTierPixelsPerCell;
const { PROJECTION_TYPES } =
  await import("@/lib/projection/projectionUtils.ts");
const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
const { useUrlParameterStore } = await import("@/store/paramStore.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { LEVEL_PICK_INTERVAL_MS, useLevelSelection } =
  await import("@/store/useLevelSelection.ts");

const VIEWPORT = { width: 1000, height: 1000 };

function resolution(order: number) {
  return (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 2 ** order;
}

function altitudeFor(order: number) {
  const halfFov = (CAMERA_VERTICAL_FOV_DEGREES * Math.PI) / 360;
  return (
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

/** The measured scale at which one cell of `order` spans the target pixels. */
function scaleFor(order: number) {
  return resolution(order) / DEFAULT_PIXELS_PER_CELL;
}

async function nextPick() {
  await nextTick();
  vi.advanceTimersByTime(LEVEL_PICK_INTERVAL_MS);
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("picks the level from the rendered ground scale", async () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  scope.run(() => useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT));
  try {
    store.metersPerPixel = scaleFor(8);
    await nextPick();
    expect(store.selectedLevel).toBe(1);
    expect(store.levelAuto).toBe(true);

    store.metersPerPixel = scaleFor(6);
    await nextPick();
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});

it("switches while the camera keeps moving, once per interval", async () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  scope.run(() => useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT));
  try {
    store.metersPerPixel = scaleFor(8);
    await nextTick();
    expect(store.selectedLevel).toBe(1);

    store.metersPerPixel = scaleFor(6);
    await nextTick();
    vi.advanceTimersByTime(LEVEL_PICK_INTERVAL_MS / 2);
    expect(store.selectedLevel).toBe(1);
    vi.advanceTimersByTime(LEVEL_PICK_INTERVAL_MS / 2);
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});

it("keeps a manual pick until automatic selection is re-enabled", async () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  scope.run(() => useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT));
  try {
    store.selectLevel(0);
    store.metersPerPixel = scaleFor(6);
    await nextPick();
    expect(store.selectedLevel).toBe(0);

    store.setLevelAuto(true);
    await nextTick();
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});

it("picks on flat projections too, and leaves single-level datasets alone", async () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  scope.run(() => useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT));
  try {
    store.projectionMode = PROJECTION_TYPES.ROBINSON;
    store.metersPerPixel = scaleFor(6);
    await nextPick();
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }

  const single = effectScope();
  const singleLevel = single.run(() =>
    useLevelSelection(pyramid([10]), () => VIEWPORT)
  )!;
  try {
    store.selectLevel(0, false);
    singleLevel.pickLevel();
    expect(store.selectedLevel).toBe(0);
  } finally {
    single.stop();
  }
});

it("picks from the URL camera before the first frame is rendered", () => {
  const store = useGlobeControlStore();
  useUrlParameterStore().paramCameraAlt = String(altitudeFor(6));
  const scope = effectScope();
  const { pickLevel } = scope.run(() =>
    useLevelSelection(pyramid([10, 8, 6]), () => VIEWPORT)
  )!;
  try {
    pickLevel();
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});

it("picks from the globe's fitted framing before the URL has a camera", () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  const { pickLevel } = scope.run(() =>
    useLevelSelection(pyramid([12, 10, 8, 5]), () => VIEWPORT)
  )!;
  try {
    pickLevel();
    // A square 1000 px viewport frames the globe ~15 radii up: order-5 cells
    // are about 16 pixels there and order-8 about 2, so the 2 px target picks
    // order 8; order 12 is over the renderer's cap anyway.
    expect(store.selectedLevel).toBe(2);
  } finally {
    scope.stop();
  }
});

it("lifts the cap for levels loaded by view, not for one that is loaded whole", async () => {
  const store = useGlobeControlStore();
  const scope = effectScope();
  // order 12 holds 201M cells: far over the whole-level cap
  scope.run(() => useLevelSelection(pyramid([12, 10, 8]), () => VIEWPORT));
  try {
    store.metersPerPixel = scaleFor(12);
    await nextPick();
    expect(store.selectedLevel).toBe(1);

    // the grid reports that it loads only the view: order 12 is in reach
    store.viewLoading = true;
    await nextTick();
    expect(store.selectedLevel).toBe(0);

    // order 12 turns out to need loading whole: the pick settles on order 10
    // and does not return while the grid still loads the others by view
    store.wholeLevels = [0];
    await nextTick();
    expect(store.selectedLevel).toBe(1);
    store.metersPerPixel = scaleFor(12) * 1.01;
    await nextPick();
    expect(store.selectedLevel).toBe(1);
  } finally {
    scope.stop();
  }
});

/** A hive store's ladder: derived 17..14 over stored 13, a height variable. */
function hivePyramid() {
  const sources = pyramid([17, 16, 15, 14, 13]);
  for (const [index, level] of sources.value.levels.entries()) {
    const order = 17 - index;
    const digest = {
      store: "hive+s",
      dataset: String(order),
      attrs: {
        digest: {
          array: "h_tdigest_signal",
          product: "percentile",
          stratum: "signal",
        },
      },
    };
    Object.assign(level, {
      datasources: {
        count: { store: "hive+s", dataset: String(order), attrs: {} },
        h_percentile_signal: digest, // eslint-disable-line camelcase
      },
      cellCount: 0,
      ...(order > 13
        ? { derived: { dataset: "19", refinement: 19 - order } }
        : {}),
      ...(index === 0 ? { points: "19" } : {}),
    });
  }
  return sources;
}

/** The ground scale at which an order-17 cell spans `pixels`. */
function order17At(pixels: number) {
  return resolution(17) / pixels;
}

it("turns the point tier on past the finest level and off again with hysteresis", async () => {
  const store = useGlobeControlStore();
  store.varnameSelector = "h_percentile_signal";
  store.viewLoading = true;
  const scope = effectScope();
  scope.run(() => useLevelSelection(hivePyramid(), () => VIEWPORT));
  try {
    // over the finest level's floor (8 px), short of the tier's 32
    store.metersPerPixel = order17At(0.8 * POINT_TIER_PIXELS_PER_CELL);
    await nextPick();
    expect(store.selectedLevel).toBe(0);
    expect(store.pointTier).toBe(false);

    store.metersPerPixel = order17At(POINT_TIER_PIXELS_PER_CELL + 1);
    await nextPick();
    expect(store.pointTier).toBe(true);
    expect(store.selectedLevel).toBe(0);
    expect(store.levelAuto).toBe(true);

    // back inside the band: still on; below it: off, the level stays
    store.metersPerPixel = order17At(0.85 * POINT_TIER_PIXELS_PER_CELL);
    await nextPick();
    expect(store.pointTier).toBe(true);
    store.metersPerPixel = order17At(0.76 * POINT_TIER_PIXELS_PER_CELL);
    await nextPick();
    expect(store.pointTier).toBe(false);
    expect(store.selectedLevel).toBe(0);
  } finally {
    scope.stop();
  }
});

it("never shows points on a flat projection or under a stored variable", async () => {
  const store = useGlobeControlStore();
  store.varnameSelector = "h_percentile_signal";
  store.viewLoading = true;
  const scope = effectScope();
  scope.run(() => useLevelSelection(hivePyramid(), () => VIEWPORT));
  try {
    store.metersPerPixel = order17At(200);
    await nextPick();
    expect(store.pointTier).toBe(true);

    store.projectionMode = PROJECTION_TYPES.ROBINSON;
    await nextTick();
    expect(store.pointTier).toBe(false);
    expect(store.selectedLevel).toBe(0);
    store.projectionMode = PROJECTION_TYPES.NEARSIDE_PERSPECTIVE;
    await nextTick();
    expect(store.pointTier).toBe(true);

    store.varnameSelector = "count";
    await nextTick();
    expect(store.pointTier).toBe(false);
    expect(store.selectedLevel).toBe(0);
  } finally {
    scope.stop();
  }
});

it("leaves the points when a level is picked by hand, and returns on auto", async () => {
  const store = useGlobeControlStore();
  store.varnameSelector = "h_percentile_signal";
  store.viewLoading = true;
  const scope = effectScope();
  scope.run(() => useLevelSelection(hivePyramid(), () => VIEWPORT));
  try {
    store.metersPerPixel = order17At(200);
    await nextPick();
    expect(store.pointTier).toBe(true);

    store.selectLevel(2);
    expect(store.pointTier).toBe(false);
    expect(store.levelAuto).toBe(false);
    store.metersPerPixel = order17At(300);
    await nextPick();
    expect(store.pointTier).toBe(false);
    expect(store.selectedLevel).toBe(2);

    // and the points can be picked by hand too
    store.selectPointTier(0);
    expect(store.pointTier).toBe(true);
    expect(store.selectedLevel).toBe(0);
    expect(store.levelAuto).toBe(false);

    store.setLevelAuto(true);
    await nextTick();
    expect(store.pointTier).toBe(true);
    expect(store.selectedLevel).toBe(0);

    // a hand-picked tier ends on a flat projection all the same
    store.selectPointTier(0);
    store.projectionMode = PROJECTION_TYPES.ROBINSON;
    await nextTick();
    expect(store.pointTier).toBe(false);
    expect(store.levelAuto).toBe(false);
    expect(store.selectedLevel).toBe(0);
  } finally {
    scope.stop();
  }
});
