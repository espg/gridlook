import { beforeEach, expect, it, vi } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { POINT_TIER } = await import("@/lib/data/levels.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: LevelSelector } =
  await import("@/ui/overlays/controls/LevelSelector.vue");

const height = {
  store: "hive+s",
  dataset: "17",
  attrs: {
    digest: {
      array: "h_tdigest_signal",
      product: "percentile",
      stratum: "signal",
    },
  },
};
const level = (order: number, derived: boolean) => ({
  name: `order ${order}${derived ? " (derived)" : ""}`,
  grid: { store: "hive+s", dataset: String(order) },
  time: { store: "hive+s", dataset: String(order) },
  datasources: {
    count: { store: "hive+s", dataset: String(order), attrs: {} },
    h_percentile_signal: height, // eslint-disable-line camelcase
  },
  resolution: 50 * 2 ** (17 - order),
  cellCount: 12 * 4 ** order,
  ...(derived ? { derived: { dataset: "19", refinement: 19 - order } } : {}),
});
const levels = [level(17, true), level(13, false)];

beforeEach(() => setActivePinia(createPinia()));

function render(sources = levels) {
  return renderToString(createSSRApp(LevelSelector, { levels: sources }));
}

it("lists the points before the finest level under a height variable", async () => {
  const store = useGlobeControlStore();
  store.varnameSelector = "h_percentile_signal";
  const html = await render();
  expect(html).toContain(`value="${POINT_TIER}"`);
  expect(html.indexOf("points (signal)")).toBeLessThan(
    html.indexOf("order 17 (derived)")
  );
  // the strata drawn name the entry
  store.setDigestStratum("both");
  expect(await render()).toContain("points (signal)");
  const noise = {
    ...height,
    attrs: {
      digest: {
        array: "h_tdigest_noise",
        product: "percentile",
        stratum: "noise",
      },
    },
  };
  const strata = levels.map((level) => ({
    ...level,
    datasources: { ...level.datasources, h_percentile_noise: noise }, // eslint-disable-line camelcase
  }));
  expect(await render(strata)).toContain("points (signal + noise)");
  store.setDigestStratum("noise");
  expect(await render(strata)).toContain("points (noise)");
  store.setDigestStratum("signal");
  // not under count, nor without a derived finest level
  store.varnameSelector = "count";
  expect(await render()).not.toContain("points (");
  store.varnameSelector = "h_percentile_signal";
  expect(await render([level(17, false), level(13, false)])).not.toContain(
    "points ("
  );
});

it("shows the points as the current level while the tier is on", async () => {
  const store = useGlobeControlStore();
  store.varnameSelector = "h_percentile_signal";
  store.selectPointTier(0, false);
  expect(await render()).toContain(`<select value="${POINT_TIER}"`);
  store.setPointTier(false);
  expect(await render()).toContain('<select value="0"');
  // the finest level stays selected beneath the points
  expect(store.selectedLevel).toBe(0);
  expect(ZARR_FORMAT.V3).toBe(3);
});

it("carries the legend of the points' controls while the tier is on", async () => {
  const store = useGlobeControlStore();
  store.varnameSelector = "h_percentile_signal";
  // the option's tooltip carries it always; the legend element only on
  expect(await render()).not.toContain(">Drag pans");
  store.selectPointTier(0, false);
  const html = await render();
  expect(html).toContain(
    ">Drag pans · Shift+drag or right-drag orbits · wheel zooms to the cursor<"
  );
});
