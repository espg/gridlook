import { describe, expect, it } from "vitest";

import {
  digestVariableMetadata,
  digestVariableOf,
  digestVariablesOf,
} from "@/lib/digest/digestVariables.ts";

const ragged = (dtype: string, shape: number[]) => ({
  ragged: { spec: "zagg-ragged/1", element: { dtype, shape } },
});
const DIGEST = ragged("float32", [-1, 2]);

describe("digestVariablesOf", () => {
  it("derives a percentile and a range from a t-digest, per stratum", () => {
    const variables = digestVariablesOf("h_tdigest_signal", DIGEST);
    expect(Object.keys(variables)).toEqual([
      "h_percentile_signal",
      "h_range_signal",
    ]);
    expect(variables.h_percentile_signal.attributes).toEqual({
      long_name: "height percentile (signal)", // eslint-disable-line camelcase
      units: "m (WGS84 ellipsoid)",
      digest: {
        array: "h_tdigest_signal",
        product: "percentile",
        stratum: "signal",
      },
    });
    // a difference of heights has no datum
    expect(variables.h_range_signal.attributes).toMatchObject({
      long_name: "height percentile range (signal)", // eslint-disable-line camelcase
      units: "m",
    });
  });

  it("names an unknown quantity as stored, without units or stratum", () => {
    const variables = digestVariablesOf("slope_tdigest", DIGEST);
    expect(Object.keys(variables)).toEqual(["slope_percentile", "slope_range"]);
    expect(variables.slope_percentile.attributes).toEqual({
      long_name: "slope percentile", // eslint-disable-line camelcase
      digest: { array: "slope_tdigest", product: "percentile" },
    });
  });

  it("derives nothing from a digest's located and timed siblings", () => {
    expect(
      digestVariablesOf("h_tdigest_signal_locations", ragged("uint64", [-1]))
    ).toEqual({});
    expect(digestVariablesOf("count", {})).toEqual({});
    expect(digestVariablesOf("h_tdigest_signal", undefined)).toEqual({});
    expect(digestVariablesOf("heights", DIGEST)).toEqual({});
  });
});

describe("digestVariableOf", () => {
  it("reads a derived variable's digest from its attributes", () => {
    const { attributes } = digestVariablesOf(
      "h_tdigest_noise",
      DIGEST
    ).h_range_noise;
    expect(digestVariableOf(attributes)).toEqual({
      array: "h_tdigest_noise",
      product: "range",
      stratum: "noise",
    });
  });

  it("is undefined for a stored variable", () => {
    expect(digestVariableOf(undefined)).toBeUndefined();
    expect(digestVariableOf({ units: "m" })).toBeUndefined();
    expect(
      digestVariableOf({ digest: { array: "x", product: "mean" } })
    ).toBeUndefined();
  });
});

describe("digestVariableMetadata", () => {
  it("keeps the digest's grid as float32 with NaN for no data", () => {
    const metadata = digestVariableMetadata(
      {
        shape: [1, 48],
        data_type: "variable_length_bytes", // eslint-disable-line camelcase
        fill_value: "", // eslint-disable-line camelcase
        codecs: [{ name: "vlen-bytes" }, { name: "zstd" }],
        dimension_names: ["window", "cells"], // eslint-disable-line camelcase
      },
      { units: "m" }
    );
    expect(metadata).toEqual({
      shape: [1, 48],
      data_type: "float32", // eslint-disable-line camelcase
      fill_value: "NaN", // eslint-disable-line camelcase
      codecs: [{ name: "bytes", configuration: { endian: "little" } }],
      dimension_names: ["window", "cells"], // eslint-disable-line camelcase
      attributes: { units: "m" },
    });
  });
});
