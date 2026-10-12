import { beforeEach, expect, it, vi } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: DistanceScale } =
  await import("@/ui/overlays/DistanceScale.vue");

beforeEach(() => setActivePinia(createPinia()));

const render = () => renderToString(createSSRApp(DistanceScale));

it("sits in the upper-left corner on the point tier, toggle or not", async () => {
  const store = useGlobeControlStore();
  store.distanceScale = { distanceMeters: 50, widthPx: 101.7 };
  // off the tier the toggle rules
  expect(await render()).not.toContain("distance-scale");
  store.showDistanceScale = true;
  const cursor = await render();
  expect(cursor).toContain("50 m");
  expect(cursor).not.toContain("is-pivot");
  expect(cursor).toContain("at cursor");
  store.showDistanceScale = false;
  store.selectPointTier(0, false);
  const pivot = await render();
  expect(pivot).toContain("is-pivot");
  expect(pivot).toContain("at the pivot: 50 m");
  expect(pivot).toContain("width:101.7px");
  store.distanceScale = { distanceMeters: 2000, widthPx: 80 };
  expect(await render()).toContain("2 km");
});
