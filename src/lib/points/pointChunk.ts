import type { Grid } from "healpix-geo";

import { decimate, decimatedCount } from "./pointBudget.ts";
import { timeWordsToDays, type TTimeWords } from "./pointTimes.ts";
import { wordsToNested } from "./pointWords.ts";

import type { TWordChunk } from "@/lib/digest/digestReader.ts";
import type { TDigestChunk } from "@/lib/digest/tdigest.ts";

/**
 * The observations of one leaf chunk, ready to draw: one point per
 * centroid of the chunk's digests (a lossy centroid, weight above 1, is one
 * point at its mean like any other), at the centre of the cell its located
 * word names. Positions are on the unit sphere and relative to the chunk's
 * `origin`, so that a float32 offset resolves to millimetres where the
 * absolute coordinate would resolve to half a metre; the renderer adds the
 * origin back through the object's matrix, in double precision. The times
 * (`pointTimes.ts`) come separately, read only when the colour asks.
 */
export type TPointChunk = {
  count: number;
  /** xyz per point, unit sphere, minus `origin`. */
  offsets: Float32Array;
  /** The centroid means: heights, in the digest's unit. */
  heights: Float32Array;
  /** Days since the point time epoch, once the times sibling is read. */
  times?: Float32Array;
  /** A point on the unit sphere near the chunk, e.g. its cell's centre. */
  origin: [number, number, number];
};

const RADIANS = Math.PI / 180;

/** The unit-sphere point under a longitude and latitude, in degrees. */
export function unitVector(lon: number, lat: number): [number, number, number] {
  const cosLat = Math.cos(lat * RADIANS);
  return [
    cosLat * Math.cos(lon * RADIANS),
    cosLat * Math.sin(lon * RADIANS),
    Math.sin(lat * RADIANS),
  ];
}

/** Longitude/latitude pairs of nested ids that may sit at several orders. */
function lonLatOf(
  nested: BigUint64Array,
  orders: Uint8Array,
  gridAt: (order: number) => Grid
) {
  const distinct = new Set(orders);
  if (distinct.size === 1) {
    return gridAt(orders[0]).healpixToLonLat(nested);
  }
  const out = new Float64Array(2 * nested.length);
  for (const order of distinct) {
    const indices: number[] = [];
    for (let i = 0; i < orders.length; i++) {
      if (orders[i] === order) {
        indices.push(i);
      }
    }
    const coords = gridAt(order).healpixToLonLat(
      BigUint64Array.from(indices, (i) => nested[i])
    );
    indices.forEach((i, j) => {
      out[2 * i] = coords[2 * j];
      out[2 * i + 1] = coords[2 * j + 1];
    });
  }
  return out;
}

/**
 * Decode one chunk: the digest's centroids are the points, the located
 * words of the same chunk their places. `gridAt(order)` is the store's
 * nested grid at an order (29 for every point word).
 */
export function decodePointChunk(
  digest: TDigestChunk,
  located: TWordChunk,
  origin: [number, number, number],
  gridAt: (order: number) => Grid
): TPointChunk {
  const count = digest.means.length;
  if (located.words.length !== count) {
    throw new Error(
      `located words (${located.words.length}) do not match the digest's centroids (${count})`
    );
  }
  const { nested, orders } = wordsToNested(located.words);
  const lonLat = count ? lonLatOf(nested, orders, gridAt) : new Float64Array();
  const offsets = new Float32Array(3 * count);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = unitVector(lonLat[2 * i], lonLat[2 * i + 1]);
    offsets[3 * i] = x - origin[0];
    offsets[3 * i + 1] = y - origin[1];
    offsets[3 * i + 2] = z - origin[2];
  }
  return { count, offsets, heights: digest.means.slice(), origin };
}

/** The chunk with the times of the `times` sibling's chunk, one word per point. */
export function withTimes(
  chunk: TPointChunk,
  timed: TWordChunk,
  kind: TTimeWords
): TPointChunk {
  if (timed.words.length !== chunk.count) {
    throw new Error(
      `time words (${timed.words.length}) do not match the chunk's points (${chunk.count})`
    );
  }
  return { ...chunk, times: timeWordsToDays(timed.words, kind) };
}

/** Every `stride`-th point of a chunk, from its first. */
export function decimatePointChunk(
  chunk: TPointChunk,
  stride: number
): TPointChunk {
  if (stride <= 1) {
    return chunk;
  }
  return {
    ...chunk,
    count: decimatedCount(chunk.count, stride),
    offsets: decimate(chunk.offsets, stride, 3),
    heights: decimate(chunk.heights, stride),
    times: chunk.times && decimate(chunk.times, stride),
  };
}

/** Bytes a decoded chunk holds, for a byte-bounded cache. */
export function pointChunkBytes(chunk: TPointChunk) {
  return (
    chunk.offsets.byteLength +
    chunk.heights.byteLength +
    (chunk.times?.byteLength ?? 0)
  );
}
