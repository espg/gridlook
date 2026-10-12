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
 * never reads the store; with nothing of the level on screen in memory at
 * the place, the cell of the level drawn beneath is shown instead. A cell of
 * a derived level shows the pooled digests of its leaf cells.
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
  /** The level drawn beneath the one on screen, if any. */
  getBeneath?: () => { grid: healpixGeo.Grid; sources: TSources } | undefined;
}) {
  const store = useGlobeControlStore();
  const { logError } = useLog();
  let revision = 0;

  function level(sources = options.getDatasources(), grid = options.getGrid()) {
    if (!sources || !grid || grid.scheme !== "nested") {
      return undefined;
    }
    const current = currentLevel(sources);
    const strata = digestStrata(
      current.datasources,
      current.derived?.dataset,
      store.digestStratum
    );
    const source = Object.values(current.datasources)[0];
    const from = source && strata.length > 0 && levelSource(current, source);
    return from ? { grid, strata, reader: from.digests } : undefined;
  }

  /** The digests of a level's cell at a place; `cachedOnly` reads nothing. */
  async function readCell(
    { grid, strata, reader }: NonNullable<ReturnType<typeof level>>,
    place: { lat: number; lon: number },
    cachedOnly: boolean
  ) {
    const ids = grid.lonLatToHealpix(
      new Float64Array([
        ProjectionHelper.normalizeLongitude(place.lon),
        place.lat,
      ])
    );
    const cell = Number(ids[0]);
    const centre = grid.healpixToLonLat(ids);
    const digests = await Promise.all(
      strata.map(async ({ path }) =>
        digestCell(await reader, path, cell, cachedOnly)
      )
    );
    return { grid, strata, cell, centre, digests };
  }

  /**
   * Show the cell at a place; `cachedOnly` reads nothing, and falls back to
   * the level drawn beneath when nothing of the level on screen is in memory.
   */
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
    const beneath = cachedOnly ? options.getBeneath?.() : undefined;
    const targets = [target, beneath && level(beneath.sources, beneath.grid)];
    for (const candidate of targets) {
      if (!candidate) {
        continue;
      }
      const read = await readCell(candidate, place, cachedOnly);
      if (request !== revision) {
        return;
      }
      if (cachedOnly && read.digests.every((digest) => digest === undefined)) {
        // nothing of this cell is in memory: try beneath, or keep what is shown
        continue;
      }
      const { grid, strata, cell, centre, digests } = read;
      store.setDigestProbe({
        lat: centre[1],
        lon: ProjectionHelper.normalizeLongitude(centre[0]),
        cell,
        order: grid.level,
        pinned,
        interpolated:
          candidate === target
            ? options.getInterpolated(cell, grid)
            : undefined,
        strata: strata.map(({ name }, index) => ({
          name,
          digest: digests[index],
        })),
      });
      return;
    }
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
  // a pinned place is a cell of whatever level is on screen; the stratum
  // choice orders the strata shown
  watch(
    [
      () => store.digestPin,
      options.getGrid,
      options.filledRevision,
      () => store.digestStratum,
    ],
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
