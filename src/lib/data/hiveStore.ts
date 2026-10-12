import * as zarr from "zarrita";

import {
  digestVariableMetadata,
  digestVariablesOf,
} from "@/lib/digest/digestVariables.ts";
import { mergeDigestChunks } from "@/lib/digest/strata.ts";
import {
  digestChunkFromVlen,
  vlenFromDigestChunk,
} from "@/lib/digest/tdigest.ts";
import { decodeVlenChunk, encodeVlenChunk } from "@/lib/digest/vlenChunk.ts";
import { parseRootCoverage, rangesShardIds } from "@/lib/morton/coverage.ts";
import { decimalBase, parseMortonDecimal } from "@/lib/morton/decimal.ts";
import { hiveComponents, leafPath } from "@/lib/morton/hive.ts";
import {
  MANIFEST_NAME,
  parseHiveManifest,
  type HiveManifest,
} from "@/lib/morton/manifest.ts";
import { wordToNested } from "@/lib/morton/word.ts";

/**
 * A zagg morton-hive store read as one zarr v3 hierarchy: the layout of the
 * store's Icechunk companion repo (zagg spec §11), computed in the browser.
 *
 * One group per level, named by its CELL order (`/19` the leaves, `/13` the
 * leaf column, `/12` … `/4` the overviews). Every array is the artifact's,
 * re-rooted on the whole sphere under a leading `window` row: shape
 * `(rows, 12·4^cellOrder)`, one chunk per inner chunk of a node's object.
 * Chunk `n` of a level lives in the object of the node at nested rank
 * `floor(n / C)` (`C` inner chunks per object), inner chunk `n mod C`; a
 * leaf's inner chunk is a byte range of its shard object, found through the
 * shard index that the leaf writer appends.
 *
 * A t-digest array (ragged, which zarrita cannot open) is listed with the
 * variables a viewer derives from it, as float32 arrays without chunks: the
 * digests themselves are read by `digestReader.ts` from the same keys.
 *
 * The orders between the leaf chunk's and the leaves' that the store does
 * not hold are listed too, as levels without chunks (`derived_levels` in
 * the root attributes): a viewer computes them from the leaf chunks, chunk
 * `n` of a derived level being chunk `n` of the leaves (`derivedLevel.ts`).
 * The finest `POINT_TIER_ORDERS` orders are not derived: there the viewer
 * shows the points themselves, and the leaves are only their source.
 *
 * Nothing is listed: the manifest plus the root coverage name every node.
 * The per-cell `morton` coordinate is never read (a windowed leaf has none:
 * the cell is the nested index).
 *
 * A windowed store (a manifest with a `temporal` schedule) holds its leaves
 * and its leaf column per window (`{shard}_{window}.zarr`,
 * `{window}.pyramid.zarr`) and only the overviews folded over all time
 * (`all.zarr`). The hierarchy shows the all-time product at every level:
 * a leaf or column chunk is read from every window present at its node and
 * merged cell by cell, a summed field by addition and a t-digest by
 * concatenating the centroids (`mergeDigestChunks`), and served
 * uncompressed; the located, timed and packed arrays of those levels have
 * no chunk there. The windows are not listed: a generative schedule's
 * labels are enumerated from its epoch (yearly: every year to the present)
 * and probed per node, an absent window adding nothing.
 */

export const HIVE_PREFIX = "hive+";
const COVERAGE_NAME = "coverage.moc";
const COVERAGE_ENCODING_UNSUPPORTED =
  "the hive root coverage is not a ranges envelope";
// 32 KB: zarrita's default, and the largest gap worth bridging between two
// inner chunks of one shard object.
const COALESCE_SIZE = 32768;
const INDEX_ENTRY_BYTES = 16;
const INDEX_CHECKSUM_BYTES = 4;
const ABSENT = 0xffffffffffffffffn;
/**
 * Orders at the fine end that are no level of the viewer: the leaves and
 * the order above them (19 and 18 in the stores so far). Past the finest
 * derived level, two orders above the leaves, the viewer shows the points
 * themselves (gridlook#21); the leaves stay the source of every derived
 * level and of the digests, and are not listed as a level (`multiscales.ts`).
 */
const POINT_TIER_ORDERS = 2;

const LITTLE_ENDIAN_BYTES = {
  name: "bytes",
  configuration: { endian: "little" },
};
const VLEN_BYTES = { name: "vlen-bytes", configuration: {} };
const DENSE_TYPES = {
  int32: Int32Array,
  uint32: Uint32Array,
  int64: BigInt64Array,
  uint64: BigUint64Array,
  float32: Float32Array,
  float64: Float64Array,
} as const;

