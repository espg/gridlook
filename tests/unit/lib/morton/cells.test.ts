import { expect, it } from "vitest";

import golden from "../../../data/morton_boundary_golden.json";

import { decodeMortonCells } from "@/lib/morton/cells.ts";

/** Golden order-29 POINT words (suffix band 48..63; moczarr test_convention). */
const POINT_NORTH_WORD = 4733760060091642301n; // suffix 61
const POINT_SOUTH_WORD = 13712984013617909360n; // suffix 48

/** An area word at order k with an empty body: prefix base 0, suffix k. */
function areaWord(order: number): bigint {
  return (1n << 60n) | BigInt(order);
}

it("decodes a uniform coordinate to its golden NESTED ids", () => {
  // Sorted by word, the way a store is written: at one order the packed-word
  // order and the NESTED order coincide, and a coordinate must arrive
  // ascending (see the not-ascending test below).
  const cells = golden.cells
    .filter((cell) => cell.order === 9)
    .sort((left, right) => (BigInt(left.word) < BigInt(right.word) ? -1 : 1));
  const decoded = decodeMortonCells(cells.map((cell) => BigInt(cell.word)));
  expect(decoded.order).toBe(9);
  expect(decoded.cells).toEqual(cells.map((cell) => Number(cell.nested)));
});

it("clips point words to order 24 (mortie spec section 4 viewer cast)", () => {
  // Decode is kind-agnostic: the clip is what a point word means to a viewer,
  // and this is the parity the shim's fabricate_cell_ids produced. What the
  // caller does with it is a separate decision -- see the flag test below.
  const decoded = decodeMortonCells([POINT_NORTH_WORD, POINT_SOUTH_WORD]);
  expect(decoded.order).toBe(24);
  for (const cell of decoded.cells) {
    expect(Number.isSafeInteger(cell)).toBe(true);
    expect(cell).toBeLessThan(12 * 4 ** 24);
  }
});

it("reports point-kind words so the render path can refuse them", () => {
  // An order-24 grid is nside 2**24: decodable, not rasterizable. The flag is
  // what Healpix.vue throws on (and the hive endpoint 422s on server-side).
  expect(decodeMortonCells([POINT_NORTH_WORD]).hasPointWords).toBe(true);
  expect(decodeMortonCells([areaWord(9)]).hasPointWords).toBe(false);
});

it("rejects an empty coordinate", () => {
  expect(() => decodeMortonCells([])).toThrow(/empty/);
});

it("rejects mixed orders loudly", () => {
  expect(() => decodeMortonCells([areaWord(9), areaWord(8)])).toThrow(
    /mixed morton orders/
  );
  // Point words clip to 24, so an area word at another order still mixes.
  expect(() => decodeMortonCells([POINT_NORTH_WORD, areaWord(9)])).toThrow(
    /mixed morton orders/
  );
});

it("rejects a coordinate that is not strictly ascending", () => {
  // Descending, and duplicated: both break the one-contiguous-span-per-face
  // assumption getHealpixFaceRange makes of the read range.
  const [low, high] = [areaWord(9), areaWord(9) | (3n << 42n)];
  expect(decodeMortonCells([low, high])).toBeTruthy();
  expect(() => decodeMortonCells([high, low])).toThrow(
    /not strictly ascending/
  );
  expect(() => decodeMortonCells([low, low])).toThrow(/not strictly ascending/);
});

it("rejects area words above the float64-exact order", () => {
  expect(() => decodeMortonCells([areaWord(25)])).toThrow(/hive virtual store/);
});

it("rejects Number-valued input (bits above 2**53 already lost)", () => {
  expect(() =>
    decodeMortonCells([4108, 8] as unknown as ArrayLike<bigint>)
  ).toThrow(/BigInt/);
});

it("accepts a BigUint64Array (the raw uint64 zarr read)", () => {
  const cell = golden.cells.find((entry) => entry.label === "midlat_o9")!;
  const decoded = decodeMortonCells(new BigUint64Array([BigInt(cell.word)]));
  expect(decoded).toEqual({
    cells: [Number(cell.nested)],
    hasPointWords: false,
    order: 9,
  });
});
