import type { FeatureCollection } from "geojson";
import { beforeEach, expect, it, vi } from "vitest";
import { isReactive } from "vue";

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

const { createPinia, setActivePinia } = await import("pinia");
const {
  BUILTIN_LAYER_IDS,
  BUILTIN_LAYER_NAMES,
  LAYER_KINDS,
  LAYER_OPACITY,
  useGlobeControlStore,
  VECTOR_LAYER_OPACITY,
  VECTOR_LAYER_STYLE_DEFAULTS,
} = await import("@/store/store.ts");
const { getVectorLayerData } = await import("@/lib/layers/vectorDataStore.ts");

beforeEach(() => {
  setActivePinia(createPinia());
});

it("starts with only coastlines and the active data grid", () => {
  const store = useGlobeControlStore();

  expect(store.layerStack.map((layer) => layer.id)).toEqual([
    BUILTIN_LAYER_IDS.COASTLINES,
    BUILTIN_LAYER_IDS.GRID,
  ]);
});

it("defaults layer opacity to opaque and clamps updates", () => {
  const store = useGlobeControlStore();
  store.restoreBuiltinLayer(LAYER_KINDS.MASK);
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

it("enables streamlines without selecting the derived magnitude", () => {
  const store = useGlobeControlStore();

  expect(store.isStreamlineLayerEnabled()).toBe(false);
  expect(store.streamlineMagnitudeDisplayed).toBe(false);
  store.setStreamlineLayerEnabled(true);
  expect(store.isStreamlineLayerEnabled()).toBe(true);
  store.setStreamlineMagnitudeInfo(
    { longName: "Vector magnitude", units: "m s-1" },
    true
  );
  expect(store.streamlineMagnitudeRequested).toBe(false);
  expect(store.streamlineMagnitudeDisplayed).toBe(false);

  store.setStreamlineMagnitudeDisplayed(true);
  store.setStreamlineLayerEnabled(false);
  expect(store.isStreamlineLayerEnabled()).toBe(false);
  expect(store.streamlineMagnitudeRequested).toBe(false);
  expect(store.streamlineMagnitudeDisplayed).toBe(false);

  store.setStreamlineLayerEnabled(true);
  expect(store.streamlineMagnitudeDisplayed).toBe(false);
});

it("switches between the derived vector magnitude and selected scalar", () => {
  const store = useGlobeControlStore();
  store.setStreamlineLayerEnabled(true);
  store.varnameSelector = "temperature";

  store.setStreamlineMagnitudeDisplayed(true, true);
  expect(store.streamlineMagnitudeDisplayed).toBe(true);
  expect(store.streamlineScalarRevision).toBe(1);

  store.setStreamlineMagnitudeDisplayed(false, true);
  expect(store.streamlineMagnitudeRequested).toBe(false);
  expect(store.streamlineMagnitudeDisplayed).toBe(false);
  expect(store.streamlineScalarRevision).toBe(2);
  expect(store.varnameSelector).toBe("temperature");
  expect(store.isStreamlineLayerEnabled()).toBe(true);
});

it("restores a requested magnitude after a transient incompatible pair", () => {
  const store = useGlobeControlStore();
  store.setStreamlineLayerEnabled(true);
  store.setStreamlineMagnitudeDisplayed(true);
  store.varnameSelector = "temperature";
  store.varnameDisplay = "vector_magnitude";

  store.setStreamlineMagnitudeInfo(undefined);
  expect(store.streamlineMagnitudeRequested).toBe(true);
  expect(store.streamlineMagnitudeDisplayed).toBe(false);
  expect(store.streamlineScalarRevision).toBe(1);

  store.setStreamlineMagnitudeInfo(
    { longName: "Vector magnitude", units: "m s-1" },
    true
  );
  expect(store.streamlineMagnitudeDisplayed).toBe(true);
});

it("selects a streamline level and resets it with the vector components", () => {
  const store = useGlobeControlStore();
  store.setStreamlineLevelInfo({
    dimensionName: "level",
    values: [1000, 850, 700],
    units: "hPa",
  });

  store.setStreamlineLevelIndex(2);
  expect(store.streamlineLevelIndex).toBe(2);
  expect(store.streamlineSelectionRevision).toBe(1);

  store.setStreamlineLevelIndex(1, false);
  expect(store.streamlineLevelIndex).toBe(1);
  expect(store.streamlineSelectionRevision).toBe(1);

  store.setStreamlineSelection({ automatic: false, u: "ua", v: "va" });
  expect(store.streamlineLevelIndex).toBe(0);
  expect(store.streamlineLevelInfo).toBeUndefined();
});

it("stores active data layer visibility and opacity", () => {
  const store = useGlobeControlStore();
  const gridLayer = store.layerStack.find(
    (layer) => layer.id === BUILTIN_LAYER_IDS.GRID
  );

  expect(gridLayer?.visible).toBe(true);
  store.toggleLayerVisibility(BUILTIN_LAYER_IDS.GRID);
  store.updateLayerOpacity(BUILTIN_LAYER_IDS.GRID, 0.4);

  expect(gridLayer?.visible).toBe(false);
  expect(gridLayer?.opacity).toBe(0.4);
});

it("removes and restores built-in layers", () => {
  const store = useGlobeControlStore();

  expect(
    store.layerStack.some((layer) => layer.id === BUILTIN_LAYER_IDS.MASK)
  ).toBe(false);

  store.restoreBuiltinLayer(LAYER_KINDS.MASK);
  expect(store.layerStack[0]?.id).toBe(BUILTIN_LAYER_IDS.MASK);
  expect(store.layerStack[0]?.name).toBe(BUILTIN_LAYER_NAMES[LAYER_KINDS.MASK]);
  expect(store.layerStack[0]?.visible).toBe(true);
  expect(store.layerStack[0]?.opacity).toBe(LAYER_OPACITY.MAX);

  store.restoreBuiltinLayer(LAYER_KINDS.MASK);
  expect(
    store.layerStack.filter((layer) => layer.id === BUILTIN_LAYER_IDS.MASK)
  ).toHaveLength(1);
});

it("sets volume layer visibility and selection", () => {
  const store = useGlobeControlStore();

  expect(store.isVolumeLayerEnabled()).toBe(false);
  store.setVolumeSelections([
    { variable: "clw", color: "#ffffff", opacity: 0.8 },
  ]);
  store.setVolumeLayerEnabled(true);
  expect(store.isVolumeLayerEnabled()).toBe(true);
  expect(store.volumeSelections).toEqual([
    { variable: "clw", color: "#ffffff", opacity: 0.8 },
  ]);
  store.setVolumeLayerEnabled(false);
  expect(store.isVolumeLayerEnabled()).toBe(false);
});

it("adds, toggles and removes vector layers", () => {
  const store = useGlobeControlStore();
  const data: FeatureCollection = { type: "FeatureCollection", features: [] };

  store.addVectorLayer("vector-layer", "basins.geojson", data);
  const entry = store.layerStack.find((layer) => layer.id === "vector-layer");
  expect(store.layerStack[0]).toBe(entry);
  expect(entry?.kind).toBe(LAYER_KINDS.VECTOR);
  expect(entry?.name).toBe("basins.geojson");
  expect(entry?.visible).toBe(true);
  expect(entry?.opacity).toBe(VECTOR_LAYER_OPACITY);
  // the FeatureCollection lives outside the stack, keyed by layer id
  expect(getVectorLayerData("vector-layer")).toBe(data);

  store.toggleLayerVisibility("vector-layer");
  expect(entry?.visible).toBe(false);

  // vector layers are never restored as built-ins
  store.restoreBuiltinLayer(LAYER_KINDS.VECTOR);
  expect(
    store.layerStack.filter((layer) => layer.kind === LAYER_KINDS.VECTOR)
  ).toHaveLength(1);

  store.removeLayer("vector-layer");
  expect(store.layerStack.some((layer) => layer.id === "vector-layer")).toBe(
    false
  );
  expect(getVectorLayerData("vector-layer")).toBeUndefined();
});

it("keeps vector data raw and identical across a kept-layerStack reset", () => {
  const store = useGlobeControlStore();
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { count: 3 },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
    ],
  };

  store.addVectorLayer("vector-layer", "basins.geojson", data);
  // the source-change path of GlobeView: the stack survives, and the
  // FeatureCollection must survive with it, unmodified and non-reactive
  store.resetExcept(["layerStack"]);

  expect(store.layerStack.some((layer) => layer.id === "vector-layer")).toBe(
    true
  );
  expect(getVectorLayerData("vector-layer")).toBe(data);
  expect(isReactive(getVectorLayerData("vector-layer"))).toBe(false);
});

it("styles vector layers with per-layer defaults", () => {
  const store = useGlobeControlStore();
  const data: FeatureCollection = { type: "FeatureCollection", features: [] };

  store.addVectorLayer("vector-layer", "basins.geojson", data);
  const entry = store.layerStack.find((layer) => layer.id === "vector-layer");
  expect(entry?.vectorStyle).toEqual(VECTOR_LAYER_STYLE_DEFAULTS);
  // defaults are copied per layer, not shared
  expect(entry?.vectorStyle).not.toBe(VECTOR_LAYER_STYLE_DEFAULTS);

  store.updateVectorLayerStyle("vector-layer", { fillColor: "#ff0000" });
  expect(entry?.vectorStyle?.fillColor).toBe("#ff0000");
  expect(entry?.vectorStyle?.strokeColor).toBe(
    VECTOR_LAYER_STYLE_DEFAULTS.strokeColor
  );

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
    layerName: "basins.geojson",
    properties: { name: "Amery" },
    screenX: 10,
    screenY: 20,
  });
  expect(store.hoveredVectorFeature?.properties).toEqual({ name: "Amery" });

  store.clearHoveredVectorFeature();
  expect(store.hoveredVectorFeature).toBeUndefined();
});