const CHUNK_KEY = /^\/(\d+)\/([^/]+)\/c\/(\d+)\/(\d+)$/;
const GROUP_KEY = /^\/(\d+)\/zarr\.json$/;
const ARRAY_KEY = /^\/(\d+)\/([^/]+)\/zarr\.json$/;

const HiveArtifact = {
  LEAF: "leaf",
  COLUMN: "column",
  OVERVIEW: "overview",
} as const;
type THiveArtifact = (typeof HiveArtifact)[keyof typeof HiveArtifact];

type THiveLevel = {
  cellOrder: number;
  nodeOrder: number;
  artifact: THiveArtifact;
  // nested rank at `nodeOrder` -> store-relative directories holding
  // `{cellOrder}/{name}/...` for that node: one, or one per window of a
  // windowed store (merged on read)
  nodes: Map<number, string[]>;
  // whether the level's chunks are merged from per-window objects
  merged: boolean;
};
/** How the per-window chunks of an array merge; undefined for no merge. */
type TMergeKind = "sum" | "digest";
type TArrayView = {
  metadata: TJson;
  innerChunk: number;
  /** The inner codecs of the store's objects (before any rewrite). */
  innerCodecs: unknown[];
  merge?: TMergeKind;
};

type TJson = Record<string, unknown>;
type TIndexEntry = { offset: number; length: number } | undefined;
type TContents = { path: zarr.AbsolutePath; kind: "array" | "group" }[];
// a derived variable's name -> the digest array beside it and its attributes
type TDerived = Map<string, { array: string; attributes: TJson }>;
// the orders computed from the leaves, finest first, and their arrays
type TPooled = { orders: number[]; names: string[] };

export type THiveStore = zarr.Listable<zarr.AsyncReadable>;

function isRecord(value: unknown): value is TJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRank(decimalId: string) {
  return Number(wordToNested(parseMortonDecimal(decimalId)).nested);
}

/** The ancestor of a shard id at `order`: its base plus that many digits. */
function ancestorId(shardId: string, order: number) {
  return shardId.slice(0, decimalBase(shardId).length + order);
}

/** The nodes present at every level of each store opened, by root URL. */
const nodesByRoot = new Map<
  string,
  { levels: THiveLevel[]; windows: number }
>();

const rootKey = (rootUrl: string) => rootUrl.replace(/\/+$/, "");

/** The nodes of a store that hold a level's cells. */
export type THiveNodes = {
  /** The order of a node: a leaf's (shard) order for the column levels. */
  nodeOrder: number;
  /** The nested ranks at `nodeOrder` of every node present. */
  ranks: Set<number>;
  /**
   * Objects read per chunk: the windows of a windowed store merged on read
   * for a leaf or column level, 1 where one object holds the level.
   */
  windows: number;
};

/**
 * The nodes of the store opened at `rootUrl` that hold the cells of a level,
 * for a window to read only where the store has something: a level the
 * store does not hold (one derived from the leaves) answers with the leaves'
 * nodes. Undefined before the store is opened.
 */
export function hiveNodes(
  rootUrl: string,
  cellOrder: number
): THiveNodes | undefined {
  const opened = nodesByRoot.get(rootKey(rootUrl));
  if (!opened) {
    return undefined;
  }
  const { levels, windows } = opened;
  const level =
    levels.find((entry) => entry.cellOrder === cellOrder) ?? levels[0];
  return {
    nodeOrder: level.nodeOrder,
    ranks: new Set(level.nodes.keys()),
    windows: level.merged ? windows : 1,
  };
}

/**
 * The window labels of a windowed store's per-window objects, or undefined
 * for an unwindowed one: the manifest's list, else every label a yearly
 * schedule can have generated from its epoch to the present (the manifest
 * does not list them; a node is probed for each).
 */
function windowLabels(manifest: HiveManifest): string[] | undefined {
  if (manifest.schedule === "none") {
    return undefined;
  }
  if (manifest.windows) {
    return manifest.windows;
  }
  if (manifest.schedule !== "yearly") {
    throw new Error(
      `windowed hive stores with a ${manifest.schedule} schedule are not supported`
    );
  }
  const temporal = isRecord(manifest.raw.temporal) ? manifest.raw.temporal : {};
  const epoch = new Date(String(temporal.epoch)).getUTCFullYear();
  if (!Number.isInteger(epoch)) {
    throw new Error("a yearly hive schedule needs a temporal epoch");
  }
  const now = new Date().getUTCFullYear();
  return Array.from({ length: now - epoch + 1 }, (_, i) => String(epoch + i));
}

