<script lang="ts" setup>
import { computed } from "vue";

import PointTierControls from "./PointTierControls.vue";
import { pointTierLegend } from "./pointTierLegend.ts";

import { exceedsCellCap, finestLevel, POINT_TIER } from "@/lib/data/levels.ts";
import { pointTierSources } from "@/lib/points/pointSource.ts";
import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils.ts";
import type { TSourceLevel } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  levels: TSourceLevel[];
}>();

const store = useGlobeControlStore();

const resolutionFormat = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 3,
});

function formatResolution(resolution?: number) {
  if (resolution === undefined) {
    return "";
  }
  return resolution >= 1000
    ? ` · ${resolutionFormat.format(resolution / 1000)} km`
    : ` · ${resolutionFormat.format(resolution)} m`;
}

const options = computed(() =>
  props.levels.map((level, index) => ({
    index,
    label: `${level.name ?? index}${formatResolution(level.resolution)}`,
    // still selectable by hand; the camera never picks these
    tooManyCells: !store.loadsLevelByView(index) && exceedsCellCap(level),
  }))
);

// the point tier, when the finest level has observations under the shown
// variable and the globe is drawn: listed before the levels, as the finest
// entry, named by the strata drawn
const pointTier = computed(() => {
  const finest = finestLevel(props.levels);
  const sources =
    finest === undefined ||
    store.projectionMode !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE
      ? []
      : pointTierSources(
          props.levels[finest],
          store.varnameSelector,
          store.digestStratum
        );
  const strata = sources.map(({ stratum, array }) => stratum ?? array);
  return sources.length && finest !== undefined
    ? { index: finest, label: `points (${strata.join(" + ")})` }
    : undefined;
});

const selected = computed(() =>
  store.pointTier && pointTier.value ? POINT_TIER : store.selectedLevel
);

const countFormat = new Intl.NumberFormat();
const pointTierTitle = computed(() => {
  const stats = store.pointTier ? store.pointTierStats : undefined;
  const legend = pointTierLegend(store.pointTierLeftDrag);
  if (!stats) {
    return `The observations themselves, drawn at their height in place of the finest level. ${legend}`;
  }
  const thinned = stats.stride > 1 ? ` (1 in ${stats.stride})` : "";
  return `${countFormat.format(stats.photons)} observations in ${stats.loaded} of ${stats.chunks} chunks, ${countFormat.format(stats.drawn)} drawn${thinned}. ${legend}`;
});

function onLevelChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === POINT_TIER && pointTier.value) {
    store.selectPointTier(pointTier.value.index);
    return;
  }
  store.selectLevel(Number(value));
}

function onAutoChange(event: Event) {
  store.setLevelAuto((event.target as HTMLInputElement).checked);
}

function onParentBeneathChange(event: Event) {
  store.setLevelParentBeneath((event.target as HTMLInputElement).checked);
}

function onRangeSharedChange(event: Event) {
  store.setLevelRangeShared((event.target as HTMLInputElement).checked);
}
</script>

<template>
  <div class="column">
    <div class="control">
      <div class="is-size-7 has-text-grey">Level</div>
      <div
        class="select is-fullwidth mb-2"
        :class="{ 'is-loading': store.loading }"
      >
        <select :value="selected" class="form-control" @change="onLevelChange">
          <option v-if="pointTier" :value="POINT_TIER" :title="pointTierTitle">
            {{ pointTier.label }}
          </option>
          <option
            v-for="option in options"
            :key="option.index"
            :value="option.index"
            :title="
              option.tooManyCells
                ? 'More cells than the renderer allocates comfortably'
                : undefined
            "
          >
            {{ option.label }}
          </option>
        </select>
      </div>
      <PointTierControls v-if="store.pointTier" />
      <label class="checkbox is-size-7">
        <input
          :checked="store.levelAuto"
          type="checkbox"
          @change="onAutoChange"
        />
        Pick the level from the zoom
      </label>
      <label
        class="checkbox is-size-7 is-block"
        title="Off: each level takes its own data range (sums such as counts grow with the cell size)"
      >
        <input
          :checked="store.levelRangeShared"
          type="checkbox"
          @change="onRangeSharedChange"
        />
        Keep one colour range across levels
      </label>
      <label
        class="checkbox is-size-7 is-block"
        title="Show the next coarser level where this one has not loaded yet or is over its budget"
      >
        <input
          :checked="store.levelParentBeneath"
          type="checkbox"
          @change="onParentBeneathChange"
        />
        Draw the next coarser level beneath
      </label>
      <p
        v-if="store.viewWindowClipped"
        class="is-size-7 has-text-warning has-text-weight-semibold mt-1"
        title="The cells nearest the centre of the view are loaded, up to the budget of this level"
      >
        Max cells at this level reached: zoom in, or pick a coarser level.
      </p>
    </div>
  </div>
</template>
