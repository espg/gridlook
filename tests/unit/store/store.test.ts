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
