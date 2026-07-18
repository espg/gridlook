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

it("adds a URL-sourced layer once when two restores overlap the fetch window", async () => {
  // Defer the first fetch so a second same-URL add starts before the first
  // entry has landed in the stack — the exact double-add race the guard closes.
  let resolveFetch!: (data: FeatureCollection) => void;
  const deferred = new Promise<FeatureCollection>((resolve) => {
    resolveFetch = resolve;
  });
  mockedLoad
    .mockReturnValueOnce(deferred)
    .mockResolvedValue(emptyFeatureCollection);

  const store = useGlobeControlStore();
  const { addVectorLayerFromUrl } = useVectorLayerInjection();
  const url = "https://example.com/shard_outlines.geojson";

  const first = addVectorLayerFromUrl(url);
  const second = addVectorLayerFromUrl(url);

  resolveFetch(emptyFeatureCollection);
  const [firstAdded, secondAdded] = await Promise.all([first, second]);

  expect(firstAdded).toBe(true);
  expect(secondAdded).toBe(false);
  expect(mockedLoad).toHaveBeenCalledTimes(1);
  const restored = store.layerStack.filter(
    (entry) =>
      entry.kind === LAYER_KINDS.VECTOR && entry.vectorSourceUrl === url
  );
  expect(restored).toHaveLength(1);
});