/**
 * Whether a block (a nested cell of `blockLevel`) of a level's window lies
 * under a node the store holds, or holds one.
 */
export function coveredBlocks(
  nodes: Pick<THiveNodes, "nodeOrder" | "ranks">,
  blockLevel: number
) {
  if (blockLevel >= nodes.nodeOrder) {
    const perNode = 4 ** (blockLevel - nodes.nodeOrder);
    return (block: number) => nodes.ranks.has(Math.floor(block / perNode));
  }
  const perBlock = 4 ** (nodes.nodeOrder - blockLevel);
  const covered = new Set<number>();
  for (const rank of nodes.ranks) {
    covered.add(Math.floor(rank / perBlock));
  }
  return (block: number) => covered.has(block);
}

/**
 * A level group's `zarr.json`: the artifact's own, with `dggs.coordinate`
 * dropped. The artifact names its `morton` array as the cell coordinate, but
 * a level re-rooted on the sphere is dense — a cell IS its index — and that
 * array holds 64-bit morton words where a node has data and fill where it
 * does not, so a reader that followed the token (gridlook's whole-level load
 * does) would index every cell into face 0. The hierarchy never lists
 * `morton`, and now never points at it.
 */
function levelGroup(bytes: Uint8Array): Uint8Array {
  const meta = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  const attrs = isRecord(meta.attributes) ? meta.attributes : undefined;
  const dggs = attrs && isRecord(attrs.dggs) ? attrs.dggs : undefined;
  if (!attrs || !dggs || !("coordinate" in dggs)) {
    return bytes;
  }
  const rest = { ...dggs };
  delete rest.coordinate;
  return new TextEncoder().encode(
    JSON.stringify({ ...meta, attributes: { ...attrs, dggs: rest } })
  );
}

/**
 * The root `multiscales`: the zarr-conventions object the Icechunk companion
 * root carries since zagg 0.59.0 (englacial/zagg#618) — the
 * `zagg-multiscales/1` block's own keys plus a `layout` naming one level group
 * per cell order, finest first, every derived level from the next finer with
 * `transform.scale` 4^Δ on the cells axis. `parseMultiscales` reads the
 * layout (the `/1` block's `datasets` carry no `path`, so a bare `/1` list
 * indexes as a single level — the leaves, whole); readers of the `/1` keys
 * find them unchanged.
 */
function rootMultiscales(manifest: HiveManifest, levels: THiveLevel[]) {
  const multiscales = manifest.raw.multiscales;
  const block = Array.isArray(multiscales) ? multiscales[0] : undefined;
  const sorted = [...levels].sort((a, b) => b.cellOrder - a.cellOrder);
  const layout = sorted.map((level, index) => {
    const asset = String(level.cellOrder);
    if (index === 0) {
      return { asset };
    }
    const finer = sorted[index - 1];
    return {
      asset,
      // eslint-disable-next-line camelcase
      derived_from: String(finer.cellOrder),
      transform: { scale: [4 ** (finer.cellOrder - level.cellOrder)] },
    };
  });
  return { ...(isRecord(block) ? block : {}), layout };
}

/**
 * The levels the manifest declares: the leaves from its own orders, then
 * the `zagg-multiscales/1` datasets (finest first) when it carries them.
 */
function manifestLevels(manifest: HiveManifest): THiveLevel[] {
  const windowed = manifest.schedule !== "none";
  const levels: THiveLevel[] = [
    {
      cellOrder: manifest.cellOrder,
      nodeOrder: manifest.shardOrder,
      artifact: HiveArtifact.LEAF,
      nodes: new Map(),
      merged: windowed,
    },
  ];
  const multiscales = manifest.raw.multiscales;
  const block = Array.isArray(multiscales) ? multiscales[0] : undefined;
  const datasets = isRecord(block) ? block.datasets : undefined;
  if (!Array.isArray(datasets)) {
    return levels;
  }
  for (const dataset of datasets) {
    if (!isRecord(dataset) || !Array.isArray(dataset.cells)) {
      continue;
    }
    const cellOrder = Number(dataset.cells[0]);
    const nodeOrder = Number(dataset.order);
    const artifact =
      dataset.artifact === HiveArtifact.COLUMN
        ? HiveArtifact.COLUMN
        : HiveArtifact.OVERVIEW;
    if (Number.isInteger(cellOrder) && Number.isInteger(nodeOrder)) {
      levels.push({
        cellOrder,
        nodeOrder,
        artifact,
        nodes: new Map(),
        merged: windowed && artifact === HiveArtifact.COLUMN,
      });
    }
  }
  return levels;
}

