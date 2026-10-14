import type * as healpixGeo from "healpix-geo";
import type * as THREE from "three";
import type * as zarr from "zarrita";

import { coarserLevels } from "@/lib/data/levels.ts";
import { digestVariableOf } from "@/lib/digest/digestVariables.ts";
import {
  blockParts,
  createBlockCache,
  type TFaceParts,
} from "@/lib/grids/healpixBlockFetch.ts";
import {
  decodeHealpixFaceXY,
  type THealpixDataRect,
} from "@/lib/grids/healpixCalculations.ts";
import {
  healpixBlockDepth,
  healpixBlockLevel,
  viewWindowMargin,
} from "@/lib/grids/healpixWindow.ts";
import type { THealpixBatch } from "@/lib/grids/healpixWorkerProtocol.ts";
import type { createSortedCells } from "@/lib/grids/sortedCells.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

type TDataVar = zarr.Array<zarr.DataType, zarr.AsyncReadable>;
type TIndices = (number | zarr.Slice | null)[];

/** A level and the array of the variable shown, as the grid reads them. */
export type TReadLevel = {
  /** The dataset with this level selected. */
  sources: TSources;
  datavar: TDataVar;
  grid: healpixGeo.Grid;
  /** Orders between the level's cells and the blocks of its window. */
  blockDepth?: number;
  /** Cells of one chunk of the variable. */
  chunkCells: number;
  /** Whether the variable is derived from a t-digest (priced in bytes). */
  digest: boolean;
  /** The coordinate reader of a sparse level; a dense one is read by index. */
  sortedCells?: ReturnType<typeof createSortedCells>;
};

/** A level drawn beneath the one on screen, over the same ground. */
export type TBeneath = {
  index: number;
  name: string;
  key: string;
  grid: healpixGeo.Grid;
  sources: TSources;
  batches: THealpixBatch[];
};

/**
 * The faces of a level as last built over its window: the blocks it holds
 * and its textures. The blocks are kept in the cache (never let go while
 * the level is on screen or beneath); the textures go with the level.
 */
type TBuiltField = {
  key: string;
  blocks: Set<number>;
  batches: THealpixBatch[];
};

const cellsPerBlockOf = (level: Pick<TReadLevel, "grid" | "blockDepth">) =>
  4 **
  (level.grid.level - healpixBlockLevel(level.grid.level, level.blockDepth));

/** The centres of a level's blocks, lon and lat interleaved (degrees). */
function blockCentres(
  level: Pick<TReadLevel, "grid" | "blockDepth">,
  blocks: number[]
) {
  const { grid, blockDepth } = level;
  using blockGrid = grid.replace({
    level: healpixBlockLevel(grid.level, blockDepth),
    scheme: "nested",
  });
  return blockGrid.healpixToLonLat(BigUint64Array.from(blocks, BigInt));
}

/**
 * The value a drawn face holds for a point, from the texture itself: the
 * cell's centre and its value, null where the cell is blank, or undefined
 * where no face is drawn.
 */
export function faceValue(
  meshes: readonly (THREE.Mesh | undefined)[],
  grid: healpixGeo.Grid,
  lon: number,
  lat: number
) {
  const ids = grid.lonLatToHealpix(Float64Array.of(lon, lat));
  const pixel = Number(ids[0]);
  const faceSize = grid.nside ** 2;
  const mesh = meshes[Math.floor(pixel / faceSize)];
  if (!mesh) {
    return undefined;
  }
  const texture = (mesh.material as THREE.ShaderMaterial).uniforms.data
    .value as THREE.DataTexture;
  // the same array as the texture: no second copy of the field
  const data = texture.image.data as Float32Array;
  const rect = mesh.userData.dataRect as THealpixDataRect;
  const { x, y } = decodeHealpixFaceXY(pixel % faceSize);
  const localX = x - Math.round(rect.u * grid.nside);
  const localY = y - Math.round(rect.v * grid.nside);
  const inRect =
    localX >= 0 &&
    localX < texture.image.width &&
    localY >= 0 &&
    localY < texture.image.height;
  const value = inRect ? data[localY * texture.image.width + localX] : NaN;
  const centre = grid.healpixToLonLat(ids);
  return {
    pixel,
    lat: centre[1],
    lon: ProjectionHelper.normalizeLongitude(centre[0]),
    value: Number.isFinite(value) ? value : null,
  };
}

