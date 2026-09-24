import type { FeatureCollection } from "geojson";
import { expect, it } from "vitest";

import {
  parseChoroplethBound,
  resolveChoroplethRange,
  scanFeatureProperty,
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
    { name: "a", count: 12, area: 3.5 },
    { name: "b", count: 7 },
    { label: "no numbers here" },
    null,
    { infinite: Infinity, nan: NaN, count: 3 },
  ]);

  // sorted; strings, Infinity and NaN never qualify
  expect(scanNumericProperties(geojson)).toEqual(["area", "count"]);
});

it("extracts per-feature values with NaN for missing or non-numeric", () => {
  const geojson = featureCollection([
    { count: 12 },
    { count: "12" },
    {},
    null,
    { count: -3.5 },
  ]);

  const { values } = scanFeatureProperty(geojson, "count");
  expect(values).toHaveLength(5);
  expect(values[0]).toBe(12);
  expect(values[1]).toBeNaN();
  expect(values[2]).toBeNaN();
  expect(values[3]).toBeNaN();
  expect(values[4]).toBe(-3.5);
});

function autoRangeOf(values: (number | string | null)[]) {
  const geojson = featureCollection(
    values.map((count) => (count === null ? null : { count }))
  );
  return scanFeatureProperty(geojson, "count").autoRange;
}

it("computes the auto range over finite values only", () => {
  expect(autoRangeOf([3, NaN, -2, 8, NaN])).toEqual({ low: -2, high: 8 });
  // constant-value data is a valid degenerate range
  expect(autoRangeOf([5, 5, NaN])).toEqual({ low: 5, high: 5 });
  // nothing finite -> no range
  expect(autoRangeOf([NaN, NaN])).toBeUndefined();
  expect(autoRangeOf([])).toBeUndefined();
});

it("scans a collection once per property", () => {
  const geojson = featureCollection([{ count: 1, area: 2 }, { count: 4 }]);

  const first = scanFeatureProperty(geojson, "count");
  expect(scanFeatureProperty(geojson, "count")).toBe(first);
  // a different colorBy re-scans, and switching back does too
  const area = scanFeatureProperty(geojson, "area");
  expect(area.values[0]).toBe(2);
  expect(scanFeatureProperty(geojson, "count")).not.toBe(first);
});

it("resolves the effective range with per-side manual overrides", () => {
  const auto = { low: 0, high: 10 };
  expect(resolveChoroplethRange(auto, {})).toEqual({ low: 0, high: 10 });
  expect(resolveChoroplethRange(auto, { rangeLow: 2 })).toEqual({
    low: 2,
    high: 10,
  });
  expect(resolveChoroplethRange(auto, { rangeHigh: 4 })).toEqual({
    low: 0,
    high: 4,
  });
  expect(resolveChoroplethRange(auto, { rangeLow: -1, rangeHigh: 1 })).toEqual({
    low: -1,
    high: 1,
  });
  // no data range and no complete manual range -> no choropleth
  expect(resolveChoroplethRange(undefined, {})).toBeUndefined();
  expect(resolveChoroplethRange(undefined, { rangeLow: 0 })).toBeUndefined();
  expect(
    resolveChoroplethRange(undefined, { rangeLow: 0, rangeHigh: 1 })
  ).toEqual({ low: 0, high: 1 });
});

it("reads an emptied range field as auto, not as zero", () => {
  // the layer panel documents an empty field as "auto from data"; Number("")
  // would pin the bound to 0 and there would be no way back
  expect(parseChoroplethBound("")).toBeUndefined();
  expect(parseChoroplethBound("   ")).toBeUndefined();
  expect(parseChoroplethBound("abc")).toBeUndefined();
  expect(parseChoroplethBound("0")).toBe(0);
  expect(parseChoroplethBound(" -1.5 ")).toBe(-1.5);
});
