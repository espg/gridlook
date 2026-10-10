import { fillGaps, type TGapFillMethod } from "./gapFill.ts";
import { decodeHealpixFaceXY } from "./healpixCalculations.ts";

/**
 * Gap filling on a HEALPix face. Nested order is not a grid, so the cells
 * are laid out by their (x, y) on the face, over the bounding box of the
 * cells loaded, filled there and read back. One face at a time: a cell is
 * never filled from across a face boundary.
 */

// Larger boxes are left as they are (a whole face of order 12).
const MAX_FILL_CELLS = 2 ** 24;

/** The cells of one face that gap filling gave a value. */
export type TFilledCells = {
  nside: number;
  /** Nested cell ids, ascending. */
  cells: Float64Array;
  /** Per field that was filled, the value of each cell. */
  values: Float32Array[];
};

/**
 * `data` with its blank cells filled, in the same order. `data[i]` is the
 * value of `cells[i]`, or of the face's cell `i` in nested order for a whole
 * face.
 */
export function fillFaceGaps(
  face: { data: Float32Array; cells?: number[] },
  faceIndex: number,
  nside: number,
  size: number,
  method?: TGapFillMethod
) {
  const { data, cells } = face;
  const faceOffset = faceIndex * nside * nside;
  const xs = new Uint32Array(data.length);
  const ys = new Uint32Array(data.length);
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -1, -1];
  for (let index = 0; index < data.length; index++) {
    const { x, y } = decodeHealpixFaceXY(
      cells ? cells[index] - faceOffset : index
    );
    xs[index] = x;
    ys[index] = y;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (data.length === 0 || width * height > MAX_FILL_CELLS) {
    return data;
  }
  const field = new Float32Array(width * height).fill(NaN);
  for (let index = 0; index < data.length; index++) {
    field[(ys[index] - minY) * width + xs[index] - minX] = data[index];
  }
  const filled = fillGaps(field, width, size, method);
  return data.map(
    (_, index) => filled[(ys[index] - minY) * width + xs[index] - minX]
  );
}

/**
 * The cells that were blank in `original` and have a value in `fields`
 * (the original's cells, filled; several for a variable made of several).
 */
export function filledCells(
  original: Float32Array,
  fields: Float32Array[],
  nside: number,
  cellAt: (index: number) => number
): TFilledCells {
  const indices: number[] = [];
  for (let index = 0; index < original.length; index++) {
    if (Number.isNaN(original[index]) && !Number.isNaN(fields[0][index])) {
      indices.push(index);
    }
  }
  return {
    nside,
    cells: Float64Array.from(indices, cellAt),
    values: fields.map((field) =>
      Float32Array.from(indices, (index) => field[index])
    ),
  };
}

/** The filled values of a cell; undefined for a cell that was not filled. */
export function filledValues(filled: TFilledCells | undefined, cell: number) {
  if (!filled) {
    return undefined;
  }
  let low = 0;
  let high = filled.cells.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (filled.cells[middle] === cell) {
      return filled.values.map((values) => values[middle]);
    }
    if (filled.cells[middle] < cell) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return undefined;
}
