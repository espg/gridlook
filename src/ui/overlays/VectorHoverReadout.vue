<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed } from "vue";

import { useGlobeControlStore } from "@/store/store.ts";

const store = useGlobeControlStore();
const { hoveredVectorFeature } = storeToRefs(store);

const OFFSET_Y = 14;
const MAX_PROPERTIES = 12;

const tooltipStyle = computed(() => {
  if (!hoveredVectorFeature.value) {
    return {};
  }
  return {
    left: `${hoveredVectorFeature.value.screenX}px`,
    top: `${hoveredVectorFeature.value.screenY + OFFSET_Y}px`,
  };
});

const propertyEntries = computed(() => {
  if (!hoveredVectorFeature.value) {
    return [];
  }
  return Object.entries(hoveredVectorFeature.value.properties).slice(
    0,
    MAX_PROPERTIES
  );
});

const hiddenPropertyCount = computed(() => {
  if (!hoveredVectorFeature.value) {
    return 0;
  }
  return Math.max(
    0,
    Object.keys(hoveredVectorFeature.value.properties).length - MAX_PROPERTIES
  );
});

function formatPropertyValue(value: unknown) {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
</script>

<template>
  <div
    v-if="hoveredVectorFeature"
    class="vector-hover-readout"
    :style="tooltipStyle"
  >
    <div class="vector-hover-title">{{ hoveredVectorFeature.layerName }}</div>
    <div v-if="propertyEntries.length" class="vector-hover-properties">
      <template v-for="[key, value] in propertyEntries" :key="key">
        <span class="vector-hover-label">{{ key }}</span>
        <span class="vector-hover-value">{{ formatPropertyValue(value) }}</span>
      </template>
    </div>
    <div v-else class="vector-hover-empty">no properties</div>
    <div v-if="hiddenPropertyCount > 0" class="vector-hover-empty">
      +{{ hiddenPropertyCount }} more
    </div>
  </div>
  <div v-else />
</template>

<style lang="scss" scoped>
// mirrors the grid HoverReadout presentation, placed below the pointer so
// both readouts can show at once
.vector-hover-readout {
  position: fixed;
  transform: translate(-50%, 0);
  z-index: 1050;
  pointer-events: none;
  background: rgba(17, 24, 39, 0.92);
  color: #f8fafc;
  border: 1px solid rgba(148, 163, 184, 0.35);
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.28);
  padding: 0.55rem 0.85rem;
  border-radius: 10px;
  font-size: 0.85rem;
  white-space: nowrap;
  max-width: 24rem;
  overflow: hidden;
}

.vector-hover-title {
  font-weight: 700;
  font-size: 0.78rem;
  margin-bottom: 0.3rem;
  color: rgba(191, 219, 254, 0.9);
  overflow: hidden;
  text-overflow: ellipsis;
}

.vector-hover-properties {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.6rem;
  row-gap: 0.1rem;
}

.vector-hover-label {
  color: rgba(226, 232, 240, 0.72);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.72rem;
  align-self: center;
}

.vector-hover-value {
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vector-hover-empty {
  color: rgba(226, 232, 240, 0.6);
  font-size: 0.75rem;
}
</style>
