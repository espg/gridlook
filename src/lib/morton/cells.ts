/**
 * Packed morton coordinate -> the NESTED cell view the healpix render path
 * consumes (issue #8, phase 6 v2). Words are decoded per mortie spec
 * section 4's viewer-side cast (viewNestedId): POINT-kind words clip to
 * order 24, AREA words above order 24 throw (that data renders through the
 * hive virtual store, never as lossy Numbers). The store's cells must all
 * decode to ONE order -- the healpix grid renders a single nside -- so a
 * mixed-order coordinate is a loud error, not a silent misplacement.
 *
 * Decoding itself stays kind-agnostic -- the clip is what a POINT word MEANS
 * to a viewer (spec section 4), so point words decode here exactly as the
 * spec says. Whether the result can be RENDERED is a separate question,
 * answered by the reported `hasPointWords`: a point coordinate decodes to
 * order 24, i.e. nside 2**24 and ~0.4 m cells, which the sparse healpix
 * texture cannot rasterize, so the render path refuses point coordinates
 * instead of building that grid (issue #8).
 *
 * The cells must also arrive strictly ascending. getHealpixFaceRange does not
 * index cells by face: it slices the contiguous index span between the first
 * and last cell falling in the face, and that span is the zarr read range. An
 * out-of-order coordinate still renders correctly (out-of-face cells are
 * skipped) but makes all twelve faces span nearly the whole array -- a silent
 * 12x over-read -- and duplicate cells are dropped last-write-wins. For a
 * uniform order the packed-word order and the NESTED order coincide, so a
 * morton-sorted store satisfies this by construction; the single decode pass
 * checks it rather than assuming it.
 */

import { isPointWord, viewNestedId } from "@/lib/morton/word.ts";

export interface DecodedMortonCells {
  /** HEALPix order shared by every decoded cell (the grid's level). */
  order: number;
  /** NESTED cell ids, float64-exact by construction (order <= 24). */
  cells: number[];
  /**
   * Whether any word was POINT-kind (suffix band 48..63, clipped to order 24
   * by the viewer cast). Point coordinates decode cleanly but do not render
   * as healpix cells -- see the module docstring.
   */
  hasPointWords: boolean;
}

/**
 * Decode a whole packed-u64 morton coordinate. The input must be the raw
 * BigInt-valued array a uint64 zarr read produces (BigUint64Array) -- a
 * Number-valued array has already lost bits above 2**53 and is rejected.
 */
export function decodeMortonCells(
  words: ArrayLike<bigint>
): DecodedMortonCells {
  if (words.length === 0) {
    throw new Error("morton coordinate is empty: nothing to render");
  }
  const cells = new Array<number>(words.length);
  let order = -1;
  let hasPointWords = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (typeof word !== "bigint") {
      throw new Error(
        "morton coordinate must decode as BigInt words (uint64); got " +
          `${typeof word} at index ${index} -- packed words above 2**53 ` +
          "are not exact as Numbers"
      );
    }
    hasPointWords = hasPointWords || isPointWord(word);
    const decoded = viewNestedId(word);
    if (index === 0) {
      order = decoded.order;
    } else if (decoded.order !== order) {
      throw new Error(
        `mixed morton orders in one coordinate: cell 0 decodes to order ` +
          `${order} but cell ${index} to order ${decoded.order}; a healpix ` +
          "grid renders a single order"
      );
    } else if (decoded.cellId <= cells[index - 1]) {
      throw new Error(
        `morton coordinate is not strictly ascending at index ${index}: ` +
          `cell ${decoded.cellId} follows ${cells[index - 1]}. The healpix ` +
          "face ranges slice one contiguous index span per face, so cells " +
          "must be stored in morton/NESTED order, once each"
      );
    }
    cells[index] = decoded.cellId;
  }
  return { order, cells, hasPointWords };
}
