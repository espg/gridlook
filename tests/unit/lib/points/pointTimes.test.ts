import { describe, expect, it } from "vitest";

import {
  formatPointTime,
  POINT_COLOURS,
  POINT_TIME_EPOCH,
  TIME_WORDS,
  timeWordsToDays,
  wordsToDays,
} from "@/lib/points/pointTimes.ts";

const DAY_NS = 86_400e9;
/** Days from 1850-01-01 to 2018-01-01 on the leap-free scale. */
const EPOCH_DAYS = (POINT_TIME_EPOCH - Date.UTC(1850, 0, 1)) / 86_400_000;

/** A timestamp word: the nanoseconds with the flag spliced in at bit 31. */
function timestampWord(ns: bigint) {
  return ((ns >> 31n) << 32n) | (1n << 31n) | (ns & 0x7fffffffn);
}

/** A range word: the start code at 2^31 ns, the end code at 2^32 ns. */
function rangeWord(startNs: bigint, endNs: bigint) {
  const start = startNs / 2n ** 31n;
  const end = (endNs + 2n ** 32n - 1n) / 2n ** 32n;
  return (start << 32n) | end;
}

describe("wordsToDays", () => {
  it("reads a timestamp word to the day and fraction since 2018-01-01", () => {
    expect(EPOCH_DAYS).toBe(61361);
    const days = [437.5, 0, 2000.25];
    const words = BigUint64Array.from(days, (day) =>
      timestampWord(BigInt(Math.round((EPOCH_DAYS + day) * DAY_NS)))
    );
    const read = wordsToDays(words);
    expect(read).toBeInstanceOf(Float32Array);
    for (let i = 0; i < days.length; i++) {
      // float32 resolves 10 s over the mission
      expect(Math.abs(read[i] - days[i]) * 86400).toBeLessThan(10);
    }
  });

  it("reads a range word at its start", () => {
    const start = BigInt((EPOCH_DAYS + 100) * DAY_NS);
    const end = start + BigInt(2 * DAY_NS);
    const [days] = wordsToDays(BigUint64Array.of(rangeWord(start, end)));
    // the start is rounded down by at most 2^31 ns, 2 s
    expect(Math.abs(days - 100) * 86400).toBeLessThan(10);
    // the flag tells the two apart: the same start code as a timestamp
    const [stamp] = wordsToDays(BigUint64Array.of(timestampWord(start)));
    expect(Math.abs(stamp - 100) * 86400).toBeLessThan(10);
  });
});

describe("timeWordsToDays", () => {
  it("reads toc words, or the legacy microseconds since 1970", () => {
    const stamp = BigUint64Array.of(
      timestampWord(BigInt((EPOCH_DAYS + 437.5) * DAY_NS))
    );
    expect(timeWordsToDays(stamp, TIME_WORDS.TOC)).toEqual(wordsToDays(stamp));
    // 2019-03-14T12:00Z and 1969-12-31T00:00Z as signed microseconds
    const micros = BigUint64Array.from(
      [Date.UTC(2019, 2, 14, 12), Date.UTC(1969, 11, 31)],
      (ms) => BigInt.asUintN(64, BigInt(ms) * 1000n)
    );
    const days = timeWordsToDays(micros, TIME_WORDS.LEGACY);
    expect(days[0]).toBeCloseTo(437.5, 3);
    expect(days[1]).toBeCloseTo(-17533, 2);
  });
});

describe("formatPointTime", () => {
  it("labels a time as its UTC date", () => {
    expect(formatPointTime(0)).toBe("2018-01-01");
    expect(formatPointTime(437.5)).toBe("2019-03-14");
    expect(formatPointTime(2000.25)).toBe("2023-06-24");
    expect(formatPointTime(NaN)).toBe("");
    expect(POINT_COLOURS).toEqual({ HEIGHT: "height", TIME: "time" });
  });
});