/**
 * The next coarser level drawn beneath a level loaded by view. Before the
 * level's own blocks stream in, the window of the parent level (the next
 * coarser stored level whose window fits its budget at this view, or else
 * the coarsest, which is loaded whole) is read and drawn beneath, so that
 * the cells not yet landed, and those the budget leaves out, show the
 * parent instead of nothing. The blocks read are kept in a cache bounded by
 * decoded bytes (`createBlockCache`), so that a pan back or a zoom between
 * levels reads only what it has not held.
 */
// eslint-disable-next-line max-lines-per-function
export function useAncestorFill(options: {
  getDatasources: () => TSources | undefined;
  /** The grid and the variable's array of a level; undefined without one. */
  describe: (
    sources: TSources
  ) => Promise<Pick<TReadLevel, "datavar" | "grid"> | undefined>;
  /**
   * The blocks of a level's window at the view, and whether the budget cut
   * into the view itself.
   */
  window: (
    level: TReadLevel,
    margin: number
  ) => { blocks: number[]; clipped: boolean };
  /**
   * Read `blocks` of a level and draw its faces beneath as they land, with
   * the parts of `seed` already in; the faces read and built.
   */
  read: (
    level: TReadLevel,
    blocks: number[],
    seed: TFaceParts,
    key: string,
    indices: TIndices,
    isCurrent: () => boolean
  ) => Promise<{ parts: TFaceParts; batches: THealpixBatch[] } | undefined>;
  /** Draw a level kept in memory beneath, or nothing. */
  show: (beneath: TBeneath | undefined) => void;
  /** The meshes drawn beneath. */
  meshes: readonly (THREE.Mesh | undefined)[];
  /** Decoded bytes the block cache may hold (`DEFAULT_BLOCK_CACHE_BYTES`). */
  cacheBytes?: number;
}) {
  const store = useGlobeControlStore();
  const cache = createBlockCache(options.cacheBytes);
  const built = new Map<number, TBuiltField>();
  let shown: TBeneath | undefined;

  /**
   * What a level's window can take from the cache: the parts of the blocks
   * it holds, by face, and the blocks still to read. A block is one part, so
   * the parts seeded are disjoint, and none of them is read again.
   */
  function take(index: number, key: string, blocks: number[]) {
    const seed: TFaceParts = new Map();
    const missing: number[] = [];
    for (const block of blocks) {
      const held = cache.get(index, key, block);
      if (!held) {
        missing.push(block);
      } else if (seed.has(held.face)) {
        seed.get(held.face)!.push(held.part);
      } else {
        seed.set(held.face, [held.part]);
      }
    }
    return { seed, missing };
  }

  /** Let the blocks farthest from the camera go, past the cache's bound. */
  function evict() {
    cache.evict(
      store.viewFootprint ?? { centreLon: 0, centreLat: 0 },
      (index, block) => built.get(index)?.blocks.has(block) ?? false
    );
  }

  /** Hold the parts of a level in the cache, block by block; their blocks. */
  function hold(
    index: number,
    key: string,
    level: Pick<TReadLevel, "grid" | "blockDepth">,
    parts: TFaceParts
  ) {
    const cellsPerBlock = cellsPerBlockOf(level);
    const cut = [...parts].flatMap(([face, faceParts]) =>
      faceParts.flatMap((part) =>
        blockParts(part, cellsPerBlock).map((held) => ({ face, ...held }))
      )
    );
    const centres = blockCentres(
      level,
      cut.map(({ block }) => block)
    );
    cut.forEach(({ face, block, part }, at) =>
      cache.add(index, key, block, {
        face,
        part,
        lon: centres[2 * at],
        lat: centres[2 * at + 1],
      })
    );
    return cut.map(({ block }) => block);
  }

  /**
   * Keep a level's field as read and built over its window: its blocks join
   * the cache, held while the level is on screen or beneath, and its
   * textures are kept for a redraw with no read.
   */
  function keep(
    index: number,
    key: string,
    level: Pick<TReadLevel, "grid" | "blockDepth">,
    parts: TFaceParts,
    batches: THealpixBatch[]
  ) {
    const blocks = new Set(hold(index, key, level, parts));
    built.set(index, { key, blocks, batches });
    evict();
  }

  /**
   * Let go of the textures of every level but those of `indices` (the level
   * on screen and the one beneath): the blocks of the others stay in the
   * cache, now free to go, while its bound holds.
   */
  function retain(indices: (number | undefined)[]) {
    for (const index of [...built.keys()]) {
      if (!indices.includes(index)) {
        built.delete(index);
      }
    }
    evict();
  }

  /** A dense nested level and its window's blocks, or nothing to window. */
  async function describeWindowed(sources: TSources) {
    const described = await options.describe(sources);
    if (!described) {
      return undefined;
    }
    const { datavar, grid } = described;
    if (
      grid.scheme !== "nested" ||
      datavar.shape.at(-1) !== 12 * grid.nside ** 2
    ) {
      return undefined;
    }
    const chunkCells = datavar.chunks.at(-1)!;
    return {
      ...described,
      sources,
      chunkCells,
      blockDepth: healpixBlockDepth(chunkCells),
      digest: digestVariableOf(datavar.attrs) !== undefined,
    };
  }

  function beneathOf(
    index: number,
    key: string,
    level: Pick<TReadLevel, "grid" | "sources">,
    batches: THealpixBatch[]
  ): TBeneath {
    const name = level.sources.levels[index].name ?? `level ${index}`;
    return {
      index,
      name,
      key,
      grid: level.grid,
      sources: level.sources,
      batches,
    };
  }

  /** Draw a level's window beneath, reading only what the cache lacks. */
  async function fill(
    index: number,
    level: TReadLevel,
    blocks: number[],
    key: string,
    indices: TIndices,
    isCurrent: () => boolean
  ) {
    const levelKey = `${index}:${key}`;
    const { seed, missing } = take(index, key, blocks);
    const field = built.get(index);
    if (
      field?.key === key &&
      blocks.every((block) => field.blocks.has(block))
    ) {
      shown = beneathOf(index, levelKey, level, field.batches);
      options.show(shown);
      return shown;
    }
    const read = await options.read(
      level,
      missing,
      seed,
      levelKey,
      indices,
      isCurrent
    );
    if (!read) {
      return undefined;
    }
    keep(index, key, level, read.parts, read.batches);
    shown = beneathOf(index, levelKey, level, read.batches);
    return shown;
  }

  type TCoarsest = Pick<TBeneath, "index" | "key" | "grid" | "batches">;

  function showCoarsest(sources: TSources, coarsest: TCoarsest) {
    shown = beneathOf(
      coarsest.index,
      coarsest.key,
      {
        grid: coarsest.grid,
        sources: { ...sources, selectedLevel: coarsest.index },
      },
      coarsest.batches
    );
    options.show(shown);
    return shown;
  }

  /**
   * Draw the coarsest level beneath a sparse level loaded whole, which
   * leaves the rest of the globe empty; undefined with the fill off.
   */
  function coarsestBeneath(coarsest: TCoarsest | undefined) {
    const sources = options.getDatasources();
    shown = undefined;
    if (!sources || !store.levelParentBeneath || !coarsest) {
      options.show(undefined);
      return undefined;
    }
    return showCoarsest(sources, coarsest);
  }

  /**
   * Draw the parent of the selected level beneath it: the next coarser
   * stored level whose window fits its budget at this view, read now or
   * kept from before, or the coarsest level when the walk reaches it.
   * Undefined with the fill off, or when nothing coarser can be shown.
   */
  async function loadBeneath(
    indices: TIndices,
    key: string,
    isCurrent: () => boolean,
    coarsest?: TCoarsest
  ) {
    const sources = options.getDatasources();
    shown = undefined;
    if (!sources || !store.levelParentBeneath) {
      options.show(undefined);
      return undefined;
    }
    for (const index of coarserLevels(
      sources.levels,
      sources.selectedLevel ?? 0
    )) {
      const selected = { ...sources, selectedLevel: index };
      if (index === coarsest?.index) {
        return showCoarsest(sources, coarsest);
      }
      const level = await describeWindowed(selected);
      if (!isCurrent()) {
        return undefined;
      }
      if (!level) {
        continue;
      }
      const window = options.window(
        level,
        viewWindowMargin(level.datavar.attrs)
      );
      if (window.clipped) {
        // over budget in view here (a trimmed margin is not): the next
        // coarser level is the parent instead
        continue;
      }
      // the textures of the level and of this parent only, before the read
      retain([sources.selectedLevel ?? 0, index]);
      return await fill(index, level, window.blocks, key, indices, isCurrent);
    }
    return undefined;
  }

  /**
   * The value of the level beneath at a point, with the level's name, where
   * it is drawn and has one.
   */
  function lookup(lon: number, lat: number) {
    const hit = shown && faceValue(options.meshes, shown.grid, lon, lat);
    return hit && hit.value !== null
      ? { ...hit, level: shown!.name }
      : undefined;
  }

  return {
    take,
    keep,
    retain,
    loadBeneath,
    coarsestBeneath,
    lookup,
    /** The level drawn beneath now, if any. */
    beneath: () => shown,
  };
}
