// Property-driven choropleth support for vector layers. CPU side only:
// numeric-property discovery at ingest, per-feature value extraction, and
// range resolution. The colors come from the shared colormap shaders: the fill
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
function featurePropertyValues(
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
function computeAutoRange(
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

export type TChoroplethScan = {
  property: string;
  values: Float32Array;
  autoRange: TChoroplethRange | undefined;
};

// The fill material, the legend card and the layer panel's auto placeholders
// all want the same per-feature values on every layer tweak (an opacity drag
// re-asks once per frame), and a collection can hold a few MB of features.
// One entry per collection is enough: only the active colorBy is ever asked
// for, and it changes far more rarely than the styles around it.
const scanCache = new WeakMap<FeatureCollection, TChoroplethScan>();

/**
 * Per-feature values of `property` plus their data range, memoized on the
 * collection.
 */
export function scanFeatureProperty(
  geojson: FeatureCollection,
  property: string
): TChoroplethScan {
  const cached = scanCache.get(geojson);
  if (cached?.property === property) {
    return cached;
  }
  const values = featurePropertyValues(geojson, property);
  const scan = { property, values, autoRange: computeAutoRange(values) };
  scanCache.set(geojson, scan);
  return scan;
}

/**
 * Parse one manual range bound as typed into the layer panel. An empty field
 * is the documented way back to "auto from data", so it must read as
 * undefined rather than as `Number("") === 0`.
 */
export function parseChoroplethBound(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Effective choropleth range: manual bounds win per side, the scanned data
 * range fills the rest. Undefined when a side has neither (no finite values
 * and no manual override); the fill then falls back to constant styling.
 */
export function resolveChoroplethRange(
  auto: TChoroplethRange | undefined,
  style: { rangeLow?: number; rangeHigh?: number }
): TChoroplethRange | undefined {
  const low = style.rangeLow ?? auto?.low;
  const high = style.rangeHigh ?? auto?.high;
  if (low === undefined || high === undefined) {
    return undefined;
  }
  return { low, high };
}
