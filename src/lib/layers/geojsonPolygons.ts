// Filled-polygon geometry for GeoJSON vector layers. Rings are densified and
// triangulated in lat/lon space (Earcut via THREE.ShapeUtils); the projection
// runs in the vertex shader so fills track globe <-> flat projection switches
// without geometry rebuilds, like the line overlays.
// Longitudes are unwrapped edge by edge, so a ring may span any width up to a
// full turn (antimeridian crossers included) and still be a simple planar
// contour. A ring enclosing a pole (winding ~360 degrees of longitude) is not
// closed in that plane; it is closed by a synthetic edge along the pole
// latitude, which collapses to the pole under projection (see
// poleAugmentedContour). Triangles are then subdivided so every edge stays
// short enough for a flat GPU triangle to hug the sphere.

import * as d3 from "d3-geo";
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
type TGpuPolygonFillBuilder = {
  positions: number[];
  latLon: number[];
  triLatLonB: number[];
  triLatLonC: number[];
  featureIndex: number[];
};

// Densify ring edges and unwrap each longitude against the previous vertex,
// so the ring is a continuous path in the lon/lat plane whatever its width.
// Drops the GeoJSON closing vertex for Earcut.
function prepareRing(ring: number[][]): number[][] {
  const densified = densifyGeographicPolyline(ring);
  const first = densified[0];
  const last = densified[densified.length - 1];
  if (densified.length > 1 && last[0] === first[0] && last[1] === first[1]) {
    densified.pop();
  }
  const prepared: number[][] = [];
  for (const [lon, lat] of densified) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      continue;
    }
    const previous = prepared.length ? prepared[prepared.length - 1][0] : lon;
    prepared.push([unwrapLongitude(lon, previous), lat]);
  }
  return prepared;
}

// Total signed longitude traversed around the closed ring, summing the
// shortest step between consecutive vertices. ~0 for an ordinary ring; ~+/-360
// when the ring encircles a pole.
function longitudeWinding(ring: number[][]): number {
  let winding = 0;
  for (let i = 0; i < ring.length; i++) {
    let step = ring[(i + 1) % ring.length][0] - ring[i][0];
    while (step > 180) {
      step -= 360;
    }
    while (step < -180) {
      step += 360;
    }
    winding += step;
  }
  return winding;
}

// The pole a ring encircles (+90 or -90), or null for an ordinary ring.
// ponytail: a ring winding a full turn of longitude encloses exactly one pole;
// which one is decided by the sign of the mean latitude, which holds for any
// ring that stays in one hemisphere and for the usual polar-basin shapes.
function enclosedPole(ring: number[][]): number | null {
  if (Math.abs(longitudeWinding(ring)) < 359.9) {
    return null;
  }
  let latSum = 0;
  for (const [, lat] of ring) {
    latSum += lat;
  }
  return latSum >= 0 ? 90 : -90;
}

// Close a pole-enclosing ring (already unwrapped edge by edge, so it spans
// exactly one turn between its first vertex and the shifted copy of it) with
// an edge along the pole latitude back to the start. On the sphere that edge
// collapses to the pole, so the fill covers the polar cap and the rim stays
// the densified ring. The fill and the picker share this contour.
// ponytail: the contour is simple as long as the ring never crosses its own
// start meridian again, i.e. stays within one turn.
function poleAugmentedContour(ring: number[][], pole: number): number[][] {
  const start = ring[0];
  const endLon = unwrapLongitude(start[0], ring[ring.length - 1][0]);
  return [...ring, [endLon, start[1]], [endLon, pole], [start[0], pole]];
}

function longitudeRange(ring: number[][]) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lon] of ring) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  return { minLon, maxLon };
}

/**
 * The rings of one polygon in the planar lon/lat frame the fill is built in:
 * the outer contour first (pole-augmented when it encircles a pole), then the
 * holes shifted by whole turns into the contour's longitude range. Null when
 * the outer ring is degenerate. Holes that themselves wind around the pole
 * (an annulus) are dropped, so the fill covers the pole instead.
 */
