import { describe, expect, it } from "vitest";

import {
  AXIS_TICKS,
  AXIS_VIEW_FRACTION,
  axisLabel,
  localFrame,
  niceAxisLength,
  viewHeightAt,
} from "@/lib/points/pointAxes.ts";

describe("niceAxisLength", () => {
  it("picks the largest of 1, 2, 5 × 10^k within the length", () => {
    expect(
      [9, 10, 19, 20, 49, 50, 99, 100, 499, 500, 999].map(niceAxisLength)
    ).toEqual([5, 10, 10, 20, 20, 50, 50, 100, 200, 500, 500]);
    expect(niceAxisLength(2600)).toBe(2000);
    expect(niceAxisLength(123456)).toBe(100000);
    // never below a metre, whatever the view
    expect(niceAxisLength(0.4)).toBe(1);
    expect(niceAxisLength(NaN)).toBe(1);
  });

  it("sizes a quarter of the view: 392 m at 3 km under a 7.5° lens is a 50 m bar", () => {
    const height = viewHeightAt(3000, 7.5);
    expect(height).toBeCloseTo(393.26, 1);
    expect(niceAxisLength(height * AXIS_VIEW_FRACTION)).toBe(50);
    expect(niceAxisLength(viewHeightAt(30_000, 7.5) * AXIS_VIEW_FRACTION)).toBe(
      500
    );
    expect(AXIS_TICKS).toEqual([0.5, 1]);
  });
});

describe("axisLabel", () => {
  it("labels metres, and kilometres from 1 km", () => {
    expect(axisLabel(25)).toBe("25 m");
    expect(axisLabel(500)).toBe("500 m");
    expect(axisLabel(1000)).toBe("1 km");
    expect(axisLabel(2500)).toBe("2.5 km");
    expect(axisLabel(250000)).toBe("250 km");
  });
});

describe("localFrame", () => {
  it("is east, north and up at the equator and orthonormal everywhere", () => {
    const plain = (axis: number[]) => axis.map((v) => v + 0); // no -0
    const equator = localFrame([1, 0, 0]);
    expect(plain(equator.east)).toEqual([0, 1, 0]);
    expect(plain(equator.north)).toEqual([0, 0, 1]);
    expect(plain(equator.up)).toEqual([1, 0, 0]);
    // over the Sierra, from a vector of any length
    const d = Math.PI / 180;
    const [lat, lon] = [37, -119.5];
    const frame = localFrame([
      3 * Math.cos(lat * d) * Math.cos(lon * d),
      3 * Math.cos(lat * d) * Math.sin(lon * d),
      3 * Math.sin(lat * d),
    ]);
    const dot = (a: number[], b: number[]) =>
      a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (const axis of [frame.east, frame.north, frame.up]) {
      expect(dot(axis, axis)).toBeCloseTo(1, 12);
    }
    expect(dot(frame.east, frame.north)).toBeCloseTo(0, 12);
    expect(dot(frame.north, frame.up)).toBeCloseTo(0, 12);
    expect(dot(frame.up, frame.east)).toBeCloseTo(0, 12);
    // east is level and north climbs
    expect(frame.east[2]).toBe(0);
    expect(frame.north[2]).toBeCloseTo(Math.cos(lat * d), 12);
    // a pole still gets a frame
    expect(localFrame([0, 0, 1]).east).toEqual([0, 1, 0]);
  });
});
