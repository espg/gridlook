import { readFileSync } from "node:fs";

import type { FeatureCollection } from "geojson";
import type * as THREE from "three";
import { MathUtils } from "three";
import { afterEach, expect, it, vi } from "vitest";

import {
  geojson2gpuLineSegmentsGeometry,
  unwrapLongitude,
} from "@/lib/layers/geojson.ts";
import {
  applyVectorFeatureValues,
  geojson2gpuPolygonFillGeometry,
  MAX_TRIANGLE_EDGE_DEGREES,
  planarFillRings,
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
  properties: Record<string, string> = { name: "a" }
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

// wrap-aware: the attribute stores normalized longitudes, so the point and
// the corners are unwrapped against the first corner before the planar test
function pointInTriangle(target: TLonLat, triangle: TLonLat[]) {
  const reference = triangle[0][0];
  const unwrap = ([lon, lat]: TLonLat): TLonLat => [
    unwrapLongitude(lon, reference),
    lat,
  ];
  const point = unwrap(target);
  const [a, b, c] = triangle.map(unwrap);
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

// CPU mirror of the azimuthal triangle-hiding test in
// gpuProjectedPolygon.vert.glsl. The projection is the very one the shader
// implements (d3 at scale 1, so projected distances are radians); only the
// cutoff itself is restated here.
const azimuthalHelper = new ProjectionHelper(
  PROJECTION_TYPES.AZIMUTHAL_EQUIDISTANT,
  { lat: 0, lon: 0 }
);

function maxProjectedSpan(triangle: TLonLat[]) {
  let span = 0;
  for (let i = 0; i < 3; i++) {
    const [lonA, latA] = triangle[i];
    const [lonB, latB] = triangle[(i + 1) % 3];
    const [xA, yA] = azimuthalHelper.project(latA, lonA);
    const [xB, yB] = azimuthalHelper.project(latB, lonB);
    span = Math.max(span, Math.hypot(xA - xB, yA - yB));
  }
  return span;
}

function maxAngularSeparation(triangle: TLonLat[]) {
  let separation = 0;
  for (let i = 0; i < 3; i++) {
    const [lonA, latA] = triangle[i].map(MathUtils.degToRad);
    const [lonB, latB] = triangle[(i + 1) % 3].map(MathUtils.degToRad);
    const cosSeparation =
      Math.sin(latA) * Math.sin(latB) +
      Math.cos(latA) * Math.cos(latB) * Math.cos(lonA - lonB);
    separation = Math.max(separation, Math.acos(Math.min(1, cosSeparation)));
  }
  return separation;
}

const AZIMUTHAL_SPAN_SLACK = 1;

function isHiddenByAzimuthalSpan(triangle: TLonLat[]) {
  return (
    maxProjectedSpan(triangle) >
    maxAngularSeparation(triangle) + AZIMUTHAL_SPAN_SLACK
  );
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
        properties: { name: "b" },
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

it("densifies long ring edges into many small triangles", () => {
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

function poleRing(lat: number): number[][] {
  // a ring circling a pole at constant latitude, lons 0..350 step 10, closed
  const ring: number[][] = [];
  for (let lon = 0; lon <= 350; lon += 10) {
    ring.push([lon, lat]);
  }
  ring.push([0, lat]);
  return ring;
}

it.each([
  ["south", -70, -90],
  ["north", 70, 90],
])("fills a ring enclosing the %s pole", (_, lat, pole) => {
  const geojson = polygonFeatureCollection([poleRing(lat)]);
  const geometry = geojson2gpuPolygonFillGeometry(geojson, helper);
  const triangles = trianglesFromGeometry(geometry);
  expect(triangles.length).toBeGreaterThan(0);

  // the fill reaches the pole through the synthetic polar edge; the ring
  // itself stays the rim
  const latLon = geometry.getAttribute("latLon");
  let polarVertices = 0;
  for (let i = 0; i < latLon.count; i++) {
    const vertexLat = latLon.getX(i);
    expect(pole > 0 ? vertexLat >= lat : vertexLat <= lat).toBe(true);
    if (vertexLat === pole) {
      polarVertices++;
    }
  }
  expect(polarVertices).toBeGreaterThan(0);
  expect(pointInAnyTriangle([0, pole], triangles)).toBe(true);
  expect(pointInAnyTriangle([123, (lat + pole) / 2], triangles)).toBe(true);
  expect(pointInAnyTriangle([-100, (lat + pole) / 2], triangles)).toBe(true);
  expect(pointInAnyTriangle([45, lat - pole / 9], triangles)).toBe(false);

  // cap slivers are cut along meridians so every triangle stays local enough
  // for the shader's seam and antipode tests
  for (const [a, b, c] of triangles) {
    const lons = [a, b, c].map(([lon]) => unwrapLongitude(lon, a[0]));
    expect(Math.max(...lons) - Math.min(...lons)).toBeLessThanOrEqual(90);
  }

  // the outline strokes the original ring only: no synthetic polar edge
  const outline = polygonsToOutlines(geojson).features[0].geometry;
  expect(outline.type).toBe("MultiLineString");
  const outlineLats = (outline as { coordinates: number[][][] }).coordinates
    .flat()
    .map(([, ringLat]) => ringLat);
  expect(outlineLats.every((ringLat) => ringLat === lat)).toBe(true);
});

it("projects the synthetic polar edge onto the pole in an azimuthal view", () => {
  const polar = new ProjectionHelper(PROJECTION_TYPES.AZIMUTHAL_EQUIDISTANT, {
    lat: -90,
    lon: 0,
  });
  const geometry = geojson2gpuPolygonFillGeometry(
    polygonFeatureCollection([poleRing(-70)]),
    polar
  );
  const latLon = geometry.getAttribute("latLon");
  const [poleX, poleY] = polar.project(-90, 0);
  let polarVertices = 0;
  for (let i = 0; i < latLon.count; i++) {
    if (latLon.getX(i) !== -90) {
      continue;
    }
    polarVertices++;
    const [x, y] = polar.project(latLon.getX(i), latLon.getY(i));
    expect(x).toBeCloseTo(poleX, 6);
    expect(y).toBeCloseTo(poleY, 6);
  }
  expect(polarVertices).toBeGreaterThan(0);
});

it("keeps holes inside a polar ring and skips an inner ring around the pole", () => {
  const hole = [
    [100, -80],
    [110, -80],
    [110, -75],
    [100, -75],
    [100, -80],
  ];
  const withHole = geojson2gpuPolygonFillGeometry(
    polygonFeatureCollection([poleRing(-70), hole]),
    helper
  );
  const triangles = trianglesFromGeometry(withHole);
  expect(pointInAnyTriangle([105, -77.5], triangles)).toBe(false);
  expect(pointInAnyTriangle([105, -72], triangles)).toBe(true);

  // annulus: the inner ring is not carved, the fill still covers the pole
  const annulus = geojson2gpuPolygonFillGeometry(
    polygonFeatureCollection([poleRing(-70), poleRing(-85)]),
    helper
  );
  expect(pointInAnyTriangle([0, -90], trianglesFromGeometry(annulus))).toBe(
    true
  );
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
        properties: { count: 7 },
        geometry: { type: "Polygon", coordinates: [square(0)] },
      },
      {
        type: "Feature",
        properties: { count: 42 },
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
  // value updates never rebuild the triangulation
  expect(geometry.getAttribute("position")).toBe(position);
  expect(geometry.getAttribute("featureValue")).toBe(featureValue);

  // a property missing on the first feature -> NaN fallback
  applyVectorFeatureValues(geometry, [NaN, 3]);
  expect(featureValue.getX(0)).toBeNaN();
  expect(featureValue.getX(featureValue.count - 1)).toBe(3);
});

it("keeps every triangle of a 100 degree wide fill in azimuthal equidistant", () => {
  const geometry = geojson2gpuPolygonFillGeometry(
    polygonFeatureCollection([
      [
        [-50, -20],
        [50, -20],
        [50, 20],
        [-50, 20],
        [-50, -20],
      ],
    ]),
    helper
  );

  const triangles = trianglesFromGeometry(geometry);
  expect(triangles.length).toBeGreaterThan(0);
  expect(triangles.filter(isHiddenByAzimuthalSpan)).toHaveLength(0);
});

it("still hides wraparound triangles straddling the azimuthal antipode", () => {
  // a small box around (0, 180), the antipode of the projection center: the
  // corners are close together on the sphere but project to opposite rims
  const geometry = geojson2gpuPolygonFillGeometry(
    polygonFeatureCollection([
      [
        [172, -8],
        [188, -8],
        [188, 8],
        [172, 8],
        [172, -8],
      ],
    ]),
    helper
  );

  const triangles = trianglesFromGeometry(geometry);
  const wraparound = triangles.filter(
    (triangle) =>
      maxAngularSeparation(triangle) < MathUtils.degToRad(20) &&
      maxProjectedSpan(triangle) > 2
  );
  expect(wraparound.length).toBeGreaterThan(0);
  for (const triangle of wraparound) {
    expect(isHiddenByAzimuthalSpan(triangle)).toBe(true);
  }
});

// A simplified copy of a real Antarctic drainage-basin collection: one basin
// encloses the South Pole, its neighbour wraps almost a full turn around it
// without enclosing it, the rest cross the antimeridian or are ordinary.
const basins: FeatureCollection = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/antarctic_basins_simplified.geojson",
      import.meta.url
    ),
    "utf8"
  )
);

function shoelace(ring: number[][]) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

// CPU mirror of rotateCoords in projectionShaderFunctions.glsl
function rotatedLongitude(
  lat: number,
  lon: number,
  centerLon: number,
  centerLat: number
) {
  const latRad = MathUtils.degToRad(lat);
  const lonRad = MathUtils.degToRad(lon - centerLon);
  const centerLatRad = MathUtils.degToRad(centerLat);
  const y = Math.cos(latRad) * Math.sin(lonRad);
  const x =
    Math.sin(latRad) * Math.sin(centerLatRad) +
    Math.cos(latRad) * Math.cos(lonRad) * Math.cos(centerLatRad);
  return MathUtils.radToDeg(Math.atan2(y, x));
}

const basinGeometry = geojson2gpuPolygonFillGeometry(basins, helper, {
  radius: 1.001,
});
const basinTriangles = trianglesFromGeometry(basinGeometry);

it("subdivides the basins into short-edged triangles with consistent corners", () => {
  expect(basinTriangles.length).toBeGreaterThan(0);

  // (i) every edge is short on the sphere (float32 storage adds a hair)
  for (const triangle of basinTriangles) {
    expect(maxAngularSeparation(triangle)).toBeLessThanOrEqual(
      MathUtils.degToRad(MAX_TRIANGLE_EDGE_DEGREES) + 1e-5
    );
  }

  // (ii) every vertex carries the other two corners of its own triangle
  const latLon = basinGeometry.getAttribute("latLon");
  const cornerB = basinGeometry.getAttribute("triLatLonB");
  const cornerC = basinGeometry.getAttribute("triLatLonC");
  for (let i = 0; i < latLon.count; i++) {
    const base = i - (i % 3);
    const b = base + ((i + 1) % 3);
    const c = base + ((i + 2) % 3);
    expect([cornerB.getX(i), cornerB.getY(i)]).toEqual([
      latLon.getX(b),
      latLon.getY(b),
    ]);
    expect([cornerC.getX(i), cornerC.getY(i)]).toEqual([
      latLon.getX(c),
      latLon.getY(c),
    ]);
  }
});

it("partitions each basin exactly: no overlaps, no gaps", () => {
  // (iii) planar lon/lat area, the space the triangulation and subdivision
  // work in (so a partition there is a partition on the sphere), summed over
  // the triangles equals the polygons' area -- including the pole-enclosing
  // basin, whose reference is its pole-augmented contour
  let polygonArea = 0;
  for (const feature of basins.features) {
    const rings = planarFillRings(
      (feature.geometry as { coordinates: number[][][] }).coordinates
    );
    expect(rings).not.toBeNull();
    const [contour, ...holes] = rings!;
    polygonArea += Math.abs(shoelace(contour));
    for (const hole of holes) {
      polygonArea -= Math.abs(shoelace(hole));
    }
  }
  let triangleArea = 0;
  for (const triangle of basinTriangles) {
    const reference = triangle[0][0];
    triangleArea += Math.abs(
      shoelace(
        triangle.map(([lon, lat]) => [unwrapLongitude(lon, reference), lat])
      )
    );
  }
  expect(triangleArea / polygonArea).toBeCloseTo(1, 3);
});

it("hides no basin triangle in an azimuthal view centred on the pole", () => {
  // (iv) CPU mirror of the vertex shader: neither the seam test (rotated
  // longitude gap) nor the antipode span test discards anything
  const center = { lat: -90, lon: 0 };
  const polar = new ProjectionHelper(
    PROJECTION_TYPES.AZIMUTHAL_EQUIDISTANT,
    center
  );
  let hidden = 0;
  for (const triangle of basinTriangles) {
    const rotated = triangle.map(([lon, lat]) =>
      rotatedLongitude(lat, lon, center.lon, center.lat)
    );
    const gap = Math.max(
      Math.abs(rotated[0] - rotated[1]),
      Math.abs(rotated[0] - rotated[2]),
      Math.abs(rotated[1] - rotated[2])
    );
    const projected = triangle.map(([lon, lat]) => polar.project(lat, lon));
    let span = 0;
    for (let i = 0; i < 3; i++) {
      const [xA, yA] = projected[i];
      const [xB, yB] = projected[(i + 1) % 3];
      span = Math.max(span, Math.hypot(xA - xB, yA - yB));
    }
    if (
      gap > 180 ||
      span > maxAngularSeparation(triangle) + AZIMUTHAL_SPAN_SLACK
    ) {
      hidden++;
    }
  }
  expect(hidden).toBe(0);
});

it("keeps basin triangles from sagging below the globe surface", () => {
  // (v) a flat triangle sags below the sphere by less than the 1e-3 R the
  // fill floats above the surface in globe mode
  let maxSag = 0;
  for (const triangle of basinTriangles) {
    const corners = triangle.map(([lon, lat]) => helper.project(lat, lon, 1));
    const centroid = [0, 1, 2].map(
      (axis) => (corners[0][axis] + corners[1][axis] + corners[2][axis]) / 3
    );
    maxSag = Math.max(maxSag, 1 - Math.hypot(...centroid));
  }
  expect(maxSag).toBeLessThan(1e-3);
});