/** The directories a node's level may be read from (one per window merged). */
function nodeDirs(
  level: THiveLevel,
  shardId: string,
  components: string,
  manifest: HiveManifest,
  windows: string[] | undefined
) {
  if (level.artifact === HiveArtifact.LEAF) {
    return level.merged && windows
      ? windows.map((window) => leafPath(manifest, shardId, window))
      : [leafPath(manifest, shardId)];
  }
  if (level.artifact === HiveArtifact.COLUMN) {
    return level.merged && windows
      ? windows.map((window) => `${components}/${window}.pyramid.zarr`)
      : [`${components}/all.pyramid.zarr`];
  }
  return [`${components}/all.zarr`];
}

/** Fill every level's node map from the covered shard ids. */
function placeNodes(
  levels: THiveLevel[],
  shardIds: string[],
  manifest: HiveManifest
) {
  const windows = windowLabels(manifest);
  for (const level of levels) {
    for (const shardId of shardIds) {
      const id = ancestorId(shardId, level.nodeOrder);
      const rank = nestedRank(id);
      if (level.nodes.has(rank)) {
        continue;
      }
      const components = hiveComponents(id, manifest.pathGrouping).join("/");
      level.nodes.set(
        rank,
        nodeDirs(level, shardId, components, manifest, windows)
      );
    }
  }
}

/**
 * How a merged level's array merges across windows: a field the manifest
 * sums exactly by addition, a t-digest by concatenation; anything else (the
 * located and timed siblings, a packed field) is not merged and has no chunk.
 */
function mergeKind(
  manifest: HiveManifest,
  name: string,
  attributes: unknown
): TMergeKind | undefined {
  const multiscales = manifest.raw.multiscales;
  const block = Array.isArray(multiscales) ? multiscales[0] : undefined;
  const fields = isRecord(block) && isRecord(block.fields) ? block.fields : {};
  if (
    fields[name] === "exact" ||
    (!Object.keys(fields).length && name === "count")
  ) {
    return "sum";
  }
  return Object.keys(digestVariablesOf(name, attributes)).length
    ? "digest"
    : undefined;
}

/**
 * A merged array as served: a sum as float64 (the per-window `count` is
 * int64, which no texture holds), a digest as plain `vlen-bytes`; both
 * uncompressed, since the merge re-encodes.
 */
function mergedMetadata(metadata: TJson, merge: TMergeKind): TJson {
  return merge === "sum"
    ? { ...metadata, data_type: "float64", codecs: [LITTLE_ENDIAN_BYTES] } // eslint-disable-line camelcase
    : { ...metadata, codecs: [VLEN_BYTES] };
}

/** Undo an inner codec list's bytes-to-bytes codecs, last to first. */
async function bytesDecoder(codecs: unknown[]) {
  const stages: {
    decode(bytes: Uint8Array): Promise<Uint8Array> | Uint8Array;
  }[] = [];
  for (const codec of codecs.slice(1)) {
    if (!isRecord(codec) || typeof codec.name !== "string") {
      continue;
    }
    const entry = await zarr.registry.get(codec.name)?.();
    if (!entry) {
      throw new Error(`unknown codec ${codec.name}`);
    }
    stages.unshift(
      (await entry.fromConfig(codec.configuration ?? {}, {} as never)) as never
    );
  }
  return async (bytes: Uint8Array) => {
    let decoded = bytes;
    for (const stage of stages) {
      decoded = await stage.decode(decoded);
    }
    return decoded;
  };
}

