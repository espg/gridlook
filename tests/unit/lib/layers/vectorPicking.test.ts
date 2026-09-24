import { readFileSync } from "node:fs";

import type { Feature, FeatureCollection } from "geojson";
import { expect, it } from "vitest";

import { unwrapLongitude } from "@/lib/layers/geojson.ts";
import { geojson2gpuPolygonFillGeometry } from "@/lib/layers/geojsonPolygons.ts";
import { findVectorFeatureAtPoint } from "@/lib/layers/vectorPicking.ts";
import {
  ProjectionHelper,
  PROJECTION_TYPES,
} from "@/lib/projection/projectionUtils.ts";

function polygonFeature(
  rings: number[][][],
  properties: Record<string, unknown>
): Feature {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: rings },
  };
}

function collectionOf(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

const square = (
  west: number,
  south: number,
  size: number,
  properties: Record<string, unknown>
) =>
  polygonFeature(
    [
      [
        [west, south],
        [west + size, south],
        [west + size, south + size],
        [west, south + size],
        [west, south],
      ],
    ],
    properties
  );

it("finds the feature containing a point and misses outside points", () => {
  const collection = collectionOf([
    square(10, 20, 5, { name: "a" }),
    square(40, -10, 5, { name: "b" }),
  ]);

  expect(findVectorFeatureAtPoint(collection, 22, 12)?.properties).toEqual({
    name: "a",
  });
  expect(findVectorFeatureAtPoint(collection, -8, 42)?.properties).toEqual({
    name: "b",
  });
  expect(findVectorFeatureAtPoint(collection, 0, 0)).toBeNull();
  // outside the bbox entirely
  expect(findVectorFeatureAtPoint(collection, 80, 170)).toBeNull();
});

it("excludes points inside holes", () => {
  const withHole = polygonFeature(
    [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ],
    { name: "holed" }
  );
  const collection = collectionOf([withHole]);

  expect(findVectorFeatureAtPoint(collection, 2, 2)?.properties).toEqual({
    name: "holed",
  });
  expect(findVectorFeatureAtPoint(collection, 5, 5)).toBeNull();
});

it("tests every part of a MultiPolygon", () => {
  const multi: Feature = {
    type: "Feature",
    properties: { name: "m" },
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
            [0, 0],
          ],
        ],
        [
          [
            [20, 20],
            [22, 20],
            [22, 22],
            [20, 22],
            [20, 20],
          ],
        ],
      ],
    },
  };
  const collection = collectionOf([multi]);

  expect(findVectorFeatureAtPoint(collection, 21, 21)?.properties).toEqual({
    name: "m",
  });
  expect(findVectorFeatureAtPoint(collection, 10, 10)).toBeNull();
});

it("handles polygons crossing the antimeridian", () => {
  const crossing = polygonFeature(
    [
      [
        [178, -2],
        [-178, -2],
        [-178, 2],
        [178, 2],
        [178, -2],
      ],
    ],
    { name: "am" }
  );
  const collection = collectionOf([crossing]);

  expect(findVectorFeatureAtPoint(collection, 0, 179.5)?.properties).toEqual({
    name: "am",
  });
  expect(findVectorFeatureAtPoint(collection, 0, -179.5)?.properties).toEqual({
    name: "am",
  });
  expect(findVectorFeatureAtPoint(collection, 0, 170)).toBeNull();
});

it("returns the topmost (last drawn) of overlapping features", () => {
  const collection = collectionOf([
    square(0, 0, 10, { name: "below" }),
    square(5, 5, 10, { name: "above" }),
  ]);

  expect(findVectorFeatureAtPoint(collection, 7, 7)?.properties).toEqual({
    name: "above",
  });
  expect(findVectorFeatureAtPoint(collection, 2, 2)?.properties).toEqual({
    name: "below",
  });
});

it.each([
  ["south", -70, -90],
  ["north", 70, 90],
])("picks inside a ring enclosing the %s pole", (_, lat, pole) => {
  // a ring circling the pole at constant latitude, lons 0..350 step 10
  const ring: number[][] = [];
  for (let lon = 0; lon <= 350; lon += 10) {
    ring.push([lon, lat]);
  }
  ring.push([0, lat]);
  const collection = collectionOf([polygonFeature([ring], { name: "polar" })]);

  expect(findVectorFeatureAtPoint(collection, pole, 0)?.properties).toEqual({
    name: "polar",
  });
  expect(findVectorFeatureAtPoint(collection, pole, 123)?.properties).toEqual({
    name: "polar",
  });
  expect(
    findVectorFeatureAtPoint(collection, (lat + pole) / 2, -170)?.properties
  ).toEqual({ name: "polar" });
  expect(findVectorFeatureAtPoint(collection, lat - pole / 9, 45)).toBeNull();
  expect(findVectorFeatureAtPoint(collection, 0, 0)).toBeNull();
});

it("ignores non-polygon geometries and degenerate rings", () => {
  const line: Feature = {
    type: "Feature",
    properties: { kind: "line" },
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [5, 5],
      ],
    },
  };
  const degenerate = polygonFeature(
    [
      [
        [0, 0],
        [1, 1],
        [0, 0],
      ],
    ],
    { name: "degenerate" }
  );
  const collection = collectionOf([line, degenerate]);

  expect(findVectorFeatureAtPoint(collection, 1, 1)).toBeNull();
});

it("picks the basins wherever their fills are drawn", () => {
  // simplified real basins: one encloses the South Pole, its neighbour wraps
  // 190 degrees of longitude around it, others cross the antimeridian
  const basins: FeatureCollection = JSON.parse(
    readFileSync(
      new URL(
        "../../../fixtures/antarctic_basins_simplified.geojson",
        import.meta.url
      ),
      "utf8"
    )
  );
  const helper = new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
    lat: 0,
    lon: 0,
  });
  expect(findVectorFeatureAtPoint(basins, -90, 17)?.properties?.basin).toBe(1);

  // the centroid of every fill triangle of a basin picks that basin
  for (const feature of basins.features) {
    const single: FeatureCollection = {
      type: "FeatureCollection",
      features: [feature],
    };
    const latLon = geojson2gpuPolygonFillGeometry(single, helper).getAttribute(
      "latLon"
    );
    for (let i = 0; i < latLon.count; i += 3 * 50) {
      const lat =
        (latLon.getX(i) + latLon.getX(i + 1) + latLon.getX(i + 2)) / 3;
      const lonA = latLon.getY(i);
      const lon =
        (lonA +
          unwrapLongitude(latLon.getY(i + 1), lonA) +
          unwrapLongitude(latLon.getY(i + 2), lonA)) /
        3;
      expect(
        findVectorFeatureAtPoint(basins, lat, lon)?.properties?.basin
      ).toBe(feature.properties?.basin);
    }
  }
});
