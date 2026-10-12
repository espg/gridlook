import * as healpixGeo from "healpix-geo";
import { describe, expect, it } from "vitest";

import type { TWordChunk } from "@/lib/digest/digestReader.ts";
import type { TDigestChunk } from "@/lib/digest/tdigest.ts";
import { MORTON_STORE_ELLIPSOID } from "@/lib/morton/convention.ts";
import { parseMortonDecimal } from "@/lib/morton/decimal.ts";
import { MAX_ORDER } from "@/lib/morton/word.ts";
import {
  decimatePointChunk,
  decodePointChunk,
  pointChunkBytes,
  unitVector,
  withTimes,
} from "@/lib/points/pointChunk.ts";
import {
  locationsArrayOf,
  pointArrayPath,
  pointTierSource,
  timesArrayOf,
  timeWordsOf,
} from "@/lib/points/pointSource.ts";
import {
  POINT_TIME_EPOCH,
  TIME_WORDS,
  wordsToDays,
} from "@/lib/points/pointTimes.ts";
import { makeHeightPointMaterial } from "@/lib/shaders/gridShaders.ts";

const grids = new Map<number, healpixGeo.Grid>();
function gridAt(order: number) {
  let grid = grids.get(order);
  if (!grid) {
    grid = new healpixGeo.Grid({
      scheme: "nested",
      level: order,
      ellipsoid: MORTON_STORE_ELLIPSOID,
    });
    grids.set(order, grid);
  }
  return grid;
}

/** The decimal id of a nested id at `order`, a point word at order 29. */
function decimalOf(nested: bigint, order: number, point = order === MAX_ORDER) {
  const base = Number(nested >> BigInt(2 * order));
  let within = nested & ((1n << BigInt(2 * order)) - 1n);
  const digits: string[] = [];
  for (let i = 0; i < order; i++) {
    digits.unshift(String(Number(within & 3n) + 1));
    within >>= 2n;
  }
  const sign = base >= 6 ? `-${base - 5}` : String(base + 1);
  return `${sign}${digits.join("")}${point ? "p" : ""}`;
}

/** Photons over the Sierra: their words at order 29 and their heights. */
function photons(count: number) {
  const lonLat = new Float64Array(2 * count);
  const heights = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    lonLat[2 * i] = -119.5 + (i % 50) * 1e-4;
    lonLat[2 * i + 1] = 37 + Math.floor(i / 50) * 1e-4;
    heights[i] = 1500 + i;
  }
  const nested = gridAt(MAX_ORDER).lonLatToHealpix(lonLat);
  const words = BigUint64Array.from(nested, (id) =>
    parseMortonDecimal(decimalOf(id, MAX_ORDER))
  );
  return { lonLat, heights, words };
}

function digestOf(heights: Float32Array, cells = 4): TDigestChunk {
  const per = Math.ceil(heights.length / cells);
  const offsets = Uint32Array.from({ length: cells + 1 }, (_, cell) =>
    Math.min(cell * per, heights.length)
  );
  return {
    offsets,
    means: heights,
    weights: new Float32Array(heights.length).fill(1),
  };
}

function locatedOf(words: BigUint64Array, offsets: Uint32Array): TWordChunk {
  return { offsets, words };
}

const ORIGIN = unitVector(-119.5, 37);

