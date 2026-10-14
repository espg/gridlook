import type { Grid } from "healpix-geo";

import type { TAxisRange } from "@/lib/data/viewWindow.ts";
import { digestVariableOf } from "@/lib/digest/digestVariables.ts";
import type { TViewFootprint } from "@/lib/projection/viewFootprint.ts";

/**
 * A view window of a nested HEALPix level is made of blocks: the cells below
 * one cell this many orders up. A block is at most 4^6 = 4096 cells,
 * contiguous in nested order and a square on its face.
 */
const HEALPIX_BLOCK_DEPTH = 6;

/**
 * A view window reaches this fraction of the view's size past every edge,
 * so that a small pan fetches nothing: 2.25 times the visible area.
 */
export const VIEW_WINDOW_MARGIN = 0.5;
/**
 * The margin of a variable derived from a t-digest, whose cells cost
 * hundreds of bytes each: a tenth of the view, 1.44 times the visible area,
 * 36% fewer bytes than the half-view margin, so that a pan to a new area
 * reads little past the view.
 */
export const DIGEST_WINDOW_MARGIN = 0.1;

/** The window margin of a variable, from its attributes. */
export function viewWindowMargin(attributes: unknown) {
  return digestVariableOf(attributes)
    ? DIGEST_WINDOW_MARGIN
    : VIEW_WINDOW_MARGIN;
}

/**
 * Orders between a level's cells and its blocks. A block is never larger
 * than a chunk when the chunk is a square of cells (a power of four): a
 * window then reads only the chunks it touches, and each chunk is read as
 * one block. A level derived from leaf chunks is windowed by chunk whatever
 * the chunk's size: one block, one chunk.
 */
export function healpixBlockDepth(chunkCells: number, derived = false) {
  const orders = Math.log2(chunkCells) / 2;
  if (derived) {
    return orders;
  }
  return Number.isInteger(orders)
    ? Math.min(orders, HEALPIX_BLOCK_DEPTH)
    : HEALPIX_BLOCK_DEPTH;
}

// side of one of the 12 base faces, sqrt(4π / 12) in degrees
const FACE_SIDE_DEGREES = 58.63;
const RADIANS = Math.PI / 180;

function normalizeLon(lon: number) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Order of the cells a level's view window is made of. */
export function healpixBlockLevel(level: number, depth = HEALPIX_BLOCK_DEPTH) {
  return level > depth ? level - depth : 0;
}

/** Side of a cell of `blockLevel`, in degrees. */
function healpixBlockSide(blockLevel: number) {
  return FACE_SIDE_DEGREES / 2 ** blockLevel;
}

/** Great-circle distance between two points, in degrees. */
/** Great-circle distance between two points, in degrees. */
export function degreesApart(
  lon: number,
  lat: number,
  toLon: number,
  toLat: number
) {
  const cosine =
    Math.sin(lat * RADIANS) * Math.sin(toLat * RADIANS) +
    Math.cos(lat * RADIANS) *
      Math.cos(toLat * RADIANS) *
      Math.cos((toLon - lon) * RADIANS);
  return Math.acos(Math.min(Math.max(cosine, -1), 1)) / RADIANS;
}

/** Great-circle distances from a point to the centres of cells, in degrees. */
export function blockDistances(
  blockGrid: Grid,
  blocks: number[],
  lon: number,
  lat: number
) {
  const centres = blockGrid.healpixToLonLat(
    BigUint64Array.from(blocks, (block) => BigInt(block))
  );
  return blocks.map((_, index) =>
    degreesApart(centres[2 * index], centres[2 * index + 1], lon, lat)
  );
}

/** The cells of `blockGrid`, the nearest to a point first. */
export function blocksByDistance(
  blockGrid: Grid,
  blocks: number[],
  lon: number,
  lat: number
) {
  const distance = blockDistances(blockGrid, blocks, lon, lat);
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => distance[a.index] - distance[b.index])
    .map(({ block }) => block);
}

/** Keep the `count` cells of `blockGrid` nearest to a point. */
function nearestBlocks(
  blockGrid: Grid,
  blocks: number[],
  lon: number,
  lat: number,
  count: number
) {
  return blocksByDistance(blockGrid, blocks, lon, lat).slice(0, count);
}

/** A lat/lon box: `[south, north]`, and `span` degrees east of `west`. */
type TBox = { south: number; north: number; west: number; span: number };

/** Blocks of side `side` a box holds, by area. */
function boxBlocks({ south, north, span }: TBox, side: number) {
  return (
    (span * (Math.sin(north * RADIANS) - Math.sin(south * RADIANS))) /
    RADIANS /
    side ** 2
  );
}

/**
 * The box a window samples: the footprint grown by `margin` on every side,
 * then, over the budget, shrunk around the point below the camera. A band
 * that still reaches a pole keeps every longitude: the cells on the other
 * side of the pole are among the nearest.
 */
