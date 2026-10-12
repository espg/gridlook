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
  expect(html).toMatch(/<button[^>]*>\s*Profile\s*<\/button>/);
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

it("asks the camera for a tilt once per press", () => {
  const store = useGlobeControlStore();
  expect(store.pointTierTilt).toBeUndefined();
  store.requestPointTierTilt(POINT_PIVOT_TILTS.PROFILE);
  expect(store.pointTierTilt).toEqual({ degrees: 90, serial: 1 });
  // the same view asked again is a new request: the watch fires again
  store.requestPointTierTilt(POINT_PIVOT_TILTS.PROFILE);
  expect(store.pointTierTilt).toEqual({ degrees: 90, serial: 2 });
  store.requestPointTierTilt(POINT_PIVOT_TILTS.TOP);
  expect(store.pointTierTilt).toEqual({ degrees: 0, serial: 3 });
});
