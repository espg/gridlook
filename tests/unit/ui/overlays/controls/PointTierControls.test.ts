import { beforeEach, expect, it, vi } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { POINT_PIVOT_LEFT_DRAGS, POINT_PIVOT_TILTS } =
  await import("@/lib/camera/pointPivot.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: PointTierControls } =
  await import("@/ui/overlays/controls/PointTierControls.vue");

beforeEach(() => setActivePinia(createPinia()));

function render() {
  return renderToString(createSSRApp(PointTierControls));
}

it("carries the legend and the view buttons", async () => {
  const html = await render();
  expect(html).toContain(
    ">Drag pans · Shift+drag or right-drag orbits · wheel zooms to the cursor<"
  );
  expect(html).toMatch(/<button[^>]*>\s*Top\s*<\/button>/);
  expect(html).toMatch(/<button[^>]*>\s*Oblique\s*<\/button>/);
});

it("marks the drag mode and words the legend for it", async () => {
  const store = useGlobeControlStore();
  expect(store.pointTierLeftDrag).toBe(POINT_PIVOT_LEFT_DRAGS.PAN);
  const pan = await render();
  expect(pan).toMatch(/<button[^>]*is-selected[^>]*>\s*Pan\s*<\/button>/);
  expect(pan).not.toMatch(/<button[^>]*is-selected[^>]*>\s*Orbit\s*<\/button>/);
  store.setPointTierLeftDrag(POINT_PIVOT_LEFT_DRAGS.ORBIT);
  const orbit = await render();
  expect(orbit).toMatch(/<button[^>]*is-selected[^>]*>\s*Orbit\s*<\/button>/);
  expect(orbit).not.toMatch(/<button[^>]*is-selected[^>]*>\s*Pan\s*<\/button>/);
  expect(orbit).toContain(
    ">Drag or right-drag orbits · arrows pan · wheel zooms to the cursor<"
  );
  expect(orbit).not.toContain(">Drag pans");
});

it("offers the colour by time only when the source has times", async () => {
  const store = useGlobeControlStore();
  expect(store.pointTierColour).toBe("height");
  const untimed = await render();
  expect(untimed).toMatch(
    /<button[^>]*is-selected[^>]*>\s*height\s*<\/button>/
  );
  expect(untimed).toMatch(/<button[^>]*disabled[^>]*>\s*time\s*<\/button>/);
  expect(untimed).toContain("This store has no times");
  store.setPointTierTimed(true);
  store.setPointTierColour("time");
  const timed = await render();
  expect(timed).toMatch(/<button[^>]*is-selected[^>]*>\s*time\s*<\/button>/);
  expect(timed).not.toMatch(/<button[^>]*disabled[^>]*>\s*time\s*<\/button>/);
});

it("carries the opacity slider, clamped to its range", async () => {
  const store = useGlobeControlStore();
  expect(store.pointTierOpacity).toBe(1);
  expect(await render()).toMatch(
    /<input id="point_opacity"[^>]*type="range"[^>]*min="0.05"[^>]*max="1"[^>]*step="0.05"[^>]*value="1"/
  );
  store.setPointTierOpacity(0.3);
  expect(await render()).toContain('value="0.3"');
  store.setPointTierOpacity(0);
  expect(store.pointTierOpacity).toBe(0.05);
  store.setPointTierOpacity(7);
  expect(store.pointTierOpacity).toBe(1);
  store.setPointTierOpacity(NaN);
  expect(store.pointTierOpacity).toBe(1);
});

it("asks the camera for a tilt once per press", () => {
  const store = useGlobeControlStore();
  expect(store.pointTierTilt).toBeUndefined();
  store.requestPointTierTilt(POINT_PIVOT_TILTS.OBLIQUE);
  expect(store.pointTierTilt).toEqual({ degrees: 60, serial: 1 });
  // the same view asked again is a new request: the watch fires again
  store.requestPointTierTilt(POINT_PIVOT_TILTS.OBLIQUE);
  expect(store.pointTierTilt).toEqual({ degrees: 60, serial: 2 });
  store.requestPointTierTilt(POINT_PIVOT_TILTS.TOP);
  expect(store.pointTierTilt).toEqual({ degrees: 0, serial: 3 });
});
