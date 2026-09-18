import type * as THREE from "three";

import {
  ladderFromCatalog,
  hashWithResource,
  rungForCamera,
  rungForSource,
  type TLadderRung,
} from "@/lib/data/orderLadder.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import type { TCatalog } from "@/utils/catalog.ts";

/**
 * Wait this long after the last change of pick (and for the scene to come
 * to rest) before swapping the source. Longer than the camera-state URL
 * encode debounce (300 ms) so the swapped-in grid restores the camera the
 * pick was made for.
 */
export const ORDER_SWAP_SETTLE_MS = 450;

type TOrderLadderOptions = {
  getCamera: () => THREE.PerspectiveCamera | undefined;
  getViewportHeightPx: () => number;
  /** The current dataset source (the grid's `levels[0].grid.store`). */
  getSource: () => string | undefined;
  isSceneInMotion: () => boolean;
  /** Auto-order only makes sense on the globe: flat projections have no camera distance. */
  isFlatProjection: () => boolean;
  /** Test seam; defaults to swapping the location hash's resource. */
  swapSource?: (rung: TLadderRung) => void;
};

function swapHashResource(rung: TLadderRung) {
  location.hash = hashWithResource(location.hash, rung.url);
}

/** The catalog's rungs, recomputed only when the catalog object changes. */
function createLadderCache(getCatalog: () => TCatalog | undefined) {
  let rungsFor: TCatalog | undefined = undefined;
  let rungs: TLadderRung[] = [];
  return () => {
    const catalog = getCatalog();
    if (catalog !== rungsFor) {
      rungsFor = catalog;
      rungs = ladderFromCatalog(catalog);
    }
    return rungs;
  };
}

/**
 * Holds one pending swap: it fires after the pick has held for the settle
 * time with the scene at rest; a changed pick restarts the clock, and an
 * unchanged pick leaves it running.
 */
function createSwapScheduler(
  options: TOrderLadderOptions,
  swapSource: (rung: TLadderRung) => void,
  canSwap: () => boolean
) {
  let pending: ReturnType<typeof setTimeout> | undefined = undefined;
  let pendingRung: TLadderRung | undefined = undefined;

  function cancel() {
    if (pending !== undefined) {
      clearTimeout(pending);
      pending = undefined;
    }
    pendingRung = undefined;
  }

  function request(rung: TLadderRung) {
    if (pending !== undefined && pendingRung === rung) {
      return;
    }
    cancel();
    pendingRung = rung;
    pending = setTimeout(() => {
      pending = undefined;
      pendingRung = undefined;
      // Still moving: the next render re-requests once the motion stops.
      if (!options.isSceneInMotion() && canSwap()) {
        swapSource(rung);
      }
    }, ORDER_SWAP_SETTLE_MS);
  }

  return { request, cancel };
}

/**
 * Camera-driven order selection (gridlook#10 phase 2). `updateOrderLOD` is
 * meant for the scene's per-render LOD hook: it is cheap (a handful of
 * comparisons), and it only ever schedules a swap — the swap itself waits
 * for the scene to rest and for the pick to hold, then drives the same
 * catalog-switch seam a manual pick uses (the hash resource), so every
 * consumer of `levels[0]` stays untouched and the manual picker keeps working.
 */
export function useOrderLadder(options: TOrderLadderOptions) {
  const store = useGlobeControlStore();
  const ladder = createLadderCache(() => store.catalogData);
  let swapped = false; // this grid instance is being replaced: swap once
  const scheduler = createSwapScheduler(
    options,
    (rung) => {
      swapped = true;
      (options.swapSource ?? swapHashResource)(rung);
    },
    () => store.orderAuto && !swapped
  );

  function updateOrderLOD() {
    if (!store.orderAuto || swapped || options.isFlatProjection()) {
      scheduler.cancel();
      return;
    }
    const rungs = ladder();
    const active = rungForSource(rungs, options.getSource());
    const camera = options.getCamera();
    if (rungs.length < 2 || !active || !camera) {
      return;
    }
    const pick = rungForCamera(
      rungs,
      {
        distance: camera.position.length(),
        fovDegrees: camera.fov,
        viewportHeightPx: options.getViewportHeightPx(),
      },
      active
    );
    if (!pick || pick === active) {
      scheduler.cancel();
      return;
    }
    scheduler.request(pick);
  }

  return { updateOrderLOD, cancelOrderSwap: scheduler.cancel };
}