/** The per-window chunks of a merged array, merged, as the view's bytes. */
async function mergeChunks(
  parts: Uint8Array[],
  view: TArrayView,
  dataType: string
): Promise<Uint8Array> {
  const unpack = await bytesDecoder(view.innerCodecs);
  const raw = await Promise.all(parts.map((part) => unpack(part)));
  if (view.merge === "digest") {
    const merged = mergeDigestChunks(
      raw.map((bytes) => digestChunkFromVlen(decodeVlenChunk(bytes)))
    );
    return encodeVlenChunk(vlenFromDigestChunk(merged!));
  }
  const type = DENSE_TYPES[dataType as keyof typeof DENSE_TYPES];
  if (!type) {
    throw new Error(`unsupported data type ${dataType}`);
  }
  let out: Float64Array | undefined;
  for (const bytes of raw) {
    const values = new type(bytes.slice().buffer);
    out ??= new Float64Array(values.length);
    for (let i = 0; i < values.length; i++) {
      out[i] += Number(values[i]);
    }
  }
  return new Uint8Array(out!.buffer);
}

/**
 * The repo-shaped metadata of an object's array: the whole sphere behind a
 * row axis, chunked by the object's inner chunk, with the inner codecs.
 */
function viewArrayMetadata(
  meta: TJson,
  cellOrder: number,
  rows: number
): TArrayView {
  const codecs = Array.isArray(meta.codecs) ? meta.codecs : [];
  const sharding = codecs.find(
    (codec) => isRecord(codec) && codec.name === "sharding_indexed"
  );
  const config =
    isRecord(sharding) && isRecord(sharding.configuration)
      ? sharding.configuration
      : undefined;
  const chunkGrid = isRecord(meta.chunk_grid) ? meta.chunk_grid : {};
  const gridConfig = isRecord(chunkGrid.configuration)
    ? chunkGrid.configuration
    : {};
  const inner = (config?.chunk_shape ?? gridConfig.chunk_shape) as number[];
  const shape = meta.shape as number[];
  const names = Array.isArray(meta.dimension_names)
    ? meta.dimension_names
    : ["cells"];
  return {
    metadata: {
      ...meta,
      shape: [rows, 12 * 4 ** cellOrder, ...shape.slice(1)],
      // eslint-disable-next-line camelcase
      chunk_grid: {
        name: "regular",
        configuration: { chunk_shape: [1, ...inner] }, // eslint-disable-line camelcase
      },
      // eslint-disable-next-line camelcase
      chunk_key_encoding: {
        name: "default",
        configuration: { separator: "/" },
      },
      codecs: config?.codecs ?? codecs,
      // eslint-disable-next-line camelcase
      dimension_names: ["window", ...names],
      // eslint-disable-next-line camelcase
      storage_transformers: [],
    },
    innerChunk: inner[0],
    innerCodecs: Array.isArray(config?.codecs) ? config.codecs : codecs,
  };
}

/** `(offset, length)` per inner chunk from a shard index suffix. */
function parseShardIndex(bytes: Uint8Array, chunks: number): TIndexEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: TIndexEntry[] = [];
  for (let i = 0; i < chunks; i++) {
    const offset = view.getBigUint64(i * INDEX_ENTRY_BYTES, true);
    const length = view.getBigUint64(i * INDEX_ENTRY_BYTES + 8, true);
    entries.push(
      offset === ABSENT || length === ABSENT
        ? undefined
        : { offset: Number(offset), length: Number(length) }
    );
  }
  return entries;
}

