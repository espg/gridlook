<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed } from "vue";

import { useGlobeControlStore } from "@/store/store.ts";

/**
 * The horizontal distance scale, in the upper-left corner at every level
 * (on by default, the toggle hides it): the ground scale under the cursor,
 * at the view's centre without one, and always on the point tier, at the
 * pivot (useGridScene.ts).
 */
const { distanceScale, showDistanceScale, pointTier } = storeToRefs(
  useGlobeControlStore()
);
const label = computed(() => {
  const meters = distanceScale.value?.distanceMeters ?? 0;
  const value = meters >= 1000 ? meters / 1000 : meters;
  return `${Number(value.toPrecision(3))} ${meters >= 1000 ? "km" : "m"}`;
});
</script>

<template>
  <div
    v-if="(showDistanceScale || pointTier) && distanceScale"
    class="distance-scale has-text-white is-size-6"
    :class="{ 'is-pivot': pointTier }"
    role="img"
    :aria-label="`Local horizontal distance scale at ${pointTier ? 'the pivot' : 'cursor'}: ${label}`"
  >
    <div>{{ label }}</div>
    <div
      class="distance-scale-bar"
      :style="{ width: `${distanceScale.widthPx}px` }"
    />
  </div>
  <div v-else />
</template>

<style scoped>
.distance-scale {
  position: absolute;
  left: 18px;
  top: 18px;
  pointer-events: none;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  background: rgba(17, 24, 39, 0.85);
  font-variant-numeric: tabular-nums;
}

.distance-scale-bar {
  height: 8px;
  border: solid currentColor;
  border-width: 0 1px 2px;
  margin-top: 4px;
}
</style>
