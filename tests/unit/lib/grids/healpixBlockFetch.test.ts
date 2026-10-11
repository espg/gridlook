import { Grid } from "healpix-geo";
import { expect, it } from "vitest";

import "@/utils/disposablePolyfill.ts";
import {
  createFaceAssembly,
  fetchInOrder,
  orderedBlockRanges,
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
  expect(ranges[1]).toEqual({
    start: (7 * 4 ** 6 + 5) * 4096,
    end: (7 * 4 ** 6 + 6) * 4096,
    face: 7,
  });
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
  expect(assembly.count).toBe(1);
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
});