// eslint-disable-next-line max-lines-per-function
function createHiveReader(
  inner: zarr.AsyncReadable,
  manifest: HiveManifest,
  levels: THiveLevel[],
  rows: number
) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const cache = new Map<string, Promise<unknown>>();
  const derived: TDerived = new Map();
  const pooled: TPooled = { orders: [], names: [] };
  // Every derived fact is computed once per key, however many chunks ask.
  function once<T>(key: string, compute: () => Promise<T>): Promise<T> {
    let pending = cache.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = compute();
      cache.set(key, pending);
    }
    return pending;
  }
  async function json(path: string): Promise<TJson | undefined> {
    const bytes = await inner.get(`/${path}`);
    return bytes ? (JSON.parse(decoder.decode(bytes)) as TJson) : undefined;
  }
  function level(cellOrder: number) {
    return levels.find((candidate) => candidate.cellOrder === cellOrder);
  }
  /**
   * The directory of one of a node's objects: a versioned leaf names its
   * run; undefined where the object is absent (a window the node lacks)
   * and `probe` says to look.
   */
  function objectDir(dir: string, probe: boolean) {
    return once(`dir:${dir}`, async () => {
      const stamp = (await json(`${dir}/zarr.json`))?.attributes;
      if (stamp === undefined && probe) {
        return undefined;
      }
      const commit = isRecord(stamp) ? stamp.morton_hive_commit : undefined;
      const current = isRecord(commit) ? commit.current : undefined;
      return typeof current === "string" ? `${dir}/${current}` : dir;
    });
  }
  /** The directories of a node's arrays present: one, or one per window. */
  async function nodeDirs(target: THiveLevel, rank: number) {
    const dirs = target.nodes.get(rank) ?? [];
    if (!target.merged || dirs.length === 0) {
      return target.artifact === HiveArtifact.LEAF && dirs.length
        ? [await objectDir(dirs[0], false)]
        : dirs;
    }
    const present = await Promise.all(dirs.map((dir) => objectDir(dir, true)));
    return present.filter((dir) => dir !== undefined);
  }
  async function templateDir(target: THiveLevel) {
    const first = target.nodes.keys().next();
    return first.done ? undefined : (await nodeDirs(target, first.value))[0];
  }
  function arrayView(target: THiveLevel, name: string) {
    return once(`array:${target.cellOrder}/${name}`, async () => {
      const dir = await templateDir(target);
      const meta =
        dir === undefined
          ? undefined
          : await json(`${dir}/${target.cellOrder}/${name}/zarr.json`);
      if (!meta) {
        return undefined;
      }
      const view = viewArrayMetadata(meta, target.cellOrder, rows);
      const merge = target.merged
        ? mergeKind(manifest, name, meta.attributes)
        : undefined;
      return merge
        ? { ...view, merge, metadata: mergedMetadata(view.metadata, merge) }
        : view;
    });
  }
  /** The windows the template leaf node holds (1 for an unwindowed store). */
  async function windowCount() {
    const first = levels[0].nodes.keys().next();
    return first.done || !levels[0].merged
      ? 1
      : Math.max((await nodeDirs(levels[0], first.value)).length, 1);
  }
  /** A leaf array on the grid of a derived level: chunk for chunk. */
  async function pooledView(order: number, name: string) {
    if (!pooled.orders.includes(order) || !pooled.names.includes(name)) {
      return undefined;
    }
    const view = await arrayView(levels[0], derived.get(name)?.array ?? name);
    const group = 4 ** (levels[0].cellOrder - order);
    return (
      view && {
        ...view.metadata,
        shape: [rows, 12 * 4 ** order],
        // eslint-disable-next-line camelcase
        chunk_grid: {
          name: "regular",
          configuration: { chunk_shape: [1, view.innerChunk / group] }, // eslint-disable-line camelcase
        },
      }
    );
  }
  /**
   * The leaf group's metadata at the order of a derived level, served as
   * every level group is: without the artifact's cell coordinate.
   */
  async function pooledGroup(order: number) {
    const meta = await once("group:leaf", async () => {
      const dir = await templateDir(levels[0]);
      return dir === undefined
        ? undefined
        : await json(`${dir}/${levels[0].cellOrder}/zarr.json`);
    });
    const attributes = isRecord(meta?.attributes) ? meta.attributes : {};
    return (
      meta &&
      levelGroup(
        encoder.encode(
          JSON.stringify({
            ...meta,
            attributes: {
              ...attributes,
              ...(isRecord(attributes.dggs)
                ? { dggs: { ...attributes.dggs, refinement_level: order } } // eslint-disable-line camelcase
                : {}),
            },
          })
        )
      )
    );
  }
  function shardIndex(objectKey: string, chunks: number) {
    return once(`index:${objectKey}`, async () => {
      const bytes = await inner.getRange!(`/${objectKey}`, {
        suffixLength: chunks * INDEX_ENTRY_BYTES + INDEX_CHECKSUM_BYTES,
      });
      return bytes ? parseShardIndex(bytes, chunks) : [];
    });
  }
  /** One object's inner chunk, as stored. */
  async function objectChunk(
    objectKey: string,
    perNode: number,
    index: number
  ) {
    if (perNode === 1) {
      return await inner.get(`/${objectKey}`);
    }
    const entry = (await shardIndex(objectKey, perNode))[index % perNode];
    return entry && (await inner.getRange!(`/${objectKey}`, entry));
  }
  async function chunk(match: RegExpMatchArray) {
    const [, order, name, row, index] = match;
    const target = level(Number(order));
    if (!target || Number(row) >= rows || derived.has(name)) {
      return undefined;
    }
    const view = await arrayView(target, name);
    if (!view || (target.merged && !view.merge)) {
      return undefined;
    }
    const perNode =
      4 ** (target.cellOrder - target.nodeOrder) / view.innerChunk;
    const dirs = await nodeDirs(target, Math.floor(Number(index) / perNode));
    const parts = await Promise.all(
      dirs.map((dir) =>
        dir === undefined
          ? undefined
          : objectChunk(
              `${dir}/${target.cellOrder}/${name}/c/0`,
              perNode,
              Number(index)
            )
      )
    );
    const present = parts.filter((part) => part !== undefined);
    if (!view.merge || present.length === 0) {
      return present[0];
    }
    const dir = await templateDir(target);
    const meta = await json(`${dir}/${target.cellOrder}/${name}/zarr.json`);
    return await mergeChunks(present, view, String(meta?.data_type));
  }
  function rootMetadata() {
    return encoder.encode(
      JSON.stringify({
        // eslint-disable-next-line camelcase
        zarr_format: 3,
        // eslint-disable-next-line camelcase
        node_type: "group",
        attributes: {
          multiscales: rootMultiscales(manifest, levels),
          ...(pooled.orders.length
            ? {
                // eslint-disable-next-line camelcase
                derived_levels: {
                  dataset: String(levels[0].cellOrder),
                  cells: pooled.orders,
                },
              }
            : {}),
          // eslint-disable-next-line camelcase
          morton_hive: manifest.raw,
        },
      })
    );
  }
  async function get(key: zarr.AbsolutePath) {
    if (key === "/zarr.json") {
      return rootMetadata();
    }
    const group = GROUP_KEY.exec(key);
    if (group) {
      if (pooled.orders.includes(Number(group[1]))) {
        return await pooledGroup(Number(group[1]));
      }
      const target = level(Number(group[1]));
      const dir = target && (await templateDir(target));
      const bytes =
        dir === undefined
          ? undefined
          : await inner.get(`/${dir}/${target!.cellOrder}/zarr.json`);
      return bytes && levelGroup(bytes);
    }
    const array = ARRAY_KEY.exec(key);
    if (array) {
      const target = level(Number(array[1]));
      const variable = derived.get(array[2]);
      const metadata = target
        ? (await arrayView(target, variable?.array ?? array[2]))?.metadata
        : await pooledView(Number(array[1]), array[2]);
      return (
        metadata &&
        encoder.encode(
          JSON.stringify(
            variable
              ? digestVariableMetadata(metadata, variable.attributes)
              : metadata
          )
        )
      );
    }
    const match = CHUNK_KEY.exec(key);
    return match ? await chunk(match) : undefined;
  }
  return { get, arrayView, derived, pooled, windowCount };
}

