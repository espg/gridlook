/* eslint-disable camelcase -- Zarr metadata uses snake_case keys. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { EARTH_RADIUS_METERS } from "@/lib/camera/cameraSettings.ts";
import { indexFromIndex, indexFromZarr } from "@/lib/data/sourceIndexing.ts";

const SRC = "https://example.test/pyramid.zarr";

type TLevelSpec = { path: string; nlat: number; nlon: number };

function zarray(length: number[]) {
  return {
    zarr_format: 2,
    shape: length,
    chunks: length,
    dtype: "<f8",
    compressor: null,
    filters: null,
    fill_value: 0,
    order: "C",
  };
}

/** Consolidated v2 metadata of a lat/lon pyramid, one child group a level. */
function pyramidMetadata(
  levels: TLevelSpec[],
  rootAttrs: Record<string, unknown>
) {
  const metadata: Record<string, unknown> = {
    ".zgroup": { zarr_format: 2 },
    ".zattrs": rootAttrs,
  };
  for (const { path, nlat, nlon } of levels) {
    metadata[`${path}/.zgroup`] = { zarr_format: 2 };
    metadata[`${path}/lat/.zarray`] = zarray([nlat]);
    metadata[`${path}/lat/.zattrs`] = { _ARRAY_DIMENSIONS: ["lat"] };
    metadata[`${path}/lon/.zarray`] = zarray([nlon]);
    metadata[`${path}/lon/.zattrs`] = { _ARRAY_DIMENSIONS: ["lon"] };
    metadata[`${path}/tas/.zarray`] = zarray([nlat, nlon]);
    metadata[`${path}/tas/.zattrs`] = { _ARRAY_DIMENSIONS: ["lat", "lon"] };
  }
  return { zarr_consolidated_format: 1, metadata };
}

function omeAttrs(paths: string[]) {
  return { multiscales: [{ datasets: paths.map((path) => ({ path })) }] };
}

function longitudes(nlon: number) {
  const step = 360 / nlon;
  return Float64Array.from({ length: nlon }, (_, index) => index * step);
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

/**
 * Serve `files` (JSON, typed arrays, or an Error to throw) by URL; anything
 * else is a 404. Returns the fetch mock so a test can inspect the requests.
 */
function serve(files: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const file = files[requestUrl(input)];
    if (file instanceof Error) {
      throw file;
    }
    if (file instanceof Float64Array) {
      return new Response(file.buffer as ArrayBuffer);
    }
    if (file === undefined) {
      return new Response(null, { status: 404 });
    }
    return new Response(JSON.stringify(file));
  });
}

function pyramidFiles(levels: TLevelSpec[], rootAttrs = omeAttrs([])) {
  const files: Record<string, unknown> = {
    [`${SRC}/.zmetadata`]: pyramidMetadata(levels, rootAttrs),
  };
  for (const { path, nlon } of levels) {
    files[`${SRC}/${path}/lon/0`] = longitudes(nlon);
  }
  return files;
}