function planarFillRings(rings: number[][][]): number[][][] | null {
  if (rings.length === 0 || rings[0].length < 4) {
    return null;
  }
  const outer = prepareRing(rings[0]);
  if (outer.length < 3) {
    return null;
  }
  const pole = enclosedPole(outer);
  const contour = pole === null ? outer : poleAugmentedContour(outer, pole);
  const { minLon, maxLon } = longitudeRange(contour);
  const midLon = (minLon + maxLon) / 2;
  const planar = [contour];
  for (const ring of rings.slice(1)) {
    const hole = prepareRing(ring);
    if (hole.length < 3 || enclosedPole(hole) !== null) {
      continue;
    }
    const shift = unwrapLongitude(hole[0][0], midLon) - hole[0][0];
    planar.push(hole.map(([lon, lat]) => [lon + shift, lat]));
  }
  return planar;
}

// Earcut freely connects far-apart contour vertices (and drops the collinear
// polar edge), so a polar cap comes out as slivers spanning most of a turn.
// Triangles wider than this are cut along meridians so the seam test in the
// vertex shader, which needs local triangles, keeps working.
const MAX_TRIANGLE_LON_SPAN = 90;

// Sutherland-Hodgman clip of one planar lon/lat triangle against a meridian at
// its longitude midpoint, recursing until every piece fits the span limit.
// Pieces are convex and boundary-ordered, so a fan triangulates them.
function splitByLongitude(corners: number[][], out: number[][][]) {
  const { minLon, maxLon } = longitudeRange(corners);
  if (maxLon - minLon <= MAX_TRIANGLE_LON_SPAN) {
    out.push(corners);
    return;
  }
  const cut = (minLon + maxLon) / 2;
  const west: number[][] = [];
  const east: number[][] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    if (a[0] <= cut) {
      west.push(a);
    }
    if (a[0] >= cut) {
      east.push(a);
    }
    if ((a[0] - cut) * (b[0] - cut) < 0) {
      const t = (cut - a[0]) / (b[0] - a[0]);
      const crossing = [cut, a[1] + t * (b[1] - a[1])];
      west.push(crossing);
      east.push(crossing);
    }
  }
  for (const piece of [west, east]) {
    for (let i = 1; i + 1 < piece.length; i++) {
      splitByLongitude([piece[0], piece[i], piece[i + 1]], out);
    }
  }
}

// The GPU rasterises a flat triangle between the projected corners, so the
// interior of a wide triangle sags below the sphere: by 1 - cos(r) for a
// circumradius r, which is 4.6e-4 R at r = 1.73 deg (an equilateral 3 deg
// triangle), under the 1e-3 R the fill floats above the globe surface.
// Earcut's interior triangles are far wider than the 2 deg densified edges,
// so they are subdivided to this edge length.
const MAX_TRIANGLE_EDGE_DEGREES = 3;

function angularEdgeDegrees(a: number[], b: number[]) {
  return THREE.MathUtils.radToDeg(d3.geoDistance([a[0], a[1]], [b[0], b[1]]));
}

// Midpoint subdivision into four (planar lon/lat midpoints, so the pieces
// partition the parent exactly) until every edge is short on the sphere.
function subdivideByEdgeLength(corners: number[][], out: number[][][]) {
  const [a, b, c] = corners;
  const longest = Math.max(
    angularEdgeDegrees(a, b),
    angularEdgeDegrees(b, c),
    angularEdgeDegrees(c, a)
  );
  if (longest <= MAX_TRIANGLE_EDGE_DEGREES) {
    out.push(corners);
    return;
  }
  const mid = (p: number[], q: number[]) => [
    (p[0] + q[0]) / 2,
    (p[1] + q[1]) / 2,
  ];
  const ab = mid(a, b);
  const bc = mid(b, c);
  const ca = mid(c, a);
  for (const piece of [
    [a, ab, ca],
    [ab, b, bc],
    [ca, bc, c],
    [ab, bc, ca],
  ]) {
    subdivideByEdgeLength(piece, out);
  }
}

