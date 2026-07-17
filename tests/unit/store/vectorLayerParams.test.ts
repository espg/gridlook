import { expect, it } from "vitest";

import { LAND_SEA_MASK_MODES } from "@/lib/layers/landSeaMask.ts";
import {
  LAYER_KINDS,
  VECTOR_LAYER_STYLE_DEFAULTS,
  type TLayerEntry,
} from "@/store/store.ts";
import {
  decodeVectorLayersParam,
  encodeVectorLayersParam,
  vectorLayerSpecsFromStack,
  type TVectorLayerSpec,
} from "@/store/vectorLayerParams.ts";

function vectorEntry(overrides: Partial<TLayerEntry>): TLayerEntry {
  return {
    id: "vector-layer",
    kind: LAYER_KINDS.VECTOR,
    name: "shard_outlines.geojson",
    visible: true,
    opacity: 1,
    maskMode: LAND_SEA_MASK_MODES.OFF,
    vectorStyle: { ...VECTOR_LAYER_STYLE_DEFAULTS },
    ...overrides,
  };
}

it("round-trips URL-sourced layer specs through the parameter", () => {
  const specs: TVectorLayerSpec[] = [
    {
      url: "https://example.com/shard_outlines.geojson?cycle=22&aoi=serc",
      visible: true,
      style: {
        fillColor: "#3388ff",
        fillOpacity: 0.35,
        strokeColor: "#88ccff",
        colorBy: "granuleCount",
        colormap: "turbo",
        rangeLow: 0,
        rangeHigh: 500,
      },
    },
    {
      url: "https://example.com/granule_footprints.geojson",
      visible: false,
      style: { fillColor: "#ff0000", fillOpacity: 0.5, strokeColor: "#ffffff" },
    },
  ];

  const encoded = encodeVectorLayersParam(specs);
  // base64url survives the hash decode/re-serialize cycle: no '&', ':', '='
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeVectorLayersParam(encoded)).toEqual(specs);
});

it("encodes only URL-sourced vector layers from the stack", () => {
  const stack: TLayerEntry[] = [
    vectorEntry({
      id: "from-url",
      vectorSourceUrl: "https://example.com/shard_outlines.geojson",
      visible: false,
      vectorStyle: {
        ...VECTOR_LAYER_STYLE_DEFAULTS,
        colorBy: "granuleCount",
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
  expect(specs[0].url).toBe("https://example.com/shard_outlines.geojson");
  expect(specs[0].visible).toBe(false);
  expect(specs[0].style?.colorBy).toBe("granuleCount");
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
  expect(decodeVectorLayersParam(btoa("nonsense"))).toEqual([]);
  // valid JSON but not an array
  expect(decodeVectorLayersParam(btoa(JSON.stringify({ url: "x" })))).toEqual(
    []
  );

  const encoded = encodeVectorLayersParam([
    { url: "" } as TVectorLayerSpec,
    {
      url: "https://example.com/a.geojson",
      style: {
        colormap: "not-a-colormap",
        rangeLow: "not-a-number",
        fillOpacity: Infinity,
        colorBy: "granuleCount",
        junk: "dropped",
      } as unknown as TVectorLayerSpec["style"],
    },
  ]);
  const specs = decodeVectorLayersParam(encoded);
  // entries without a url are dropped; unknown colormaps, non-finite numbers
  // and unknown keys are stripped
  expect(specs).toHaveLength(1);
  expect(specs[0].url).toBe("https://example.com/a.geojson");
  expect(specs[0].visible).toBe(true);
  expect(specs[0].style).toEqual({ colorBy: "granuleCount" });
});
