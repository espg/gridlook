<script lang="ts" setup>
import { computed, ref } from "vue";

import {
  digestPlot,
  probeDigests,
  probePercentiles,
} from "@/lib/digest/digestProbe.ts";
import {
  DIGEST_PRODUCTS,
  digestVariableOf,
  type TDigestVariable,
} from "@/lib/digest/digestVariables.ts";
import { digestWeight } from "@/lib/digest/tdigest.ts";
import type { TDataSource } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  /** The variables of the level on screen. */
  vars?: Record<string, TDataSource>;
}>();

const store = useGlobeControlStore();

// plot geometry, in SVG user units
const WIDTH = 300;
const HEIGHT = 120;
const TOP = 14;
const BOTTOM = 18;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;
// the percentiles always listed under the plot
const SUMMARY_PERCENTILES = [2, 50, 98];

const probe = computed(() => store.digestProbe);
const displayed = computed<TDigestVariable | undefined>(() =>
  digestVariableOf(props.vars?.[store.varnameSelector]?.attrs)
);
const plot = computed(() => probe.value && digestPlot(probe.value));

const countFormat = new Intl.NumberFormat();
const metres = (value: number) => `${value.toFixed(1)} m`;

const strata = computed(() =>
  (probe.value?.strata ?? []).map(({ name, digest }, index) => ({
    name,
    primary: index === 0,
    loaded: digest !== undefined,
    weight: digest ? digestWeight(digest.chunk, digest.cell) : 0,
  }))
);

const scaleX = (value: number) => {
  const x = plot.value!.x;
  return ((value - x[0]) / (x[x.length - 1] - x[0])) * WIDTH;
};
const scaleY = (density: number) =>
  TOP + PLOT_HEIGHT * (1 - density / (plot.value!.peak || 1));

/** A stepped outline of one stratum's density, left to right. */
function outline(density: Float32Array) {
  const x = plot.value!.x;
  let path = "";
  for (let bin = 0; bin < density.length; bin++) {
    const y = scaleY(density[bin]).toFixed(1);
    path += `${bin === 0 ? "M" : "L"}${scaleX(x[bin]).toFixed(1)},${y}`;
    path += `L${scaleX(x[bin + 1]).toFixed(1)},${y}`;
  }
  return path;
}

const curves = computed(() =>
  (plot.value?.curves ?? []).map(({ name, density }) => {
    const line = outline(density);
    const primary = name === probe.value?.strata[0].name;
    return {
      name,
      primary,
      line,
      area: `${line}L${WIDTH},${TOP + PLOT_HEIGHT}L0,${TOP + PLOT_HEIGHT}Z`,
    };
  })
);

// the percentiles of the displayed variable; all three for a stored one
const markers = computed(() => {
  if (!probe.value || !plot.value) {
    return [];
  }
  const product = displayed.value?.product;
  const percentiles =
    product === DIGEST_PRODUCTS.PERCENTILE
      ? [store.digestPercentile]
      : product === DIGEST_PRODUCTS.RANGE
        ? [store.digestPercentileLow, store.digestPercentileHigh]
        : [];
  const values =
    probePercentiles(probe.value, percentiles, displayed.value?.stratum)
      ?.values ?? [];
  return values.map(({ percentile, value }) => ({
    label: `p${percentile}`,
    x: Math.min(Math.max(scaleX(value), 0), WIDTH),
  }));
});

const summary = computed(
  () =>
    probe.value &&
    probePercentiles(probe.value, SUMMARY_PERCENTILES, displayed.value?.stratum)
);

const axis = computed(() => {
  const x = plot.value?.x;
  return x ? [x[0], (x[0] + x[x.length - 1]) / 2, x[x.length - 1]] : [];
});

// the value under the cursor
const cursor = ref<number | undefined>(undefined);
function onPointerMove(event: PointerEvent) {
  const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
  cursor.value =
    rect.width > 0
      ? Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
      : undefined;
}
const readout = computed(() => {
  const x = plot.value?.x;
  if (!x || cursor.value === undefined) {
    return undefined;
  }
  const bin = Math.min(Math.floor(cursor.value * (x.length - 1)), x.length - 2);
  return {
    x: cursor.value * WIDTH,
    text:
      `${metres(x[bin])} to ${metres(x[bin + 1])}: ` +
      plot
        .value!.curves.map(
          ({ name, density }) =>
            `${name} ${countFormat.format(
              Math.round(density[bin] * (x[bin + 1] - x[bin]))
            )}`
        )
        .join(", "),
  };
});

const hasData = computed(
  () => probe.value !== undefined && probeDigests(probe.value).length > 0
);

function close() {
  store.setDigestPin(undefined);
  store.setDigestProbe(undefined);
}
</script>

