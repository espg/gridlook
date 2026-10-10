import { watchThrottled } from "@vueuse/core";
import type * as healpixGeo from "healpix-geo";
import { watch, type Ref, type ShallowRef } from "vue";

import type { THoverGeoPoint } from "./gridHoverUtils.ts";

import { currentLevel } from "@/lib/data/levels.ts";
import { digestCell, levelSource } from "@/lib/digest/digestField.ts";
import { digestStrata, type TDigestProbe } from "@/lib/digest/digestProbe.ts";
import { digestVariableOf } from "@/lib/digest/digestVariables.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

const HOVER_THROTTLE_MS = 80;

/**
 * Feeds the distribution panel with the t-digests of one cell of a nested
 * HEALPix level. A click pins a place: its cell is read (one chunk per
 * stratum, cached) and resolved again at every level that comes on screen.
 * Without a pin, while a variable derived from a digest is displayed, the
 * panel follows the hovered cell from the chunks already decoded; a hover
 * never reads the store. A cell of a derived level shows the pooled digests
 * of its leaf cells.
 */
// eslint-disable-next-line max-lines-per-function
export function useDigestProbe(options: {
  getDatasources: () => TSources | undefined;
  /** The grid of the level on screen. */
  getGrid: () => healpixGeo.Grid | null;
  clickedGeoPoint: Readonly<ShallowRef<THoverGeoPoint | null>>;
  /** The values gap filling gave a cell of the level on screen, if any. */
  getInterpolated: (
    cell: number,
    grid: healpixGeo.Grid
  ) => TDigestProbe["interpolated"];
  /** Changes when the filled cells do. */
  filledRevision: Readonly<Ref<number>>;
}) {
  const store = useGlobeControlStore();
  const { logError } = useLog();
  let revision = 0;

  function level() {
    const sources = options.getDatasources();
    const grid = options.getGrid();
    if (!sources || !grid || grid.scheme !== "nested") {
      return undefined;
    }
    const current = currentLevel(sources);
    const strata = digestStrata(current.datasources, current.derived?.dataset);
    const source = Object.values(current.datasources)[0];
    const from = source && strata.length > 0 && levelSource(current, source);
    return from ? { grid, strata, reader: from.digests } : undefined;
  }

  /** Show the cell at a place; `cachedOnly` reads nothing. */
  async function show(
    place: { lat: number; lon: number },
    pinned: boolean,
    cachedOnly: boolean
  ) {
    const target = level();
    const request = ++revision;
    if (!target) {
      store.setDigestProbe(undefined);
      return;
    }
    const { grid, strata } = target;
    const ids = grid.lonLatToHealpix(
      new Float64Array([
        ProjectionHelper.normalizeLongitude(place.lon),
        place.lat,
      ])
    );
    const cell = Number(ids[0]);
    const centre = grid.healpixToLonLat(ids);
    const reader = await target.reader;
    const digests = await Promise.all(
      strata.map(({ path }) => digestCell(reader, path, cell, cachedOnly))
    );
    if (request !== revision) {
      return;
    }
    if (cachedOnly && digests.every((digest) => digest === undefined)) {
      // nothing of this cell is in memory: keep what is shown
      return;
    }
    store.setDigestProbe({
      lat: centre[1],
      lon: ProjectionHelper.normalizeLongitude(centre[0]),
      cell,
      order: grid.level,
      pinned,
      interpolated: options.getInterpolated(cell, grid),
      strata: strata.map(({ name }, index) => ({
        name,
        digest: digests[index],
      })),
    });
  }

  function showPinned() {
    // without a grid the level is still being read: keep what is shown
    if (store.digestPin && options.getGrid()) {
      show(store.digestPin, true, false).catch((error) =>
        logError(error, "Could not read the cell's distribution")
      );
    }
  }

  watch(options.clickedGeoPoint, (point) => {
    if (point && level()) {
      store.setDigestPin({ lat: point.lat, lon: point.lon });
    }
  });
  // a pinned place is a cell of whatever level is on screen
  watch(
    [() => store.digestPin, options.getGrid, options.filledRevision],
    showPinned,
    { immediate: true }
  );
  watchThrottled(
    () => store.hoveredGridPoint,
    (point) => {
      const sources = options.getDatasources();
      const displayed =
        sources && currentLevel(sources).datasources[store.varnameSelector];
      if (point && !store.digestPin && digestVariableOf(displayed?.attrs)) {
        void show(point, false, true);
      }
    },
    { throttle: HOVER_THROTTLE_MS }
  );
}
