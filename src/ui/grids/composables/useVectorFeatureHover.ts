import { onBeforeUnmount, watch, type ShallowRef } from "vue";

import type { THoverGeoPoint } from "./gridHoverUtils.ts";

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

  const stopWatch = watch(
    [hoveredGeoPoint, () => store.layerStack] as const,
    ([point]) => {
      if (!point) {
        store.clearHoveredVectorFeature();
        return;
      }
      // the stack is ordered top -> bottom, so the first hit wins
      for (const entry of store.layerStack) {
        if (
          entry.kind !== LAYER_KINDS.VECTOR ||
          !entry.visible ||
          !entry.vectorData
        ) {
          continue;
        }
        const feature = findVectorFeatureAtPoint(
          entry.vectorData,
          point.lat,
          point.lon
        );
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
