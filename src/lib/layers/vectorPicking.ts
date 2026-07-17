// Data-space picking for GeoJSON vector layers: the scene raycaster already
// inverts the pointer to lat/lon (useGridScene's hoveredGeoPoint), so feature
// lookup is a point-in-polygon test over the source FeatureCollection. This
// stays correct across projection switches, where the fill meshes' CPU-side
// positions are stale (only shader uniforms update on projection change).
// Longitudes are unwrapped per polygon against its first vertex, mirroring
// the fill triangulation, so antimeridian-crossing polygons pick correctly.

import type { Feature, FeatureCollection, Position } from "geojson";

import { unwrapLongitude } from "./geojson.ts";
import { longitudeWinding } from "./geojsonPolygons.ts";

type TPickPolygon = {
  featureIndex: number;
  rings: Position[][];
  referenceLon: number;
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
};

const pickIndexCache = new WeakMap<FeatureCollection, TPickPolygon[]>();

function buildPickPolygon(
  featureIndex: number,
  rings: Position[][]
): TPickPolygon | null {
  const outer = rings[0];
  if (!outer || outer.length < 4) {
    return null;
  }
  // Mirror the fill's phase-1 guard: a pole-enclosing ring winds ~360 degrees
  // of longitude, so the unwrapped even-odd test doubles back on itself and is
  // undefined there. Such rings render no fill, so picking must skip them too.
  if (Math.abs(longitudeWinding(outer)) >= 359.9) {
    return null;
  }
  const referenceLon = outer[0][0];
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of outer) {
    const unwrapped = unwrapLongitude(lon, referenceLon);
    minLon = Math.min(minLon, unwrapped);
    maxLon = Math.max(maxLon, unwrapped);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return { featureIndex, rings, referenceLon, minLon, maxLon, minLat, maxLat };
}

function buildPickIndex(collection: FeatureCollection): TPickPolygon[] {
  const polygons: TPickPolygon[] = [];
  for (const [featureIndex, feature] of collection.features.entries()) {
    const geometry = feature.geometry;
    const parts =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates
          : [];
    for (const rings of parts) {
      const polygon = buildPickPolygon(featureIndex, rings);
      if (polygon) {
        polygons.push(polygon);
      }
    }
  }
  return polygons;
}

// even-odd ray cast in unwrapped-longitude space; `lon` is pre-unwrapped
// against the polygon's reference longitude
function pointInRing(
  lon: number,
  lat: number,
  ring: Position[],
  referenceLon: number
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = unwrapLongitude(ring[i][0], referenceLon);
    const yi = ring[i][1];
    const xj = unwrapLongitude(ring[j][0], referenceLon);
    const yj = ring[j][1];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonContainsPoint(polygon: TPickPolygon, lat: number, lon: number) {
  const unwrapped = unwrapLongitude(lon, polygon.referenceLon);
  if (
    lat < polygon.minLat ||
    lat > polygon.maxLat ||
    unwrapped < polygon.minLon ||
    unwrapped > polygon.maxLon
  ) {
    return false;
  }
  if (!pointInRing(unwrapped, lat, polygon.rings[0], polygon.referenceLon)) {
    return false;
  }
  for (let i = 1; i < polygon.rings.length; i++) {
    if (pointInRing(unwrapped, lat, polygon.rings[i], polygon.referenceLon)) {
      return false;
    }
  }
  return true;
}

/**
 * Find the topmost feature containing the given point. Features later in the
 * collection draw on top of earlier ones, so the last match wins.
 */
export function findVectorFeatureAtPoint(
  collection: FeatureCollection,
  lat: number,
  lon: number
): Feature | null {
  let polygons = pickIndexCache.get(collection);
  if (!polygons) {
    polygons = buildPickIndex(collection);
    pickIndexCache.set(collection, polygons);
  }
  let matchIndex = -1;
  for (const polygon of polygons) {
    if (
      polygon.featureIndex > matchIndex &&
      polygonContainsPoint(polygon, lat, lon)
    ) {
      matchIndex = polygon.featureIndex;
    }
  }
  return matchIndex === -1 ? null : collection.features[matchIndex];
}
