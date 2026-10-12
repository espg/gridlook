<script lang="ts" setup>
import { computed } from "vue";

import { pointTierLegend, pointTierLegendTitle } from "./pointTierLegend.ts";

import {
  POINT_PIVOT_LEFT_DRAGS,
  POINT_PIVOT_TILTS,
  type TPivotLeftDrag,
} from "@/lib/camera/pointPivot.ts";
import {
  POINT_EXAGGERATION_RANGE,
  POINT_OPACITY_RANGE,
} from "@/lib/points/pointBudget.ts";
import { POINT_COLOURS, type TPointColour } from "@/lib/points/pointTimes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

/**
 * The point tier's controls, under the level picker while the tier is on:
 * the legend of its mouse controls, the mode buttons for what a plain left
 * drag does (shift + left and the right button orbit either way), and the
 * view buttons, which animate the camera's tilt (pointPivot.ts) to the top
 * (nadir) or to a profile (the cloud seen edge-on along the ground),
 * keeping the azimuth and the pivot, the colour choice: the height, or
 * the time when the source has one (pointTimes.ts), the points' opacity
 * and the heights' vertical exaggeration about the datum.
 */
const store = useGlobeControlStore();

const number = (event: Event) =>
  Number((event.target as HTMLInputElement).value);

const legend = computed(() => pointTierLegend(store.pointTierLeftDrag));
const legendTitle = computed(() =>
  pointTierLegendTitle(store.pointTierLeftDrag)
);

const COLOURS: { colour: TPointColour; label: string; title: string }[] = [
  {
    colour: POINT_COLOURS.HEIGHT,
    label: "height",
    title: "Colour each point by its height",
  },
  {
    colour: POINT_COLOURS.TIME,
    label: "time",
    title: "Colour each point by when it was observed",
  },
];

const DRAG_MODES: { mode: TPivotLeftDrag; label: string; title: string }[] = [
  {
    mode: POINT_PIVOT_LEFT_DRAGS.PAN,
    label: "Pan",
    title: "A left drag slides the ground under the pointer",
  },
  {
    mode: POINT_PIVOT_LEFT_DRAGS.ORBIT,
    label: "Orbit",
    title: "A left drag turns about the point under the view and tilts",
  },
];
</script>

<template>
  <div class="point-tier">
    <p class="is-size-7 has-text-grey" :title="legendTitle">
      {{ legend }}
    </p>
    <div class="point-tier-row">
      <span class="is-size-7 has-text-grey point-tier-label">Drag</span>
      <div class="buttons has-addons are-small mb-0">
        <button
          v-for="{ mode, label, title } in DRAG_MODES"
          :key="mode"
          type="button"
          class="button"
          :class="{ 'is-selected is-link': store.pointTierLeftDrag === mode }"
          :title="title"
          @click="store.setPointTierLeftDrag(mode)"
        >
          {{ label }}
        </button>
      </div>
    </div>
    <div class="point-tier-row">
      <span class="is-size-7 has-text-grey point-tier-label">Colour by</span>
      <div class="buttons has-addons are-small mb-0">
        <button
          v-for="{ colour, label, title } in COLOURS"
          :key="colour"
          type="button"
          class="button"
          :class="{ 'is-selected is-link': store.pointTierColour === colour }"
          :disabled="colour === POINT_COLOURS.TIME && !store.pointTierTimed"
          :title="
            colour === POINT_COLOURS.TIME && !store.pointTierTimed
              ? 'This store has no times for its observations'
              : title
          "
          @click="store.setPointTierColour(colour)"
        >
          {{ label }}
        </button>
      </div>
    </div>
    <div class="point-tier-row">
      <label
        class="is-size-7 has-text-grey point-tier-label"
        for="point_opacity"
        >Opacity</label
      >
      <input
        id="point_opacity"
        class="slider point-tier-slider"
        type="range"
        :min="POINT_OPACITY_RANGE.min"
        :max="POINT_OPACITY_RANGE.max"
        :step="POINT_OPACITY_RANGE.step"
        :value="store.pointTierOpacity"
        @input="store.setPointTierOpacity(number($event))"
      />
      <input
        class="input is-small point-tier-number"
        type="number"
        :min="POINT_OPACITY_RANGE.min"
        :max="POINT_OPACITY_RANGE.max"
        :step="POINT_OPACITY_RANGE.step"
        :value="store.pointTierOpacity"
        @change="store.setPointTierOpacity(number($event))"
      />
    </div>
    <div class="point-tier-row">
      <label
        class="is-size-7 has-text-grey point-tier-label"
        for="point_exaggeration"
        title="Stretch the heights above the datum"
        >Exaggerate</label
      >
      <input
        id="point_exaggeration"
        class="slider point-tier-slider"
        type="range"
        :min="POINT_EXAGGERATION_RANGE.min"
        :max="POINT_EXAGGERATION_RANGE.max"
        :step="POINT_EXAGGERATION_RANGE.step"
        :value="store.pointTierExaggeration"
        @input="store.setPointTierExaggeration(number($event))"
      />
      <input
        class="input is-small point-tier-number"
        type="number"
        :min="POINT_EXAGGERATION_RANGE.min"
        :max="POINT_EXAGGERATION_RANGE.max"
        :step="POINT_EXAGGERATION_RANGE.step"
        :value="store.pointTierExaggeration"
        @change="store.setPointTierExaggeration(number($event))"
      />
    </div>
    <div class="point-tier-row">
      <span class="is-size-7 has-text-grey point-tier-label">View</span>
      <div class="buttons has-addons are-small mb-0">
        <button
          type="button"
          class="button"
          title="Look straight down at the pivot"
          @click="store.requestPointTierTilt(POINT_PIVOT_TILTS.TOP)"
        >
          Top
        </button>
        <button
          type="button"
          class="button"
          title="Look along the ground at the pivot: the cloud edge-on"
          @click="store.requestPointTierTilt(POINT_PIVOT_TILTS.PROFILE)"
        >
          Profile
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.point-tier {
  margin-bottom: 0.5rem;
}

.point-tier-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.25rem 0;
}

.point-tier-label {
  flex: 0 0 4rem;
}

.point-tier-slider {
  flex: 1 1 auto;
  min-width: 0;
}

.point-tier-number {
  flex: 0 0 4.5rem;
  width: 4.5rem;
}
</style>