// eslint-disable-next-line max-lines-per-function
describe("decodePointChunk", () => {
  it("places every centroid at its word's cell and keeps its height", () => {
    const { lonLat, heights, words } = photons(400);
    const digest = digestOf(heights);
    const chunk = decodePointChunk(
      digest,
      locatedOf(words, digest.offsets),
      ORIGIN,
      gridAt
    );
    expect(chunk.count).toBe(400);
    expect(chunk.origin).toBe(ORIGIN);
    expect([...chunk.heights]).toEqual([...heights]);
    expect(chunk.heights).not.toBe(heights);
    // the word names an order-29 cell, a centimetre across: the point is
    // its centre, within a float32 offset from a nearby origin (sub-mm)
    const centres = gridAt(MAX_ORDER).healpixToLonLat(
      gridAt(MAX_ORDER).lonLatToHealpix(lonLat)
    );
    for (let i = 0; i < 400; i++) {
      const [x, y, z] = unitVector(centres[2 * i], centres[2 * i + 1]);
      expect(chunk.offsets[3 * i] + ORIGIN[0]).toBeCloseTo(x, 10);
      expect(chunk.offsets[3 * i + 1] + ORIGIN[1]).toBeCloseTo(y, 10);
      expect(chunk.offsets[3 * i + 2] + ORIGIN[2]).toBeCloseTo(z, 10);
      // and within a cell of the photon itself
      const [px, py, pz] = unitVector(lonLat[2 * i], lonLat[2 * i + 1]);
      expect(
        Math.hypot(
          chunk.offsets[3 * i] + ORIGIN[0] - px,
          chunk.offsets[3 * i + 1] + ORIGIN[1] - py,
          chunk.offsets[3 * i + 2] + ORIGIN[2] - pz
        ) * 6378137
      ).toBeLessThan(0.02);
    }
  });

  it("draws a lossy centroid at the centre of its ancestor cell", () => {
    const { lonLat, heights, words } = photons(3);
    const coarse = gridAt(20).lonLatToHealpix(lonLat.subarray(2, 4));
    words[1] = parseMortonDecimal(decimalOf(coarse[0], 20));
    const digest = digestOf(heights, 1);
    digest.weights[1] = 17;
    const chunk = decodePointChunk(
      digest,
      locatedOf(words, digest.offsets),
      ORIGIN,
      gridAt
    );
    const centre = gridAt(20).healpixToLonLat(coarse);
    const [x, y, z] = unitVector(centre[0], centre[1]);
    expect(chunk.offsets[3] + ORIGIN[0]).toBeCloseTo(x, 9);
    expect(chunk.offsets[4] + ORIGIN[1]).toBeCloseTo(y, 9);
    expect(chunk.offsets[5] + ORIGIN[2]).toBeCloseTo(z, 9);
    expect(chunk.heights[1]).toBe(heights[1]);
  });

  it("refuses located words that do not match the digest, and decodes an empty chunk", () => {
    const { heights, words } = photons(5);
    const digest = digestOf(heights, 1);
    expect(() =>
      decodePointChunk(
        digest,
        locatedOf(words.slice(0, 4), digest.offsets),
        ORIGIN,
        gridAt
      )
    ).toThrow(/do not match/);
    const empty = decodePointChunk(
      {
        offsets: new Uint32Array(2),
        means: new Float32Array(),
        weights: new Float32Array(),
      },
      { offsets: new Uint32Array(2), words: new BigUint64Array() },
      ORIGIN,
      gridAt
    );
    expect(empty.count).toBe(0);
    expect(pointChunkBytes(empty)).toBe(0);
  });
});

describe("decimatePointChunk", () => {
  it("keeps every k-th point with its height, and the chunk itself at 1", () => {
    const { heights, words } = photons(10);
    const digest = digestOf(heights, 1);
    const chunk = decodePointChunk(
      digest,
      locatedOf(words, digest.offsets),
      ORIGIN,
      gridAt
    );
    expect(decimatePointChunk(chunk, 1)).toBe(chunk);
    const thinned = decimatePointChunk(chunk, 3);
    expect(thinned.count).toBe(4);
    expect([...thinned.heights]).toEqual([1500, 1503, 1506, 1509]);
    expect([...thinned.offsets.subarray(3, 6)]).toEqual([
      ...chunk.offsets.subarray(9, 12),
    ]);
    expect(pointChunkBytes(thinned)).toBe(4 * 16);
  });
});

describe("the radius law", () => {
  it("lifts a point by its height over the reference, exaggerated, in earth radii", () => {
    const material = makeHeightPointMaterial("viridis", 0, 1, 6378137);
    expect(material.uniforms.heightReference.value).toBe(0);
    expect(material.uniforms.heightExaggeration.value).toBe(1);
    // opaque unless the slider says otherwise; the falloff still shapes the splat
    expect(material.uniforms.pointOpacity.value).toBe(1);
    expect(material.fragmentShader).toContain(
      "gl_FragColor.a = falloff * pointOpacity;"
    );
    expect(material.uniforms.earthRadius.value).toBe(6378137);
    expect(material.vertexShader).toContain(
      "float lift = (height - heightReference) * heightExaggeration / earthRadius;"
    );
    expect(material.vertexShader).toContain("position + vertical * lift");
    // the cloud is drawn over the level beneath it and coloured as the grid is
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(material.uniforms.colormap).toBeDefined();
    expect(material.uniforms.addOffset).toBeDefined();
    expect(material.uniforms.hideBelowValue).toBeDefined();
  });
});

