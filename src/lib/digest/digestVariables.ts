/**
 * The variables a viewer derives from a t-digest array, client-side: a
 * percentile, and the difference between two percentiles. A store lists
 * them as float32 arrays beside the digest (no chunk of theirs exists);
 * their `digest` attribute names the array they are computed from.
 */

export const DIGEST_PRODUCTS = {
  PERCENTILE: "percentile",
  RANGE: "range",
} as const;
export type TDigestProduct =
  (typeof DIGEST_PRODUCTS)[keyof typeof DIGEST_PRODUCTS];

/** The `digest` attribute of a derived variable. */
export type TDigestVariable = {
  /** The digest array, a sibling of the variable. */
  array: string;
  product: TDigestProduct;
  /** The part of the observations the digest holds, e.g. `signal`. */
  stratum?: string;
};

export const DIGEST_ATTRIBUTE = "digest";
/** The default percentile, and the default bounds of a percentile range. */
export const DEFAULT_PERCENTILE = 50;
export const DEFAULT_PERCENTILE_LOW = 2;
export const DEFAULT_PERCENTILE_HIGH = 98;

// `h_tdigest_signal`: the quantity, then the stratum (optional).
const DIGEST_NAME = /^(.+?)_tdigest(?:_(.+))?$/;
// ICESat-2 photon heights (`h_ph`) are metres above the WGS84 ellipsoid;
// they are shown as stored, without a geoid correction.
const QUANTITIES: Record<
  string,
  { label: string; units: string; datum: string }
> = {
  h: { label: "height", units: "m", datum: "WGS84 ellipsoid" },
};
const PRODUCT_LABELS: Record<TDigestProduct, string> = {
  [DIGEST_PRODUCTS.PERCENTILE]: "percentile",
  [DIGEST_PRODUCTS.RANGE]: "percentile range",
};

type TJson = Record<string, unknown>;

function isRecord(value: unknown): value is TJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether array attributes describe ragged float32 `(mean, weight)` rows. */
function isDigestArray(attributes: unknown) {
  const ragged = isRecord(attributes) ? attributes.ragged : undefined;
  const element = isRecord(ragged) ? ragged.element : undefined;
  if (!isRecord(element) || !Array.isArray(element.shape)) {
    return false;
  }
  return (
    element.dtype === "float32" &&
    element.shape.length === 2 &&
    element.shape[1] === 2
  );
}

/**
 * The variables derived from the array `name`, keyed by their own name
 * (`h_percentile_signal`, `h_range_signal`); empty unless it is a t-digest.
 */
export function digestVariablesOf(
  name: string,
  attributes: unknown
): Record<string, TDigestVariable & { attributes: TJson }> {
  const match = DIGEST_NAME.exec(name);
  if (!match || !isDigestArray(attributes)) {
    return {};
  }
  const [, quantity, stratum] = match;
  const known = QUANTITIES[quantity];
  const variables: ReturnType<typeof digestVariablesOf> = {};
  for (const product of Object.values(DIGEST_PRODUCTS)) {
    const digest: TDigestVariable = { array: name, product, stratum };
    variables[[quantity, product, stratum].filter(Boolean).join("_")] = {
      ...digest,
      attributes: {
        // eslint-disable-next-line camelcase
        long_name:
          `${known?.label ?? quantity} ${PRODUCT_LABELS[product]}` +
          (stratum ? ` (${stratum})` : ""),
        // a difference of two heights has no datum
        ...(known && product === DIGEST_PRODUCTS.PERCENTILE
          ? { units: `${known.units} (${known.datum})` }
          : known
            ? { units: known.units }
            : {}),
        [DIGEST_ATTRIBUTE]: digest,
      },
    };
  }
  return variables;
}

/** The digest a variable is derived from, read from its attributes. */
export function digestVariableOf(
  attributes: unknown
): TDigestVariable | undefined {
  const digest = isRecord(attributes)
    ? attributes[DIGEST_ATTRIBUTE]
    : undefined;
  if (!isRecord(digest) || typeof digest.array !== "string") {
    return undefined;
  }
  return Object.values(DIGEST_PRODUCTS).includes(
    digest.product as TDigestProduct
  )
    ? (digest as TDigestVariable)
    : undefined;
}

/**
 * The metadata of a derived variable: the digest array's grid, as float32
 * with NaN where a cell has no data.
 */
export function digestVariableMetadata(digestArray: TJson, attributes: TJson) {
  return {
    ...digestArray,
    data_type: "float32", // eslint-disable-line camelcase
    fill_value: "NaN", // eslint-disable-line camelcase
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    attributes,
  };
}
