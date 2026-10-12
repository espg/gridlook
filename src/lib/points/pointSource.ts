import { digestVariableOf } from "@/lib/digest/digestVariables.ts";
import { TIME_WORDS, type TTimeWords } from "@/lib/points/pointTimes.ts";
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

/**
 * The name of the times sibling a digest array's attributes declare
 * (`times`, beside the `ragged` block: zagg spec §8.3); undefined for a
 * digest without timed centroids.
 */
export function timesArrayOf(metadata: TJson): string | undefined {
  const attributes = isRecord(metadata.attributes)
    ? metadata.attributes
    : undefined;
  return typeof attributes?.times === "string" ? attributes.times : undefined;
}

/**
 * How the words of a times sibling read, from the `temporal` block of the
 * sibling's own metadata (zagg spec §8, §8.3): mortie toc words under
 * `{spec: "zagg-toc/1", shape: "per-centroid", grammar: "mortie-toc/1"}`,
 * the legacy int64 microseconds without a block; undefined (the times are
 * not read) for any other revision, shape or grammar, which a reader must
 * refuse rather than guess at.
 */
export function timeWordsOf(metadata: TJson): TTimeWords | undefined {
  const attributes = isRecord(metadata.attributes) ? metadata.attributes : {};
  const temporal = attributes.temporal;
  if (temporal === undefined) {
    return TIME_WORDS.LEGACY;
  }
  return isRecord(temporal) &&
    temporal.spec === "zagg-toc/1" &&
    temporal.shape === "per-centroid" &&
    temporal.grammar === "mortie-toc/1"
    ? TIME_WORDS.TOC
    : undefined;
}