<template>
  <aside v-if="probe" class="digest-panel" aria-label="Cell distribution">
    <header class="digest-header">
      <div>
        <div class="digest-title">
          Height distribution
          <span v-if="probe.pinned" class="digest-tag">pinned</span>
          <span v-else class="digest-tag">under the cursor</span>
        </div>
        <div class="digest-meta">
          level {{ probe.order }} · cell {{ probe.cell }} ·
          {{ probe.lat.toFixed(4) }}°, {{ probe.lon.toFixed(4) }}°
        </div>
      </div>
      <button
        type="button"
        class="digest-close"
        aria-label="Close the distribution panel"
        @click="close"
      >
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
    </header>

    <div v-if="!hasData" class="digest-empty">No photons in this cell.</div>
    <template v-else>
      <svg
        class="digest-plot"
        :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
        role="img"
        aria-label="Photons per metre of height, by stratum"
        @pointermove="onPointerMove"
        @pointerleave="cursor = undefined"
      >
        <line
          class="digest-baseline"
          x1="0"
          :x2="WIDTH"
          :y1="TOP + PLOT_HEIGHT"
          :y2="TOP + PLOT_HEIGHT"
        />
        <template v-for="curve in curves" :key="curve.name">
          <path v-if="curve.primary" class="digest-area" :d="curve.area" />
          <path
            class="digest-line"
            :class="{ 'is-muted': !curve.primary }"
            :d="curve.line"
          />
        </template>
        <g v-for="marker in markers" :key="marker.label">
          <line
            class="digest-marker"
            :x1="marker.x"
            :x2="marker.x"
            :y1="TOP"
            :y2="TOP + PLOT_HEIGHT"
          />
          <text
            class="digest-marker-label"
            :x="marker.x"
            :y="TOP - 4"
            :text-anchor="
              marker.x < 16 ? 'start' : marker.x > WIDTH - 16 ? 'end' : 'middle'
            "
          >
            {{ marker.label }}
          </text>
        </g>
        <line
          v-if="readout"
          class="digest-cursor"
          :x1="readout.x"
          :x2="readout.x"
          :y1="TOP"
          :y2="TOP + PLOT_HEIGHT"
        />
        <text
          v-for="(tick, index) in axis"
          :key="index"
          class="digest-tick"
          :x="(index * WIDTH) / 2"
          :y="HEIGHT - 4"
          :text-anchor="['start', 'middle', 'end'][index]"
        >
          {{ tick.toFixed(0) }}
        </text>
      </svg>
      <div class="digest-readout">
        {{
          readout?.text ??
          "Photons per metre · height in m above the WGS84 ellipsoid"
        }}
      </div>
      <ul class="digest-legend">
        <li v-for="stratum in strata" :key="stratum.name">
          <span
            class="digest-swatch"
            :class="{ 'is-muted': !stratum.primary }"
          />
          {{ stratum.name }}
          <span class="digest-value">
            {{
              stratum.loaded
                ? `${countFormat.format(stratum.weight)} photons`
                : "click the cell to load"
            }}
          </span>
        </li>
      </ul>
      <div v-if="summary" class="digest-summary">
        <span class="digest-summary-label">{{ summary.stratum }}</span>
        <span v-for="entry in summary.values" :key="entry.percentile">
          p{{ String(entry.percentile).padStart(2, "0") }}
          <span class="digest-value">{{ metres(entry.value) }}</span>
        </span>
      </div>
    </template>
  </aside>
  <div v-else />
</template>

<style lang="scss" scoped>
.digest-panel {
  // one dark surface in both themes, as the hover readout
  --digest-surface: rgba(17, 24, 39, 0.94);
  --digest-text: #f8fafc;
  --digest-text-muted: rgba(226, 232, 240, 0.72);
  --digest-signal: #3987e5;
  --digest-noise: #94a3b8;

  position: fixed;
  right: 1rem;
  bottom: 3.5rem;
  z-index: 1040;
  width: min(22rem, calc(100vw - 2rem));
  padding: 0.7rem 0.8rem;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 0.6rem;
  background: var(--digest-surface);
  color: var(--digest-text);
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.28);
  font-size: 0.8rem;
}

.digest-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}

.digest-title {
  font-weight: 600;
  font-size: 0.9rem;
}

.digest-tag {
  margin-left: 0.35rem;
  padding: 0.05rem 0.4rem;
  border: 1px solid rgba(148, 163, 184, 0.45);
  border-radius: 999px;
  color: var(--digest-text-muted);
  font-weight: 400;
  font-size: 0.7rem;
}

.digest-meta,
.digest-readout,
.digest-empty {
  color: var(--digest-text-muted);
}

.digest-meta,
.digest-value {
  font-variant-numeric: tabular-nums;
}

.digest-close {
  width: 1.6rem;
  height: 1.6rem;
  border: 0;
  border-radius: 0.3rem;
  background: transparent;
  color: var(--digest-text-muted);
  cursor: pointer;

  &:hover {
    background: rgb(255 255 255 / 12%);
    color: var(--digest-text);
  }
}

.digest-plot {
  display: block;
  width: 100%;
  margin-top: 0.4rem;
  overflow: visible;
}

.digest-baseline {
  stroke: rgba(148, 163, 184, 0.45);
  stroke-width: 1;
}

.digest-area {
  fill: var(--digest-signal);
  fill-opacity: 0.25;
}

.digest-line {
  fill: none;
  stroke: var(--digest-signal);
  stroke-width: 1.5;
  stroke-linejoin: round;

  &.is-muted {
    stroke: var(--digest-noise);
    stroke-dasharray: 3 2;
  }
}

.digest-marker {
  stroke: var(--digest-text);
  stroke-width: 1;
}

.digest-cursor {
  stroke: var(--digest-text-muted);
  stroke-width: 1;
  stroke-dasharray: 1 2;
}

.digest-marker-label,
.digest-tick {
  fill: var(--digest-text-muted);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.digest-marker-label {
  fill: var(--digest-text);
}

.digest-readout {
  min-height: 1.2em;
  font-size: 0.72rem;
}

.digest-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.9rem;
  margin: 0.35rem 0 0;
}

.digest-swatch {
  display: inline-block;
  width: 0.9rem;
  height: 0;
  margin-right: 0.25rem;
  border-top: 2px solid var(--digest-signal);
  vertical-align: middle;

  &.is-muted {
    border-top: 2px dashed var(--digest-noise);
  }
}

.digest-value {
  color: var(--digest-text-muted);
}

.digest-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.9rem;
  margin-top: 0.3rem;
  padding-top: 0.3rem;
  border-top: 1px solid rgba(148, 163, 184, 0.25);
}

.digest-summary-label {
  color: var(--digest-text-muted);
}
</style>
