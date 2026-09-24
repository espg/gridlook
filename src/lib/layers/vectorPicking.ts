// Data-space picking for GeoJSON vector layers: the scene raycaster already
// inverts the pointer to lat/lon (useGridScene's hoveredGeoPoint), so feature
// lookup is a point-in-polygon test over the source FeatureCollection. This
// stays correct across projection switches, where the fill meshes' CPU-side
// positions are stale (only shader uniforms update on projection change).
// The even-odd test runs on the same planar rings the fill is triangulated
// from (planarFillRings: edge-by-edge unwrapped, pole-augmented), so a feature
// picks exactly where its fill is drawn.

import type { Feature, FeatureCollection, Position } from "geojson";

import { unwrapLongitude } from "./geojson.ts";
import { planarFillRings } from "./geojsonPolygons.ts";

type TPickPolygon = {
  featureIndex: number;
  // the pole the outer ring encloses, if any; that point lies on the planar
  // contour's polar edge, so it is matched explicitly
  pole: number | null;
  // outer contour then holes, longitudes pre-unwrapped
  rings: number[][][];
  // query longitudes unwrap against this before the even-odd test
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
  const planar = planarFillRings(rings as number[][][]);
  if (!planar) {
    return null;
  }
  const contour = planar[0];
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of contour) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return {
    featureIndex,
    // a pole-augmented contour is the only way a vertex reaches +/-90
    pole: contour.find(([, lat]) => Math.abs(lat) === 90)?.[1] ?? null,
    rings: planar,
    // queries unwrap into the contour's own longitude range
    referenceLon: (minLon + maxLon) / 2,
    minLon,
    maxLon,
    minLat,
    maxLat,
  };
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

// even-odd ray cast in unwrapped-longitude space; both `lon` and the ring are
// pre-unwrapped against the polygon's reference longitude
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
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
  if (polygon.pole !== null && lat === polygon.pole) {
    return true;
  }
  const unwrapped = unwrapLongitude(lon, polygon.referenceLon);
  if (
    lat < polygon.minLat ||
    lat > polygon.maxLat ||
    unwrapped < polygon.minLon ||
    unwrapped > polygon.maxLon
  ) {
    return false;
  }
  if (!pointInRing(unwrapped, lat, polygon.rings[0])) {
    return false;
  }
  for (let i = 1; i < polygon.rings.length; i++) {
    if (pointInRing(unwrapped, lat, polygon.rings[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Find the topmost feature containing the given point. Features later in the
 * collection draw on top of earlier ones, so the last match wins.
 *
 * ponytail: every pointer move walks all polygons of the collection, with only
 * the per-polygon lat/lon bbox as a prefilter (the cache holds that bbox list,
 * not a spatial index). A uniform grid or R-tree over the bboxes is the upgrade
 * once collections grow past a few thousand features.
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
  // buildPickIndex emits polygons in feature order, so scanning backwards hits
  // the topmost feature first and can stop there
  for (let i = polygons.length - 1; i >= 0; i--) {
    if (polygonContainsPoint(polygons[i], lat, lon)) {
      return collection.features[polygons[i].featureIndex];
    }
  }
  return null;
}