function addTriangle(
  corners: number[][],
  helper: ProjectionHelper,
  builder: TGpuPolygonFillBuilder,
  radius: number,
  zOffset: number,
  featureIndex: number
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
    builder.featureIndex.push(featureIndex);
  }
}

function addPolygonFill(
  rings: number[][][],
  helper: ProjectionHelper,
  builder: TGpuPolygonFillBuilder,
  radius: number,
  zOffset: number,
  featureIndex: number
) {
  const planar = planarFillRings(rings);
  if (!planar) {
    return;
  }
  const [contour, ...holes] = planar.map((ring) =>
    ring.map(([lon, lat]) => new THREE.Vector2(lon, lat))
  );
  // faces index into the concatenated [contour, ...holes] vertex list
  const vertices = planar.flat();
  const wide: number[][][] = [];
  for (const face of THREE.ShapeUtils.triangulateShape(contour, holes)) {
    splitByLongitude(
      face.map((index) => vertices[index]),
      wide
    );
  }
  const triangles: number[][][] = [];
  for (const corners of wide) {
    subdivideByEdgeLength(corners, triangles);
  }
  for (const corners of triangles) {
    addTriangle(corners, helper, builder, radius, zOffset, featureIndex);
  }
}

function geojson2gpuPolygonFillGeometry(
  geojson: FeatureCollection,
  helper: ProjectionHelper,
  options?: TGeometryOptions
) {
  const radius = options?.radius ?? 1;
  const zOffset = options?.zOffset ?? 0;
  const builder: TGpuPolygonFillBuilder = {
    positions: [],
    latLon: [],
    triLatLonB: [],
    triLatLonC: [],
    featureIndex: [],
  };

  for (const [featureIndex, feature] of geojson.features.entries()) {
    if (feature.geometry.type === "Polygon") {
      addPolygonFill(
        feature.geometry.coordinates as number[][][],
        helper,
        builder,
        radius,
        zOffset,
        featureIndex
      );
    } else if (feature.geometry.type === "MultiPolygon") {
      for (const rings of feature.geometry.coordinates as number[][][][]) {
        addPolygonFill(rings, helper, builder, radius, zOffset, featureIndex);
      }
    }
    // other geometry types are handled by the line path (polygonsToOutlines)
  }
  return fillGeometryFromBuilder(builder);
}

function fillGeometryFromBuilder(builder: TGpuPolygonFillBuilder) {
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
  // choropleth input, refilled by applyVectorFeatureValues; NaN renders as
  // the constant fill color
  geometry.setAttribute(
    "featureValue",
    new THREE.Float32BufferAttribute(
      new Float32Array(builder.positions.length / 3).fill(NaN),
      1
    )
  );
  // vertex -> source-feature mapping, kept CPU-side so per-feature values can
  // be refilled (colorBy changes) without retriangulating
  geometry.userData.featureIndex = Uint32Array.from(builder.featureIndex);
  geometry.computeBoundingSphere();
  return geometry;
}

// Refill the featureValue attribute from per-feature values (in source
// feature order) using the vertex mapping recorded at triangulation time.
function applyVectorFeatureValues(
  geometry: THREE.BufferGeometry,
  values: ArrayLike<number>
) {
  const attribute = geometry.getAttribute("featureValue");
  const featureIndex = geometry.userData.featureIndex as Uint32Array;
  for (let i = 0; i < featureIndex.length; i++) {
    attribute.setX(i, values[featureIndex[i]] ?? NaN);
  }
  attribute.needsUpdate = true;
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

export {
  applyVectorFeatureValues,
  geojson2gpuPolygonFillGeometry,
  MAX_TRIANGLE_EDGE_DEGREES,
  planarFillRings,
  polygonsToOutlines,
};