/**
 * The arrays every level lists: the manifest's fields, the located and
 * timed siblings the leaf template declares for them, and the variables
 * derived from a t-digest field.
 */
async function arrayNames(
  reader: ReturnType<typeof createHiveReader>,
  manifest: HiveManifest,
  leaf: THiveLevel
) {
  const multiscales = manifest.raw.multiscales;
  const block = Array.isArray(multiscales) ? multiscales[0] : undefined;
  const fields = isRecord(block) && isRecord(block.fields) ? block.fields : {};
  // ponytail: a store without a multiscales block lists `count` alone.
  const names = new Set(
    Object.keys(fields).length ? Object.keys(fields) : ["count"]
  );
  for (const name of [...names]) {
    const attrs = (await reader.arrayView(leaf, name))?.metadata.attributes;
    for (const [variable, { array, attributes }] of Object.entries(
      digestVariablesOf(name, attrs)
    )) {
      reader.derived.set(variable, { array, attributes });
      names.add(variable);
    }
    const ragged = isRecord(attrs) ? attrs.ragged : undefined;
    for (const sibling of [
      isRecord(ragged) ? ragged.locations : undefined,
      isRecord(attrs) ? attrs.times : undefined,
    ]) {
      if (typeof sibling === "string") {
        names.add(sibling);
      }
    }
  }
  return [...names];
}

/**
 * The levels computed from the leaves: every order the store does not hold
 * from the leaf chunk's (one chunk, one cell) up to `POINT_TIER_ORDERS`
 * below the leaves, and only under a stored level, which is what a viewer
 * loads whole. Their arrays are the fields that sum exactly (`count`) and
 * the digest variables.
 */
