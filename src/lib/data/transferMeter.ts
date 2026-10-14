import type * as zarr from "zarrita";

/** How far back the meter looks: the reads of the last few seconds. */
const RATE_WINDOW_MS = 20_000;

/** Bytes the meter must have seen in its window before it gives a rate. */
const RATE_MIN_BYTES = 4 * 2 ** 20;

type TTransfer = { start: number; end: number; bytes: number };

let transfers: TTransfer[] = [];

/** Bytes and cells read of a stored level, by order, then by array name. */
const cellBytes = new Map<
  number,
  Map<string, { bytes: number; cells: number }>
>();

function now() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/** Note a read of `bytes` from `start` to `end` (milliseconds). */
export function recordTransfer(start: number, end: number, bytes: number) {
  transfers.push({ start, end, bytes });
  transfers = transfers.filter(({ end }) => end >= start - RATE_WINDOW_MS);
}

/**
 * Bytes a second the store delivered over its recent reads: their bytes over
 * the time at least one was in flight, so that idle time between loads does
 * not count and concurrent reads are not counted twice. Undefined until the
 * window holds `RATE_MIN_BYTES`.
 */
export function transferRate(at = now()): number | undefined {
  const recent = transfers
    .filter(({ end }) => end >= at - RATE_WINDOW_MS)
    .sort((a, b) => a.start - b.start);
  const bytes = recent.reduce((sum, read) => sum + read.bytes, 0);
  if (bytes < RATE_MIN_BYTES) {
    return undefined;
  }
  let [busy, reach] = [0, -Infinity];
  for (const { start, end } of recent) {
    busy += Math.max(end - Math.max(start, reach), 0);
    reach = Math.max(reach, end);
  }
  return busy > 0 ? (bytes * 1000) / busy : undefined;
}

/** Note that a chunk of `cells` cells of array `name` at `order` cost `bytes`. */
export function recordCellBytes(
  order: number,
  name: string,
  bytes: number,
  cells: number
) {
  const names = cellBytes.get(order) ?? new Map();
  const seen = names.get(name) ?? { bytes: 0, cells: 0 };
  names.set(name, { bytes: seen.bytes + bytes, cells: seen.cells + cells });
  cellBytes.set(order, names);
}

/**
 * Bytes a cell of a stored level costs, as read so far: the cheapest array
 * read at `order` (the signal digest; a stratum choice is priced relative to
 * it), else at the nearest coarser order read, which costs more a cell than
 * a finer one and so errs towards the coarser level. Undefined before any
 * read at `order` or coarser.
 */
export function learnedCellBytes(order: number): number | undefined {
  const known = [...cellBytes.keys()].filter((at) => at <= order);
  if (!known.length) {
    return undefined;
  }
  const names = cellBytes.get(Math.max(...known))!;
  return Math.min(...[...names.values()].map((n) => n.bytes / n.cells));
}

/** Forget the cell prices learned (a new store). */
export function resetCellBytes() {
  cellBytes.clear();
}

/** Forget everything the meter has seen (tests). */
export function resetTransferMeter() {
  transfers = [];
  cellBytes.clear();
}

/** A store that notes every read's bytes and time with `recordTransfer`. */
export function meterTransfers(store: zarr.AsyncReadable): zarr.AsyncReadable {
  async function timed(read: () => Promise<Uint8Array | undefined>) {
    const start = now();
    const bytes = await read();
    recordTransfer(start, now(), bytes?.byteLength ?? 0);
    return bytes;
  }
  const { getRange } = store;
  return {
    get: (key, opts) => timed(() => store.get(key, opts)),
    ...(getRange && {
      getRange: (key, range, opts) =>
        timed(() => getRange.call(store, key, range, opts)),
    }),
  };
}
