// Filled-polygon geometry for GeoJSON vector layers (e.g. zagg shard
// outlines). Rings are densified and triangulated in lat/lon space (Earcut
// via THREE.ShapeUtils); the projection runs in the vertex shader so fills
// track globe <-> flat projection switches without geometry rebuilds.
// Interior triangulation is planar in lat/lon, so very large polygons can
// chord across great circles; at shard/granule scale (a few degrees) this
// is not visible, and densified ring edges keep fill and outline aligned.

import type { Feature, FeatureCollection } from "geojson";
import * as THREE from "three";

import { ProjectionHelper } from "../projection/projectionUtils.ts";

import { densifyGeographicPolyline, unwrapLongitude } from "./geojson.ts";

type TGeometryOptions = {
  radius?: number;
  zOffset?: number;
};

// Non-indexed triangle soup; every vertex also carries the other two corners
// of its triangle so the vertex shader can hide triangles that straddle a
// projection seam (mirrors segmentOtherLatLon on the line builder).
interface GpuPolygonFillBuilder {
  positions: number[];
  latLon: number[];
  triLatLonB: number[];
  triLatLonC: number[];
}

// Densify ring edges and unwrap longitudes against the polygon's first
// vertex so triangulation stays planar even for (non-pre-split) polygons
// crossing the antimeridian. Drops the GeoJSON closing vertex for Earcut.
function prepareRing(ring: number[][], referenceLon: number): number[][] {
  const densified = densifyGeographicPolyline(ring);
  const first = densified[0];
  const last = densified[densified.length - 1];
  if (densified.length > 1 && last[0] === first[0] && last[1] === first[1]) {
    densified.pop();
  }
  return densified
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
    .map(([lon, lat]) => [unwrapLongitude(lon, referenceLon), lat]);
}

function addTriangle(
  corners: number[][],
  helper: ProjectionHelper,
  builder: GpuPolygonFillBuilder,
  radius: number,
  zOffset: number
) {
  for (let i = 0; i < 3; i++) {
    const [lon, lat] = corners[i];
    const [lonB, latB] = corners[(i + 1) % 3];
    const [lonC, latC] = corners[(i + 2) % 3];
    const normalizedLon = ProjectionHelper.normalizeLongitude(lon);
    const [x, y, z] = helper.project(lat, normalizedLon, radius);
    builder.positions.push(x, y, helper.isFlat ? z + zOffset : z);
    builder.latLon.push(lat, normalizedLon);
    builder.triLatLonB.push(latB, ProjectionHelper.normalizeLongitude(lonB));
    builder.triLatLonC.push(latC, ProjectionHelper.normalizeLongitude(lonC));
  }
}

function addPolygonFill(
  rings: number[][][],
  helper: ProjectionHelper,
  builder: GpuPolygonFillBuilder,
  radius: number,
  zOffset: number
) {
  if (rings.length === 0 || rings[0].length < 4) {
    return;
  }
  const referenceLon = ProjectionHelper.normalizeLongitude(rings[0][0][0]);
  const vertices: number[][] = [];
  let contour: THREE.Vector2[] = [];
  const holes: THREE.Vector2[][] = [];
  for (const [ringIndex, ring] of rings.entries()) {
    const prepared = prepareRing(ring, referenceLon);
    if (prepared.length < 3) {
      if (ringIndex === 0) {
        return;
      }
      continue;
    }
    const points = prepared.map(([lon, lat]) => new THREE.Vector2(lon, lat));
    if (ringIndex === 0) {
      contour = points;
    } else {
      holes.push(points);
    }
    vertices.push(...prepared);
  }
  // faces index into the concatenated [contour, ...holes] vertex list
  for (const face of THREE.ShapeUtils.triangulateShape(contour, holes)) {
    addTriangle(
      face.map((index) => vertices[index]),
      helper,
      builder,
      radius,
      zOffset
    );
  }
}

function geojson2gpuPolygonFillGeometry(
  geojson: FeatureCollection,
  helper: ProjectionHelper,
  options?: TGeometryOptions
) {
  const radius = options?.radius ?? 1;
  const zOffset = options?.zOffset ?? 0;
  const builder: GpuPolygonFillBuilder = {
    positions: [],
    latLon: [],
    triLatLonB: [],
    triLatLonC: [],
  };

  for (const feature of geojson.features) {
    if (feature.geometry.type === "Polygon") {
      addPolygonFill(
        feature.geometry.coordinates as number[][][],
        helper,
        builder,
        radius,
        zOffset
      );
    } else if (feature.geometry.type === "MultiPolygon") {
      for (const rings of feature.geometry.coordinates as number[][][][]) {
        addPolygonFill(rings, helper, builder, radius, zOffset);
      }
    }
    // other geometry types are handled by the line path (polygonsToOutlines)
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(builder.positions, 3)
  );
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(builder.latLon, 2)
  );
  geometry.setAttribute(
    "triLatLonB",
    new THREE.Float32BufferAttribute(builder.triLatLonB, 2)
  );
  geometry.setAttribute(
    "triLatLonC",
    new THREE.Float32BufferAttribute(builder.triLatLonC, 2)
  );
  geometry.computeBoundingSphere();
  return geometry;
}

// Convert Polygon/MultiPolygon features to ring outlines so the existing GPU
// line builder can stroke them; other geometries pass through unchanged
// (unknown types keep the line builder's log-and-skip behavior).
function polygonsToOutlines(geojson: FeatureCollection): FeatureCollection {
  const features = geojson.features.map((feature): Feature => {
    if (feature.geometry.type === "Polygon") {
      return {
        ...feature,
        geometry: {
          type: "MultiLineString",
          coordinates: feature.geometry.coordinates,
        },
      };
    }
    if (feature.geometry.type === "MultiPolygon") {
      return {
        ...feature,
        geometry: {
          type: "MultiLineString",
          coordinates: feature.geometry.coordinates.flat(),
        },
      };
    }
    return feature;
  });
  return { ...geojson, features };
}

export { geojson2gpuPolygonFillGeometry, polygonsToOutlines };
