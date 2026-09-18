import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { ORDER_SWAP_SETTLE_MS, useOrderLadder } =
  await import("@/ui/grids/composables/useOrderLadder.ts");
const { hashWithResource } = await import("@/lib/data/orderLadder.ts");

type TStore = ReturnType<typeof useGlobeControlStore>;

const RES0_KM = 6519.6;
function entry(cellOrder: number) {
  return {
    url: `https://hub/gridlook/hive/id${cellOrder}`,
    cell_order: cellOrder, // eslint-disable-line camelcase
    resolution_km: RES0_KM / 2 ** cellOrder, // eslint-disable-line camelcase
  };
}

const CATALOG = {
  type: "gridlook_catalog" as const,
  datasets: [12, 11, 10, 9, 8, 7, 6, 5, 4].map(entry),
};

// Far camera (30 radii, 7.5°, 1000 px) picks order 7; near (1.05 radii) picks 12.
function fakeCamera(distance: number) {
  return { position: { length: () => distance }, fov: 7.5 } as never;
}

function setup(
  overrides: Partial<{
    distance: number;
    source: string;
    inMotion: boolean;
    flat: boolean;
  }> = {}
) {
  const state = {
    distance: 30,
    source: "https://hub/gridlook/hive/id7",
    inMotion: false,
    flat: false,
    ...overrides,
  };
  const swaps: string[] = [];
  const ladder = useOrderLadder({
    getCamera: () => fakeCamera(state.distance),
    getViewportHeightPx: () => 1000,
    getSource: () => state.source,
    isSceneInMotion: () => state.inMotion,
    isFlatProjection: () => state.flat,
    swapSource: (rung) => swaps.push(rung.url),
  });
  return { state, swaps, ...ladder };
}

let store: TStore;

beforeEach(() => {
  setActivePinia(createPinia());
  store = useGlobeControlStore();
  store.catalogData = CATALOG;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useOrderLadder", () => {
  it("keeps the matching order for a resting camera", () => {
    const { updateOrderLOD, swaps } = setup();
    updateOrderLOD();
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS * 2);
    expect(swaps).toEqual([]);
  });

  it("swaps to the finer order once the zoomed-in camera has settled", () => {
    const { state, updateOrderLOD, swaps } = setup();
    state.distance = 1.05;
    updateOrderLOD();
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS - 1);
    expect(swaps).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(swaps).toEqual(["https://hub/gridlook/hive/id12"]);
    // Once swapped, this grid instance is done: no second swap.
    updateOrderLOD();
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS * 2);
    expect(swaps).toHaveLength(1);
  });

  it("waits for the scene to come to rest", () => {
    const { state, updateOrderLOD, swaps } = setup({
      distance: 1.05,
      inMotion: true,
    });
    updateOrderLOD();
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS);
    expect(swaps).toEqual([]);
    state.inMotion = false;
    updateOrderLOD(); // the next render after the motion stops
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS);
    expect(swaps).toEqual(["https://hub/gridlook/hive/id12"]);
  });
});

describe("useOrderLadder guards", () => {
  it("restarts the clock when the pick changes and cancels when it returns", () => {
    const { state, updateOrderLOD, swaps } = setup();
    state.distance = 1.05;
    updateOrderLOD();
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS / 2);
    state.distance = 30; // back to the active order's range
    updateOrderLOD();
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS * 2);
    expect(swaps).toEqual([]);
  });

  it("does nothing when auto-order is off, the projection is flat, or the source is not a rung", () => {
    const off = setup({ distance: 1.05 });
    store.orderAuto = false;
    off.updateOrderLOD();
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS);
    expect(off.swaps).toEqual([]);
    store.orderAuto = true;

    const flat = setup({ distance: 1.05, flat: true });
    flat.updateOrderLOD();
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS);
    expect(flat.swaps).toEqual([]);

    const other = setup({ distance: 1.05, source: "https://elsewhere" });
    other.updateOrderLOD();
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS);
    expect(other.swaps).toEqual([]);
  });

  it("honours a manual pick made while a swap is pending", () => {
    const { state, updateOrderLOD, swaps } = setup();
    state.distance = 1.05;
    updateOrderLOD();
    store.orderAuto = false; // DataInput's manual rung pick
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS);
    expect(swaps).toEqual([]);
  });

  it("needs a ladder of at least two rungs", () => {
    store.catalogData = { type: "gridlook_catalog", datasets: [entry(7)] };
    const { state, updateOrderLOD, swaps } = setup();
    state.distance = 1.05;
    updateOrderLOD();
    vi.advanceTimersByTime(ORDER_SWAP_SETTLE_MS);
    expect(swaps).toEqual([]);
  });
});

describe("hashWithResource", () => {
  it("replaces the resource and keeps every :: parameter", () => {
    expect(
      hashWithResource(
        "#https://hub/gridlook/hive/id7::varname=count::catalog=x",
        "https://hub/gridlook/hive/id8"
      )
    ).toBe("#https://hub/gridlook/hive/id8::varname=count::catalog=x");
    expect(hashWithResource("", "https://a")).toBe("#https://a");
    expect(hashWithResource("#old", "new")).toBe("#new");
  });
});
