import * as zarr from "zarrita";

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
 * Nothing is listed: the manifest plus the root coverage name every node.
 * The per-cell `morton` coordinate is never read (a windowed leaf has none:
 * the cell is the nested index).
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
  // nested rank at `nodeOrder` -> store-relative directory holding
  // `{cellOrder}/{name}/...` for that node
  nodes: Map<number, string>;
};

type TJson = Record<string, unknown>;
type TIndexEntry = { offset: number; length: number } | undefined;
type TContents = { path: zarr.AbsolutePath; kind: "array" | "group" }[];

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
  const levels: THiveLevel[] = [
    {
      cellOrder: manifest.cellOrder,
      nodeOrder: manifest.shardOrder,
      artifact: HiveArtifact.LEAF,
      nodes: new Map(),
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
      levels.push({ cellOrder, nodeOrder, artifact, nodes: new Map() });
    }
  }
  return levels;
}

/** Fill every level's node map from the covered shard ids. */
function placeNodes(
  levels: THiveLevel[],
  shardIds: string[],
  manifest: HiveManifest
) {
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
        level.artifact === HiveArtifact.LEAF
          ? leafPath(manifest, shardId)
          : `${components}/${level.artifact === HiveArtifact.COLUMN ? "all.pyramid" : "all"}.zarr`
      );
    }
  }
}

/**
 * The repo-shaped metadata of an object's array: the whole sphere behind a
 * row axis, chunked by the object's inner chunk, with the inner codecs.
 */
function viewArrayMetadata(
  meta: TJson,
  cellOrder: number,
  rows: number
): { metadata: TJson; innerChunk: number } {
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
  /** The directory of a node's arrays; a versioned leaf names its run. */
  function nodeDir(target: THiveLevel, rank: number) {
    const dir = target.nodes.get(rank);
    if (dir === undefined || target.artifact !== HiveArtifact.LEAF) {
      return Promise.resolve(dir);
    }
    return once(`dir:${dir}`, async () => {
      const stamp = (await json(`${dir}/zarr.json`))?.attributes;
      const commit = isRecord(stamp) ? stamp.morton_hive_commit : undefined;
      const current = isRecord(commit) ? commit.current : undefined;
      return typeof current === "string" ? `${dir}/${current}` : dir;
    });
  }
  function templateDir(target: THiveLevel) {
    const first = target.nodes.keys().next();
    return first.done
      ? Promise.resolve(undefined)
      : nodeDir(target, first.value);
  }
  function arrayView(target: THiveLevel, name: string) {
    return once(`array:${target.cellOrder}/${name}`, async () => {
      const dir = await templateDir(target);
      const meta =
        dir === undefined
          ? undefined
          : await json(`${dir}/${target.cellOrder}/${name}/zarr.json`);
      return meta && viewArrayMetadata(meta, target.cellOrder, rows);
    });
  }
  function shardIndex(objectKey: string, chunks: number) {
    return once(`index:${objectKey}`, async () => {
      const bytes = await inner.getRange!(`/${objectKey}`, {
        suffixLength: chunks * INDEX_ENTRY_BYTES + INDEX_CHECKSUM_BYTES,
      });
      return bytes ? parseShardIndex(bytes, chunks) : [];
    });
  }
  async function chunk(match: RegExpMatchArray) {
    const [, order, name, row, index] = match;
    const target = level(Number(order));
    if (!target || Number(row) >= rows) {
      return undefined;
    }
    const view = await arrayView(target, name);
    if (!view) {
      return undefined;
    }
    const perNode =
      4 ** (target.cellOrder - target.nodeOrder) / view.innerChunk;
    const dir = await nodeDir(target, Math.floor(Number(index) / perNode));
    if (dir === undefined) {
      return undefined;
    }
    const objectKey = `${dir}/${target.cellOrder}/${name}/c/0`;
    if (perNode === 1) {
      return await inner.get(`/${objectKey}`);
    }
    const entry = (await shardIndex(objectKey, perNode))[
      Number(index) % perNode
    ];
    return entry && (await inner.getRange!(`/${objectKey}`, entry));
  }
  async function get(key: zarr.AbsolutePath) {
    if (key === "/zarr.json") {
      return encoder.encode(
        JSON.stringify({
          // eslint-disable-next-line camelcase
          zarr_format: 3,
          // eslint-disable-next-line camelcase
          node_type: "group",
          attributes: {
            multiscales: rootMultiscales(manifest, levels),
            // eslint-disable-next-line camelcase
            morton_hive: manifest.raw,
          },
        })
      );
    }
    const group = GROUP_KEY.exec(key);
    if (group) {
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
      const view = target && (await arrayView(target, array[2]));
      return view && encoder.encode(JSON.stringify(view.metadata));
    }
    const match = CHUNK_KEY.exec(key);
    return match ? await chunk(match) : undefined;
  }
  return { get, arrayView };
}

/**
 * The arrays every level lists: the manifest's fields plus the located and
 * timed siblings the leaf template declares for them.
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

function listContents(levels: THiveLevel[], names: string[]): TContents {
  const contents: TContents = [{ path: "/", kind: "group" }];
  for (const level of levels) {
    contents.push({ path: `/${level.cellOrder}`, kind: "group" });
    for (const name of names) {
      contents.push({ path: `/${level.cellOrder}/${name}`, kind: "array" });
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
  if (manifest.version !== 1) {
    // ponytail: windowed stores add a row per window (spec §11.2).
    throw new Error(
      `windowed hive stores (${manifest.spec}) are not supported yet`
    );
  }
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
  const contents = listContents(
    levels,
    await arrayNames(reader, manifest, levels[0])
  );
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
