import { describe, expect, it } from "vitest";

import {
  fillGaps,
  GAP_FILL_METHODS,
  GAP_FILL_SIZES,
  gaussianSigma,
} from "@/lib/grids/gapFill.ts";

const { DIRECT, FFT } = GAP_FILL_METHODS;

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

/** Heights along a few tracks, blank between them. */
function tracks(width: number, height: number, seed = 7) {
  const next = random(seed);
  const field = new Float32Array(width * height).fill(NaN);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x + 2 * y) % 11 === 0 || next() < 0.02) {
        field[y * width + x] = 1500 + 300 * Math.sin(x / 9) + 40 * next();
      }
    }
  }
  return field;
}

/** The normalised convolution, written out tap by tap. */
function reference(values: Float32Array, width: number, size: number) {
  const height = values.length / width;
  const radius = (size - 1) / 2;
  const sigma = gaussianSigma(size);
  return values.map((value, index) => {
    if (!Number.isNaN(value)) {
      return value;
    }
    const [x, y] = [index % width, Math.floor(index / width)];
    let [total, weight] = [0, 0];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const [u, v] = [x + dx, y + dy];
        const near = values[v * width + u];
        if (u < 0 || u >= width || v < 0 || v >= height || Number.isNaN(near)) {
          continue;
        }
        const tap = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        total += tap * near;
        weight += tap;
      }
    }
    return weight > 0 ? total / weight : NaN;
  });
}

function expectClose(actual: Float32Array, expected: Float32Array) {
  expect(actual).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index++) {
    if (Number.isNaN(expected[index])) {
      expect(actual[index]).toBeNaN();
    } else {
      // float32 heights of a few thousand metres resolve 0.25 mm
      expect(Math.abs(actual[index] - expected[index])).toBeLessThan(1e-3);
    }
  }
}

// eslint-disable-next-line max-lines-per-function
describe("fillGaps", () => {
  it("states the kernel's sigma from its size", () => {
    for (const size of GAP_FILL_SIZES) {
      expect(2 * Math.ceil(3 * gaussianSigma(size) - 1e-9) + 1).toBe(size);
    }
    expect(gaussianSigma(31)).toBe(5);
  });

  it.each([...GAP_FILL_SIZES])(
    "is the normalised convolution, directly and through the FFT (%i)",
    (size) => {
      // not powers of two, and narrower than the largest kernel one way
      const [width, height] = [53, 20];
      const field = tracks(width, height);
      const expected = reference(field, width, size);
      expectClose(fillGaps(field, width, size, DIRECT), expected);
      expectClose(fillGaps(field, width, size, FFT), expected);
    }
  );

  it("agrees between the two methods on a power-of-two field", () => {
    const field = tracks(64, 64, 3);
    expectClose(fillGaps(field, 64, 9, FFT), fillGaps(field, 64, 9, DIRECT));
  });

  it.each([DIRECT, FFT])("keeps every cell that has data (%s)", (method) => {
    const field = tracks(40, 30);
    const filled = fillGaps(field, 40, 15, method);
    field.forEach((value, index) => {
      if (!Number.isNaN(value)) {
        expect(filled[index]).toBe(value);
      }
    });
    expect(field.some(Number.isNaN)).toBe(true);
  });

  it.each([DIRECT, FFT])(
    "leaves a blank cell blank beyond the kernel's reach (%s)",
    (method) => {
      const width = 32;
      const field = new Float32Array(width * width).fill(NaN);
      field[5 * width + 5] = 10;
      const filled = fillGaps(field, width, 5, method);
      filled.forEach((value, index) => {
        const reach = Math.max(
          Math.abs((index % width) - 5),
          Math.abs(Math.floor(index / width) - 5)
        );
        // one cell with data: every cell it reaches takes its value
        expect(value).toSatisfy((filledValue: number) =>
          reach <= 2
            ? Math.abs(filledValue - 10) < 1e-5
            : Number.isNaN(filledValue)
        );
      });
      // nothing wraps around: the far edges stay blank
      expect(filled[5 * width + width - 1]).toBeNaN();
      expect(filled[(width - 1) * width + 5]).toBeNaN();
    }
  );

  it.each([DIRECT, FFT])("returns an empty field unchanged (%s)", (method) => {
    const blank = new Float32Array(48).fill(NaN);
    expect(fillGaps(blank, 8, 9, method).every(Number.isNaN)).toBe(true);
  });

  it("interpolates between two values, never past them", () => {
    const field = new Float32Array(9).fill(NaN);
    field[0] = 100;
    field[8] = 200;
    const filled = fillGaps(field, 9, 31);
    for (let index = 1; index < 8; index++) {
      expect(filled[index]).toBeGreaterThan(filled[index - 1]);
      expect(filled[index]).toBeLessThan(200);
    }
    expect(filled[4]).toBeCloseTo(150, 4);
  });
});
