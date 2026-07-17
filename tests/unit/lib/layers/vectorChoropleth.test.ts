import type { FeatureCollection } from "geojson";
import { expect, it } from "vitest";

import {
  computeAutoRange,
  featurePropertyValues,
  resolveChoroplethRange,
  scanNumericProperties,
} from "@/lib/layers/vectorChoropleth.ts";

function featureCollection(
  propertiesList: (Record<string, unknown> | null)[]
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: propertiesList.map((properties, index) => ({
      type: "Feature",
      properties,
      geometry: {
        type: "Point",
        coordinates: [index, 0],
      },
    })),
  } as FeatureCollection;
}

it("scans numeric properties across mixed features", () => {
  const geojson = featureCollection([
    { shard: "4331422", granuleCount: 12, area: 3.5 },
    { shard: "4331423", granuleCount: 7 },
    { label: "no numbers here" },
    null,
    { infinite: Infinity, nan: NaN, granuleCount: 3 },
  ]);

  // sorted; strings, Infinity and NaN never qualify
  expect(scanNumericProperties(geojson)).toEqual(["area", "granuleCount"]);
});

it("extracts per-feature values with NaN for missing or non-numeric", () => {
  const geojson = featureCollection([
    { granuleCount: 12 },
    { granuleCount: "12" },
    {},
    null,
    { granuleCount: -3.5 },
  ]);

  const values = featurePropertyValues(geojson, "granuleCount");
  expect(values).toHaveLength(5);
  expect(values[0]).toBe(12);
  expect(values[1]).toBeNaN();
  expect(values[2]).toBeNaN();
  expect(values[3]).toBeNaN();
  expect(values[4]).toBe(-3.5);
});

it("computes the auto range over finite values only", () => {
  expect(computeAutoRange([3, NaN, -2, 8, NaN])).toEqual({ low: -2, high: 8 });
  // constant-value data is a valid degenerate range
  expect(computeAutoRange([5, 5, NaN])).toEqual({ low: 5, high: 5 });
  // nothing finite -> no range
  expect(computeAutoRange([NaN, NaN])).toBeUndefined();
  expect(computeAutoRange([])).toBeUndefined();
});

it("resolves the effective range with per-side manual overrides", () => {
  const values = [0, 10, NaN];
  expect(resolveChoroplethRange(values, {})).toEqual({ low: 0, high: 10 });
  expect(resolveChoroplethRange(values, { rangeLow: 2 })).toEqual({
    low: 2,
    high: 10,
  });
  expect(resolveChoroplethRange(values, { rangeHigh: 4 })).toEqual({
    low: 0,
    high: 4,
  });
  expect(
    resolveChoroplethRange(values, { rangeLow: -1, rangeHigh: 1 })
  ).toEqual({ low: -1, high: 1 });
  // no data range and no complete manual range -> no choropleth
  expect(resolveChoroplethRange([NaN], {})).toBeUndefined();
  expect(resolveChoroplethRange([NaN], { rangeLow: 0 })).toBeUndefined();
  expect(resolveChoroplethRange([NaN], { rangeLow: 0, rangeHigh: 1 })).toEqual({
    low: 0,
    high: 1,
  });
});
