import { watchDebounced } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { watch, type Ref } from "vue";

import { useUrlParameterStore } from "./paramStore.ts";
import { useGlobeControlStore } from "./store.ts";

import {
  EARTH_RADIUS_METERS,
  getGlobeFitCameraDistance,
} from "@/lib/camera/cameraSettings.ts";
import { selectLevel } from "@/lib/data/levels.ts";
import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";

/**
 * Wait this long after the settled camera reaches the URL state before
 * picking a level, so a swap happens once per rest and never mid-gesture.
 */
export const LEVEL_SWAP_SETTLE_MS = 450;

export type TViewportSize = { width: number; height: number };

/**
 * Camera-driven level selection for multi-resolution datasets.
 *
 * The scene writes the settled camera to the URL state; this watches that
 * altitude and, on the globe with auto-selection on, writes the level whose
 * cells best fit the screen into the store. Flat projections have no camera
 * height and keep the loaded level. `pickLevel` runs the same choice on
 * demand — before the first render, from the fitted camera when the URL has
 * none — so a pyramid never opens on a level the renderer cannot hold.
 */
export function useLevelSelection(
  datasources: Ref<TSources | undefined>,
  getViewport: () => TViewportSize
) {
  const store = useGlobeControlStore();
  const { paramCameraAlt } = storeToRefs(useUrlParameterStore());

  function altitudeMeters(viewport: TViewportSize) {
    const altitude = Number(paramCameraAlt.value);
    if (paramCameraAlt.value !== undefined && Number.isFinite(altitude)) {
      return altitude;
    }
    const aspect = viewport.width / Math.max(viewport.height, 1);
    return (getGlobeFitCameraDistance(aspect) - 1) * EARTH_RADIUS_METERS;
  }

  function pickLevel() {
    const levels = datasources.value?.levels;
    if (
      !levels ||
      levels.length < 2 ||
      !store.levelAuto ||
      store.projectionMode !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE
    ) {
      return;
    }
    const viewport = getViewport();
    const next = selectLevel(
      {
        altitudeMeters: altitudeMeters(viewport),
        viewportHeightPx: viewport.height,
      },
      levels,
      store.selectedLevel
    );
    store.selectLevel(next, false);
  }

  watchDebounced(paramCameraAlt, pickLevel, {
    debounce: LEVEL_SWAP_SETTLE_MS,
  });
  watch(
    () => store.levelAuto,
    (auto) => {
      if (auto) {
        pickLevel();
      }
    }
  );

  return { pickLevel };
}
