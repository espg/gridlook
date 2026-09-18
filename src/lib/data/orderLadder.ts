/**
 * Zoom-driven order selection for hive pyramid stores (gridlook#10 phase 2).
 *
 * A per-order catalog (`/gridlook/hive/catalog`) lists one entry per
 * MATERIALIZED pyramid level, each carrying `cell_order` and `resolution_km`
 * (mortie's RMS cell spacing at that order). The functions here are pure:
 * they turn such a catalog into a ladder, turn the camera into a ground scale
 * per screen pixel, and pick the rung whose cells best match a target on-screen
 * cell size — with hysteresis so a camera resting near a boundary never
 * oscillates. The ladder is dense (any materialized order is a valid render),
 * so the pick is a nearest-rung choice, never an interpolation.
 */
import type { TCatalog, TCatalogEntry } from "@/utils/catalog.ts";

export type TLadderRung = {
  cellOrder: number;
  resolutionKm: number;
  url: string;
  entry: TCatalogEntry;
};

/** Mean Earth radius (IUGG), km — the globe is rendered as a unit sphere. */
export const EARTH_RADIUS_KM = 6371.0088;

/** Target on-screen size of one cell, in pixels, at the sub-camera point. */
export const DEFAULT_PIXELS_PER_CELL = 2;

/**
 * Hysteresis in orders: a rung replaces the active one only when it fits the
 * target better by at least this margin (in log2 cell-size space, where one
 * order is one unit). 0.5 would mean "never switch before the midpoint plus
 * half an order"; 0.35 keeps the dead band clear of the midpoint while
 * switching before the mismatch reaches a full order.
 */
export const DEFAULT_HYSTERESIS_ORDERS = 0.35;

function isRungEntry(
  entry: TCatalogEntry
): entry is TCatalogEntry & { cell_order: number; resolution_km: number } {
  return (
    typeof entry.cell_order === "number" &&
    Number.isInteger(entry.cell_order) &&
    typeof entry.resolution_km === "number" &&
    entry.resolution_km > 0
  );
}

/**
 * The ladder a catalog describes: its entries carrying a cell order and a
 * resolution, finest first. Entries without both are ordinary datasets, not
 * rungs; a catalog with fewer than two rungs has no ladder to climb.
 */
export function ladderFromCatalog(
  catalog: TCatalog | undefined
): TLadderRung[] {
  if (!catalog) {
    return [];
  }
  const rungs = catalog.datasets.filter(isRungEntry).map((entry) => ({
    cellOrder: entry.cell_order,
    resolutionKm: entry.resolution_km,
    url: entry.url,
    entry,
  }));
  rungs.sort((a, b) => b.cellOrder - a.cellOrder);
  return rungs;
}

function normalizeUrl(url: string) {
  return url.replace(/\/+$/, "");
}

/** The rung whose view URL is the given source, if any. */
export function rungForSource(
  rungs: TLadderRung[],
  src: string | undefined
): TLadderRung | undefined {
  if (!src) {
    return undefined;
  }
  const wanted = normalizeUrl(src);
  return rungs.find((rung) => normalizeUrl(rung.url) === wanted);
}

/**
 * Ground kilometres covered by one screen pixel at the point of the unit
 * globe nearest the camera: the vertical field of view spans
 * `2 (d − 1) tan(fov/2)` globe radii at that surface distance.
 */
export function kmPerPixel(
  cameraDistance: number,
  fovDegrees: number,
  viewportHeightPx: number
): number {
  const surfaceDistance = Math.max(cameraDistance - 1, 1e-6);
  const halfFov = (fovDegrees * Math.PI) / 360;
  const viewHeightRadii = 2 * surfaceDistance * Math.tan(halfFov);
  return (viewHeightRadii / Math.max(viewportHeightPx, 1)) * EARTH_RADIUS_KM;
}

/**
 * Pick the rung to render for a target cell size (km), given the active
 * rung. Distances are measured in orders (log2 of cell size); the active rung
 * keeps its place unless another rung is closer to the target by more than
 * `hysteresis` orders. With no active rung the nearest rung wins outright.
 */
export function pickRung(
  rungs: TLadderRung[],
  targetKm: number,
  active: TLadderRung | undefined,
  hysteresis = DEFAULT_HYSTERESIS_ORDERS
): TLadderRung | undefined {
  if (rungs.length === 0 || !(targetKm > 0)) {
    return active;
  }
  const mismatch = (rung: TLadderRung) =>
    Math.abs(Math.log2(rung.resolutionKm) - Math.log2(targetKm));
  let best = rungs[0];
  for (const rung of rungs) {
    if (mismatch(rung) < mismatch(best)) {
      best = rung;
    }
  }
  if (active === undefined || !rungs.includes(active)) {
    return best;
  }
  return mismatch(best) + hysteresis < mismatch(active) ? best : active;
}

/**
 * The rung a camera should render: cells at least `pixelsPerCell` pixels
 * wide at the sub-camera point, nearest rung, hysteresis against the active
 * one.
 */
export function rungForCamera(
  rungs: TLadderRung[],
  camera: { distance: number; fovDegrees: number; viewportHeightPx: number },
  active: TLadderRung | undefined,
  pixelsPerCell = DEFAULT_PIXELS_PER_CELL,
  hysteresis = DEFAULT_HYSTERESIS_ORDERS
): TLadderRung | undefined {
  const targetKm =
    pixelsPerCell *
    kmPerPixel(camera.distance, camera.fovDegrees, camera.viewportHeightPx);
  return pickRung(rungs, targetKm, active, hysteresis);
}

/**
 * The location hash with its resource (the part before the first `::`)
 * replaced and every `::param=value` kept — a source swap that preserves the
 * variable, colormap, camera, catalog and the rest of the shared state.
 */
export function hashWithResource(hash: string, resource: string): string {
  const [, ...params] = hash.replace(/^#/, "").split("::");
  return "#" + [resource, ...params].join("::");
}
