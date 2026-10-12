import { watchThrottled } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { watch, type Ref } from "vue";

import { useUrlParameterStore } from "./paramStore.ts";
import { useGlobeControlStore } from "./store.ts";

import {
  EARTH_RADIUS_METERS,
  getGlobeFitCameraDistance,
} from "@/lib/camera/cameraSettings.ts";
import {
  currentLevel,
  groundMetersPerPixel,
  selectViewLevel,
} from "@/lib/data/levels.ts";
import { digestVariableOf } from "@/lib/digest/digestVariables.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";

/**
 * Pick a level at most this often while the camera moves, so a zoom swaps
 * levels as it passes them without a pick on every frame.
 */
export const LEVEL_PICK_INTERVAL_MS = 200;

export type TViewportSize = { width: number; height: number };

/** Whether the variable shown is derived from a t-digest: priced in bytes. */
function isDigest(datasources: TSources, varname: string) {
  const attrs = currentLevel(datasources).datasources[varname]?.attrs;
  return digestVariableOf(attrs) !== undefined;
}

/** The URL camera's altitude, else the globe's fitted framing. */
function altitudeMeters(viewport: TViewportSize, paramAltitude?: string) {
  const altitude = Number(paramAltitude);
  if (Number.isFinite(altitude)) {
    return altitude;
  }
  const aspect = viewport.width / Math.max(viewport.height, 1);
  return (getGlobeFitCameraDistance(aspect) - 1) * EARTH_RADIUS_METERS;
}

/**
 * Camera-driven level selection for multi-resolution datasets.
 *
 * The scene writes the ground metres one pixel covers below the camera into
 * the store, in whatever projection is shown; this watches it and, with
 * auto-selection on, writes the finest level whose cells are not sub-pixel
 * and whose window fits its budget into the store, also while the camera is
 * moving. `pickLevel` runs the same
 * choice on demand — before the first render, from the URL camera or else
 * the globe's fitted one — so a pyramid never opens on a level the renderer
 * cannot hold.
 */
export function useLevelSelection(
  datasources: Ref<TSources | undefined>,
  getViewport: () => TViewportSize
) {
  const store = useGlobeControlStore();
  const { paramCameraAlt } = storeToRefs(useUrlParameterStore());

  function pickLevel() {
    const levels = datasources.value?.levels;
    if (!levels || levels.length < 2 || !store.levelAuto) {
      return;
    }
    const viewport = getViewport();
    const next = selectViewLevel(
      store.metersPerPixel ??
        groundMetersPerPixel({
          altitudeMeters: altitudeMeters(viewport, paramCameraAlt.value),
          viewportHeightPx: viewport.height,
        }),
      viewport.width * viewport.height,
      levels.map((level, index) => ({
        resolution: level.resolution,
        cellCount: level.cellCount,
        derived: level.derived,
        byView: store.loadsLevelByView(index),
      })),
      store.selectedLevel,
      { digest: isDigest(datasources.value!, store.varnameSelector) }
    );
    store.selectLevel(next, false);
  }

  watchThrottled(() => store.metersPerPixel, pickLevel, {
    throttle: LEVEL_PICK_INTERVAL_MS,
  });
  watch(
    () => [
      store.varnameSelector,
      store.levelAuto,
      ...(datasources.value?.levels ?? []).map((_, index) =>
        store.loadsLevelByView(index)
      ),
    ],
    pickLevel
  );

  return { pickLevel };
}