const LEVELS: TLevelSpec[] = [
  { path: "0", nlat: 180, nlon: 360 },
  { path: "1", nlat: 90, nlon: 180 },
  { path: "2", nlat: 45, nlon: 90 },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("indexing a pyramid whose levels fail to read", () => {
  it("leaves out a level whose grid cannot be read", async () => {
    const files = pyramidFiles(LEVELS, omeAttrs(["0", "1", "2"]));
    files[`${SRC}/1/lon/0`] = new TypeError("network error");
    serve(files);
    const index = await indexFromZarr(SRC);
    expect(index.levels.map((level) => level.name)).toEqual(["0", "2"]);
  });

  it("opens as a single level when fewer than two levels survive", async () => {
    const files = pyramidFiles(LEVELS.slice(0, 2), omeAttrs(["0", "1"]));
    files[`${SRC}/0/lon/0`] = new TypeError("network error");
    serve(files);
    const index = await indexFromZarr(SRC);
    expect(index.levels).toHaveLength(1);
    expect(Object.keys(index.levels[0].datasources)).toEqual(
      expect.arrayContaining(["0/tas", "1/tas"])
    );
  });

  it("does not read the grid when the attributes give the resolution", async () => {
    const attrs = {
      multiscales: [
        {
          axes: [
            { name: "lat", type: "space", unit: "degree" },
            { name: "lon", type: "space", unit: "degree" },
          ],
          datasets: ["0", "1"].map((path, index) => ({
            path,
            coordinateTransformations: [
              { type: "scale", scale: [2 ** index, 2 ** index] },
            ],
          })),
        },
      ],
    };
    const fetchMock = serve(pyramidFiles(LEVELS.slice(0, 2), attrs));
    const index = await indexFromZarr(SRC);
    expect(index.levels.map((level) => level.cellCount)).toEqual([
      180 * 360,
      90 * 180,
    ]);
    const urls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
    expect(urls.some((url) => url.endsWith("/lon/0"))).toBe(false);
  });
});

describe("indexing a HEALPix pyramid under the DGGS convention", () => {
  it("reads each level's refinement level and stored cell count", async () => {
    const metadata: Record<string, unknown> = {
      ".zgroup": { zarr_format: 2 },
      ".zattrs": omeAttrs(["14", "13"]),
    };
    for (const [path, cells] of [
      ["14", 4000],
      ["13", 1000],
    ] as const) {
      metadata[`${path}/.zgroup`] = { zarr_format: 2 };
      metadata[`${path}/.zattrs`] = {
        dggs: { name: "healpix", refinement_level: Number(path) },
      };
      metadata[`${path}/cell_ids/.zarray`] = zarray([cells]);
      metadata[`${path}/cell_ids/.zattrs`] = { _ARRAY_DIMENSIONS: ["cells"] };
      metadata[`${path}/tas/.zarray`] = zarray([cells]);
      metadata[`${path}/tas/.zattrs`] = { _ARRAY_DIMENSIONS: ["cells"] };
    }
    serve({
      [`${SRC}/.zmetadata`]: { zarr_consolidated_format: 1, metadata },
    });
    const index = await indexFromZarr(SRC);
    const nsideResolution = (order: number) =>
      (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 2 ** order;
    expect(index.levels.map(({ cellCount }) => cellCount)).toEqual([
      4000, 1000,
    ]);
    expect(index.levels[0].resolution).toBeCloseTo(nsideResolution(14), 6);
    expect(index.levels[1].resolution).toBeCloseTo(nsideResolution(13), 6);
  });
});

function jsonIndex(stores: string[]) {
  return {
    zarr_format: 2,
    levels: stores.map((store) => ({
      grid: { store, dataset: "" },
      time: { store, dataset: "" },
      datasources: { tas: { store, dataset: "" } },
    })),
  };
}

function flatStore(nlat: number, nlon: number) {
  return {
    zarr_consolidated_format: 1,
    metadata: {
      ".zgroup": { zarr_format: 2 },
      ".zattrs": {},
      "tas/.zarray": zarray([nlat, nlon]),
      "tas/.zattrs": { _ARRAY_DIMENSIONS: ["lat", "lon"] },
    },
  };
}

describe("indexing a JSON index whose levels fail to read", () => {
  const INDEX = "https://example.test/index.json";
  const FINE = "https://example.test/fine.zarr";
  const COARSE = "https://example.test/coarse.zarr";

  it("leaves out a further level whose store cannot be read", async () => {
    serve({
      [INDEX]: jsonIndex([FINE, COARSE]),
      [`${FINE}/.zmetadata`]: flatStore(180, 360),
    });
    const index = await indexFromIndex(INDEX);
    expect(index.levels).toHaveLength(1);
    expect(index.levels[0].datasources.tas.shape).toEqual([180, 360]);
  });

  it("still fails when the first level's store cannot be read", async () => {
    serve({
      [INDEX]: jsonIndex([FINE, COARSE]),
      [`${COARSE}/.zmetadata`]: flatStore(90, 180),
    });
    await expect(indexFromIndex(INDEX)).rejects.toThrow();
  });
});