async function pooledLevels(
  reader: ReturnType<typeof createHiveReader>,
  manifest: HiveManifest,
  levels: THiveLevel[]
): Promise<TPooled> {
  const multiscales = manifest.raw.multiscales;
  const block = Array.isArray(multiscales) ? multiscales[0] : undefined;
  const fields = isRecord(block) && isRecord(block.fields) ? block.fields : {};
  const sums = Object.keys(fields).filter((name) => fields[name] === "exact");
  const [leaf, ...stored] = levels;
  const inner = sums.length
    ? (await reader.arrayView(leaf, sums[0]))?.innerChunk
    : undefined;
  const chunkOrder = leaf.cellOrder - Math.log2(inner ?? NaN) / 2;
  if (stored.length === 0 || !Number.isInteger(chunkOrder)) {
    return { orders: [], names: [] };
  }
  const held = Math.max(...stored.map(({ cellOrder }) => cellOrder));
  const orders: number[] = [];
  const finest = leaf.cellOrder - POINT_TIER_ORDERS;
  for (let order = finest; order >= chunkOrder; order--) {
    if (order > held) {
      orders.push(order);
    }
  }
  return { orders, names: [...sums, ...reader.derived.keys()] };
}

function listContents(
  levels: THiveLevel[],
  names: string[],
  pooled: TPooled
): TContents {
  const contents: TContents = [{ path: "/", kind: "group" }];
  const groups = [
    ...levels.map(({ cellOrder }) => ({ cellOrder, names })),
    ...pooled.orders.map((cellOrder) => ({ cellOrder, names: pooled.names })),
  ];
  for (const group of groups) {
    contents.push({ path: `/${group.cellOrder}`, kind: "group" });
    for (const name of group.names) {
      contents.push({ path: `/${group.cellOrder}/${name}`, kind: "array" });
    }
  }
  return contents;
}

export function isHiveStorePath(storePath: string) {
  return storePath.startsWith(HIVE_PREFIX);
}

/** The manifest and the root coverage, the two objects every path follows. */
async function readRoot(store: zarr.AsyncReadable, rootUrl: string) {
  const decoder = new TextDecoder();
  const [manifestBytes, coverageBytes] = await Promise.all([
    store.get(`/${MANIFEST_NAME}`),
    store.get(`/${COVERAGE_NAME}`),
  ]);
  if (!manifestBytes) {
    throw new Error(
      `${rootUrl} is not a morton-hive store: no ${MANIFEST_NAME}`
    );
  }
  const manifest = parseHiveManifest(JSON.parse(decoder.decode(manifestBytes)));
  // a windowed store is read as its all-time product: the per-window
  // objects merged on read (see the module note); `windowLabels` refuses a
  // schedule it cannot enumerate
  windowLabels(manifest);
  const coverage = coverageBytes
    ? parseRootCoverage(JSON.parse(decoder.decode(coverageBytes)))
    : null;
  if (!coverage) {
    throw new Error(COVERAGE_ENCODING_UNSUPPORTED);
  }
  return { manifest, coverage };
}

/**
 * Open a morton-hive store root (the URL after `hive+`) as a listable zarr
 * v3 store. `inner` replaces the HTTP store behind it (tests).
 */
export async function createHiveStore(
  rootUrl: string,
  inner?: zarr.AsyncReadable
): Promise<THiveStore> {
  const store =
    inner ??
    zarr.extendStore(
      new zarr.FetchStore(rootUrl.replace(/\/+$/, ""), {
        useSuffixRequest: true,
      }),
      (s) => zarr.withRangeCoalescing(s, { coalesceSize: COALESCE_SIZE })
    );
  const { manifest, coverage } = await readRoot(store, rootUrl);
  const levels = manifestLevels(manifest);
  placeNodes(levels, rangesShardIds(coverage), manifest);
  const reader = createHiveReader(store, manifest, levels, 1);
  nodesByRoot.set(rootKey(rootUrl), {
    levels,
    windows: await reader.windowCount(),
  });
  const names = await arrayNames(reader, manifest, levels[0]);
  Object.assign(reader.pooled, await pooledLevels(reader, manifest, levels));
  const contents = listContents(levels, names, reader.pooled);
  return {
    get: reader.get,
    async getRange(key, range) {
      // ponytail: the view's arrays are unsharded, so zarrita never ranges
      // into a chunk; the outer coalescer only needs the method to exist.
      const bytes = await reader.get(key);
      if (!bytes) {
        return undefined;
      }
      return "suffixLength" in range
        ? bytes.slice(Math.max(bytes.length - range.suffixLength, 0))
        : bytes.slice(range.offset, range.offset + range.length);
    },
    contents: () => contents,
  };
}
