import { Grid } from "healpix-geo";
import { expect, it } from "vitest";

import "@/utils/disposablePolyfill.ts";
import {
  rangeChunks,
  fetchConcurrency,
  concurrencyFor,
  fetchOverride,
  blockParts,
  createBlockCache,
  createFaceAssembly,
  createWindowRead,
  fetchInOrder,
  rangeDistance,
  orderedBlockRanges,
  partBytes,
  readFaceProgressively,
  readRanges,
} from "@/lib/grids/healpixBlockFetch.ts";
import { buildHealpixTexture } from "@/lib/grids/healpixCalculations.ts";

const deferred = <T>() => {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("orders a window's ranges by their distance from the camera", () => {
  using blockGrid = new Grid({ scheme: "nested", level: 6 });
  const under = Number(blockGrid.lonLatToHealpix(Float64Array.of(31, 11))[0]);
  // the block under the camera, its neighbours and one far away
  const blocks = [under + 2, under + 1, under, under + 3, 7 * 4 ** 6 + 5];
  const ranges = orderedBlockRanges(blockGrid, blocks, 4096, Infinity, 31, 11);
  // neighbours merge into one range, placed by the nearest of them
  expect(ranges[0]).toMatchObject({
    start: under * 4096,
    end: (under + 4) * 4096,
    face: Math.floor(under / 4 ** 6),
  });
  expect(ranges[1]).toMatchObject({
    start: (7 * 4 ** 6 + 5) * 4096,
    end: (7 * 4 ** 6 + 6) * 4096,
    face: 7,
  });
  // each range carries its nearest block's centre, to re-rank against a moved camera
  expect(
    rangeDistance(ranges[0], { centreLon: 31, centreLat: 11 })
  ).toBeLessThan(2);
  expect(
    rangeDistance(ranges[1], { centreLon: 31, centreLat: 11 })
  ).toBeGreaterThan(20);
  // a run never crosses into another chunk
  const chunked = orderedBlockRanges(blockGrid, blocks, 4096, 2 * 4096, 31, 11);
  expect(chunked).toHaveLength(under % 2 === 0 ? 3 : 4);
  for (const range of chunked) {
    expect(Math.floor(range.start / 8192)).toBe(
      Math.floor((range.end - 1) / 8192)
    );
  }
  expect(chunked[0].start).toBeLessThanOrEqual(under * 4096);
  expect(chunked[0].end).toBeGreaterThan(under * 4096);
});

it("fetches in order, a few at a time, and hands results over as they land", async () => {
  const pending: ReturnType<typeof deferred<string>>[] = [];
  const started: number[] = [];
  const landings = fetchInOrder(
    [0, 1, 2, 3, 4],
    (item) => {
      started.push(item);
      const entry = deferred<string>();
      pending.push(entry);
      return entry.promise;
    },
    { concurrency: 2 }
  );
  expect(started).toEqual([0, 1]);
  pending[1].resolve("b");
  expect(await landings.next()).toEqual({ item: 1, result: "b" });
  await tick();
  expect(started).toEqual([0, 1, 2]);
  pending[2].resolve("c");
  pending[0].resolve("a");
  expect(await landings.next()).toEqual({ item: 2, result: "c" });
  expect(await landings.next()).toEqual({ item: 0, result: "a" });
  await tick();
  pending[3].resolve("d");
  pending[4].resolve("e");
  expect(await landings.next()).toEqual({ item: 3, result: "d" });
  expect(await landings.next()).toEqual({ item: 4, result: "e" });
  expect(await landings.next()).toBeUndefined();
});

it("starts nothing more once the read is superseded, and reports a failure", async () => {
  let current = true;
  const started: number[] = [];
  const landings = fetchInOrder(
    [0, 1, 2, 3],
    async (item) => {
      started.push(item);
      await tick();
      return item;
    },
    { concurrency: 1, isCurrent: () => current }
  );
  expect(await landings.next()).toEqual({ item: 0, result: 0 });
  current = false;
  // the read in flight lands; nothing follows it
  expect(await landings.next()).toEqual({ item: 1, result: 1 });
  expect(await landings.next()).toBeUndefined();
  expect(started).toEqual([0, 1]);

  const failing = fetchInOrder([0, 1], async (item) => {
    await tick();
    if (item === 1) {
      throw new Error("gone");
    }
    return item;
  });
  expect(await failing.next()).toEqual({ item: 0, result: 0 });
  await expect(failing.next()).rejects.toThrow("gone");
});

it("draws a face from the blocks landed so far, in cell order", () => {
  const nside = 2 ** 9;
  using blockGrid = new Grid({ scheme: "nested", level: 5 });
  const under = Number(blockGrid.lonLatToHealpix(Float64Array.of(31, 11))[0]);
  const face = Math.floor(under / 4 ** 5);
  const blocks = [under, under + 1, under + 2];
  const part = (block: number) => ({
    range: { start: block * 256, end: (block + 1) * 256 },
    cells: Array.from({ length: 256 }, (_, index) => block * 256 + index),
    data: Float32Array.from({ length: 256 }, (_, index) => block * 256 + index),
  });
  const assembly = createFaceAssembly();
  // the second block lands first
  assembly.add(part(blocks[1]).range, part(blocks[1]));
  expect(assembly.parts()).toHaveLength(1);
  const partial = assembly.face();
  expect(partial.cells).toEqual(part(blocks[1]).cells);
  const texture = buildHealpixTexture(partial.data, face, nside, partial.cells);
  // the one block: a 16 by 16 square, every texel of it a cell
  expect(texture.width * texture.height).toBe(256);
  expect(Array.from(texture.dataValues).filter(Number.isFinite)).toHaveLength(
    256
  );
  expect(texture.dataRect.width).toBeCloseTo(16 / nside);

  assembly.add(part(blocks[2]).range, part(blocks[2]));
  assembly.add(part(blocks[0]).range, part(blocks[0]));
  const whole = assembly.face();
  expect(whole.cells).toEqual([
    ...part(blocks[0]).cells,
    ...part(blocks[1]).cells,
    ...part(blocks[2]).cells,
  ]);
  expect(whole.data[0]).toBe(blocks[0] * 256);
  expect(whole.data[767]).toBe(blocks[2] * 256 + 255);
  expect(whole.ranges.map(({ start }) => start / 256)).toEqual(blocks);
  // a face kept from an earlier window seeds the next one's assembly
  const seeded = createFaceAssembly(assembly.parts().slice(0, 2));
  seeded.add(part(blocks[2]).range, part(blocks[2]));
  expect(seeded.face().cells).toEqual(whole.cells);
});

it("reads a window's faces as their ranges land, the seeded parts first", async () => {
  const range = (face: number, block: number) => ({
    face,
    start: block * 4,
    end: (block + 1) * 4,
    lon: 0,
    lat: 0,
  });
  const cells = ({ start, end }: { start: number; end: number }) => ({
    cells: Array.from({ length: end - start }, (_, i) => start + i),
    data: Float32Array.from({ length: end - start }, (_, i) => start + i),
  });
  const ranges = [range(1, 7), range(0, 1), range(1, 6)];
  const seed = new Map([[1, [{ range: range(1, 5), ...cells(range(1, 5)) }]]]);
  const read = createWindowRead(
    fetchInOrder(ranges, async (item) => cells(item)),
    ranges,
    seed
  );
  expect(read.pending.get(1)).toBe(2);
  const drawn: number[][] = [];
  const face = await readFaceProgressively(
    1,
    read,
    async (partial) => void drawn.push(partial.cells),
    () => true
  );
  // the seeded part and the two ranges that landed, in cell order
  expect(face.cells).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
  expect(read.pending.get(1)).toBe(0);
  // the other face's range waits in its assembly
  expect(read.assemblies.get(0)!.face().cells).toEqual([4, 5, 6, 7]);
  // nothing drawn within the redraw interval
  expect(drawn).toEqual([]);
});

it("reads every range of a face a few at a time, in ascending order", async () => {
  const ranges = Array.from({ length: 50 }, (_, index) => ({
    start: (49 - index) * 4,
    end: (50 - index) * 4,
  }));
  let [pending, most] = [0, 0];
  const face = await readRanges(ranges, async ({ start, end }) => {
    pending++;
    most = Math.max(most, pending);
    await tick();
    pending--;
    return {
      data: Float32Array.from({ length: end - start }, (_, i) => start + i),
      cells: Array.from({ length: end - start }, (_, i) => start + i),
    };
  });
  // the cap now: no protocol to read in a test, so the multiplexed one
  expect(most).toBe(fetchConcurrency());
  expect(most).toBe(32);
  expect(face.cells).toEqual(Array.from({ length: 200 }, (_, i) => i));
  expect(Array.from(face.data)).toEqual(face.cells);
});

it("re-ranks what is left each time a slot frees, nothing in flight abandoned", async () => {
  // one fetch at a time; the rank flips after the first start, as a pan would
  const items = ["a", "b", "c", "d"];
  let flipped = false;
  const rankOf = { a: 0, b: 1, c: 2, d: 3 } as Record<string, number>;
  const started: string[] = [];
  const landings = fetchInOrder(
    items,
    async (item) => {
      started.push(item);
      flipped = true;
      return item;
    },
    {
      concurrency: 1,
      rank: (item) => (flipped ? -rankOf[item] : rankOf[item]),
    }
  );
  const landed: string[] = [];
  for (
    let landing = await landings.next();
    landing;
    landing = await landings.next()
  ) {
    landed.push(landing.item);
  }
  // "a" was first under the original rank; then the order reverses for the rest
  expect(started).toEqual(["a", "d", "c", "b"]);
  expect(landed.sort()).toEqual(items);
});

it("keeps the given order when no rank is passed", async () => {
  const started: number[] = [];
  const landings = fetchInOrder(
    [3, 1, 2],
    async (item) => {
      started.push(item);
      return item;
    },
    { concurrency: 1 }
  );
  while (await landings.next()) {
    // drain
  }
  expect(started).toEqual([3, 1, 2]);
});

it("ranks a block range by its centre's great-circle distance from the camera", () => {
  const range = { face: 0, start: 0, end: 4, lon: 10, lat: 0 };
  expect(rangeDistance(range, { centreLon: 10, centreLat: 0 })).toBeCloseTo(0);
  expect(rangeDistance(range, { centreLon: 20, centreLat: 0 })).toBeCloseTo(10);
});

/** A block of 4 cells as held: 4 values, 4 ids (48 bytes), centred at `lon`. */
const heldBlock = (block: number, lon: number) => ({
  face: 0,
  part: {
    range: { start: 4 * block, end: 4 * block + 4 },
    data: new Float32Array(4),
    cells: [0, 1, 2, 3].map((cell) => 4 * block + cell),
  },
  lon,
  lat: 0,
});

it("cuts a part into one part per block, a sparse block empty", () => {
  const part = {
    range: { start: 8, end: 20 },
    data: Float32Array.of(1, 2, 3, 4),
    cells: [8, 9, 17, 19],
  };
  const cut = blockParts(part, 4);
  expect(cut.map(({ block }) => block)).toEqual([2, 3, 4]);
  expect(cut[0].part).toEqual({
    range: { start: 8, end: 12 },
    data: Float32Array.of(1, 2),
    cells: [8, 9],
  });
  expect(cut[1].part.cells).toEqual([]);
  expect([...cut[2].part.data]).toEqual([3, 4]);
  expect(cut.reduce((sum, { part }) => sum + partBytes(part), 0)).toBe(
    partBytes(part)
  );
  // a part of one block is held as it is
  const one = { ...part, range: { start: 8, end: 12 } };
  expect(blockParts(one, 4)[0].part).toBe(one);
});

it("holds a block per level and key, and misses on another key", () => {
  const cache = createBlockCache();
  cache.add(3, "a", 7, heldBlock(7, 0));
  expect(cache.get(3, "a", 7)?.part.range).toEqual({ start: 28, end: 32 });
  expect(cache.get(3, "b", 7)).toBeUndefined();
  expect(cache.get(2, "a", 7)).toBeUndefined();
  // a block held again is counted once
  cache.add(3, "a", 7, heldBlock(7, 0));
  expect(cache.bytes()).toBe(48);
  // another key for the level lets the stale blocks go
  cache.add(3, "b", 8, heldBlock(8, 0));
  expect(cache.get(3, "a", 7)).toBeUndefined();
  expect(cache.bytes()).toBe(48);
});

it("evicts the blocks farthest from the camera first, never those kept, within the bound", () => {
  // room for three blocks of 48 bytes
  const cache = createBlockCache(3 * 48);
  const lons = [0, 10, 170, 20, 90];
  lons.forEach((lon, block) => cache.add(0, "k", block, heldBlock(block, lon)));
  expect(cache.bytes()).toBe(5 * 48);
  // block 2, the farthest, is on screen: 4 and then 3 go instead
  cache.evict({ centreLon: 0, centreLat: 0 }, (_, block) => block === 2);
  expect(cache.bytes()).toBe(3 * 48);
  const held = lons.map((_, block) => cache.get(0, "k", block) !== undefined);
  expect(held).toEqual([true, true, true, false, false]);
  // over the bound with only kept blocks left, nothing kept goes
  cache.add(1, "k", 0, heldBlock(0, 0));
  cache.evict({ centreLon: 0, centreLat: 0 }, () => true);
  expect(cache.bytes()).toBe(4 * 48);
  cache.evict({ centreLon: 0, centreLat: 0 }, () => false);
  expect(cache.get(0, "k", 2)).toBeUndefined();
  expect(cache.bytes()).toBeLessThanOrEqual(3 * 48);
});

it("caps reads at 8 on HTTP/1.x and 32 otherwise, unless the hash overrides", () => {
  expect(concurrencyFor("http/1.1")).toBe(8);
  expect(concurrencyFor("http/1.0")).toBe(8);
  expect(concurrencyFor("h2")).toBe(32);
  expect(concurrencyFor("h3")).toBe(32);
  // not reported (a cross-origin entry may hide it): counted as multiplexed
  expect(concurrencyFor("")).toBe(32);
  expect(concurrencyFor(undefined)).toBe(32);
  expect(concurrencyFor("http/1.1", 64)).toBe(64);
  expect(fetchOverride("#hive+https://x/y.zarr::fetch=64")).toBe(64);
  expect(fetchOverride("#hive+https://x/y.zarr::fetch=64::lat=37")).toBe(64);
  expect(fetchOverride("#fetch=16")).toBe(16);
  expect(fetchOverride("#hive+https://x/y.zarr")).toBeUndefined();
  expect(fetchOverride("#hive+https://x/y.zarr::fetch=0")).toBeUndefined();
  expect(fetchOverride("#hive+https://x/y.zarr::fetch=abc")).toBeUndefined();
});

it("spans ranges over ::chunks= aligned chunks, one chunk by default", () => {
  expect(rangeChunks("#hive+https://x/y.zarr")).toBe(1);
  expect(rangeChunks("#hive+https://x/y.zarr::chunks=4")).toBe(4);
  expect(
    rangeChunks("#hive+https://x/y.zarr::fetch=64::chunks=6::lat=37")
  ).toBe(6);
  expect(rangeChunks("#hive+https://x/y.zarr::chunks=0")).toBe(1);
  // the same run of eight one-chunk blocks: eight ranges, then two of four
  using blockGrid = new Grid({ scheme: "nested", level: 6 });
  const blocks = Array.from({ length: 8 }, (_, block) => block);
  const one = orderedBlockRanges(blockGrid, blocks, 4096, 4096, 0, 0);
  expect(one).toHaveLength(8);
  const four = orderedBlockRanges(blockGrid, blocks, 4096, 4 * 4096, 0, 0);
  expect(
    four
      .map(({ start, end }) => [start / 4096, end / 4096])
      .sort((a, b) => a[0] - b[0])
  ).toEqual([
    [0, 4],
    [4, 8],
  ]);
});
