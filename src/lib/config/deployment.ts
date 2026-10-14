import { GAP_FILL_SIZES } from "@/lib/grids/gapFill.ts";

/**
 * The tuning of one deployment of the viewer: values chosen for the zagg v4
 * stores and the hosting the viewer ships with (espg, 2026-10-14), not
 * properties of the data or the browser. Each is read where it is used, from
 * `DEPLOYMENT_DEFAULTS` unless the page hash names it as `::<param>=<value>`
 * (`DEPLOYMENT_PARAMS`), the way `::chunks=` and `::fetch=` were first read.
 * An override that does not parse is ignored.
 */
export const DEPLOYMENT_DEFAULTS = {
  /** Reads in flight at once over HTTP/1.1 (`healpixBlockFetch.ts`). */
  fetchHttp1: 8,
  /** Reads in flight at once over HTTP/2 or HTTP/3. */
  fetchMultiplexed: 16,
  /** Aligned chunks one window range may span: one request per shard. */
  rangeChunks: 4,
  /** Fraction of the view a digest window reaches past every edge. */
  digestWindowMargin: 0.1,
  /** The finest digest order at the default pixel floor (`levels.ts`). */
  fineDigestOrder: 13,
  /** Pixel floors of the next digest orders, the last for every order past. */
  fineDigestPixelsPerCell: [4, 8, 16] as number[],
  /** Pixels a cell of the finest level spans when the points come on. */
  pointTierPixelsPerCell: 32,
  /** Orders above the leaves that are no level: the points (`hiveStore.ts`). */
  pointTierOrders: 3,
  /** The variable a store opens on when neither URL nor store names one. */
  digestDefaultVar: "h_percentile_signal",
  /** Whether gap smoothing starts on. */
  gapFill: false,
  /** The gap smoothing kernel, in cells across (one of `GAP_FILL_SIZES`). */
  gapFillSize: 15,
  /** Whether the distance scale starts shown. */
  showDistanceScale: true,
};

export type TDeploymentConfig = typeof DEPLOYMENT_DEFAULTS;
type TKey = keyof TDeploymentConfig;
type TParse<K extends TKey> = (raw: string) => TDeploymentConfig[K] | undefined;

/** A positive integer, as `::fetch=` and `::chunks=` take. */
export const positiveInteger = (raw: string) => {
  const value = Number(raw);
  return /^\d+$/.test(raw) && value > 0 ? value : undefined;
};
const nonNegative = (raw: string) => {
  const value = Number(raw);
  return /^\d*\.?\d+$/.test(raw) && value >= 0 ? value : undefined;
};
const integerList = (raw: string) => {
  const values = raw.split(",").map(positiveInteger);
  return values.every((value) => value !== undefined)
    ? (values as number[])
    : undefined;
};
const kernelSize = (raw: string) => {
  const value = positiveInteger(raw);
  return (GAP_FILL_SIZES as readonly number[]).includes(value ?? NaN)
    ? value
    : undefined;
};
const flag = (raw: string) =>
  raw === "true" ? true : raw === "false" ? false : undefined;
const text = (raw: string) => raw || undefined;

/** The hash parameter of every key and how its value is read. */
export const DEPLOYMENT_PARAMS: { [K in TKey]: [string, TParse<K>] } = {
  fetchHttp1: ["fetchhttp1", positiveInteger],
  fetchMultiplexed: ["fetchmux", positiveInteger],
  rangeChunks: ["chunks", positiveInteger],
  digestWindowMargin: ["digestmargin", nonNegative],
  fineDigestOrder: ["finedigestorder", positiveInteger],
  fineDigestPixelsPerCell: ["finedigestpx", integerList],
  pointTierPixelsPerCell: ["pointpx", positiveInteger],
  pointTierOrders: ["pointorders", positiveInteger],
  digestDefaultVar: ["digestvar", text],
  gapFill: ["smooth", flag],
  gapFillSize: ["smoothkernel", kernelSize],
  showDistanceScale: ["distancescale", flag],
};

/** The raw value of `::<name>=<value>` in a page hash, if any. */
export function hashParam(hash: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|::)${name}=([^:]*)(?:::|$)`).exec(
    hash.replace(/^#/, "")
  );
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** The page's hash, empty outside a browser. */
export function pageHash() {
  return typeof location === "undefined" ? "" : location.hash;
}

/** The value of `key` under `hash`: its override, else its default. */
export function deploymentValue<K extends TKey>(
  key: K,
  hash = pageHash()
): TDeploymentConfig[K] {
  const [param, parse] = DEPLOYMENT_PARAMS[key];
  const raw = hashParam(hash, param);
  return (
    (raw === undefined ? undefined : parse(raw)) ?? DEPLOYMENT_DEFAULTS[key]
  );
}

/** Every value under `hash`. */
export function deploymentConfig(hash = pageHash()): TDeploymentConfig {
  const keys = Object.keys(DEPLOYMENT_DEFAULTS) as TKey[];
  return Object.fromEntries(
    keys.map((key) => [key, deploymentValue(key, hash)])
  ) as TDeploymentConfig;
}
