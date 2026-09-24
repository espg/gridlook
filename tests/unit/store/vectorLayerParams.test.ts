import { expect, it } from "vitest";

import { LAND_SEA_MASK_MODES } from "@/lib/layers/landSeaMask.ts";
import {
  LAYER_KINDS,
  VECTOR_LAYER_OPACITY,
  VECTOR_LAYER_STYLE_DEFAULTS,
  type TLayerEntry,
} from "@/store/store.ts";
import {
  decodeVectorLayersParam,
  encodeVectorLayersParam,
  vectorLayerSpecsFromStack,
  type TVectorLayerSpec,
} from "@/store/vectorLayerParams.ts";
import { base64UrlEncode } from "@/utils/base64Url.ts";

function vectorEntry(overrides: Partial<TLayerEntry>): TLayerEntry {
  return {
    id: "vector-layer",
    kind: LAYER_KINDS.VECTOR,
    name: "basins.geojson",
    visible: true,
    opacity: 0.35,
    maskMode: LAND_SEA_MASK_MODES.OFF,
    vectorStyle: { ...VECTOR_LAYER_STYLE_DEFAULTS },
    ...overrides,
  };
}

it("round-trips URL-sourced layer specs through the parameter", () => {
  const specs: TVectorLayerSpec[] = [
    {
      url: "https://example.com/basins.geojson?region=south&v=2",
      visible: true,
      opacity: 0.35,
      style: {
        fillColor: "#3388ff",
        strokeColor: "#88ccff",
        colorBy: "count",
        colormap: "turbo",
        rangeLow: 0,
        rangeHigh: 500,
      },
    },
    {
      url: "https://example.com/footprints.geojson",
      visible: false,
      opacity: 0.5,
      style: { fillColor: "#ff0000", strokeColor: "#ffffff" },
    },
  ];

  const encoded = encodeVectorLayersParam(specs);
  // base64url survives the hash decode/re-serialize cycle: no '&', ':', '='
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeVectorLayersParam(encoded)).toEqual(specs);
  // re-encoding decoded specs is byte-stable
  expect(encodeVectorLayersParam(decodeVectorLayersParam(encoded))).toBe(
    encoded
  );
});

it("encodes only URL-sourced vector layers from the stack", () => {
  const stack: TLayerEntry[] = [
    vectorEntry({
      id: "from-url",
      vectorSourceUrl: "https://example.com/basins.geojson",
      visible: false,
      vectorStyle: {
        ...VECTOR_LAYER_STYLE_DEFAULTS,
        colorBy: "count",
        rangeHigh: 100,
      },
    }),
    // file-injected: no source URL to deep-link, stays session-only
    vectorEntry({ id: "from-file" }),
    // non-vector layers never encode
    {
      id: "grid",
      kind: LAYER_KINDS.GRID,
      name: "Data grid",
      visible: true,
      opacity: 1,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
  ];

  const specs = vectorLayerSpecsFromStack(stack);
  expect(specs).toHaveLength(1);
  expect(specs[0].url).toBe("https://example.com/basins.geojson");
  expect(specs[0].visible).toBe(false);
  expect(specs[0].opacity).toBe(0.35);
  expect(specs[0].style?.colorBy).toBe("count");
  expect(specs[0].style?.rangeHigh).toBe(100);
  expect(specs[0].style?.rangeLow).toBeUndefined();

  // an empty encoding deletes the URL parameter
  expect(encodeVectorLayersParam([])).toBe("");
  expect(vectorLayerSpecsFromStack([vectorEntry({ id: "from-file" })])).toEqual(
    []
  );
});

it("tolerates malformed parameters and sanitizes styles", () => {
  expect(decodeVectorLayersParam("")).toEqual([]);
  expect(decodeVectorLayersParam("not*base64!")).toEqual([]);
  // valid base64 of invalid JSON
  expect(decodeVectorLayersParam(base64UrlEncode("nonsense"))).toEqual([]);
  // valid JSON but not an array
  expect(
    decodeVectorLayersParam(base64UrlEncode(JSON.stringify({ url: "x" })))
  ).toEqual([]);

  const encoded = base64UrlEncode(
    JSON.stringify([
      { url: "" },
      {
        url: "https://example.com/a.geojson",
        opacity: "1",
        style: {
          colormap: "not-a-colormap",
          rangeLow: "not-a-number",
          colorBy: "count",
          junk: "dropped",
        },
      },
    ])
  );
  const specs = decodeVectorLayersParam(encoded);
  // entries without a url are dropped; unknown colormaps, non-finite numbers
  // and unknown keys are stripped
  expect(specs).toHaveLength(1);
  expect(specs[0].url).toBe("https://example.com/a.geojson");
  expect(specs[0].visible).toBe(true);
  // an unusable opacity normalizes to the default the layer restores at
  expect(specs[0].opacity).toBe(VECTOR_LAYER_OPACITY);
  expect(specs[0].style).toEqual({ colorBy: "count" });
});

it("re-encodes a link that omits optional keys to itself", () => {
  const encoded = base64UrlEncode(
    JSON.stringify([{ url: "https://example.com/a.geojson" }])
  );

  // decode -> encode is byte-stable from the first pass, so restoring an older
  // or hand-written link does not rewrite the hash
  const once = encodeVectorLayersParam(decodeVectorLayersParam(encoded));
  expect(encodeVectorLayersParam(decodeVectorLayersParam(once))).toBe(once);
  expect(decodeVectorLayersParam(once)[0].opacity).toBe(VECTOR_LAYER_OPACITY);
});
