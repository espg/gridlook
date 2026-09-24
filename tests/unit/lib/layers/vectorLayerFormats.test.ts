import { expect, it, vi } from "vitest";

import {
  isSupportedVectorLayerFile,
  MAX_VECTOR_LAYER_BYTES,
  parseFeatureCollection,
  readVectorLayerFile,
  vectorLayerNameFromUrl,
} from "@/lib/layers/vectorLayerFormats.ts";

const featureCollection = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "a" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    },
  ],
});

it("accepts .geojson/.json files as vector layers", () => {
  expect(isSupportedVectorLayerFile(new File([], "basins.geojson"))).toBe(true);
  expect(isSupportedVectorLayerFile(new File([], "BASINS.JSON"))).toBe(true);
  expect(
    isSupportedVectorLayerFile(
      new File([], "download", { type: "application/geo+json" })
    )
  ).toBe(true);
  expect(isSupportedVectorLayerFile(new File([], "layer.png"))).toBe(false);
});

it("parses a valid FeatureCollection", () => {
  const parsed = parseFeatureCollection(featureCollection);
  expect(parsed.type).toBe("FeatureCollection");
  expect(parsed.features).toHaveLength(1);
});

it("rejects malformed JSON", () => {
  expect(() => parseFeatureCollection("{not json")).toThrow("not valid JSON");
});

it("rejects roots that are not a FeatureCollection", () => {
  expect(() => parseFeatureCollection('"just a string"')).toThrow(
    "FeatureCollection"
  );
  expect(() => parseFeatureCollection("null")).toThrow("FeatureCollection");
  expect(() =>
    parseFeatureCollection(
      JSON.stringify({ type: "Feature", properties: {}, geometry: null })
    )
  ).toThrow("FeatureCollection");
});

it("rejects a FeatureCollection without a features array", () => {
  expect(() =>
    parseFeatureCollection(JSON.stringify({ type: "FeatureCollection" }))
  ).toThrow("features array");
});

it("drops features with null or missing geometry", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const withNullGeometry = JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "good" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
      { type: "Feature", properties: { name: "unlocated" }, geometry: null },
      { type: "Feature", properties: { name: "absent" } },
    ],
  });

  const parsed = parseFeatureCollection(withNullGeometry);
  expect(parsed.features).toHaveLength(1);
  expect(parsed.features[0].properties).toEqual({ name: "good" });
  expect(parsed.features.every((f) => f.geometry !== null)).toBe(true);
  expect(warnSpy).toHaveBeenCalledWith(
    "dropped 2 feature(s) with null or missing geometry"
  );
  warnSpy.mockRestore();
});

it("rejects oversized files before parsing", async () => {
  const oversized = {
    name: "huge.geojson",
    size: MAX_VECTOR_LAYER_BYTES + 1,
    text: () => Promise.resolve(featureCollection),
  } as unknown as File;
  await expect(readVectorLayerFile(oversized)).rejects.toThrow("limit");
});

it("reads a valid file into a FeatureCollection", async () => {
  const file = new File([featureCollection], "basins.geojson");
  const parsed = await readVectorLayerFile(file);
  expect(parsed.features).toHaveLength(1);
});

it("derives layer names from URL basenames", () => {
  expect(
    vectorLayerNameFromUrl("https://host/path/basins.geojson?v=2#top")
  ).toBe("basins.geojson");
  expect(vectorLayerNameFromUrl("https://host/dir/river%20basins.json/")).toBe(
    "river basins.json"
  );
  expect(vectorLayerNameFromUrl("")).toBe("GeoJSON layer");
});
