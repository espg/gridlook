import { describe, expect, it } from "vitest";

import { fillGaps } from "@/lib/grids/gapFill.ts";
import { decodeHealpixFaceXY } from "@/lib/grids/healpixCalculations.ts";
import {
  filledCells,
  filledValues,
  fillFaceGaps,
} from "@/lib/grids/healpixGapFill.ts";

const NSIDE = 16;
const FACE = 3;
const OFFSET = FACE * NSIDE * NSIDE;

/** The nested cell of a face at (x, y). */
function nested(x: number, y: number) {
  let pixel = 0;
  for (let bit = 0; bit < 4; bit++) {
    pixel += ((x >> bit) & 1) * 4 ** bit + ((y >> bit) & 1) * 2 * 4 ** bit;
  }
  return pixel;
}

// eslint-disable-next-line max-lines-per-function
describe("fillFaceGaps", () => {
  it("fills on the face's (x, y) grid, not along the nested order", () => {
    // a whole face, blank but for the column x = 4
    const data = new Float32Array(NSIDE * NSIDE).fill(NaN);
    for (let y = 0; y < NSIDE; y++) {
      data[nested(4, y)] = 100 + y;
    }
    const filled = fillFaceGaps({ data }, FACE, NSIDE, 3);
    const grid = new Float32Array(NSIDE * NSIDE).fill(NaN);
    data.forEach((value, pixel) => {
      const { x, y } = decodeHealpixFaceXY(pixel);
      grid[y * NSIDE + x] = value;
    });
    const expected = fillGaps(grid, NSIDE, 3);
    filled.forEach((value, pixel) => {
      const { x, y } = decodeHealpixFaceXY(pixel);
      expect(value).toBe(expected[y * NSIDE + x]);
      // the neighbours of the column across x, and nothing further
      expect(Number.isNaN(value)).toBe(Math.abs(x - 4) > 1);
    });
  });

  it("fills a window of cells over its bounding box, in their order", () => {
    // the block x 8..11, y 4..7 of the face, as a view loads it
    const cells: number[] = [];
    for (let y = 4; y < 8; y++) {
      for (let x = 8; x < 12; x++) {
        cells.push(OFFSET + nested(x, y));
      }
    }
    cells.sort((a, b) => a - b);
    const data = Float32Array.from(cells, (cell) =>
      decodeHealpixFaceXY(cell - OFFSET).x === 8 ? 50 : NaN
    );
    const filled = fillFaceGaps({ data, cells }, FACE, NSIDE, 3);
    cells.forEach((cell, index) => {
      const { x } = decodeHealpixFaceXY(cell - OFFSET);
      expect(filled[index]).toSatisfy((value: number) =>
        x <= 9 ? Math.abs(value - 50) < 1e-5 : Number.isNaN(value)
      );
    });
    expect(
      fillFaceGaps({ data: new Float32Array(), cells: [] }, 0, 16, 3)
    ).toHaveLength(0);
  });

  it("looks up the cells it filled, and only those", () => {
    const cells = [OFFSET + nested(0, 0), OFFSET + nested(1, 0), OFFSET + 200];
    const data = Float32Array.of(7, NaN, NaN);
    const low = fillFaceGaps({ data, cells }, FACE, NSIDE, 3);
    const high = low.map((value) => value + 5);
    const filled = filledCells(data, [low, high], NSIDE, (i) => cells[i]);
    expect([...filled.cells]).toEqual([cells[1]]);
    expect(filledValues(filled, cells[1])).toEqual([7, 12]);
    // a cell with data, a cell left blank, and no frame at all
    expect(filledValues(filled, cells[0])).toBeUndefined();
    expect(filledValues(filled, cells[2])).toBeUndefined();
    expect(filledValues(undefined, cells[1])).toBeUndefined();
  });
});
