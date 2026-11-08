import { expect, it } from "vitest";

import {
  buildHealpixTexture,
  decodeHealpixFaceXY,
  getHealpixFaceDataRect,
  getHealpixFaceRange,
  getHealpixTextureIndex,
  healpixCellCoordinateNames,
  healpixFaceCover,
} from "@/lib/grids/healpixCalculations.ts";
import { buildHistogramSummary } from "@/utils/histogram.ts";

it("splits a level-13 grid into contiguous 256 MiB float32 faces", () => {
  const nside = 8192;
  for (let face = 0; face < 12; face++) {
    const range = getHealpixFaceRange(face, nside);
    expect(range.start).toBe(face * nside ** 2);
    expect(range.end).toBe((face + 1) * nside ** 2);
    expect((range.end - range.start) * 4).toBe(256 * 1024 ** 2);
  }
});

it("reads shuffled sparse cells from the correct face and skips empty faces", () => {
  const cells = [191, 4, 0];
  expect(getHealpixFaceRange(0, 4, cells)).toEqual({
    start: 1,
    end: 3,
    cells: [4, 0],
  });
  expect(getHealpixFaceRange(1, 4, cells)).toEqual({
    start: 0,
    end: 0,
    cells: [],
  });
  expect(getHealpixFaceRange(11, 4, cells)).toEqual({
    start: 0,
    end: 1,
    cells: [191],
  });
});

it("derives the same regional extent before and after loading face values", () => {
  const cells = [191, 4, 0];
  const values = new Float32Array([3, 2, 1]);
  expect(getHealpixFaceDataRect(0, 4, cells)).toEqual({
    u: 0,
    v: 0,
    width: 0.75,
    height: 0.25,
  });
  expect(getHealpixFaceDataRect(1, 4, cells)).toBeNull();
  for (const face of [0, 11]) {
    expect(getHealpixFaceDataRect(face, 4, cells)).toEqual(
      buildHealpixTexture(values, face, 4, cells).dataRect
    );
  }
});

it("uses texture storage for exact nested-pixel hover values", () => {
  const values = Float32Array.from({ length: 16 }, (_, pixel) => pixel);
  const texture = buildHealpixTexture(values, 11, 4).dataValues;
  expect([...texture]).toEqual([
    0, 1, 4, 5, 2, 3, 6, 7, 8, 9, 12, 13, 10, 11, 14, 15,
  ]);
  for (let pixel = 0; pixel < 16; pixel++) {
    expect(texture[getHealpixTextureIndex(pixel, 4)]).toBe(pixel);
  }
  expect(getHealpixTextureIndex(2 ** 24, 8192)).toBe(4096);
  expect(getHealpixTextureIndex(8192 ** 2 - 1, 8192)).toBe(8192 ** 2 - 1);
});

it("builds histograms without copying values and preserves invalid-value handling", () => {
  const values = new Float32Array([NaN, Infinity, -999, -888, -1, 0, 1, 2, 3]);
  expect([...buildHistogramSummary(values, 0, 2, 2, -999, -888).bins]).toEqual([
    2, 3,
  ]);
  expect([...buildHistogramSummary([5, NaN, 5], 5, 5, 2).bins]).toEqual([0, 2]);
  expect([...buildHistogramSummary([NaN], NaN, NaN, 2).bins]).toEqual([0, 0]);
  expect(values[0]).toBeNaN();
  expect(values[2]).toBe(-999);
});

it("finds xdggs cell_ids when the dggs metadata names no coordinate", () => {
  expect(healpixCellCoordinateNames(undefined)).toEqual(["cell", "cell_ids"]);
  expect(healpixCellCoordinateNames(null)).toEqual(["cell", "cell_ids"]);
  expect(healpixCellCoordinateNames("zone_ids")).toEqual(["zone_ids"]);
});

it("covers the whole face of a dense level", () => {
  expect(healpixFaceCover(3, 12)).toEqual({
    width: 1,
    height: 1,
    values: Uint8Array.of(255),
    dataRect: { u: 0, v: 0, width: 1, height: 1 },
  });
});

it("covers the parts of a face a sparse level has cells in", () => {
  // level 2 on face 1: cells 16..31; 17 and 18 are in the corner cell
  // (x, y) = (1, 0) and (0, 1), 31 is (3, 3); NaN values still count
  const { width, height, values } = healpixFaceCover(1, 2, [17, 18, 31]);
  expect([width, height]).toEqual([4, 4]);
  const covered = [...values.keys()].filter((index) => values[index] === 255);
  expect(covered).toEqual([1, 4, 15]);
});

it("crops a fine mask to its exact cell extent", () => {
  const cells = Array.from({ length: 16 }, (_, index) => 9 * 16 + index);
  const { width, height, values, dataRect } = healpixFaceCover(0, 10, cells);
  expect([width, height]).toEqual([4, 4]);
  expect([...values]).toEqual(Array(16).fill(255));
  expect(dataRect).toEqual({
    u: 4 / 1024,
    v: 8 / 1024,
    width: 4 / 1024,
    height: 4 / 1024,
  });
});

function coveredCell(
  face: number,
  level: number,
  cells: number[],
  cell: number
) {
  const cover = healpixFaceCover(face, level, cells);
  const { x, y } = decodeHealpixFaceXY(cell - face * 4 ** level);
  const localX = x - cover.dataRect.u * 2 ** level;
  const localY = y - cover.dataRect.v * 2 ** level;
  return (
    localX >= 0 &&
    localX < cover.width &&
    localY >= 0 &&
    localY < cover.height &&
    cover.values[localY * cover.width + localX] === 255
  );
}

it("leaves the backdrop under unread level-20 blocks", () => {
  const cells = Array.from({ length: 4096 }, (_, index) => index);
  expect(coveredCell(0, 20, cells, 0)).toBe(true);
  expect(coveredCell(0, 20, cells, 4095)).toBe(true);
  expect(coveredCell(0, 20, cells, 4096)).toBe(false);
});

it("leaves the backdrop in sparse gaps within a level-8 ancestor", () => {
  // Same ancestor, different fine cells, including an internal texture hole.
  const cells = [0, 3];
  expect(coveredCell(0, 9, cells, 0)).toBe(true);
  expect(coveredCell(0, 9, cells, 3)).toBe(true);
  expect(coveredCell(0, 9, cells, 1)).toBe(false);
  expect(coveredCell(0, 9, cells, 2)).toBe(false);
});

it("keeps sparse coverage exact on nonzero faces and offsets", () => {
  const start = 7 * 4 ** 20;
  const cells = [start + 144, start + 147];
  expect(coveredCell(7, 20, cells, start + 144)).toBe(true);
  expect(coveredCell(7, 20, cells, start + 145)).toBe(false);
  expect(coveredCell(7, 20, cells, start + 143)).toBe(false);
});

it("does not cover empty faces or cells belonging to another face", () => {
  expect([...healpixFaceCover(1, 20, []).values]).toEqual([0]);
  expect([...healpixFaceCover(1, 20, [0, 3]).values]).toEqual([0]);
});
