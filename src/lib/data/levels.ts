import {
  CAMERA_VERTICAL_FOV_DEGREES,
  EARTH_RADIUS_METERS,
} from "@/lib/camera/cameraSettings.ts";
import {
  DIGEST_WINDOW_MARGIN,
  VIEW_WINDOW_MARGIN,
} from "@/lib/grids/healpixWindow.ts";
import type { TSourceLevel, TSources } from "@/lib/types/GlobeTypes.ts";

/**
 * The level every consumer of a dataset reads: `levels[selectedLevel]`, or
 * the first level while nothing has been selected (single-level datasets
 * never select anything, so they keep reading `levels[0]`). An index the
 * list does not have (kept from a dataset with more levels) also reads the
 * first level, the finest.
 */
export function currentLevel(datasources: TSources): TSourceLevel {
  return (
    datasources.levels[datasources.selectedLevel ?? 0] ?? datasources.levels[0]
  );
}

/**
 * Index of the level with the largest cells. Grids that load only the view
 * draw it whole under a finer level and take the colour range from it, so
 * neither changes as the view moves. Undefined for a single level, or when a
 * level does not state its resolution. Never a derived level.
 */
export function coarsestLevel(
  levels: readonly Pick<TSourceLevel, "resolution" | "derived">[]
) {
  let coarsest: number | undefined;
  for (const [index, level] of levels.entries()) {
    if (levels.length < 2 || !(level.resolution! > 0)) {
      return undefined;
    }
    if (level.derived) {
      // computed from the leaves: never loaded whole
      continue;
    }
    if (
      coarsest === undefined ||
      level.resolution! > levels[coarsest].resolution!
    ) {
      coarsest = index;
    }
  }
  return coarsest;
}

/**
 * Indices of the stored levels coarser than `levels[index]`, the finest
 * first: the ladder a level loaded by view is filled from beneath. A derived
 * level is skipped: its window reads the same leaf chunks as the level's own
 * and would show nothing sooner. Empty when a resolution is unknown.
 */
export function coarserLevels(
  levels: readonly Pick<TSourceLevel, "resolution" | "derived">[],
  index: number
) {
  const own = levels[index]?.resolution;
  if (!(own! > 0) || levels.some((level) => !(level.resolution! > 0))) {
    return [];
  }
  return levels
    .map((level, at) => ({ level, at }))
    .filter(({ level }) => !level.derived && level.resolution! > own!)
    .sort((a, b) => a.level.resolution! - b.level.resolution!)
    .map(({ at }) => at);
}

/** Shown in place of streamlines on a level that cannot be loaded whole. */
export const STREAMLINES_NEED_WHOLE_LEVEL =
  "Streamlines read a whole level, and this one is too large to load whole. Pick a coarser level.";

/**
 * The least a cell of a stored level may span on screen, in pixels, for the
 * level to be picked: finer cells than this are wasted on the screen. The
 * finest level over this floor whose window fits its budget is shown.
 */
export const DEFAULT_PIXELS_PER_CELL = 2;

/**
 * The floor for a level derived from leaf chunks: the same as a stored
 * level's, so every level switches on the one pattern. Its window costs a
 * leaf chunk per cell of ground whatever the order derived, so among the
 * derived levels the budget admits at a view the finest over the floor wins.
 */
export const DIGEST_PIXELS_PER_CELL = DEFAULT_PIXELS_PER_CELL;

/**
 * The active level keeps this much slack on both tests, so that a slow zoom
 * across a boundary does not flip the level back and forth.
 */
export const LEVEL_SLACK = 1.5;

/**
 * Finest level the camera may pick on a grid that loads its levels whole, as
 * the number of cells one horizontal slice of the level holds (`cellCount`: the length of a HEALPix level's
 * `cell` dimension, however sparse, or `nlat · nlon` on a regular grid). Every
 * timestep of a variable fetches and decodes that many values into Float32
 * (about 50 MB at this cap), and a dense global HEALPix level builds textures
 * of the same size; a level above it is only ever reached by a manual pick.
 */
export const DEFAULT_MAX_LEVEL_CELLS = 12 * 4 ** 10;

/**
 * A level with more cells than this is loaded as a window around the view,
 * reloaded as the camera moves, rather than whole.
 */
export const DEFAULT_VIEW_LOAD_CELLS = 12 * 4 ** 8;

