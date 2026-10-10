import { describe, expect, it } from "vitest";

import { digestCell, digestField } from "@/lib/digest/digestField.ts";
import {
  digestPlot,
  digestStrata,
  probePercentiles,
  type TDigestProbe,
} from "@/lib/digest/digestProbe.ts";
import { createDigestReader } from "@/lib/digest/digestReader.ts";
import { digestVariablesOf } from "@/lib/digest/digestVariables.ts";

const encoder = new TextEncoder();
const metadata = {
  shape: [1, 12],
  chunk_grid: { configuration: { chunk_shape: [1, 4] } }, // eslint-disable-line camelcase
  codecs: [{ name: "vlen-bytes", configuration: {} }],
};
type TCell = [mean: number, weight: number][];

function frame(cells: TCell[]) {
  const payloads = cells.map(
    (cell) => new Uint8Array(new Float32Array(cell.flat()).buffer)
  );
  const bytes = new Uint8Array(
    4 + payloads.reduce((sum, payload) => sum + 4 + payload.length, 0)
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, cells.length, true);
  let at = 4;
  for (const payload of payloads) {
    view.setUint32(at, payload.length, true);
    bytes.set(payload, at + 4);
    at += 4 + payload.length;
  }
  return bytes;
}

/** Chunks of 4 cells; chunk 1 does not exist. */
function reader() {
  const requests: string[] = [];
  const chunks: Record<string, TCell[]> = {
    "/8/h_tdigest_signal/c/0/0": [
      [[10, 1]],
      [],
      [
        [0, 5],
        [100, 5],
      ],
      [[30, 2]],
    ],
    "/8/h_tdigest_signal/c/0/2": [[[50, 1]], [[60, 1]], [[70, 1]], [[80, 1]]],
    "/8/h_tdigest_noise/c/0/0": [[[-500, 4]], [[0, 9]], [[500, 4]], []],
  };
  const store = {
    async get(key: string) {
      requests.push(key);
      if (key.endsWith("/zarr.json")) {
        return encoder.encode(JSON.stringify(metadata));
      }
      return chunks[key] && frame(chunks[key]);
    },
  };
  return { requests, reader: createDigestReader(store) };
}

const params = { percentile: 50, low: 0, high: 100 };
const PATH = "8/h_tdigest_signal";

