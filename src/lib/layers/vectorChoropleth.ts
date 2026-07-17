// Property-driven choropleth support for vector layers (e.g. zagg shard
// outlines colored by granule_count). CPU side only: numeric-property
// discovery at ingest, per-feature value extraction, and range resolution.
// The colors themselves come from the house colormap shaders — the fill
// material normalizes the raw per-vertex value with the same
// addOffset/scaleFactor convention the grid materials use.

import type { FeatureCollection } from "geojson";

export type TChoroplethRange = {
  low: number;
  high: number;
};

function numericPropertyValue(
  properties: Record<string, unknown> | null | undefined,
  property: string
): number {
  const value = properties?.[property];
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

/**
 * Names of properties that are finitely numeric on at least one feature.
 * Scanned once at layer ingest and cached on the layer entry.
 */
export function scanNumericProperties(geojson: FeatureCollection): string[] {
  const names = new Set<string>();
  for (const feature of geojson.features) {
    if (!feature.properties) {
      continue;
    }
    for (const [key, value] of Object.entries(feature.properties)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        names.add(key);
      }
    }
  }
  return [...names].sort();
}

/**
 * Per-feature values of `property` in feature order; NaN where the property
 * is missing or not finitely numeric (NaN renders as the constant fill color).
 */
export function featurePropertyValues(
  geojson: FeatureCollection,
  property: string
): Float32Array {
  const values = new Float32Array(geojson.features.length);
  for (const [index, feature] of geojson.features.entries()) {
    values[index] = numericPropertyValue(feature.properties, property);
  }
  return values;
}

/** Min/max over the finite values; undefined when there are none. */
export function computeAutoRange(
  values: ArrayLike<number>
): TChoroplethRange | undefined {
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) {
      continue;
    }
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  // low === high is a valid (constant-value) range; getColormapScaleOffset
  // maps it to the colormap midpoint
  return low <= high ? { low, high } : undefined;
}

/**
 * Effective choropleth range: manual bounds win per-side, the data range
 * fills the rest. Undefined when a side has neither (no finite values and no
 * manual override) — choropleth then falls back to constant styling.
 */
export function resolveChoroplethRange(
  values: ArrayLike<number>,
  style: { rangeLow?: number; rangeHigh?: number }
): TChoroplethRange | undefined {
  const auto = computeAutoRange(values);
  const low = style.rangeLow ?? auto?.low;
  const high = style.rangeHigh ?? auto?.high;
  if (low === undefined || high === undefined) {
    return undefined;
  }
  return { low, high };
}
