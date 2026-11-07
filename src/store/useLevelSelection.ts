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
  followVariable,
  hasLevels,
  levelHoldsVariable,
  levelOfVariable,
  selectLevel,
} from "@/lib/data/levels.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";

/**
 * Pick a level at most this often while the camera moves, so a zoom swaps
 * levels as it passes them without a pick on every frame.
 */
export const LEVEL_PICK_INTERVAL_MS = 200;

/**
 * A finer level than the shown one is taken only once the camera has stayed
 * this long (a coarser one at once), so zooming out never waits on, or shows,
 * a half-loaded fine level.
 */
const LEVEL_FINER_SETTLE_MS = 350;

export type TViewportSize = { width: number; height: number };

/**
 * Point the dataset and the variables shown at `level`. Variables are keyed
 * by their full path, so the varname (and with it the URL), a hand-picked
 * streamline pair and the volume's variables move to the level's group.
 */
function followLevel(
  store: ReturnType<typeof useGlobeControlStore>,
  sources: TSources | undefined,
  level: number
) {
  if (!sources) {
    return;
  }
  sources.selectedLevel = level;
  // a variable the level lacks keeps its name rather than a missing key
  const move = (name: string) => followVariable(sources.levels, name, level);
  store.varnameSelector = move(store.varnameSelector);
  const selection = store.streamlineSelection;
  if (selection.u && selection.v && move(selection.u) !== selection.u) {
    // set as is: the grid rebuilds its streamlines with the level
    store.streamlineSelection = {
      ...selection,
      u: move(selection.u),
      v: move(selection.v),
    };
  }
  if (
    store.volumeSelections.some(({ variable }) => move(variable) !== variable)
  ) {
    store.volumeSelections = store.volumeSelections.map((selection) => ({
      ...selection,
      variable: move(selection.variable),
    }));
  }
}

/**
 * The level whose cells fit the screen: from the scale the scene measured,
 * or before the first frame from the URL camera, else the globe's fitted
 * one.
 */
function fittingLevel(
  store: ReturnType<typeof useGlobeControlStore>,
  levels: TSources["levels"],
  viewport: TViewportSize,
  cameraAlt: string | undefined
) {
  const altitude = Number(cameraAlt);
  const aspect = viewport.width / Math.max(viewport.height, 1);
  // only the levels that hold the variable shown can be picked
  const held = [...levels.keys()].filter((index) =>
    levelHoldsVariable(levels, store.varnameSelector, index)
  );
  const picked = selectLevel(
    store.metersPerPixel ?? {
      altitudeMeters: Number.isFinite(altitude)
        ? altitude
        : (getGlobeFitCameraDistance(aspect) - 1) * EARTH_RADIUS_METERS,
      viewportHeightPx: viewport.height,
    },
    // no level is too large where the grid loads only the view of it
    held.map((index) =>
      store.loadsLevelByView(index)
        ? { ...levels[index], cellCount: 0 }
        : levels[index]
    ),
    held.indexOf(store.selectedLevel)
  );
  return held[picked] ?? store.selectedLevel;
}

type TLevelStore = ReturnType<typeof useGlobeControlStore>;

/** What makes the automatic pick run again besides the camera. */
function levelWatchKey(store: TLevelStore, sources: TSources | undefined) {
  const levels = sources?.levels ?? [];
  return [
    store.levelAuto,
    store.levelQuality,
    // back on a variable with levels after one without
    hasLevels(levels, store.varnameSelector),
    ...levels.map((_, index) => store.loadsLevelByView(index)),
  ].join();
}

/**
 * `pickLevel` applies the fitting level at once; `pickLevelSettled` is the
 * camera-driven one: a coarser level at once, a finer one only after the
 * camera has rested, so zooming out never shows a half-loaded fine level.
 */
function createLevelPickers(
  store: TLevelStore,
  datasources: Ref<TSources | undefined>,
  getViewport: () => TViewportSize,
  cameraAlt: Ref<string | undefined>
) {
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  function fitting() {
    const levels = datasources.value?.levels;
    if (
      !levels ||
      !hasLevels(levels, store.varnameSelector) ||
      !store.levelAuto
    ) {
      return undefined;
    }
    return {
      levels,
      picked: fittingLevel(store, levels, getViewport(), cameraAlt.value),
    };
  }

  function pickLevel() {
    clearTimeout(settleTimer);
    const fit = fitting();
    if (fit) {
      store.selectLevel(fit.picked, false);
    }
  }

  function pickLevelSettled() {
    clearTimeout(settleTimer);
    const fit = fitting();
    if (!fit) {
      return;
    }
    const shown = fit.levels[store.selectedLevel]?.resolution;
    const next = fit.levels[fit.picked]?.resolution;
    if (shown !== undefined && next !== undefined && next < shown) {
      settleTimer = setTimeout(pickLevel, LEVEL_FINER_SETTLE_MS);
      return;
    }
    store.selectLevel(fit.picked, false);
  }

  return { pickLevel, pickLevelSettled };
}

/**
 * Select the level a full-path varname names (from a link or the presenter),
 * without turning automatic selection off. The dataset reads the level at
 * once, before the switch reaches the watchers.
 */
function selectVariableLevel(
  store: ReturnType<typeof useGlobeControlStore>,
  sources: TSources | undefined,
  varname: string
) {
  const level = sources && levelOfVariable(sources.levels, varname);
  // on the level shown already: keep a pick the store has not applied yet
  if (level === undefined || level === (sources!.selectedLevel ?? 0)) {
    return;
  }
  sources!.selectedLevel = level;
  store.selectLevel(level, false);
}

/**
 * Camera-driven level selection for multi-resolution datasets.
 *
 * The scene writes the ground metres one pixel covers below the camera into
 * the store, in whatever projection is shown; this watches it and, with
 * auto-selection on, writes the level whose cells best fit the screen into
 * the store, also while the camera is moving. `pickLevel` runs the same
 * choice on demand — before the first render, from the URL camera or else
 * the globe's fitted one — so a pyramid never opens on a level the renderer
 * cannot hold.
 *
 * A level switch moves the variables shown onto the new level (see
 * followLevel) and then runs `onLevelChange`; `selectVariableLevel` goes the
 * other way, selecting the level a full-path varname names.
 */
export function useLevelSelection(
  datasources: Ref<TSources | undefined>,
  getViewport: () => TViewportSize,
  onLevelChange?: () => void
) {
  const store = useGlobeControlStore();
  const { paramCameraAlt } = storeToRefs(useUrlParameterStore());

  const { pickLevel, pickLevelSettled } = createLevelPickers(
    store,
    datasources,
    getViewport,
    paramCameraAlt
  );

  watchThrottled(() => store.metersPerPixel, pickLevelSettled, {
    throttle: LEVEL_PICK_INTERVAL_MS,
    trailing: true,
  });
  watch(() => levelWatchKey(store, datasources.value), pickLevel);
  watch(
    () => store.selectedLevel,
    (level) => {
      followLevel(store, datasources.value, level);
      onLevelChange?.();
    }
  );

  return {
    pickLevel,
    selectVariableLevel: (varname: string) =>
      selectVariableLevel(store, datasources.value, varname),
  };
}
