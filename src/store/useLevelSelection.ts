import { watchThrottled } from "@vueuse/core";
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
 * Pick a level at most this often while the camera moves, so a zoom swaps
 * levels as it passes them without a pick on every frame.
 */
export const LEVEL_PICK_INTERVAL_MS = 200;

export type TViewportSize = { width: number; height: number };

/**
 * Camera-driven level selection for multi-resolution datasets.
 *
 * The scene writes the altitude of every rendered frame into the store; this
 * watches it and, on the globe with auto-selection on, writes the level whose
 * cells best fit the screen into the store, also while the camera is moving.
 * Flat projections have no camera height and keep the loaded level.
 * `pickLevel` runs the same choice on demand — before the first render, from
 * the URL camera or else the fitted one — so a pyramid never opens on a level
 * the renderer cannot hold.
 */
export function useLevelSelection(
  datasources: Ref<TSources | undefined>,
  getViewport: () => TViewportSize
) {
  const store = useGlobeControlStore();
  const { paramCameraAlt } = storeToRefs(useUrlParameterStore());

  function altitudeMeters(viewport: TViewportSize) {
    const altitude = store.cameraAltitude ?? Number(paramCameraAlt.value);
    if (Number.isFinite(altitude)) {
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

  watchThrottled(() => store.cameraAltitude, pickLevel, {
    throttle: LEVEL_PICK_INTERVAL_MS,
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
