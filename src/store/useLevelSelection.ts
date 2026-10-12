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
  finestLevel,
  groundMetersPerPixel,
  selectPointTier,
  selectViewLevel,
} from "@/lib/data/levels.ts";
import { digestVariableOf } from "@/lib/digest/digestVariables.ts";
import { strataBytesFactor } from "@/lib/digest/strata.ts";
import { pointTierSource } from "@/lib/points/pointSource.ts";
import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils.ts";
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
 * The level the point tier is to be drawn over, or undefined for none: the
 * finest level has a point source under the shown variable, the globe is
 * drawn (a flat projection has no heights), and its cells are large enough
 * on screen, with the hysteresis of the tier already on.
 */
function pointTierLevel(
  store: ReturnType<typeof useGlobeControlStore>,
  levels: TSources["levels"],
  metersPerPixel: number
) {
  const finest = finestLevel(levels);
  const onGlobe =
    store.projectionMode === PROJECTION_TYPES.NEARSIDE_PERSPECTIVE;
  return finest !== undefined &&
    onGlobe &&
    pointTierSource(levels[finest], store.varnameSelector) &&
    selectPointTier(metersPerPixel, levels[finest].resolution!, store.pointTier)
    ? finest
    : undefined;
}

/** The level `selectViewLevel` picks for the view, at the scale given. */
function viewLevel(
  store: ReturnType<typeof useGlobeControlStore>,
  datasources: TSources,
  metersPerPixel: number,
  viewport: TViewportSize
) {
  return selectViewLevel(
    metersPerPixel,
    viewport.width * viewport.height,
    datasources.levels.map((level, index) => ({
      resolution: level.resolution,
      cellCount: level.cellCount,
      derived: level.derived,
      byView: store.loadsLevelByView(index),
    })),
    store.selectedLevel,
    {
      digest: isDigest(datasources, store.varnameSelector),
      strata: strataBytesFactor(store.digestStratum),
    }
  );
}

/**
 * Camera-driven level selection for multi-resolution datasets.
 *
 * The scene writes the ground metres one pixel covers below the camera into
 * the store, in whatever projection is shown; this watches it and, with
 * auto-selection on, writes the finest level whose cells are not sub-pixel
 * and whose window fits its budget into the store, also while the camera is
 * moving; past the finest level the point tier takes over, drawn over it.
 * `pickLevel` runs the same choice on demand — before the first render, from
 * the URL camera or else the globe's fitted one — so a pyramid never opens
 * on a level the renderer cannot hold.
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
    const metersPerPixel =
      store.metersPerPixel ??
      groundMetersPerPixel({
        altitudeMeters: altitudeMeters(viewport, paramCameraAlt.value),
        viewportHeightPx: viewport.height,
      });
    const next = viewLevel(store, datasources.value!, metersPerPixel, viewport);
    const points = pointTierLevel(store, levels, metersPerPixel);
    if (points !== undefined) {
      store.selectPointTier(points, false);
      return;
    }
    store.setPointTier(false);
    store.selectLevel(next, false);
  }

  watchThrottled(() => store.metersPerPixel, pickLevel, {
    throttle: LEVEL_PICK_INTERVAL_MS,
  });
  watch(
    () => [
      store.varnameSelector,
      store.digestStratum,
      store.levelAuto,
      store.projectionMode,
      ...(datasources.value?.levels ?? []).map((_, index) =>
        store.loadsLevelByView(index)
      ),
    ],
    pickLevel
  );

  return { pickLevel };
}
