import type { Grid } from "healpix-geo";

import { blocksByDistance, healpixBlockRanges } from "./healpixWindow.ts";

import type { TAxisRange } from "@/lib/data/viewWindow.ts";

/** A run of cells of a view window read in one go, on one face. */
export type TBlockRange = TAxisRange & { face: number };

/** The cells of a range as read: their values and their ids. */
export type TRangeCells = { data: Float32Array; cells: number[] };

/**
 * Reads in flight at once: a little over the connections a browser opens
 * to one host, so that its queue never runs dry while the order is kept.
 */
const FETCH_CONCURRENCY = 8;

/**
 * The cell ranges of a window's blocks, the nearest to a point first. A
 * range is a run of neighbouring blocks within one chunk, placed by its
 * nearest block; read in this order, the cells under the camera land first.
 */
export function orderedBlockRanges(
  blockGrid: Grid,
  blocks: number[],
  cellsPerBlock: number,
  chunkCells: number,
  lon: number,
  lat: number
): TBlockRange[] {
  const rank = new Map(
    blocksByDistance(blockGrid, blocks, lon, lat).map((block, index) => [
      block,
      index,
    ])
  );
  const faceBlocks = 4 ** blockGrid.level;
  const ascending = [...blocks].sort((a, b) => a - b);
  return healpixBlockRanges(ascending, cellsPerBlock, chunkCells)
    .map((range) => {
      const first = range.start / cellsPerBlock;
      let nearest = Infinity;
      for (let block = first; block < range.end / cellsPerBlock; block++) {
        nearest = Math.min(nearest, rank.get(block)!);
      }
      return { range, face: Math.floor(first / faceBlocks), nearest };
    })
    .sort((a, b) => a.nearest - b.nearest)
    .map(({ range, face }) => ({ ...range, face }));
}

/**
 * Fetch `items` in order, at most `concurrency` at a time, and hand each
 * result over as it lands, in the order they land. `next` resolves with
 * undefined once nothing more will land; a fetch that fails makes it
 * throw. Once `isCurrent` is false nothing more is started.
 */
export function fetchInOrder<TItem, TResult>(
  items: TItem[],
  fetch: (item: TItem) => Promise<TResult>,
  options: { concurrency?: number; isCurrent?: () => boolean } = {}
) {
  const { concurrency = FETCH_CONCURRENCY, isCurrent = () => true } = options;
  const landed: { item: TItem; result: TResult }[] = [];
  let failure: { error: unknown } | undefined;
  let [position, inFlight] = [0, 0];
  let wake: (() => void) | undefined;

  async function run(item: TItem) {
    inFlight++;
    try {
      landed.push({ item, result: await fetch(item) });
    } catch (error) {
      failure ??= { error };
    } finally {
      inFlight--;
      start();
      wake?.();
      wake = undefined;
    }
  }
  function start() {
    while (
      inFlight < concurrency &&
      position < items.length &&
      !failure &&
      isCurrent()
    ) {
      void run(items[position++]);
    }
  }
  start();

  async function next() {
    for (;;) {
      if (landed.length > 0) {
        return landed.shift();
      }
      if (failure) {
        throw failure.error;
      }
      if (inFlight === 0 && (position >= items.length || !isCurrent())) {
        return undefined;
      }
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return { next };
}

/**
 * The cells of one face as its ranges land, kept in ascending cell order
 * however they land: what the face is drawn from before every range is in.
 * A cell not yet landed is absent, as a cell outside the window is.
 */
export function createFaceAssembly() {
  const parts: ({ range: TAxisRange } & TRangeCells)[] = [];
  let length = 0;
  return {
    add(range: TAxisRange, part: TRangeCells) {
      // the ranges are disjoint: keep them by start
      let at = parts.length;
      while (at > 0 && parts[at - 1].range.start > range.start) {
        at--;
      }
      parts.splice(at, 0, { range, ...part });
      length += part.data.length;
    },
    get count() {
      return parts.length;
    },
    face(): TRangeCells & { ranges: TAxisRange[] } {
      const data = new Float32Array(length);
      const cells: number[] = [];
      for (const part of parts) {
        data.set(part.data, cells.length);
        for (const cell of part.cells) {
          cells.push(cell);
        }
      }
      return { data, cells, ranges: parts.map(({ range }) => range) };
    },
  };
}
