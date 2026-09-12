/**
 * Shim-retirement parity evidence (issue #8, phase 6 v2): the SAME SERC
 * shard rendered via the old `_shim_dggs_attrs` path and the new native
 * morton path must agree. The fixture froze what the shim actually served
 * (fabricated NESTED cell_ids + the healpix-flavored dggs block) beside the
 * stored words; the native path must reproduce the identical (order, cells)
 * render inputs from the words alone, and the face texture built from them
 * must be value-identical -- the render path downstream of (cells, nside,
 * data) is shared, and the data bytes are untouched by either path.
 */
import { expect, it } from "vitest";

import parity from "../../../data/shim_parity_serc.json";

import { buildHealpixTexture } from "@/lib/grids/healpixCalculations.ts";
import { decodeMortonCells } from "@/lib/morton/cells.ts";

const words = parity.morton_words.map((word) => BigInt(word));

it("native word decode reproduces the shim-served cell ids and level", () => {
  const decoded = decodeMortonCells(words);
  expect(decoded.order).toBe(parity.shim_dggs.refinement_level);
  expect(decoded.cells).toEqual(parity.shim_cell_ids);
});

it("both cell paths build the identical face data texture", () => {
  const decoded = decodeMortonCells(words);
  const nside = 2 ** parity.shim_dggs.refinement_level;
  const data = Float32Array.from(parity.count, (value) => value ?? NaN);
  const faceIndex = Math.floor(parity.shim_cell_ids[0] / nside ** 2);
  const shimTexture = buildHealpixTexture(
    data,
    faceIndex,
    nside,
    parity.shim_cell_ids
  );
  const nativeTexture = buildHealpixTexture(
    data,
    faceIndex,
    nside,
    decoded.cells
  );
  expect(nativeTexture.width).toBe(shimTexture.width);
  expect(nativeTexture.height).toBe(shimTexture.height);
  expect(nativeTexture.dataRect).toEqual(shimTexture.dataRect);
  expect(nativeTexture.dataValues).toEqual(shimTexture.dataValues);
  // The texture is not degenerate: the shard's cells actually landed.
  expect(
    Array.from(nativeTexture.dataValues).some((value) => Number.isFinite(value))
  ).toBe(true);
});
