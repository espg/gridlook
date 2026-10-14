import { afterEach, expect, it, vi } from "vitest";

import { EARTH_RADIUS_METERS } from "@/lib/camera/cameraSettings.ts";
import {
  DEPLOYMENT_DEFAULTS,
  DEPLOYMENT_PARAMS,
  deploymentConfig,
  deploymentValue,
  hashParam,
} from "@/lib/config/deployment.ts";
import { pixelFloorOf, selectPointTier } from "@/lib/data/levels.ts";
import { concurrencyFor, rangeChunks } from "@/lib/grids/healpixBlockFetch.ts";
import { digestWindowMargin } from "@/lib/grids/healpixWindow.ts";

const STORE = "#hive+https://x/y.zarr";

// the cell size, in metres, of a HEALPix order (healpixOrderOf's inverse)
const resolutionOf = (order: number) =>
  (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 2 ** order;

afterEach(() => {
  vi.unstubAllGlobals();
});

it("ships the tuned values, each under a hash parameter of its own", () => {
  expect(deploymentConfig(STORE)).toEqual({
    fetchHttp1: 8,
    fetchMultiplexed: 16,
    rangeChunks: 4,
    digestWindowMargin: 0.1,
    fineDigestOrder: 13,
    fineDigestPixelsPerCell: [4, 8, 16],
    pointTierPixelsPerCell: 32,
    pointTierOrders: 3,
    digestDefaultVar: "h_percentile_signal",
    gapFill: false,
    gapFillSize: 15,
    showDistanceScale: true,
  });
  const params = Object.values(DEPLOYMENT_PARAMS).map(([param]) => param);
  expect(new Set(params).size).toBe(params.length);
});

it("reads `::<param>=<value>` anywhere in the hash", () => {
  expect(hashParam(`${STORE}::chunks=2::lat=37`, "chunks")).toBe("2");
  expect(hashParam("#chunks=2", "chunks")).toBe("2");
  expect(hashParam(`${STORE}::xchunks=2`, "chunks")).toBeUndefined();
  expect(hashParam(`${STORE}::digestvar=h%20mean`, "digestvar")).toBe("h mean");
});

it("takes every override that parses", () => {
  const hash =
    `${STORE}::fetchhttp1=4::fetchmux=24::chunks=2::digestmargin=0.25` +
    "::finedigestorder=12::finedigestpx=3,6::pointpx=64::pointorders=2" +
    "::digestvar=h_mean::smooth=true::smoothkernel=31::distancescale=false";
  expect(deploymentConfig(hash)).toEqual({
    fetchHttp1: 4,
    fetchMultiplexed: 24,
    rangeChunks: 2,
    digestWindowMargin: 0.25,
    fineDigestOrder: 12,
    fineDigestPixelsPerCell: [3, 6],
    pointTierPixelsPerCell: 64,
    pointTierOrders: 2,
    digestDefaultVar: "h_mean",
    gapFill: true,
    gapFillSize: 31,
    showDistanceScale: false,
  });
});

it("ignores an override that does not parse", () => {
  for (const bad of [
    "chunks=0",
    "chunks=abc",
    "chunks=1.5",
    "digestmargin=-1",
    "finedigestpx=4,x",
    "smoothkernel=4",
    "distancescale=yes",
    "digestvar=",
  ]) {
    const [param] = bad.split("=");
    const key = (
      Object.keys(DEPLOYMENT_PARAMS) as (keyof typeof DEPLOYMENT_PARAMS)[]
    ).find((name) => DEPLOYMENT_PARAMS[name][0] === param)!;
    expect(deploymentValue(key, `${STORE}::${bad}`)).toEqual(
      DEPLOYMENT_DEFAULTS[key]
    );
  }
});

it("is read from the page hash where each value is used", () => {
  vi.stubGlobal("location", {
    hash:
      `${STORE}::fetchhttp1=3::fetchmux=5::chunks=2::digestmargin=0.2` +
      "::finedigestpx=6::pointpx=8",
  });
  expect(concurrencyFor("http/1.1")).toBe(3);
  expect(concurrencyFor("h3")).toBe(5);
  expect(concurrencyFor("h3", 64)).toBe(64);
  expect(rangeChunks(location.hash)).toBe(2);
  expect(digestWindowMargin()).toBe(0.2);
  // one floor for every digest order past 13; none for a non-digest level
  expect(pixelFloorOf(resolutionOf(14), true)).toBe(6);
  expect(pixelFloorOf(resolutionOf(16), true)).toBe(6);
  expect(pixelFloorOf(resolutionOf(16), false)).toBe(2);
  // the points come on at 8 px of the finest level's cells
  expect(selectPointTier(10 / 9, 10, false)).toBe(true);
  expect(selectPointTier(10 / 7, 10, false)).toBe(false);
});

it("falls back to the defaults outside a browser", () => {
  vi.stubGlobal("location", undefined);
  expect(deploymentValue("rangeChunks")).toBe(4);
  expect(pixelFloorOf(resolutionOf(14), true)).toBe(4);
  expect(pixelFloorOf(resolutionOf(15), true)).toBe(8);
  expect(pixelFloorOf(resolutionOf(17), true)).toBe(16);
});
