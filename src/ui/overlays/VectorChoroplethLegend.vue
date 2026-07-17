<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed } from "vue";

import {
  featurePropertyValues,
  resolveChoroplethRange,
} from "@/lib/layers/vectorChoropleth.ts";
import type { TColorMap } from "@/lib/shaders/colormapShaders.ts";
import { LAYER_KINDS, useGlobeControlStore } from "@/store/store.ts";
import ChoroplethGradient from "@/ui/overlays/controls/ChoroplethGradient.vue";
import { formatValue } from "@/utils/formatValue.ts";

// One legend card per visible vector layer with an active choropleth,
// stacked bottom-left over the canvas (mirrors the ColorBar's gradient +
// value-label presentation).
const store = useGlobeControlStore();
const { layerStack } = storeToRefs(store);

type TLegendEntry = {
  id: string;
  name: string;
  property: string;
  colormap: TColorMap;
  low: number;
  high: number;
};

const legendEntries = computed<TLegendEntry[]>(() => {
  const entries: TLegendEntry[] = [];
  for (const layer of layerStack.value) {
    if (
      layer.kind !== LAYER_KINDS.VECTOR ||
      !layer.visible ||
      !layer.vectorData
    ) {
      continue;
    }
    const style = layer.vectorStyle;
    if (!style?.colorBy) {
      continue;
    }
    const range = resolveChoroplethRange(
      featurePropertyValues(layer.vectorData, style.colorBy),
      style
    );
    if (!range) {
      continue;
    }
    entries.push({
      id: layer.id,
      name: layer.name,
      property: style.colorBy,
      colormap: style.colormap,
      ...range,
    });
  }
  return entries;
});
</script>

<template>
  <div v-if="legendEntries.length" class="vector-legend">
    <div
      v-for="entry in legendEntries"
      :key="entry.id"
      class="vector-legend-card"
    >
      <div class="vector-legend-title" :title="entry.name">
        {{ entry.name }}
      </div>
      <div class="vector-legend-property">{{ entry.property }}</div>
      <ChoroplethGradient :colormap="entry.colormap" />
      <div class="vector-legend-labels">
        <span>{{ formatValue(entry.low) }}</span>
        <span>{{ formatValue(entry.high) }}</span>
      </div>
    </div>
  </div>
  <div v-else />
</template>

<style lang="scss" scoped>
// mirrors the VectorHoverReadout card language, pinned bottom-left so it
// never collides with the corner links or the control panel
.vector-legend {
  position: absolute;
  left: 12px;
  bottom: 14px;
  z-index: 900;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  pointer-events: none;
}

.vector-legend-card {
  background: rgba(17, 24, 39, 0.92);
  color: #f8fafc;
  border: 1px solid rgba(148, 163, 184, 0.35);
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.28);
  padding: 0.5rem 0.7rem;
  border-radius: 10px;
  width: 12rem;
}

.vector-legend-title {
  font-weight: 700;
  font-size: 0.72rem;
  color: rgba(191, 219, 254, 0.9);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vector-legend-property {
  color: rgba(226, 232, 240, 0.72);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.68rem;
  margin-bottom: 0.3rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vector-legend-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 0.2rem;
  font-size: 0.7rem;
  font-family: ui-monospace, "SF Mono", monospace;
  font-variant-numeric: tabular-nums;
}
</style>
