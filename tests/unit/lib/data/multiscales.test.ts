import { describe, expect, it, vi } from "vitest";

import { EARTH_RADIUS_METERS } from "@/lib/camera/cameraSettings.ts";
import {
  levelGeometryFromGrid,
  parseMultiscales,
} from "@/lib/data/multiscales.ts";
import type { TDataSource } from "@/lib/types/GlobeTypes.ts";

const METERS_PER_DEGREE = (Math.PI / 180) * EARTH_RADIUS_METERS;

function omeAttrs(
  units: [string, string],
  scales: [number, number][],
  axisType = "space"
) {
  return {
    multiscales: [
      {
        axes: [
          { name: "time", type: "time" },
          { name: "lat", type: axisType, unit: units[0] },
          { name: "lon", type: axisType, unit: units[1] },
        ],
        datasets: scales.map((scale, index) => ({
          path: String(index),
          coordinateTransformations: [{ type: "scale", scale: [1, ...scale] }],
        })),
      },
    ],
  };
}

describe("parseMultiscales", () => {
  it("lists OME-NGFF datasets as declared with their ground resolution", () => {
    const levels = parseMultiscales(
      omeAttrs(
        ["degree", "degrees_east"],
        [
          [0.25, 0.25],
          [0.5, 0.5],
        ]
      )
    );
    expect(levels.map((level) => level.path)).toEqual(["0", "1"]);
    expect(levels[0].resolution).toBeCloseTo(0.25 * METERS_PER_DEGREE, 6);
    expect(levels[1].resolution).toBeCloseTo(0.5 * METERS_PER_DEGREE, 6);
  });

  it("averages the spatial axes in metres and converts kilometres", () => {
    const [level] = parseMultiscales(omeAttrs(["km", "metre"], [[1, 1000]]));
    expect(level.resolution).toBe(1000);
  });

  it("leaves the resolution out for units it cannot convert", () => {
    const [level] = parseMultiscales(omeAttrs(["pixel", "pixel"], [[1, 1]]));
    expect(level.path).toBe("0");
    expect(level.resolution).toBeUndefined();
  });

  it("leaves the resolution out without spatial axes or a scale", () => {
    expect(
      parseMultiscales(omeAttrs(["degree", "degree"], [[1, 1]], "channel"))[0]
        .resolution
    ).toBeUndefined();
    expect(
      parseMultiscales({
        multiscales: [{ datasets: [{ path: "0" }, { path: "1" }] }],
      })
    ).toEqual([{ path: "0" }, { path: "1" }]);
  });
});

describe("parseMultiscales for GeoZarr", () => {
  it("orders GeoZarr tile matrices finest first with WebMercatorQuad resolutions", () => {
    const levels = parseMultiscales({
      multiscales: [
        {
          tile_matrix_set: "WebMercatorQuad", // eslint-disable-line camelcase
          tile_matrix_limits: { "0": {}, "1": {}, "2": {} }, // eslint-disable-line camelcase
        },
      ],
    });
    expect(levels.map((level) => level.path)).toEqual(["2", "1", "0"]);
    expect(levels[0].resolution).toBeCloseTo(156543.03392804097 / 4, 6);
    expect(levels[2].resolution).toBeCloseTo(156543.03392804097, 6);
  });

  it("keeps named tile matrices as declared without a known resolution", () => {
    const levels = parseMultiscales({
      multiscales: [
        {
          tile_matrix_set: { id: "CustomGrid" }, // eslint-disable-line camelcase
          tile_matrix_limits: { coarse: {}, fine: {} }, // eslint-disable-line camelcase
        },
      ],
    });
    expect(levels).toEqual([{ path: "coarse" }, { path: "fine" }]);
  });

  it("declares no levels without a usable multiscales attribute", () => {
    expect(parseMultiscales({})).toEqual([]);
    expect(parseMultiscales({ multiscales: "0.4" })).toEqual([]);
    expect(parseMultiscales({ multiscales: [] })).toEqual([]);
    expect(parseMultiscales({ multiscales: [{ version: "0.4" }] })).toEqual([]);
  });
});

function source(overrides: Partial<TDataSource> = {}): TDataSource {
  return { store: "store", dataset: "0", ...overrides };
}

describe("levelGeometryFromGrid", () => {
  const readAxis = vi.fn(async () => [0, 0.25]);

  it("takes the HEALPix nside from the CRS variable", async () => {
    const geometry = await levelGeometryFromGrid(
      {
        crs: source({
          attrs: { grid_mapping_name: "healpix", healpix_nside: 1024 }, // eslint-disable-line camelcase
        }),
        tas: source({ shape: [10, 12 * 1024 * 1024] }),
      },
      readAxis
    );
    expect(geometry.cellCount).toBe(12 * 1024 * 1024);
    expect(geometry.resolution).toBeCloseTo(
      (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 1024,
      6
    );
    expect(readAxis).not.toHaveBeenCalled();
  });

  it("infers the HEALPix nside from a global cell dimension", async () => {
    const geometry = await levelGeometryFromGrid(
      {
        tas: source({
          shape: [10, 12 * 16],
          attrs: { dimensionNames: ["time", "cell"] },
        }),
      },
      readAxis
    );
    expect(geometry).toEqual({
      resolution: (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 4,
      cellCount: 12 * 16,
    });
  });
});

describe("levelGeometryFromGrid on regular grids", () => {
  const readAxis = vi.fn(async () => [0, 0.25]);

  it("reads the spacing of a regular longitude coordinate", async () => {
    const geometry = await levelGeometryFromGrid(
      {
        lat: source({ shape: [720], hidden: true }),
        lon: source({ shape: [1440], hidden: true }),
        tas: source({
          shape: [10, 720, 1440],
          attrs: { dimensionNames: ["time", "lat", "lon"] },
        }),
      },
      readAxis
    );
    expect(readAxis).toHaveBeenCalledWith("lon");
    expect(geometry.resolution).toBeCloseTo(0.25 * METERS_PER_DEGREE, 6);
    expect(geometry.cellCount).toBe(720 * 1440);
  });

  it("knows nothing about other grids", async () => {
    readAxis.mockClear();
    const geometry = await levelGeometryFromGrid(
      {
        x: source({ shape: [500] }),
        tas: source({
          shape: [500, 500],
          attrs: { dimensionNames: ["y", "x"] },
        }),
      },
      readAxis
    );
    expect(geometry).toEqual({});
    expect(readAxis).not.toHaveBeenCalled();
  });
});
