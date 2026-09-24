import { isLatitudeName, isLongitudeName } from "./coordinateVariables.ts";

import { EARTH_RADIUS_METERS } from "@/lib/camera/cameraSettings.ts";
import type { TDataSource } from "@/lib/types/GlobeTypes.ts";

/**
 * One level of a `multiscales` pyramid: the child group holding it and, when
 * the attributes say so, the ground size of one of its cells in metres.
 */
export type TMultiscaleEntry = {
  path: string;
  resolution?: number;
};

export type TLevelGeometry = {
  resolution?: number;
  cellCount?: number;
};

const WEB_MERCATOR_QUAD = "WebMercatorQuad";
// Ground size of one 256 px WebMercatorQuad tile pixel at zoom 0 (equator).
const WEB_MERCATOR_ZOOM0_METERS_PER_PIXEL = 156543.03392804097;
const METERS_PER_DEGREE = (Math.PI / 180) * EARTH_RADIUS_METERS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metersPerUnit(unit: unknown): number | undefined {
  switch (String(unit ?? "").toLowerCase()) {
    case "degree":
    case "degrees":
    case "degrees_east":
    case "degrees_north":
      return METERS_PER_DEGREE;
    case "m":
    case "meter":
    case "meters":
    case "metre":
    case "metres":
      return 1;
    case "km":
    case "kilometer":
    case "kilometers":
    case "kilometre":
    case "kilometres":
      return 1000;
    default:
      return undefined;
  }
}

/**
 * OME-NGFF: the mean ground size of a cell over the spatial axes of the
 * dataset's `scale` transformation, when every spatial axis has a length unit.
 */
function omeResolution(
  dataset: Record<string, unknown>,
  axes: unknown
): number | undefined {
  const transformations = dataset.coordinateTransformations;
  if (!Array.isArray(transformations) || !Array.isArray(axes)) {
    return undefined;
  }
  const scale = transformations.find(
    (transformation) =>
      isRecord(transformation) &&
      transformation.type === "scale" &&
      Array.isArray(transformation.scale)
  )?.scale as unknown[] | undefined;
  if (!scale) {
    return undefined;
  }
  let sum = 0;
  let count = 0;
  for (let index = 0; index < axes.length; index++) {
    const axis = axes[index];
    if (!isRecord(axis) || axis.type !== "space") {
      continue;
    }
    const factor = metersPerUnit(axis.unit);
    const step = Number(scale[index]);
    if (factor === undefined || !(step > 0)) {
      return undefined;
    }
    sum += step * factor;
    count++;
  }
  return count > 0 ? sum / count : undefined;
}

function omeEntries(multiscale: Record<string, unknown>): TMultiscaleEntry[] {
  const datasets = multiscale.datasets;
  if (!Array.isArray(datasets)) {
    return [];
  }
  return datasets
    .filter(
      (dataset): dataset is Record<string, unknown> =>
        isRecord(dataset) && typeof dataset.path === "string"
    )
    .map((dataset) => ({
      path: dataset.path as string,
      resolution: omeResolution(dataset, multiscale.axes),
    }));
}

/**
 * GeoZarr: one child group per tile matrix listed in `tile_matrix_limits`,
 * finest (highest zoom) first when the matrices are numbered. Only the
 * WebMercatorQuad tile matrix set has a known ground resolution per zoom.
 */
function geoZarrEntries(
  multiscale: Record<string, unknown>
): TMultiscaleEntry[] {
  const limits = multiscale.tile_matrix_limits;
  if (!isRecord(limits)) {
    return [];
  }
  const tileMatrixSet = multiscale.tile_matrix_set;
  const isWebMercator =
    tileMatrixSet === WEB_MERCATOR_QUAD ||
    (isRecord(tileMatrixSet) && tileMatrixSet.id === WEB_MERCATOR_QUAD);
  const ids = Object.keys(limits);
  if (ids.every((id) => /^\d+$/.test(id))) {
    ids.sort((a, b) => Number(b) - Number(a));
  }
  return ids.map((id) => ({
    path: id,
    resolution:
      isWebMercator && /^\d+$/.test(id)
        ? WEB_MERCATOR_ZOOM0_METERS_PER_PIXEL / 2 ** Number(id)
        : undefined,
  }));
}

/**
 * The levels a group's `multiscales` attribute declares, finest first (OME-NGFF
 * orders its datasets that way; GeoZarr tile matrices are sorted by zoom).
 * Groups without the attribute have no levels to declare.
 */
export function parseMultiscales(
  attrs: Record<string, unknown>
): TMultiscaleEntry[] {
  const multiscales = attrs.multiscales;
  const multiscale = Array.isArray(multiscales) ? multiscales[0] : multiscales;
  if (!isRecord(multiscale)) {
    return [];
  }
  const entries = omeEntries(multiscale);
  return entries.length > 0 ? entries : geoZarrEntries(multiscale);
}

function healpixGeometry(nside: number): TLevelGeometry {
  // Every HEALPix cell has the same area, 4π / (12 nside²) steradians.
  return {
    resolution: (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / nside,
    cellCount: 12 * nside * nside,
  };
}

function healpixGeometryFromSources(
  datasources: Record<string, TDataSource>
): TLevelGeometry | undefined {
  for (const source of Object.values(datasources)) {
    const nside = Number(source.attrs?.healpix_nside);
    if (Number.isInteger(nside) && nside > 0) {
      return healpixGeometry(nside);
    }
  }
  for (const source of Object.values(datasources)) {
    const dimensions = source.attrs?.dimensionNames;
    const shape = source.shape;
    if (source.hidden || !Array.isArray(dimensions) || !shape?.length) {
      continue;
    }
    if (!/^cells?$/.test(String(dimensions[dimensions.length - 1]))) {
      continue;
    }
    const nside = Math.sqrt(shape[shape.length - 1] / 12);
    if (Number.isInteger(nside) && nside > 0) {
      return healpixGeometry(nside);
    }
  }
  return undefined;
}

function findAxis(
  datasources: Record<string, TDataSource>,
  matches: (name: string) => boolean
) {
  return Object.keys(datasources).find(
    (name) => matches(name) && datasources[name].shape?.length === 1
  );
}

/**
 * The cell size and cell count of a level whose attributes do not state them,
 * read off its grid: the HEALPix nside (from the CRS variable or a
 * `12 nside²` cell dimension), or the spacing of a one-dimensional longitude
 * coordinate on a regular grid. `readAxis` fetches the first values of a
 * coordinate variable of the level.
 */
export async function levelGeometryFromGrid(
  datasources: Record<string, TDataSource>,
  readAxis: (name: string) => Promise<ArrayLike<number>>
): Promise<TLevelGeometry> {
  const healpix = healpixGeometryFromSources(datasources);
  if (healpix) {
    return healpix;
  }
  const longitudeName = findAxis(datasources, isLongitudeName);
  if (!longitudeName) {
    return {};
  }
  const longitudes = await readAxis(longitudeName);
  const step = Math.abs(Number(longitudes[1]) - Number(longitudes[0]));
  if (longitudes.length < 2 || !(step > 0)) {
    return {};
  }
  const latitudeName = findAxis(datasources, isLatitudeName);
  const latitudeCount = latitudeName
    ? datasources[latitudeName].shape?.[0]
    : undefined;
  const longitudeCount = datasources[longitudeName].shape?.[0];
  return {
    resolution: step * METERS_PER_DEGREE,
    cellCount:
      latitudeCount && longitudeCount
        ? latitudeCount * longitudeCount
        : undefined,
  };
}
