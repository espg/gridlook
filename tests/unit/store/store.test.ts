import type { FeatureCollection } from "geojson";
import { beforeEach, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

const { createPinia, setActivePinia } = await import("pinia");
const {
  BUILTIN_LAYER_IDS,
  LAYER_KINDS,
  LAYER_OPACITY,
  useGlobeControlStore,
  VECTOR_LAYER_STYLE_DEFAULTS,
} = await import("@/store/store.ts");

beforeEach(() => {
  setActivePinia(createPinia());
});

it("defaults layer opacity to opaque and clamps updates", () => {
  const store = useGlobeControlStore();
  const maskLayer = store.layerStack.find(
    (layer) => layer.id === BUILTIN_LAYER_IDS.MASK
  );

  expect(maskLayer?.opacity).toBe(LAYER_OPACITY.MAX);

  store.updateLayerOpacity(BUILTIN_LAYER_IDS.MASK, 0.35);
  expect(maskLayer?.opacity).toBe(0.35);

  store.updateLayerOpacity(BUILTIN_LAYER_IDS.MASK, -0.25);
  expect(maskLayer?.opacity).toBe(LAYER_OPACITY.MIN);

  store.updateLayerOpacity(BUILTIN_LAYER_IDS.MASK, 1.25);
  expect(maskLayer?.opacity).toBe(LAYER_OPACITY.MAX);

  store.addTextureLayer("texture-layer", "Texture layer");
  const textureLayer = store.layerStack.find(
    (layer) => layer.id === "texture-layer"
  );
  expect(textureLayer?.opacity).toBe(LAYER_OPACITY.MAX);

  store.updateLayerOpacity("texture-layer", 0.5);
  expect(textureLayer?.opacity).toBe(0.5);
});

it("adds, toggles and removes vector layers", () => {
  const store = useGlobeControlStore();
  const data: FeatureCollection = { type: "FeatureCollection", features: [] };

  store.addVectorLayer("vector-layer", "Shard outlines", data);
  const entry = store.layerStack.find((layer) => layer.id === "vector-layer");
  expect(store.layerStack[0]).toBe(entry);
  expect(entry?.kind).toBe(LAYER_KINDS.VECTOR);
  expect(entry?.name).toBe("Shard outlines");
  expect(entry?.visible).toBe(true);
  expect(entry?.vectorData).toBe(data);

  store.updateVectorLayer("vector-layer", { visible: false });
  expect(entry?.visible).toBe(false);

  store.removeVectorLayer("vector-layer");
  expect(store.layerStack.some((layer) => layer.id === "vector-layer")).toBe(
    false
  );
});

it("styles vector layers with defaults and clamped updates", () => {
  const store = useGlobeControlStore();
  const data: FeatureCollection = { type: "FeatureCollection", features: [] };

  store.addVectorLayer("vector-layer", "Shard outlines", data);
  const entry = store.layerStack.find((layer) => layer.id === "vector-layer");
  expect(entry?.vectorStyle).toEqual(VECTOR_LAYER_STYLE_DEFAULTS);
  // defaults are copied per layer, not shared
  expect(entry?.vectorStyle).not.toBe(VECTOR_LAYER_STYLE_DEFAULTS);

  store.updateVectorLayerStyle("vector-layer", { fillColor: "#ff0000" });
  expect(entry?.vectorStyle?.fillColor).toBe("#ff0000");
  expect(entry?.vectorStyle?.strokeColor).toBe(
    VECTOR_LAYER_STYLE_DEFAULTS.strokeColor
  );

  store.updateVectorLayerStyle("vector-layer", { fillOpacity: 1.4 });
  expect(entry?.vectorStyle?.fillOpacity).toBe(LAYER_OPACITY.MAX);
  store.updateVectorLayerStyle("vector-layer", { fillOpacity: -0.2 });
  expect(entry?.vectorStyle?.fillOpacity).toBe(LAYER_OPACITY.MIN);

  // non-vector layers are not styled
  store.updateVectorLayerStyle(BUILTIN_LAYER_IDS.GRID, {
    fillColor: "#000000",
  });
  const grid = store.layerStack.find(
    (layer) => layer.id === BUILTIN_LAYER_IDS.GRID
  );
  expect(grid?.vectorStyle).toBeUndefined();
});

it("records the source URL for URL-injected vector layers only", () => {
  const store = useGlobeControlStore();
  const data: FeatureCollection = { type: "FeatureCollection", features: [] };

  store.addVectorLayer("from-file", "local.geojson", data);
  store.addVectorLayer(
    "from-url",
    "shard_outlines.geojson",
    data,
    true,
    "https://example.com/shard_outlines.geojson"
  );

  const fromFile = store.layerStack.find((layer) => layer.id === "from-file");
  const fromUrl = store.layerStack.find((layer) => layer.id === "from-url");
  expect(fromFile?.vectorSourceUrl).toBeUndefined();
  expect(fromUrl?.vectorSourceUrl).toBe(
    "https://example.com/shard_outlines.geojson"
  );
});

it("caches numeric properties and tracks choropleth style state", () => {
  const store = useGlobeControlStore();
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { shard: "4331422", granuleCount: 12 },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
      {
        type: "Feature",
        properties: { granuleCount: 7, area: 1.5 },
        geometry: { type: "Point", coordinates: [1, 0] },
      },
    ],
  };

  store.addVectorLayer("vector-layer", "Shard outlines", data);
  const entry = store.layerStack.find((layer) => layer.id === "vector-layer");
  // scanned once at ingest; string properties don't qualify
  expect(entry?.vectorNumericProperties).toEqual(["area", "granuleCount"]);
  expect(entry?.vectorStyle?.colorBy).toBeUndefined();
  expect(entry?.vectorStyle?.colormap).toBe(
    VECTOR_LAYER_STYLE_DEFAULTS.colormap
  );

  store.updateVectorLayerStyle("vector-layer", {
    colorBy: "granuleCount",
    colormap: "turbo",
    rangeLow: 0,
    rangeHigh: 20,
  });
  expect(entry?.vectorStyle?.colorBy).toBe("granuleCount");
  expect(entry?.vectorStyle?.colormap).toBe("turbo");
  expect(entry?.vectorStyle?.rangeLow).toBe(0);
  expect(entry?.vectorStyle?.rangeHigh).toBe(20);

  // undefined clears back to auto range / constant styling
  store.updateVectorLayerStyle("vector-layer", {
    colorBy: undefined,
    rangeLow: undefined,
    rangeHigh: undefined,
  });
  expect(entry?.vectorStyle?.colorBy).toBeUndefined();
  expect(entry?.vectorStyle?.rangeLow).toBeUndefined();
  expect(entry?.vectorStyle?.rangeHigh).toBeUndefined();
});

it("tracks the hovered vector feature", () => {
  const store = useGlobeControlStore();

  store.setHoveredVectorFeature({
    layerId: "vector-layer",
    layerName: "Shard outlines",
    properties: { shard: "s001" },
    screenX: 10,
    screenY: 20,
  });
  expect(store.hoveredVectorFeature?.properties).toEqual({ shard: "s001" });

  store.clearHoveredVectorFeature();
  expect(store.hoveredVectorFeature).toBeUndefined();
});
