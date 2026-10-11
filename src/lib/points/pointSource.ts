import { digestVariableOf } from "@/lib/digest/digestVariables.ts";
import type { TSourceLevel } from "@/lib/types/GlobeTypes.ts";

/**
 * Where the point tier reads its observations: the leaf group a derived
 * level is computed from, and the t-digest array the displayed variable is
 * derived from. Each centroid of a leaf digest below the compression limit
 * is one observation at its mean (a height), located by the order-29 point
 * word of the `locations` sibling the array's attributes name
 * (`zagg-located/1`, one word per centroid).
 */
export type TPointSource = {
  store: string;
  /** The leaf group, e.g. `19`. */
  dataset: string;
  /** The digest array, e.g. `h_tdigest_signal`. */
  array: string;
  /** The part of the observations drawn, e.g. `signal`. */
  stratum?: string;
};

type TJson = Record<string, unknown>;

function isRecord(value: unknown): value is TJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The point source of a level and the variable shown on it: only a level
 * derived from the leaves has one (the leaves are where the points are),
 * and only for a variable derived from a t-digest, so that the heights
 * drawn are the quantity the colour range already shows. Undefined
 * otherwise: under `count` the level ladder ends at the finest level.
 */
export function pointTierSource(
  level: Pick<TSourceLevel, "derived" | "datasources"> | undefined,
  varname: string
): TPointSource | undefined {
  const source = level?.datasources[varname];
  const digest = digestVariableOf(source?.attrs);
  if (!level?.derived || !source || !digest) {
    return undefined;
  }
  return {
    store: source.store,
    dataset: level.derived.dataset,
    array: digest.array,
    stratum: digest.stratum,
  };
}

/** The array path of a source's digest, or of a sibling array. */
export function pointArrayPath(source: TPointSource, array = source.array) {
  return [source.dataset, array].filter(Boolean).join("/");
}

/**
 * The name of the locations sibling a digest array's attributes declare
 * (`ragged.locations`); undefined for a digest without located centroids.
 */
export function locationsArrayOf(metadata: TJson): string | undefined {
  const attributes = isRecord(metadata.attributes)
    ? metadata.attributes
    : undefined;
  const ragged = isRecord(attributes?.ragged) ? attributes.ragged : undefined;
  return typeof ragged?.locations === "string" ? ragged.locations : undefined;
}
