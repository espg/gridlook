import type * as healpixGeo from "healpix-geo";
import type * as THREE from "three";
import type * as zarr from "zarrita";

import { coarserLevels } from "@/lib/data/levels.ts";
import { digestVariableOf } from "@/lib/digest/digestVariables.ts";
import type { TFaceParts } from "@/lib/grids/healpixBlockFetch.ts";
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

/** The faces of a level as read over its window, and as built. */
type TLevelField = {
  key: string;
  grid: healpixGeo.Grid;
  cellsPerBlock: number;
  parts: TFaceParts;
  batches: THealpixBatch[];
};

/**
 * How many levels' fields are kept: the level on screen and the one beneath
 * it. Zooming in, the level on screen becomes the one beneath with no read;
 * zooming out, the level beneath comes on screen reading only the blocks
 * its window gains. A field is one window (at most the view cap of cells,
 * or the byte budget's worth of digest cells) as values, cell ids and the
 * textures built from them; the coarsest level, loaded whole, is kept
 * beside these for the colour range.
 */
const KEPT_FIELDS = 2;

const cellsPerBlockOf = (level: Pick<TReadLevel, "grid" | "blockDepth">) =>
  4 **
  (level.grid.level - healpixBlockLevel(level.grid.level, level.blockDepth));

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
 * parent instead of nothing. The fields read are kept (`KEPT_FIELDS`) so
 * that a zoom between neighbouring levels reads only what is new.
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
}) {
  const store = useGlobeControlStore();
  const fields = new Map<number, TLevelField>();
  let shown: TBeneath | undefined;

  /** The blocks a part of a face covers. */
  function blocksOf(
    part: { range: { start: number; end: number } },
    cellsPerBlock: number
  ) {
    const blocks: number[] = [];
    for (
      let block = Math.floor(part.range.start / cellsPerBlock);
      block < Math.ceil(part.range.end / cellsPerBlock);
      block++
    ) {
      blocks.push(block);
    }
    return blocks;
  }

  /**
   * What a level's window can take from its kept field: the parts that
   * reach into `blocks`, by face, and the blocks still to read.
   */
  function take(index: number, key: string, blocks: number[]) {
    const field = fields.get(index);
    if (!field || field.key !== key) {
      return { seed: new Map() as TFaceParts, missing: blocks };
    }
    const required = new Set(blocks);
    const have = new Set<number>();
    const seed: TFaceParts = new Map();
    for (const [face, parts] of field.parts) {
      const kept = parts.filter((part) =>
        blocksOf(part, field.cellsPerBlock).some((block) => required.has(block))
      );
      for (const part of kept) {
        blocksOf(part, field.cellsPerBlock).forEach((block) => have.add(block));
      }
      if (kept.length > 0) {
        seed.set(face, kept);
      }
    }
    return { seed, missing: blocks.filter((block) => !have.has(block)) };
  }

  /** Keep a level's field as read and built over its window. */
  function keep(
    index: number,
    key: string,
    level: Pick<TReadLevel, "grid" | "blockDepth">,
    parts: TFaceParts,
    batches: THealpixBatch[]
  ) {
    fields.set(index, {
      key,
      grid: level.grid,
      cellsPerBlock: cellsPerBlockOf(level),
      parts,
      batches,
    });
  }

  /** Let go of every field but those of `indices` (at most `KEPT_FIELDS`). */
  function retain(indices: (number | undefined)[]) {
    const wanted = indices.filter((index) => index !== undefined);
    for (const index of [...fields.keys()]) {
      if (!wanted.slice(0, KEPT_FIELDS).includes(index)) {
        fields.delete(index);
      }
    }
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

  /** Draw a level's window beneath, reading only what its field lacks. */
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
    const field = fields.get(index);
    if (field && missing.length === 0) {
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
    coarsest?: Pick<TBeneath, "index" | "key" | "grid" | "batches">
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
        shown = {
          ...beneathOf(
            index,
            coarsest.key,
            { grid: coarsest.grid, sources: selected },
            coarsest.batches
          ),
        };
        options.show(shown);
        return shown;
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
      // the fields of the level and of this parent only, before the read
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
    lookup,
    /** The level drawn beneath now, if any. */
    beneath: () => shown,
  };
}