/**
 * Cells one such window holds at most: the window is shrunk to this many
 * when a level picked by hand is too fine for the view. Generous on purpose
 * (espg, 2026-10-11): a level finer than the zoom asks for is a deliberate
 * pick, and the picker never lands there on its own.
 */
export const DEFAULT_MAX_VIEW_CELLS = 12 * 4 ** 9;

/**
 * Bytes one window of a variable derived from a t-digest may read. Such a
 * variable's cells cost kilobytes where a stored value costs bytes, so its
 * window is priced in bytes, not cells, and cut around the view's centre;
 * the cells left out are reported so that the user can zoom in or pick a
 * coarser level. The digests are decoded into one value per cell and let
 * go, so the budget bounds transfer and decode time, not memory: a gigabyte
 * is a few tens of seconds on a fast link.
 */
export const DEFAULT_VIEW_BUDGET_BYTES = 1024 * 2 ** 20;

/**
 * Bytes of one leaf chunk's signal digest, what a level derived from leaf
 * chunks costs per chunk whatever the order derived (noise is 120 KB).
 */
export const DIGEST_CHUNK_BYTES = 34 * 1024;

/**
 * Bytes a cell of a stored digest level costs, as listed on the ATL03 v3
 * store: 1.7 KB at order 13 (1.29 GB over 759 000 cells), 2.0 KB at 12
 * (370 MB over 190 000) and about as much above, where a cell holds more
 * photons but its digest is capped. An estimate until the store's chunk
 * index prices each chunk.
 */
export function digestCellBytes(order: number) {
  return order >= 13 ? 1700 : 2000;
}

/**
 * Blocks a window of a digest variable may hold within a byte budget: cells
 * of `cellsPerBlock` on a stored level, leaf chunks on a derived one.
 */
export function digestWindowBlocks(
  level: Pick<TSourceLevel, "derived">,
  order: number,
  cellsPerBlock: number,
  budget = DEFAULT_VIEW_BUDGET_BYTES
) {
  const blockBytes = level.derived
    ? DIGEST_CHUNK_BYTES
    : digestCellBytes(order) * cellsPerBlock;
  return Math.max(Math.floor(budget / blockBytes), 1);
}

/** Leaf orders one zagg leaf chunk spans: 4^6 leaf cells, an order-13 cell. */
const DIGEST_CHUNK_ORDERS = 6;

