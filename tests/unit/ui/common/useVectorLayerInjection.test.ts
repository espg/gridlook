import type { FeatureCollection } from "geojson";
import { beforeEach, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

const emptyFeatureCollection: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

vi.mock("@/lib/layers/vectorLayerFormats.ts", () => ({
  loadVectorLayerFromUrl: vi.fn(),
  vectorLayerNameFromUrl: (url: string) => url,
  readVectorLayerFile: vi.fn(),
}));

const { createPinia, setActivePinia } = await import("pinia");
const { loadVectorLayerFromUrl } =
  await import("@/lib/layers/vectorLayerFormats.ts");
const { useVectorLayerInjection } =
  await import("@/ui/common/useVectorLayerInjection.ts");
const { LAYER_KINDS, useGlobeControlStore } = await import("@/store/store.ts");

const mockedLoad = vi.mocked(loadVectorLayerFromUrl);

beforeEach(() => {
  setActivePinia(createPinia());
  mockedLoad.mockReset();
});

function urlLayers(stack: { kind: string; vectorSourceUrl?: string }[]) {
  return stack
    .filter((entry) => entry.kind === LAYER_KINDS.VECTOR)
    .map((entry) => entry.vectorSourceUrl)
    .filter((source): source is string => Boolean(source));
}

it("adds a URL-sourced layer once when two restores overlap the fetch window", async () => {
  // defer the first fetch so a second same-URL add starts before the first
  // entry has landed in the stack
  let resolveFetch!: (data: FeatureCollection) => void;
  const deferred = new Promise<FeatureCollection>((resolve) => {
    resolveFetch = resolve;
  });
  mockedLoad
    .mockReturnValueOnce(deferred)
    .mockResolvedValue(emptyFeatureCollection);

  const store = useGlobeControlStore();
  const { addVectorLayerFromUrl } = useVectorLayerInjection();
  const url = "https://example.com/basins.geojson";

  const first = addVectorLayerFromUrl(url);
  const second = addVectorLayerFromUrl(url);

  resolveFetch(emptyFeatureCollection);
  const [firstAdded, secondAdded] = await Promise.all([first, second]);

  expect(firstAdded).toBe(true);
  expect(secondAdded).toBe(false);
  expect(mockedLoad).toHaveBeenCalledTimes(1);
  expect(urlLayers(store.layerStack)).toEqual([url]);
});

it("reconciles A -> B by removing A's url layer and adding B's", async () => {
  mockedLoad.mockResolvedValue(emptyFeatureCollection);
  const store = useGlobeControlStore();
  const { reconcileVectorLayersFromSpecs } = useVectorLayerInjection();
  const urlA = "https://example.com/a.geojson";
  const urlB = "https://example.com/b.geojson";

  await reconcileVectorLayersFromSpecs([{ url: urlA, visible: true }]);
  expect(urlLayers(store.layerStack)).toEqual([urlA]);

  await reconcileVectorLayersFromSpecs([{ url: urlB, visible: true }]);
  expect(urlLayers(store.layerStack)).toEqual([urlB]);
});

it("re-applies a style-only param change without re-fetching", async () => {
  mockedLoad.mockResolvedValue(emptyFeatureCollection);
  const store = useGlobeControlStore();
  const { reconcileVectorLayersFromSpecs } = useVectorLayerInjection();
  const url = "https://example.com/a.geojson";

  await reconcileVectorLayersFromSpecs([
    { url, visible: true, style: { colormap: "viridis" } },
  ]);
  expect(mockedLoad).toHaveBeenCalledTimes(1);

  await reconcileVectorLayersFromSpecs([
    { url, visible: false, opacity: 0.8, style: { colormap: "turbo" } },
  ]);

  // no second fetch for the already-loaded url; state updated in place
  expect(mockedLoad).toHaveBeenCalledTimes(1);
  const layer = store.layerStack.find(
    (entry) =>
      entry.kind === LAYER_KINDS.VECTOR && entry.vectorSourceUrl === url
  );
  expect(layer?.visible).toBe(false);
  expect(layer?.opacity).toBe(0.8);
  expect(layer?.vectorStyle?.colormap).toBe("turbo");
});

it("leaves file-injected layers untouched during reconciliation", async () => {
  mockedLoad.mockResolvedValue(emptyFeatureCollection);
  const store = useGlobeControlStore();
  const { reconcileVectorLayersFromSpecs } = useVectorLayerInjection();
  const url = "https://example.com/a.geojson";

  store.addVectorLayer("file-layer", "local.geojson", emptyFeatureCollection);
  await reconcileVectorLayersFromSpecs([{ url, visible: true }]);
  // removing url layers (empty spec set) must not drop the file layer
  await reconcileVectorLayersFromSpecs([]);

  const fileLayer = store.layerStack.find((entry) => entry.id === "file-layer");
  expect(fileLayer).toBeDefined();
  expect(fileLayer?.vectorSourceUrl).toBeUndefined();
  expect(urlLayers(store.layerStack)).toEqual([]);
});