function windowBox(
  footprint: TViewFootprint,
  margin: number,
  side: number,
  maxBlocks: number
): TBox {
  const latMargin = (footprint.latMax - footprint.latMin) * margin;
  let south = Math.max(footprint.latMin - latMargin, -90);
  let north = Math.min(footprint.latMax + latMargin, 90);
  let span = Math.min(footprint.lonSpan * (1 + 2 * margin), 360);
  let west = footprint.lonStart - (span - footprint.lonSpan) / 2;
  for (let pass = 0; pass < 3; pass++) {
    const estimate = boxBlocks({ south, north, west, span }, side);
    if (estimate <= maxBlocks) {
      break;
    }
    const factor = Math.sqrt(maxBlocks / estimate);
    const half = ((north - south) / 2) * factor;
    south = Math.max(footprint.centreLat - half, -90);
    north = Math.min(footprint.centreLat + half, 90);
    if (south > -90 && north < 90) {
      span *= factor;
      west = footprint.centreLon - span / 2;
    }
  }
  return { south, north, west, span };
}

/** Whether a point of the box is within the footprint (the view itself). */
function inView(footprint: TViewFootprint, lon: number, lat: number) {
  const east = normalizeLon(lon - footprint.lonStart);
  return (
    lat >= footprint.latMin &&
    lat <= footprint.latMax &&
    (east >= 0 ? east : east + 360) <= footprint.lonSpan
  );
}

/** Points `spacing` apart over a box, as lon/lat pairs. */
function sampleBox({ south, north, west, span }: TBox, spacing: number) {
  const rows = Math.ceil((north - south) / spacing) + 1;
  const coordinates: number[] = [];
  for (let row = 0; row < rows; row++) {
    const lat = rows > 1 ? south + ((north - south) * row) / (rows - 1) : south;
    const columns = Math.ceil((span * Math.cos(lat * RADIANS)) / spacing) + 1;
    for (let column = 0; column < columns; column++) {
      const offset = columns > 1 ? (span * column) / (columns - 1) : span / 2;
      coordinates.push(normalizeLon(west + offset), lat);
    }
  }
  return coordinates;
}

/**
 * With a store that says where it has nodes, the box is sampled this many
 * times over the budget before it is shrunk by area: the blocks it holds
 * nothing for cost nothing.
 */
const COVERAGE_OVERSAMPLE = 4;

/**
 * The covered blocks under the cells a box touches, when there are at most
 * `limit`: the box is sampled at the coarsest order that keeps it within
 * `limit` cells, and the covered cells are refined an order at a time.
 * Undefined when the box is small enough to sample block by block, or when
 * it holds more covered blocks than `limit`.
 */
function coveredInBox(
  grid: Grid,
  blockLevel: number,
  box: TBox,
  side: number,
  limit: number,
  covers: (order: number) => (cell: number) => boolean
) {
  const area = boxBlocks(box, side);
  if (area <= limit) {
    return undefined;
  }
  const orders = Math.min(
    Math.ceil(Math.log(area / limit) / Math.log(4)),
    blockLevel
  );
  let order = blockLevel - orders;
  using coarseGrid = grid.replace({ level: order, scheme: "nested" });
  const sampled = coarseGrid.lonLatToHealpix(
    Float64Array.from(sampleBox(box, (side * 2 ** orders) / 4))
  );
  let cells = [...new Set(Array.from(sampled, Number))].filter(covers(order));
  while (order < blockLevel && cells.length <= limit) {
    order++;
    const covered = covers(order);
    cells = cells
      .flatMap((cell) => [4 * cell, 4 * cell + 1, 4 * cell + 2, 4 * cell + 3])
      .filter(covered);
  }
  return cells.length <= limit ? cells : undefined;
}

/**
 * The `maxBlocks` covered blocks nearest the centre of the view; clipped
 * when a block left out has its centre in view.
 */
function nearestCovered(
  blockGrid: Grid,
  covered: number[],
  footprint: TViewFootprint,
  maxBlocks: number
) {
  if (covered.length <= maxBlocks) {
    return {
      blocks: covered.sort((a, b) => a - b),
      cut: false,
      clipped: false,
    };
  }
  const ranked = blocksByDistance(
    blockGrid,
    covered,
    footprint.centreLon,
    footprint.centreLat
  );
  const dropped = ranked.slice(maxBlocks);
  const centres = blockGrid.healpixToLonLat(
    BigUint64Array.from(dropped, (block) => BigInt(block))
  );
  return {
    blocks: ranked.slice(0, maxBlocks).sort((a, b) => a - b),
    cut: true,
    clipped: dropped.some((_, index) =>
      inView(footprint, centres[2 * index], centres[2 * index + 1])
    ),
  };
}

