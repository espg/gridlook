<script lang="ts" setup>
import { computed } from "vue";

import {
  DIGEST_PRODUCTS,
  type TDigestVariable,
} from "@/lib/digest/digestVariables.ts";
import { DIGEST_STRATA, type TStratumChoice } from "@/lib/digest/strata.ts";
import { GAP_FILL_SIZES, gaussianSigma } from "@/lib/grids/gapFill.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import RangeSlider from "@/ui/common/RangeSlider.vue";

const props = withDefaults(
  defineProps<{
    /** The digest the selected variable is derived from. */
    digest: TDigestVariable;
    /** The strata the store's digests hold (`signal`, `noise`). */
    strata?: string[];
    /**
     * Whether the level on screen is derived from the leaves. Only such a
     * level is smoothed, so the gap controls are shown there alone; the
     * setting itself is kept across levels.
     */
    derivedLevel: boolean;
  }>(),
  { strata: () => [] }
);

const store = useGlobeControlStore();

const isRange = computed(() => props.digest.product === DIGEST_PRODUCTS.RANGE);

// the stratum choice, offered once the store holds more than one stratum;
// `both` needs the signal and the noise
const STRATA: { choice: TStratumChoice; label: string; title: string }[] = [
  {
    choice: DIGEST_STRATA.SIGNAL,
    label: "signal",
    title: "The photons classified as signal",
  },
  {
    choice: DIGEST_STRATA.NOISE,
    label: "noise",
    title: "The photons classified as noise",
  },
  {
    choice: DIGEST_STRATA.BOTH,
    label: "both",
    title:
      "Every photon: the signal and noise digests of each cell merged, and both clouds in the point view",
  },
];
const offered = (choice: TStratumChoice) =>
  choice === DIGEST_STRATA.BOTH
    ? props.strata.includes(DIGEST_STRATA.SIGNAL) &&
      props.strata.includes(DIGEST_STRATA.NOISE)
    : props.strata.includes(choice);

const number = (event: Event) =>
  Number((event.target as HTMLInputElement).value);

const checked = (event: Event) => (event.target as HTMLInputElement).checked;

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
    <div v-if="strata.length > 1" class="digest-row">
      <span class="is-size-7 has-text-grey">Photons</span>
      <div class="buttons has-addons are-small mb-0">
        <button
          v-for="{ choice, label, title } in STRATA"
          :key="choice"
          type="button"
          class="button"
          :class="{ 'is-selected is-link': store.digestStratum === choice }"
          :disabled="!offered(choice)"
          :title="title"
          @click="store.setDigestStratum(choice)"
        >
          {{ label }}
        </button>
      </div>
    </div>
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
    <div v-if="derivedLevel" class="digest-row">
      <label
        class="checkbox is-size-7"
        title="Fill cells without photons from the cells around them (a Gaussian-weighted mean of the values under the kernel). Cells with photons keep their value."
      >
        <input
          :checked="store.gapFill"
          type="checkbox"
          @change="store.setGapFill(checked($event))"
        />
        Smooth gaps
      </label>
      <div class="select is-small">
        <select
          aria-label="Smoothing kernel size"
          :value="store.gapFillSize"
          :disabled="!store.gapFill"
          @change="store.setGapFillSize(number($event))"
        >
          <option v-for="size in GAP_FILL_SIZES" :key="size" :value="size">
            {{ size }}×{{ size }}
          </option>
        </select>
      </div>
      <span class="is-size-7 has-text-grey">
        σ = {{ gaussianSigma(store.gapFillSize).toFixed(2) }} cells
      </span>
    </div>
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