describe("pointTierSource", () => {
  const variable = (attrs: Record<string, unknown>) => ({
    store: "hive+s",
    dataset: "17",
    attrs,
  });
  const level = {
    derived: { dataset: "19", refinement: 2 },
    datasources: {
      count: variable({}),
      // eslint-disable-next-line camelcase
      h_percentile_signal: variable({
        digest: {
          array: "h_tdigest_signal",
          product: "percentile",
          stratum: "signal",
        },
      }),
    },
  };

  it("names the leaf digest of a height variable on a derived level only", () => {
    const source = pointTierSource(level, "h_percentile_signal");
    expect(source).toEqual({
      store: "hive+s",
      dataset: "19",
      array: "h_tdigest_signal",
      stratum: "signal",
    });
    expect(pointArrayPath(source!)).toBe("19/h_tdigest_signal");
    expect(pointArrayPath(source!, "h_tdigest_signal_locations")).toBe(
      "19/h_tdigest_signal_locations"
    );
    expect(pointTierSource(level, "count")).toBeUndefined();
    expect(
      pointTierSource({ ...level, derived: undefined }, "h_percentile_signal")
    ).toBeUndefined();
    expect(pointTierSource(undefined, "h_percentile_signal")).toBeUndefined();
  });

  it("reads the locations sibling off the digest array's attributes", () => {
    expect(
      locationsArrayOf({
        attributes: { ragged: { locations: "h_tdigest_signal_locations" } },
      })
    ).toBe("h_tdigest_signal_locations");
    expect(locationsArrayOf({ attributes: { ragged: {} } })).toBeUndefined();
    expect(locationsArrayOf({})).toBeUndefined();
  });
});

// eslint-disable-next-line max-lines-per-function
describe("withTimes", () => {
  it("adds the times sibling's words as days, thinned and charged with the points", () => {
    const { heights, words } = photons(10);
    const digest = digestOf(heights, 2);
    const chunk = decodePointChunk(
      digest,
      locatedOf(words, digest.offsets),
      ORIGIN,
      gridAt
    );
    expect(chunk.times).toBeUndefined();
    const bytes = pointChunkBytes(chunk);
    // ten timestamp words a day apart from 2018-01-01
    const dayNs = 86_400e9;
    const epoch =
      (BigInt(POINT_TIME_EPOCH - Date.UTC(1850, 0, 1)) * BigInt(dayNs)) /
      86_400_000n;
    const stamps = BigUint64Array.from({ length: 10 }, (_, i) => {
      const ns = epoch + BigInt(i * dayNs);
      return ((ns >> 31n) << 32n) | (1n << 31n) | (ns & 0x7fffffffn);
    });
    const timed = withTimes(
      chunk,
      { offsets: digest.offsets, words: stamps },
      TIME_WORDS.TOC
    );
    expect(timed.times).toEqual(wordsToDays(stamps));
    expect(Array.from(timed.times!).map(Math.round)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(timed.heights).toBe(chunk.heights);
    expect(pointChunkBytes(timed)).toBe(bytes + 40);
    const thinned = decimatePointChunk(timed, 4);
    expect(Array.from(thinned.times!).map(Math.round)).toEqual([0, 4, 8]);
    expect(thinned.count).toBe(3);
    expect(() =>
      withTimes(
        chunk,
        { offsets: digest.offsets, words: stamps.slice(1) },
        TIME_WORDS.TOC
      )
    ).toThrow("time words (9) do not match the chunk's points (10)");
  });

  it("finds the times sibling beside the ragged block", () => {
    expect(
      timesArrayOf({
        attributes: {
          ragged: { locations: "h_tdigest_signal_locations" },
          times: "h_tdigest_signal_times",
        },
      })
    ).toBe("h_tdigest_signal_times");
    expect(timesArrayOf({ attributes: { ragged: {} } })).toBeUndefined();
    expect(timesArrayOf({})).toBeUndefined();
  });
});

describe("timeWordsOf", () => {
  it("reads the times sibling only under a temporal declaration it implements", () => {
    const declared = (temporal: unknown) => ({ attributes: { temporal } });
    const toc = {
      spec: "zagg-toc/1",
      shape: "per-centroid",
      grammar: "mortie-toc/1",
    };
    expect(timeWordsOf(declared(toc))).toBe(TIME_WORDS.TOC);
    // informative keys are ignored
    expect(timeWordsOf(declared({ ...toc, source: "delta_time" }))).toBe(
      TIME_WORDS.TOC
    );
    // no block: the legacy microseconds
    expect(timeWordsOf({ attributes: {} })).toBe(TIME_WORDS.LEGACY);
    expect(timeWordsOf({})).toBe(TIME_WORDS.LEGACY);
    // a future revision, another shape or grammar: refused
    for (const refused of [
      { ...toc, spec: "zagg-toc/2" },
      { ...toc, shape: "per-cell" },
      { ...toc, grammar: "mortie-toc/2" },
      "zagg-toc/1",
    ]) {
      expect(timeWordsOf(declared(refused))).toBeUndefined();
    }
  });
});