/**
 * Ids of the blocks of a nested level that a view footprint touches, grown
 * by `margin` (a fraction of the footprint's size) on every side, ascending.
 * At most `maxBlocks` are returned, those nearest the centre of the view;
 * `cut` says whether the budget left any block out, `clipped` whether one of
 * them was in view itself rather than in the margin. With `covers`, which
 * says for a cell of an order whether the store holds anything under it, a
 * block the store holds nothing for is left out before the budget, and
 * never counts as cut; the covered blocks are counted before the box is
 * shrunk, so covered blocks within the budget are never dropped.
 */
// eslint-disable-next-line max-lines-per-function
export function healpixViewWindow(
  grid: Grid,
  footprint: TViewFootprint,
  margin = 0,
  maxBlocks = Infinity,
  depth?: number,
  covers?: (order: number) => (cell: number) => boolean
) {
  const blockLevel = healpixBlockLevel(grid.level, depth);
  const side = healpixBlockSide(blockLevel);
  using blockGrid = grid.replace({ level: blockLevel, scheme: "nested" });
  const covered =
    covers &&
    coveredInBox(
      grid,
      blockLevel,
      windowBox(footprint, margin, side, Infinity),
      side,
      maxBlocks * COVERAGE_OVERSAMPLE,
      covers
    );
  if (covered) {
    return nearestCovered(blockGrid, covered, footprint, maxBlocks);
  }
  const box = windowBox(
    footprint,
    margin,
    side,
    covers ? maxBlocks * COVERAGE_OVERSAMPLE : maxBlocks
  );
  const { south, north, span } = box;
  // Four samples per block side: a block is only missed where less than a
  // quarter of its side reaches into the box, and the margin covers that.
  const coordinates = sampleBox(box, side / 4);
  const visible = Array.from({ length: coordinates.length / 2 }, (_, index) =>
    inView(footprint, coordinates[2 * index], coordinates[2 * index + 1])
  );
  const sampled = Array.from(
    blockGrid.lonLatToHealpix(Float64Array.from(coordinates)),
    Number
  );
  const exists = covers?.(blockLevel);
  const present = exists ? sampled.map(exists) : undefined;
  let blocks = [
    ...new Set(
      present ? sampled.filter((_, index) => present[index]) : sampled
    ),
  ];
  // the box shrank into the view, or a block in view is over the budget
  let clipped =
    south > footprint.latMin ||
    north < footprint.latMax ||
    span < footprint.lonSpan;
  const cut = clipped || blocks.length > maxBlocks;
  if (blocks.length > maxBlocks) {
    const kept = new Set(
      nearestBlocks(
        blockGrid,
        blocks,
        footprint.centreLon,
        footprint.centreLat,
        maxBlocks
      )
    );
    clipped ||= sampled.some(
      (block, index) =>
        visible[index] && (present?.[index] ?? true) && !kept.has(block)
    );
    blocks = [...kept];
  }
  return { blocks: blocks.sort((a, b) => a - b), cut, clipped };
}

/**
 * Whether a window cut by its budget is stale, given the blocks in view it
 * lacks. A cut window misses blocks by design, and the window at the view
 * is not the same shape as the loaded one (near a pole they differ at the
 * same camera), so a missing block alone does not make it stale (that
 * reloaded the same window over and over). It is stale once the camera has
 * moved a block's width from where the window was loaded. A cut window that
 * loaded nothing is stale as soon as a block is in view.
 */
export function cutWindowStale(
  grid: Grid,
  loaded: number[],
  missing: number[],
  centre: Pick<TViewFootprint, "centreLon" | "centreLat">,
  loadedCentre: Pick<TViewFootprint, "centreLon" | "centreLat">,
  depth?: number
) {
  if (missing.length === 0) {
    return false;
  }
  if (loaded.length === 0) {
    return true;
  }
  const moved = degreesApart(
    loadedCentre.centreLon,
    loadedCentre.centreLat,
    centre.centreLon,
    centre.centreLat
  );
  return moved > healpixBlockSide(healpixBlockLevel(grid.level, depth));
}

/** The blocks of `healpixViewWindow`. */
export function healpixViewBlocks(
  grid: Grid,
  footprint: TViewFootprint,
  margin = 0,
  maxBlocks = Infinity,
  depth?: number
) {
  return healpixViewWindow(grid, footprint, margin, maxBlocks, depth).blocks;
}

/**
 * Nested cell ranges of ascending block ids, runs of neighbours merged. A
 * run never crosses into another chunk of `chunkCells`: each range is read
 * on its own, and a chunk is then read once.
 */
export function healpixBlockRanges(
  blocks: number[],
  cellsPerBlock: number,
  chunkCells = Infinity
) {
  const ranges: TAxisRange[] = [];
  for (const block of blocks) {
    const last = ranges[ranges.length - 1];
    const start = block * cellsPerBlock;
    if (
      last &&
      last.end === start &&
      Math.floor(last.start / chunkCells) === Math.floor(start / chunkCells)
    ) {
      last.end += cellsPerBlock;
    } else {
      ranges.push({
        start: block * cellsPerBlock,
        end: (block + 1) * cellsPerBlock,
      });
    }
  }
  return ranges;
}
