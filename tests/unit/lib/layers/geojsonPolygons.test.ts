import type { FeatureCollection } from "geojson";
import type * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";

import { geojson2gpuLineSegmentsGeometry } from "@/lib/layers/geojson.ts";
import {
  applyVectorFeatureValues,
  geojson2gpuPolygonFillGeometry,
  polygonsToOutlines,
} from "@/lib/layers/geojsonPolygons.ts";
import {
  ProjectionHelper,
  PROJECTION_TYPES,
} from "@/lib/projection/projectionUtils.ts";

const helper = new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
  lat: 0,
  lon: 0,
});

type TLonLat = [number, number];

function polygonFeatureCollection(
  rings: number[][][],
  properties: Record<string, string> = { shard: "4331422" }
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties,
        geometry: { type: "Polygon", coordinates: rings },
      },
    ],
  };
}

// triangles as [lon, lat] corners, read back from the latLon attribute
function trianglesFromGeometry(geometry: THREE.BufferGeometry): TLonLat[][] {
  const latLon = geometry.getAttribute("latLon");
  const triangles: TLonLat[][] = [];
  for (let i = 0; i < latLon.count; i += 3) {
    const triangle: TLonLat[] = [];
    for (let corner = 0; corner < 3; corner++) {
      triangle.push([latLon.getY(i + corner), latLon.getX(i + corner)]);
    }
    triangles.push(triangle);
  }
  return triangles;
}

function signedArea([a, b, c]: TLonLat[]) {
  return ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

function ringSignedArea(ring: number[][]) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function pointInTriangle(point: TLonLat, triangle: TLonLat[]) {
  const [a, b, c] = triangle;
  const sign = (p: TLonLat, q: TLonLat) =>
    (q[0] - p[0]) * (point[1] - p[1]) - (q[1] - p[1]) * (point[0] - p[0]);
  const d1 = sign(a, b);
  const d2 = sign(b, c);
  const d3 = sign(c, a);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function pointInAnyTriangle(point: TLonLat, triangles: TLonLat[][]) {
  return triangles.some((triangle) => pointInTriangle(point, triangle));
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("triangulates a small square into two triangles, preserving area and winding", () => {
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];
  const geometry = geojson2gpuPolygonFillGeometry(
    polygonFeatureCollection([ring]),
    helper
  );

  const triangles = trianglesFromGeometry(geometry);
  expect(triangles).toHaveLength(2);
  expect(geometry.getAttribute("position").count).toBe(6);

  const signedSum = triangles.reduce((sum, tri) => sum + signedArea(tri), 0);
  const absoluteSum = triangles.reduce(
    (sum, tri) => sum + Math.abs(signedArea(tri)),
    0
  );
  // consistent winding, matching the input ring, with no overlap or gaps
  expect(absoluteSum).toBeCloseTo(1, 5);
  expect(signedSum).toBeCloseTo(ringSignedArea(ring), 5);
});

it("carves holes out of the fill", () => {
  const outer = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];
  const hole = [
    [0.4, 0.4],
    [0.4, 0.6],
    [0.6, 0.6],
    [0.6, 0.4],
    [0.4, 0.4],
  ];
  const geometry = geojson2gpuPolygonFillGeometry(
    polygonFeatureCollection([outer, hole]),
    helper
  );

  const triangles = trianglesFromGeometry(geometry);
  const absoluteSum = triangles.reduce(
    (sum, tri) => sum + Math.abs(signedArea(tri)),
    0
  );
  expect(absoluteSum).toBeCloseTo(0.96, 5);

  const holePoints: TLonLat[] = [
    [0.5, 0.5],
    [0.45, 0.45],
    [0.55, 0.55],
    [0.45, 0.55],
  ];
  for (const point of holePoints) {
    expect(pointInAnyTriangle(point, triangles)).toBe(false);
  }
  const fillPoints: TLonLat[] = [
    [0.2, 0.5],
    [0.9, 0.1],
    [0.5, 0.8],
  ];
  for (const point of fillPoints) {
    expect(pointInAnyTriangle(point, triangles)).toBe(true);
  }
});

it("triangulates every polygon of a MultiPolygon", () => {
  const geojson: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { shard: "4331423" },
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
            ],
            [
              [
                [10, 10],
                [11, 10],
                [11, 11],
                [10, 11],
                [10, 10],
              ],
            ],
          ],
        },
      },
    ],
  };
  const geometry = geojson2gpuPolygonFillGeometry(geojson, helper);

  const triangles = trianglesFromGeometry(geometry);
  expect(triangles).toHaveLength(4);
  const absoluteSum = triangles.reduce(
    (sum, tri) => sum + Math.abs(signedArea(tri)),
    0
  );
  expect(absoluteSum).toBeCloseTo(2, 5);
});

