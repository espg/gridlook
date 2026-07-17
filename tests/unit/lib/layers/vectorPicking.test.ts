import type { Feature, FeatureCollection } from "geojson";
import { expect, it } from "vitest";

import { findVectorFeatureAtPoint } from "@/lib/layers/vectorPicking.ts";

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
    square(10, 20, 5, { shard: "a" }),
    square(40, -10, 5, { shard: "b" }),
  ]);

  expect(findVectorFeatureAtPoint(collection, 22, 12)?.properties).toEqual({
    shard: "a",
  });
  expect(findVectorFeatureAtPoint(collection, -8, 42)?.properties).toEqual({
    shard: "b",
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
    { shard: "holed" }
  );
  const collection = collectionOf([withHole]);

  expect(findVectorFeatureAtPoint(collection, 2, 2)?.properties).toEqual({
    shard: "holed",
  });
  expect(findVectorFeatureAtPoint(collection, 5, 5)).toBeNull();
});

it("tests every part of a MultiPolygon", () => {
  const multi: Feature = {
    type: "Feature",
    properties: { granule: "g1" },
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
    granule: "g1",
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
    { shard: "am" }
  );
  const collection = collectionOf([crossing]);

  expect(findVectorFeatureAtPoint(collection, 0, 179.5)?.properties).toEqual({
    shard: "am",
  });
  expect(findVectorFeatureAtPoint(collection, 0, -179.5)?.properties).toEqual({
    shard: "am",
  });
  expect(findVectorFeatureAtPoint(collection, 0, 170)).toBeNull();
});

it("returns the topmost (last drawn) of overlapping features", () => {
  const collection = collectionOf([
    square(0, 0, 10, { shard: "below" }),
    square(5, 5, 10, { shard: "above" }),
  ]);

  expect(findVectorFeatureAtPoint(collection, 7, 7)?.properties).toEqual({
    shard: "above",
  });
  expect(findVectorFeatureAtPoint(collection, 2, 2)?.properties).toEqual({
    shard: "below",
  });
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
    { shard: "degenerate" }
  );
  const collection = collectionOf([line, degenerate]);

  expect(findVectorFeatureAtPoint(collection, 1, 1)).toBeNull();
});
