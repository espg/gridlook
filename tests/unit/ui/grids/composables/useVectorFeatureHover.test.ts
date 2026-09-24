import type { FeatureCollection } from "geojson";
import { beforeEach, expect, it, vi } from "vitest";
import { effectScope, nextTick, shallowRef } from "vue";

import type { THoverGeoPoint } from "@/ui/grids/composables/gridHoverUtils.ts";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useVectorFeatureHover } =
  await import("@/ui/grids/composables/useVectorFeatureHover.ts");

const square: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Amery" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ],
      },
    },
  ],
};

beforeEach(() => {
  setActivePinia(createPinia());
});

it("clears the readout when the hovered layer is hidden or removed", async () => {
  const store = useGlobeControlStore();
  const hoveredGeoPoint = shallowRef<THoverGeoPoint | null>(null);
  store.addVectorLayer("vector-layer", "basins.geojson", square);

  const scope = effectScope();
  try {
    scope.run(() => useVectorFeatureHover(hoveredGeoPoint));
    hoveredGeoPoint.value = { lat: 5, lon: 5, screenX: 100, screenY: 200 };
    await nextTick();
    expect(store.hoveredVectorFeature?.properties).toEqual({ name: "Amery" });

    // the pointer does not move: only the layer's visibility changes
    store.toggleLayerVisibility("vector-layer");
    await nextTick();
    expect(store.hoveredVectorFeature).toBeUndefined();

    store.toggleLayerVisibility("vector-layer");
    await nextTick();
    expect(store.hoveredVectorFeature?.properties).toEqual({ name: "Amery" });

    store.removeLayer("vector-layer");
    await nextTick();
    expect(store.hoveredVectorFeature).toBeUndefined();
  } finally {
    scope.stop();
  }
});
