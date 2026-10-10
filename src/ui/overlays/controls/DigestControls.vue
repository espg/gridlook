<script lang="ts" setup>
import { computed } from "vue";

import {
  DIGEST_PRODUCTS,
  type TDigestVariable,
} from "@/lib/digest/digestVariables.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import RangeSlider from "@/ui/common/RangeSlider.vue";

const props = defineProps<{
  /** The digest the selected variable is derived from. */
  digest: TDigestVariable;
}>();

const store = useGlobeControlStore();

const isRange = computed(() => props.digest.product === DIGEST_PRODUCTS.RANGE);

const number = (event: Event) =>
  Number((event.target as HTMLInputElement).value);

function setLow(low: number) {
  store.setDigestPercentileBounds(
    Math.min(low, store.digestPercentileHigh),
    store.digestPercentileHigh
  );
}

function setHigh(high: number) {
  store.setDigestPercentileBounds(
    store.digestPercentileLow,
    Math.max(high, store.digestPercentileLow)
  );
}
</script>

<template>
  <div class="column digest-controls">
    <template v-if="isRange">
      <div class="is-size-7 has-text-grey">
        Percentile range: p{{ store.digestPercentileHigh }} − p{{
          store.digestPercentileLow
        }}
      </div>
      <div class="digest-row">
        <input
          class="input is-small digest-number"
          type="number"
          min="0"
          max="100"
          step="1"
          aria-label="Lower percentile"
          :value="store.digestPercentileLow"
          @change="setLow(number($event))"
        />
        <RangeSlider
          class="digest-slider"
          :low="store.digestPercentileLow"
          :high="store.digestPercentileHigh"
          :min="0"
          :max="100"
          @update:low="setLow(Math.round($event))"
          @update:high="setHigh(Math.round($event))"
        />
        <input
          class="input is-small digest-number"
          type="number"
          min="0"
          max="100"
          step="1"
          aria-label="Upper percentile"
          :value="store.digestPercentileHigh"
          @change="setHigh(number($event))"
        />
      </div>
    </template>
    <template v-else>
      <label class="is-size-7 has-text-grey" for="digest_percentile">
        Percentile
      </label>
      <div class="digest-row">
        <input
          id="digest_percentile"
          class="slider digest-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="store.digestPercentile"
          @input="store.setDigestPercentile(number($event))"
        />
        <input
          class="input is-small digest-number"
          type="number"
          min="0"
          max="100"
          step="any"
          aria-label="Percentile"
          :value="store.digestPercentile"
          @change="store.setDigestPercentile(number($event))"
        />
      </div>
    </template>
    <div class="is-size-7 has-text-grey">
      Computed in the browser from each cell's t-digest. Click a cell to see its
      distribution.
    </div>
  </div>
</template>

<style lang="scss" scoped>
.digest-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.25rem 0;
}

.digest-slider {
  flex: 1 1 auto;
  min-width: 0;
}

.digest-number {
  flex: 0 0 4.5rem;
  width: 4.5rem;
}
</style>
