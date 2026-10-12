/**
 * The times of the point tier's observations (gridlook#21, phase B). The
 * `times` sibling of a located digest (zagg spec §8.3) holds one mortie toc
 * word per centroid, row-aligned with the digest like the located words:
 * `[start: 32 bits, 2^31 ns units][flag: 1 bit][low: 31 bits]`, bit 0 the
 * least significant. With the flag set the word is an exact nanosecond
 * timestamp, its bits 0..30 in `low` and 31.. in `start`; clear, it is a
 * range `[start · 2^31, low · 2^32)` ns rounded outward, read here at its
 * midpoint. The scale is continuous, leap-free and GPS-aligned, from
 * 1850-01-01. A time here is float32 **days since 2018-01-01** (ICESat-2's
 * ATLAS epoch, the notebook viewer's unit): 10 s of resolution over the
 * mission, enough for a colour. A label is the UTC date, within the leap
 * seconds (18) the scale is ahead of UTC by.
 */

/** What the points are coloured by. */
export const POINT_COLOURS = { HEIGHT: "height", TIME: "time" } as const;
export type TPointColour = (typeof POINT_COLOURS)[keyof typeof POINT_COLOURS];

/** The epoch of a point time, UTC milliseconds. */
export const POINT_TIME_EPOCH = Date.UTC(2018, 0, 1);
const TOC_EPOCH = Date.UTC(1850, 0, 1);
const DAY_MS = 86_400_000;
const DAY_NS = 86_400e9;
/** Days from the toc epoch to the point time epoch. */
const EPOCH_DAYS = (POINT_TIME_EPOCH - TOC_EPOCH) / DAY_MS;
const START_NS = 2 ** 31;
const END_NS = 2 ** 32;
const LOW_MASK = 0x7fffffff;

/**
 * The time of every word of a chunk, days since the point time epoch. The
 * words are read on their uint32 halves (little-endian: the low half of
 * word `i` is `halves[2i]`); a float64 holds the nanoseconds to within a
 * microsecond.
 */
export function wordsToDays(words: BigUint64Array): Float32Array {
  const halves = new Uint32Array(
    words.buffer,
    words.byteOffset,
    2 * words.length
  );
  const out = new Float32Array(words.length);
  for (let i = 0; i < words.length; i++) {
    const lo = halves[2 * i];
    const start = halves[2 * i + 1];
    const low = lo & LOW_MASK;
    const ns =
      lo >>> 31
        ? start * START_NS + low
        : (start * START_NS + low * END_NS) / 2;
    out[i] = ns / DAY_NS - EPOCH_DAYS;
  }
  return out;
}

/** A point time as a UTC date, `2019-03-14`; blank when it is not one. */
export function formatPointTime(days: number): string {
  if (!Number.isFinite(days)) {
    return "";
  }
  return new Date(POINT_TIME_EPOCH + days * DAY_MS).toISOString().slice(0, 10);
}
