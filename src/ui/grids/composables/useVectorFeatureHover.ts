import { onBeforeUnmount, watch, type ShallowRef } from "vue";

import type { THoverGeoPoint } from "./gridHoverUtils.ts";

import { getVectorLayerData } from "@/lib/layers/vectorDataStore.ts";
import { findVectorFeatureAtPoint } from "@/lib/layers/vectorPicking.ts";
import { LAYER_KINDS, useGlobeControlStore } from "@/store/store.ts";

/**
 * Map the hovered geo point (produced by the scene raycaster) to the topmost
 * visible vector-layer feature under the pointer via a data-space
 * point-in-polygon test, and publish it for the feature-properties readout.
 */
export function useVectorFeatureHover(
  hoveredGeoPoint: Readonly<ShallowRef<THoverGeoPoint | null>>
) {
  const store = useGlobeControlStore();

  // the second source is a cheap signature rather than a deep watch: hiding or
  // removing a layer has to re-run the lookup even while the pointer sits
  // still, but the coordinate arrays behind it never change
  const stopWatch = watch(
    [
      hoveredGeoPoint,
      () => store.layerStack.map((e) => `${e.id}:${e.visible}`).join("|"),
    ] as const,
    ([point]) => {
      if (!point) {
        store.clearHoveredVectorFeature();
        return;
      }
      // the stack is ordered top -> bottom, so the first hit wins
      for (const entry of store.layerStack) {
        const data =
          entry.kind === LAYER_KINDS.VECTOR && entry.visible
            ? getVectorLayerData(entry.id)
            : undefined;
        if (!data) {
          continue;
        }
        const feature = findVectorFeatureAtPoint(data, point.lat, point.lon);
        if (feature) {
          store.setHoveredVectorFeature({
            layerId: entry.id,
            layerName: entry.name,
            properties: (feature.properties ?? {}) as Record<string, unknown>,
            screenX: point.screenX,
            screenY: point.screenY,
          });
          return;
        }
      }
      store.clearHoveredVectorFeature();
    }
  );

  onBeforeUnmount(() => {
    stopWatch();
    store.clearHoveredVectorFeature();
  });
}