/** The HEALPix order whose cells have `resolution` metres of side. */
export function healpixOrderOf(resolution: number) {
  return Math.round(
    Math.log2((EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / resolution)
  );
}

export type TLevelSelectionCamera = {
  /** Height of the camera above the globe's surface, metres. */
  altitudeMeters: number;
  viewportHeightPx: number;
  fovDegrees?: number;
};

/**
 * Ground metres covered by one screen pixel at the point of the globe nearest
 * the camera: the vertical field of view spans `2 h tan(fov/2)` at height `h`.
 */
export function groundMetersPerPixel(camera: TLevelSelectionCamera): number {
  const halfFov =
    ((camera.fovDegrees ?? CAMERA_VERTICAL_FOV_DEGREES) * Math.PI) / 360;
  const viewHeight = 2 * Math.max(camera.altitudeMeters, 1) * Math.tan(halfFov);
  return viewHeight / Math.max(camera.viewportHeightPx, 1);
}

/**
 * Cells a level holds: its recorded count, else an upper bound from its
 * resolution alone — a square grid as wide and as tall as the equator,
 * `(2πR / resolution)²`. That over-counts a global lat/lon grid (by 2) and a
 * HEALPix sphere (by π) and matches a WebMercatorQuad zoom level, so an
 * unknown count errs towards keeping a level out of automatic selection.
 */
function estimatedCellCount(
  level: Pick<TSourceLevel, "resolution" | "cellCount">
) {
  if (level.cellCount !== undefined) {
    return level.cellCount;
  }
  return ((2 * Math.PI * EARTH_RADIUS_METERS) / level.resolution!) ** 2;
}

/**
 * Whether a level holds more cells than `maxCells`, the check that keeps it
 * out of automatic selection. A level with neither a count nor a resolution
 * cannot be judged and is not over the cap.
 */
export function exceedsCellCap(
  level: Pick<TSourceLevel, "resolution" | "cellCount">,
  maxCells = DEFAULT_MAX_LEVEL_CELLS
) {
  if (level.cellCount === undefined && !(level.resolution! > 0)) {
    return false;
  }
  return estimatedCellCount(level) > maxCells;
}

/** Cells of a level across the viewport, by area at the scale below the camera. */
export function cellsInView(
  resolution: number,
  metersPerPixel: number,
  viewportPixels: number
) {
  return viewportPixels * (metersPerPixel / resolution) ** 2;
}

/**
 * The cost of a level's window at a view as a fraction of its budget: for a
 * variable derived from a t-digest, bytes against the window budget (per
 * cell on a stored level, per leaf chunk on a derived one); for any other,
 * cells against the view cap. `cells` are the cells in view; the window
 * reaches a margin past the view on every side, and is priced with it.
 */
export function windowCost(
  level: Pick<TSourceLevel, "resolution" | "derived">,
  cells: number,
  digest: boolean,
  budget = DEFAULT_VIEW_BUDGET_BYTES
) {
  const margin = digest ? DIGEST_WINDOW_MARGIN : VIEW_WINDOW_MARGIN;
  cells *= (1 + 2 * margin) ** 2;
  if (!digest) {
    return cells / DEFAULT_MAX_VIEW_CELLS;
  }
  const bytes = level.derived
    ? (cells / 4 ** (DIGEST_CHUNK_ORDERS - level.derived.refinement)) *
      DIGEST_CHUNK_BYTES
    : cells * digestCellBytes(healpixOrderOf(level.resolution!));
  return bytes / budget;
}

/** The coarsest of some levels: the least harmful when nothing fits. */
function coarsestOf<T extends { level: Pick<TSourceLevel, "resolution"> }>(
  candidates: T[]
) {
  let coarsest = candidates[0];
  for (const candidate of candidates) {
    if (candidate.level.resolution! > coarsest.level.resolution!) {
      coarsest = candidate;
    }
  }
  return coarsest;
}

export type TViewLevel = Pick<
  TSourceLevel,
  "resolution" | "cellCount" | "derived"
> & {
  /** Whether the level is loaded as the part in view rather than whole. */
  byView?: boolean;
};

export type TLevelSelectionOptions = {
  /** Whether the variable shown is derived from a t-digest. */
  digest?: boolean;
  pixelFloor?: number;
  derivedPixelFloor?: number;
  budget?: number;
  slack?: number;
};

/**
 * The level a view should render: the finest level whose cells span at least
 * the pixel floor on screen and whose window, the cells in view priced by
 * `windowCost`, fits its budget. A level loaded whole must also be under the
 * whole-level cell cap. The active level keeps `slack` on the floor and the
 * budget so that a slow zoom does not flip it. With nothing eligible the
 * coarsest level is the least harmful. Returns the index into `levels`;
 * `active` when there is nothing to choose from (fewer than two levels, or
 * levels without a resolution).
 */
export function selectViewLevel(
  metersPerPixel: number,
  viewportPixels: number,
  levels: readonly TViewLevel[],
  active: number,
  options: TLevelSelectionOptions = {}
): number {
  const candidates = levels
    .map((level, index) => ({ level, index }))
    .filter(
      ({ level }) => level.resolution !== undefined && level.resolution > 0
    );
  if (levels.length < 2 || candidates.length !== levels.length) {
    return active;
  }
  const slack = options.slack ?? LEVEL_SLACK;
  const eligible = ({ level, index }: (typeof candidates)[number]) => {
    const give = index === active ? slack : 1;
    const floor = level.derived
      ? (options.derivedPixelFloor ?? DIGEST_PIXELS_PER_CELL)
      : (options.pixelFloor ?? DEFAULT_PIXELS_PER_CELL);
    const cells = cellsInView(
      level.resolution!,
      metersPerPixel,
      viewportPixels
    );
    return (
      level.resolution! / metersPerPixel >= floor / give &&
      windowCost(level, cells, options.digest ?? false, options.budget) <=
        give &&
      (level.byView || !exceedsCellCap(level))
    );
  };
  let pick: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    if (
      eligible(candidate) &&
      (!pick || candidate.level.resolution! < pick.level.resolution!)
    ) {
      pick = candidate;
    }
  }
  return (pick ?? coarsestOf(candidates)).index;
}