// eslint-disable-next-line max-lines-per-function
describe("digestField", () => {
  it("is the percentile per cell, NaN without data or without a chunk", async () => {
    const { reader: digests } = reader();
    const field = await digestField(
      digests,
      PATH,
      { product: "percentile" },
      params,
      0,
      12
    );
    expect(field).toBeInstanceOf(Float32Array);
    expect([...field]).toEqual([
      10,
      NaN,
      // zagg's law at rank 4.5 of 10: between the two centroids' spans
      43.75,
      30,
      NaN,
      NaN,
      NaN,
      NaN,
      50,
      60,
      70,
      80,
    ]);
  });

  it("reads only the chunks a range of cells touches", async () => {
    const { reader: digests, requests } = reader();
    const field = await digestField(
      digests,
      PATH,
      { product: "range" },
      params,
      2,
      4
    );
    expect([...field]).toEqual([100, 0]);
    expect(requests.filter((key) => key.includes("/c/"))).toEqual([
      "/8/h_tdigest_signal/c/0/0",
    ]);
  });

  it("computes other percentiles without reading anything again", async () => {
    const { reader: digests, requests } = reader();
    const variable = { product: "percentile" } as const;
    await digestField(digests, PATH, variable, params, 0, 12);
    const read = requests.length;
    const high = await digestField(
      digests,
      PATH,
      variable,
      { ...params, percentile: 100 },
      0,
      4
    );
    expect([...high]).toEqual([10, NaN, 100, 30]);
    expect(requests).toHaveLength(read);
  });

  it("is empty for an empty range", async () => {
    const { reader: digests, requests } = reader();
    expect(
      await digestField(digests, PATH, { product: "range" }, params, 5, 5)
    ).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});

describe("digestCell", () => {
  it("reads a cell's chunk, or only looks in memory", async () => {
    const { reader: digests, requests } = reader();
    expect(await digestCell(digests, PATH, 9, true)).toBeUndefined();
    expect(requests.filter((key) => key.includes("/c/"))).toEqual([]);
    const cell = await digestCell(digests, PATH, 9);
    expect(cell!.cell).toBe(1);
    expect(cell!.chunk.means[cell!.chunk.offsets[1]]).toBe(60);
    expect(await digestCell(digests, PATH, 9, true)).toEqual(cell);
    // a chunk the store does not have
    expect(await digestCell(digests, PATH, 5)).toBeNull();
  });
});

// eslint-disable-next-line max-lines-per-function
describe("the probe of one cell", () => {
  async function probe(cell: number, withNoise = true): Promise<TDigestProbe> {
    const { reader: digests } = reader();
    return {
      lat: 0,
      lon: 0,
      cell,
      order: 8,
      pinned: true,
      strata: [
        { name: "signal", digest: await digestCell(digests, PATH, cell) },
        {
          name: "noise",
          digest: withNoise
            ? await digestCell(digests, "8/h_tdigest_noise", cell)
            : undefined,
        },
      ],
    };
  }

  it("lists a level's digest arrays, the signal first", () => {
    const attrs = { ragged: { element: { dtype: "float32", shape: [-1, 2] } } };
    const datasources = Object.fromEntries(
      ["h_tdigest_noise", "h_tdigest_signal"].flatMap((name) =>
        Object.entries(digestVariablesOf(name, attrs)).map(
          ([variable, { attributes }]) => [
            variable,
            { store: "hive+x", dataset: "8", attrs: attributes },
          ]
        )
      )
    );
    expect(
      digestStrata({ ...datasources, count: { store: "hive+x", dataset: "8" } })
    ).toEqual([
      { name: "signal", path: "8/h_tdigest_signal" },
      { name: "noise", path: "8/h_tdigest_noise" },
    ]);
  });

  it("plots every stratum in observations per unit over the signal's range", async () => {
    const plot = digestPlot(await probe(2), 26)!;
    // 0..100 padded by 4% either side
    expect(plot.x[0]).toBe(-4);
    expect(plot.x[26]).toBe(104);
    expect(plot.curves.map(({ name }) => name)).toEqual(["signal", "noise"]);
    const step = plot.x[1] - plot.x[0];
    const total = (density: Float32Array) =>
      density.reduce((sum, value) => sum + value * step, 0);
    expect(total(plot.curves[0].density)).toBeCloseTo(10, 4);
    // the noise digest is one centroid at 500, outside the range
    expect(total(plot.curves[1].density)).toBe(0);
    expect(plot.peak).toBeGreaterThan(0);
  });

  it("falls back to the stratum that has data, and to nothing", async () => {
    const noiseOnly = await probe(1);
    expect(digestPlot(noiseOnly)!.curves.map(({ name }) => name)).toEqual([
      "noise",
    ]);
    expect(probePercentiles(noiseOnly, [50], "signal")).toEqual({
      stratum: "noise",
      weight: 9,
      values: [{ percentile: 50, value: 0 }],
    });
    const empty = await probe(1, false);
    expect(digestPlot(empty)).toBeUndefined();
    expect(probePercentiles(empty, [50])).toBeUndefined();
  });

  it("gives the percentiles of the stratum asked for", async () => {
    const summary = probePercentiles(await probe(2), [0, 100], "noise")!;
    expect(summary.stratum).toBe("noise");
    expect(summary.values.map(({ value }) => value)).toEqual([500, 500]);
    expect(probePercentiles(await probe(2), [0, 100])!.values).toEqual([
      { percentile: 0, value: 0 },
      { percentile: 100, value: 100 },
    ]);
  });
});
