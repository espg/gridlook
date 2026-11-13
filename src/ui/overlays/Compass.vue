<script lang="ts" setup>
import { storeToRefs } from "pinia";

import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const store = useGlobeControlStore();
const { bearing, projectionMode } = storeToRefs(store);
</script>

<template>
  <button
    v-if="projectionMode === PROJECTION_TYPES.NEARSIDE_PERSPECTIVE"
    class="compass button is-dark is-rounded"
    type="button"
    title="North. Click to turn it up"
    aria-label="Turn north up"
    @click="store.requestNorthReset"
  >
    <span class="icon" :style="{ transform: `rotate(${-bearing}deg)` }">
      <i class="fas fa-arrow-up" aria-hidden="true"></i>
    </span>
  </button>
  <div v-else />
</template>

<style scoped>
.compass {
  position: absolute;
  right: 18px;
  bottom: 40px;
}
</style>
