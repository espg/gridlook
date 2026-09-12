/**
 * Shim-retirement parity evidence (issue #8, phase 6 v2): the SAME SERC
 * shard rendered via the old `_shim_dggs_attrs` path and the new native
 * morton path must agree. The fixture froze what the shim actually served
 * (fabricated NESTED cell_ids + the healpix-flavored dggs block) beside the
 * stored words; the native path must reproduce the identical (order, cells)
 * render inputs from the words alone, and the face texture built from them
 * must be value-identical -- the render path downstream of (cells, nside,
 * data) is shared, and the data bytes are untouched by either path.
 *
 * The SERC shard is an order-8 AREA store, so it cannot pin the one axis the
 * shim uniquely existed for: the POINT clip, where the manifest says order 29
 * and the shim served 24. `shim_parity_points.json` carries that case (the
 * shim's own ground truth, fabricate_cell_ids, over the golden point words),
 * and it is DECODE parity -- a point coordinate decodes exactly as the shim
 * served it, while the render path refuses to draw an nside-2**24 grid.
 */
import { expect, it } from "vitest";

import pointParity from "../../../data/shim_parity_points.json";
import parity from "../../../data/shim_parity_serc.json";

import { buildHealpixTexture } from "@/lib/grids/healpixCalculations.ts";
import { decodeMortonCells } from "@/lib/morton/cells.ts";

const words = parity.morton_words.map((word) => BigInt(word));
const pointWords = pointParity.morton_words.map((word) => BigInt(word));

it("native word decode reproduces the shim-served cell ids and level", () => {
  const decoded = decodeMortonCells(words);
  expect(decoded.order).toBe(parity.shim_dggs.refinement_level);
  expect(decoded.cells).toEqual(parity.shim_cell_ids);
});

it("native word decode reproduces the shim's point-store clip", () => {
  // The point trap: the shim fabricated ids at order 24 and served
  // refinement_level 24, NOT the manifest's 29. Native serving passes the
  // stored refinement_level (29) through, so the decoded order -- not the
  // dggs block -- is the only honest answer, and it still agrees with what
  // the shim served.
  const decoded = decodeMortonCells(pointWords);
  expect(decoded.order).toBe(pointParity.shim_refinement_level);
  expect(decoded.order).not.toBe(pointParity.manifest_refinement_level);
  expect(decoded.cells).toEqual(pointParity.shim_cell_ids);
  // Decode parity holds; rendering is a separate verdict. An order-24 grid is
  // nside 2**24, so Healpix.vue refuses the coordinate on this flag (and the
  // hive endpoint 422s the same view server-side).
  expect(decoded.hasPointWords).toBe(true);
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