it("densifies long ring edges so fills follow great circles", () => {
  const geometry = geojson2gpuPolygonFillGeometry(
    polygonFeatureCollection([
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ]),
    helper
  );

  const position = geometry.getAttribute("position");
  // densification adds boundary vertices, so a simple polygon with n ring
  // vertices yields n - 2 triangles, far more than the undensified 2
  expect(position.count % 3).toBe(0);
  expect(position.count / 3).toBeGreaterThan(2);
  const latLon = geometry.getAttribute("latLon");
  for (let i = 0; i < latLon.count; i++) {
    expect(Number.isFinite(latLon.getX(i))).toBe(true);
    expect(latLon.getY(i)).toBeGreaterThanOrEqual(-180);
    expect(latLon.getY(i)).toBeLessThanOrEqual(180);
  }
});

it("handles unsplit polygons crossing the antimeridian without crashing", () => {
  const geometry = geojson2gpuPolygonFillGeometry(
    polygonFeatureCollection([
      [
        [179, -1],
        [-179, -1],
        [-179, 1],
        [179, 1],
        [179, -1],
      ],
    ]),
    helper
  );

  const triangles = trianglesFromGeometry(geometry);
  expect(triangles).toHaveLength(2);
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) {
    expect(Number.isFinite(position.getX(i))).toBe(true);
    expect(Number.isFinite(position.getY(i))).toBe(true);
    expect(Number.isFinite(position.getZ(i))).toBe(true);
  }
});

it("routes non-polygon geometries to the line path", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const geojson: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      },
      ...polygonFeatureCollection([
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ]).features,
    ],
  };

  // the fill only picks up the polygon
  const fillGeometry = geojson2gpuPolygonFillGeometry(geojson, helper);
  expect(fillGeometry.getAttribute("position").count).toBe(6);

  // the outline pass strokes the polygon rings and keeps the LineString
  const outlines = polygonsToOutlines(geojson);
  expect(outlines.features[0].geometry.type).toBe("LineString");
  expect(outlines.features[1].geometry.type).toBe("MultiLineString");
  const lineGeometry = geojson2gpuLineSegmentsGeometry(outlines, helper);
  expect(lineGeometry.getAttribute("position").count).toBeGreaterThan(0);
  expect(errorSpy).not.toHaveBeenCalled();
});

it("logs and skips a pole-enclosing ring instead of rendering blank", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // a ring circling the north pole: lats all +85, lons 0..350 step 10, closed
  const ring: number[][] = [];
  for (let lon = 0; lon <= 350; lon += 10) {
    ring.push([lon, 85]);
  }
  ring.push([0, 85]);

  const geometry = geojson2gpuPolygonFillGeometry(
    polygonFeatureCollection([ring]),
    helper
  );

  // no faces emitted, and it did not throw
  expect(geometry.getAttribute("position").count).toBe(0);
  expect(errorSpy).toHaveBeenCalledWith(
    "skipping pole-enclosing polygon ring (spans ~360 deg lon)"
  );
});

it("maps feature values onto vertices without retriangulating", () => {
  const square = (offset: number): number[][] => [
    [offset, 0],
    [offset + 1, 0],
    [offset + 1, 1],
    [offset, 1],
    [offset, 0],
  ];
  const geojson: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { granuleCount: 7 },
        geometry: { type: "Polygon", coordinates: [square(0)] },
      },
      {
        type: "Feature",
        properties: { granuleCount: 42 },
        geometry: {
          type: "MultiPolygon",
          coordinates: [[square(10)], [square(20)]],
        },
      },
    ],
  };
  const geometry = geojson2gpuPolygonFillGeometry(geojson, helper);
  const featureValue = geometry.getAttribute("featureValue");
  const position = geometry.getAttribute("position");

  // starts as NaN (renders as the constant fill color)
  expect(featureValue.count).toBe(position.count);
  for (let i = 0; i < featureValue.count; i++) {
    expect(featureValue.getX(i)).toBeNaN();
  }

  applyVectorFeatureValues(geometry, [7, 42]);
  // vertices 0..5 belong to the first feature, the rest (both polygons of
  // the MultiPolygon) to the second
  for (let i = 0; i < featureValue.count; i++) {
    expect(featureValue.getX(i)).toBe(i < 6 ? 7 : 42);
  }
  // color updates never rebuild the triangulation
  expect(geometry.getAttribute("position")).toBe(position);
  expect(geometry.getAttribute("featureValue")).toBe(featureValue);

  // a second property missing on the first feature -> NaN fallback
  applyVectorFeatureValues(geometry, [NaN, 3]);
  expect(featureValue.getX(0)).toBeNaN();
  expect(featureValue.getX(featureValue.count - 1)).toBe(3);
});

it("logs and skips unknown geometry", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const geojson: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [0, 0] },
      },
    ],
  };

  const fillGeometry = geojson2gpuPolygonFillGeometry(geojson, helper);
  expect(fillGeometry.getAttribute("position").count).toBe(0);

  const lineGeometry = geojson2gpuLineSegmentsGeometry(
    polygonsToOutlines(geojson),
    helper
  );
  expect(lineGeometry.getAttribute("position").count).toBe(0);
  expect(errorSpy).toHaveBeenCalledWith("unknown geometry: Point");
});
