<script lang="ts" setup>
import {
  POINT_TIER_LEGEND,
  POINT_TIER_LEGEND_TITLE,
} from "./pointTierLegend.ts";

import { POINT_PIVOT_TILTS } from "@/lib/camera/pointPivot.ts";
import { useGlobeControlStore } from "@/store/store.ts";

/**
 * The point tier's controls, under the level picker while the tier is on:
 * the legend of its mouse controls and the view buttons, which animate the
 * camera's tilt (pointPivot.ts) to the top (nadir) or to a profile (the
 * cloud seen edge-on along the ground), keeping the azimuth and the pivot.
 */
const store = useGlobeControlStore();
</script>

<template>
  <div class="point-tier">
    <p class="is-size-7 has-text-grey" :title="POINT_TIER_LEGEND_TITLE">
      {{ POINT_TIER_LEGEND }}
    </p>
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
</style>
