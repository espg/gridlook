import { useEventListener } from "@vueuse/core";
import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { computed, effectScope, ref } from "vue";

import type { TProjectionType } from "@/lib/projection/projectionUtils.ts";

const { mounted, unmounted } = vi.hoisted(() => ({
  mounted: [] as (() => void)[],
  unmounted: [] as (() => void)[],
}));

vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: (callback: () => void) => mounted.push(callback),
  onBeforeUnmount: (callback: () => void) => unmounted.push(callback),
}));

vi.mock("@vueuse/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vueuse/core")>()),
  useEventListener: vi.fn(),
  useResizeObserver: vi.fn(),
}));

vi.mock("three", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three")>()),
  WebGLRenderer: class {
    constructor(readonly parameters: object) {}
    domElement = Object.assign(new EventTarget(), {
      ownerDocument: new EventTarget(),
      style: { touchAction: "" },
      clientHeight: 600,
      setPointerCapture() {},
      releasePointerCapture() {},
      getRootNode() {
        return this.ownerDocument;
      },
    });
    render() {}
    dispose() {}
  },
}));

vi.mock("@/ui/grids/composables/useGridSnapshot.ts", () => ({
  useGridSnapshot: () => ({ makeSnapshot: vi.fn() }),
}));

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { useUrlParameterStore } = await import("@/store/paramStore.ts");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { ProjectionHelper, PROJECTION_TYPES } =
  await import("@/lib/projection/projectionUtils.ts");
const { EARTH_RADIUS_METERS, useGridCameraState } =
  await import("@/ui/grids/composables/useGridCameraState.ts");
const { useGridScene } = await import("@/ui/grids/composables/useGridScene.ts");
const { getGlobeView, globePointAt, roundBearing, setGlobeView } =
  await import("@/lib/camera/globeCamera.ts");

type TSceneSetupOptions = {
  alt?: string;
  lat?: string;
  lon?: string;
  flat?: boolean;
  projection?: TProjectionType;
};

function setupRegionalScene(saved: TSceneSetupOptions = {}) {
  vi.useFakeTimers();
  vi.stubGlobal("window", { innerWidth: 800, innerHeight: 600 });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16)
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  setActivePinia(createPinia());
  const params = useUrlParameterStore();
  params.paramCameraAlt = saved.alt;
  params.paramLat = saved.lat;
  params.paramLon = saved.lon;
  const scope = effectScope();
  const center = ref({ lat: 0, lon: 0 });
  const grid = scope.run(() =>
    useGridScene({
      projectionHelper: computed(
        () =>
          new ProjectionHelper(
            saved.projection ??
              (saved.flat
                ? PROJECTION_TYPES.EQUIRECTANGULAR
                : PROJECTION_TYPES.NEARSIDE_PERSPECTIVE),
            center.value
          )
      ),
      projectionCenter: center,
      controlPanelVisible: ref(false),
      cameraState: useGridCameraState(),
    })
  )!;
  mounted.forEach((callback) => callback());
  grid.box.value = {
    getBoundingClientRect: () => ({ width: 400, height: 800 }),
  } as HTMLDivElement;
  const geometry = new THREE.BufferGeometry().setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute([49, 9, 49, 11, 51, 9, 51, 11], 2)
  );
  return {
    grid,
    center,
    params,
    scope,
    mesh: new THREE.Mesh(geometry),
    camera: grid.getCamera()!,
  };
}

it("fits a fresh dataset after its default camera was saved during loading", async () => {
  const { grid, center, params, scope, mesh, camera } = setupRegionalScene();
  const initialDistance = camera.position.length();
  const defaultAltitude = params.paramCameraAlt;
  expect(defaultAltitude).toBeDefined();
  await vi.advanceTimersByTimeAsync(2000);
  // Coordinate-only bounds can arrive before any render mesh or texture exists.
  grid.fitCameraToDataset([{ geometry: mesh.geometry }]);
  expect(params.paramCameraAlt).not.toBe(defaultAltitude);
  expect(camera.position.length()).toBeLessThan(initialDistance);
  expect(camera.aspect).toBe(0.5);
  expect(center.value.lat).toBeCloseTo(50, 1);
  expect(center.value.lon).toBeCloseTo(10, 1);
  expect(Number(params.paramCameraAlt)).toBeCloseTo(
    (camera.position.length() - 1) * EARTH_RADIUS_METERS,
    0
  );
  camera.position.setLength(5);
  grid.fitCameraToDataset([mesh]);
  expect(camera.position.length()).toBeCloseTo(5);
  scope.stop();
});

it("asks the renderer for the stencil buffer that masks a pyramid's backdrop", () => {
  const { grid, scope } = setupRegionalScene();
  expect(grid.getRenderer()).toMatchObject({ parameters: { stencil: true } });
  scope.stop();
});

it.each([{ alt: "1000000" }, { lat: "0" }, { lon: "0" }, { flat: true }])(
  "preserves saved views and flat projections (%j)",
  (saved) => {
    const { grid, scope, mesh, camera } = setupRegionalScene(saved);
    const position = camera.position.clone();
    grid.fitCameraToDataset([mesh]);
    expect(camera.position).toEqual(position);
    scope.stop();
  }
);

it("does not replace a camera the user zoomed while data was loading", () => {
  vi.mocked(useEventListener).mockClear();
  const { grid, scope, mesh, camera } = setupRegionalScene();
  const wheelListener = vi
    .mocked(useEventListener)
    .mock.calls.find((args) => args[1] === "wheel")![2] as () => void;
  wheelListener();
  const position = camera.position.clone();
  grid.fitCameraToDataset([mesh]);
  expect(camera.position).toEqual(position);
  scope.stop();
});

it("updates the distance scale with the picker disabled and clears it on mouse leave", () => {
  vi.mocked(useEventListener).mockClear();
  const { grid, scope, camera } = setupRegionalScene({ flat: true });
  const store = useGlobeControlStore();
  grid.canvas.value = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as HTMLCanvasElement;
  grid.applyCameraPreset({ position: [0, 0, 5], quaternion: [0, 0, 0, 1] });
  camera.updateMatrixWorld();
  const move = vi
    .mocked(useEventListener)
    .mock.calls.find((args) => args[1] === "mousemove")![2] as (
    event: MouseEvent
  ) => void;
  const leave = vi
    .mocked(useEventListener)
    .mock.calls.find((args) => args[1] === "mouseleave")![2] as () => void;
  move({ clientX: 400, clientY: 300 } as MouseEvent);
  expect(store.hoverEnabled).toBe(false);
  expect(grid.hoveredGeoPoint.value).toBeNull();
  const initial = store.distanceScale!;
  expect(initial).not.toBeNull();
  camera.position.z /= 2;
  camera.updateMatrixWorld();
  grid.redraw();
  const zoomed = store.distanceScale!;
  expect(zoomed.distanceMeters / zoomed.widthPx).toBeCloseTo(
    initial.distanceMeters / initial.widthPx / 2
  );
  leave();
  expect(store.distanceScale).toBeNull();
  scope.stop();
});

it.each(Object.values(PROJECTION_TYPES))(
  "publishes the ground scale below the camera on a %s view",
  async (projection) => {
    const { grid, scope, camera } = setupRegionalScene({ projection });
    const store = useGlobeControlStore();
    grid.canvas.value = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
      }),
    } as HTMLCanvasElement;
    camera.updateMatrixWorld();
    // the scale is published at most every 200 ms
    await vi.advanceTimersByTimeAsync(250);
    grid.redraw();
    const initial = store.metersPerPixel!;
    expect(initial).toBeGreaterThan(0);
    // halve the height above the surface: a pixel covers half the ground
    const flat = projection !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE;
    if (flat) {
      camera.position.z /= 2;
    } else {
      camera.position.setLength(1 + (camera.position.length() - 1) / 2);
    }
    camera.updateMatrixWorld();
    await vi.advanceTimersByTimeAsync(250);
    grid.redraw();
    expect(store.metersPerPixel! / initial).toBeCloseTo(0.5, 1);
    scope.stop();
  }
);

it.each(
  Object.values(PROJECTION_TYPES).filter(
    (type) => type !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE
  )
)(
  "supports close zoom on a panned %s map without clipping the surface or crop",
  (projection) => {
    const { grid, scope, camera, params } = setupRegionalScene({ projection });
    grid.applyCameraPreset({
      position: [2, 1, 0.0001],
      quaternion: [0, 0, 0, 1],
    });
    expect(camera.position.z).toBeCloseTo(0.001, 6);
    expect(camera.near).toBeCloseTo(0.0005, 6);
    expect(Number(params.paramCameraAlt)).toBe(
      Math.round(0.001 * EARTH_RADIUS_METERS)
    );
    camera.updateMatrixWorld();
    const crop = grid
      .getScene()!
      .children.find((object) => object.renderOrder === -10)!.children[0];
    const cropZ = crop ? crop.getWorldPosition(new THREE.Vector3()).z : 0;
    expect(cropZ).toBe(0);
    for (const z of [0, cropZ]) {
      const depth = new THREE.Vector3(2, 1, z).project(camera).z;
      expect(depth).toBeGreaterThan(-1);
      expect(depth).toBeLessThan(1);
    }
    scope.stop();
  }
);

const CANVAS = { left: 0, top: 0, width: 800, height: 600 };

/** A globe scene with a canvas, and the listeners it put on that canvas. */
function setupGlobeDrag() {
  vi.mocked(useEventListener).mockClear();
  const setup = setupRegionalScene();
  setup.grid.canvas.value = {
    getBoundingClientRect: () => CANVAS,
  } as HTMLCanvasElement;
  const fire = (type: string, event: object = {}) =>
    (
      vi
        .mocked(useEventListener)
        .mock.calls.find((args) => args[1] === type)!
        .at(2) as (event: object) => void
    )(event);
  let timeStamp = 0;
  let pointer = { clientX: 0, clientY: 0 };
  const cursor = () =>
    new THREE.Vector2(
      (pointer.clientX / CANVAS.width) * 2 - 1,
      1 - (pointer.clientY / CANVAS.height) * 2
    );
  const press = (clientX: number, clientY: number) => {
    pointer = { clientX, clientY };
    fire("pointerdown", { pointerId: 1, button: 0, timeStamp, ...pointer });
    fire("mousedown");
  };
  /** A frame, then the pointer `dx`, `dy` further on. */
  const move = async (dx: number, dy: number, shiftKey = false) => {
    await vi.advanceTimersByTimeAsync(16);
    timeStamp += 16;
    pointer = { clientX: pointer.clientX + dx, clientY: pointer.clientY + dy };
    fire("pointermove", { pointerId: 1, timeStamp, shiftKey, ...pointer });
  };
  const release = (heldFor = 4) => {
    timeStamp += heldFor;
    fire("pointerup", { pointerId: 1, timeStamp });
    fire("mouseup");
  };
  return {
    ...setup,
    fire,
    cursor,
    pointer: () => pointer,
    press,
    move,
    release,
  };
}

it("drags the globe by the point under the pointer, across a pole", async () => {
  const { grid, scope, camera, cursor, press, move, release } =
    setupGlobeDrag();
  setGlobeView(camera, { lat: -86, lon: 30, bearing: 140 }, 4);
  grid.redraw();
  press(500, 350);
  const grabbed = globePointAt(camera, cursor())!;
  const pole = new THREE.Vector3(0, 0, -1);
  let nearest = camera.position.angleTo(pole);
  for (let step = 0; step < 30; step++) {
    await move(-9, 7);
    expect(globePointAt(camera, cursor())!.distanceTo(grabbed)).toBeLessThan(
      1e-9
    );
    nearest = Math.min(nearest, camera.position.angleTo(pole));
  }
  await vi.advanceTimersByTimeAsync(16);
  expect(globePointAt(camera, cursor())!.distanceTo(grabbed)).toBeLessThan(
    1e-9
  );
  // the camera went past the pole and on, and nothing put north back up
  expect(nearest).toBeLessThan(0.02);
  expect(camera.position.angleTo(pole)).toBeGreaterThan(0.05);
  expect(camera.position.length()).toBeCloseTo(4, 12);
  expect(roundBearing(getGlobeView(camera).bearing)).not.toBe(0);
  release(200);
  scope.stop();
});

// eslint-disable-next-line max-lines-per-function
it("glides on from a flick to a camera at rest, and not from a pointer held still", async () => {
  const { grid, scope, camera, fire, press, move, release } = setupGlobeDrag();
  const store = useGlobeControlStore();
  const flick = async () => {
    setGlobeView(camera, { lat: 70, lon: 30, bearing: 140 }, 4);
    grid.redraw();
    press(500, 350);
    for (let step = 0; step < 12; step++) {
      await move(9, -7);
    }
  };
  const turnOver = async (milliseconds: number) => {
    const before = camera.position.clone();
    await vi.advanceTimersByTimeAsync(milliseconds);
    return before.angleTo(camera.position);
  };

  await flick();
  release();
  expect(await turnOver(160)).toBeGreaterThan(0.01);
  expect(camera.position.length()).toBeCloseTo(4, 12);
  await vi.advanceTimersByTimeAsync(5000);
  // at rest: the loop has stopped, and frames drawn later publish no new view
  expect(vi.getTimerCount()).toBe(0);
  const position = camera.position.clone();
  const footprint = store.viewFootprint;
  expect(footprint).not.toBeNull();
  for (let frame = 0; frame < 5; frame++) {
    grid.redraw();
    await vi.advanceTimersByTimeAsync(250);
  }
  expect(camera.position.distanceTo(position)).toBeLessThan(1e-12);
  expect(store.viewFootprint).toBe(footprint);

  await flick();
  release(200);
  expect(await turnOver(160)).toBeLessThan(1e-12);

  // a wheel step, a press and the rotation switched on each end a glide
  for (const stop of [
    () => fire("wheel"),
    () => fire("mousedown"),
    () => grid.toggleRotate(),
  ]) {
    await flick();
    release();
    expect(await turnOver(32)).toBeGreaterThan(0.001);
    stop();
    if (store.isRotating) {
      // what is left is the rotation, about the globe's axis
      const { lat, bearing } = getGlobeView(camera);
      expect(await turnOver(160)).toBeGreaterThan(0.001);
      expect(getGlobeView(camera).lat).toBeCloseTo(lat, 9);
      expect(getGlobeView(camera).bearing).toBeCloseTo(bearing, 9);
      grid.toggleRotate();
    } else {
      expect(await turnOver(160)).toBeLessThan(1e-12);
    }
    fire("mouseup");
  }
  scope.stop();
});

it("never glides further than the drag was fast, whichever way the camera is turned", async () => {
  const { grid, scope, camera, press, move, release } = setupGlobeDrag();
  let flicks = 0;
  for (const lat of [-90, -45, 0, 45, 90]) {
    for (let lon = -180; lon < 180; lon += 60) {
      // (0, 121, 120) is a view whose camera quaternion changes sign in the drag
      for (const view of [
        { lat, lon, bearing: 0 },
        { lat, lon: lon + 1, bearing: 120 },
        { lat, lon, bearing: 240 },
      ]) {
        setGlobeView(camera, view, 4);
        grid.redraw();
        press(400, 300);
        const start = camera.quaternion.clone();
        for (let step = 0; step < 12; step++) {
          await move(6, -4);
        }
        const dragged = camera.quaternion.clone();
        release();
        await vi.advanceTimersByTimeAsync(3000);
        const drag = start.angleTo(dragged);
        const glide = dragged.angleTo(camera.quaternion);
        expect(drag).toBeGreaterThan(0.04);
        // 12 frames at a steady rate leave 7.3 frames of it to glide on by
        expect(glide / drag).toBeGreaterThan(0.5);
        expect(glide / drag).toBeLessThan(0.7);
        flicks++;
      }
    }
  }
  expect(flicks).toBe(90);
  scope.stop();
});

// eslint-disable-next-line max-lines-per-function
it("twists the view on a shift drag and takes hold again without it", async () => {
  const { grid, scope, camera, cursor, pointer, press, move, release } =
    setupGlobeDrag();
  setGlobeView(camera, { lat: -75, lon: -62, bearing: 30 }, 4);
  grid.redraw();
  const position = camera.position.clone();
  press(500, 350);
  // a plain flick first: the shift drag must not leave its glide pending
  for (let step = 0; step < 6; step++) {
    await move(9, -7);
  }
  const { lat, lon, bearing } = getGlobeView(camera);
  // a first shift move lets go of the globe; then the pointer goes a sixth
  // of a turn round the centre of the canvas, and what is under it with it
  await move(0, 0, true);
  const under = globePointAt(camera, cursor())!;
  const centre = { x: CANVAS.width / 2, y: CANVAS.height / 2 };
  const radius = Math.hypot(
    pointer().clientX - centre.x,
    pointer().clientY - centre.y
  );
  const start = Math.atan2(
    pointer().clientY - centre.y,
    pointer().clientX - centre.x
  );
  for (let step = 1; step <= 8; step++) {
    const angle = start + (step * Math.PI) / 24;
    await move(
      centre.x + radius * Math.cos(angle) - pointer().clientX,
      centre.y + radius * Math.sin(angle) - pointer().clientY,
      true
    );
    expect(globePointAt(camera, cursor())!.distanceTo(under)).toBeLessThan(
      1e-9
    );
  }
  // the pointer went clockwise on screen, so the view turned anticlockwise
  // under it and the bearing fell by that sixth of a turn
  expect(getGlobeView(camera).bearing).toBeCloseTo((bearing + 300) % 360, 6);
  // straight towards the centre turns nothing
  const twisted = camera.quaternion.clone();
  await move(
    (centre.x - pointer().clientX) / 2,
    (centre.y - pointer().clientY) / 2,
    true
  );
  expect(camera.quaternion.angleTo(twisted)).toBeLessThan(1e-9);
  expect(getGlobeView(camera).lat).toBeCloseTo(lat, 9);
  expect(getGlobeView(camera).lon).toBeCloseTo(lon, 9);
  expect(camera.position.length()).toBeCloseTo(4, 12);
  expect(camera.position.angleTo(position)).toBeGreaterThan(0.01);

  // shift let go: that move takes hold and turns nothing, the next ones grab
  const turned = camera.quaternion.clone();
  await move(-5, 3);
  expect(camera.quaternion.angleTo(turned)).toBeLessThan(1e-7);
  const grabbed = globePointAt(camera, cursor())!;
  await move(-9, 6);
  expect(globePointAt(camera, cursor())!.distanceTo(grabbed)).toBeLessThan(
    1e-9
  );
  expect(camera.quaternion.angleTo(turned)).toBeGreaterThan(1e-3);

  // released from a shift drag, nothing glides
  await move(10, 0, true);
  const released = camera.quaternion.clone();
  release();
  await vi.advanceTimersByTimeAsync(500);
  expect(camera.quaternion.angleTo(released)).toBeLessThan(1e-7);
  scope.stop();
});

// eslint-disable-next-line max-lines-per-function
it("goes back to the grab with the finger a pinch leaves down", async () => {
  const { grid, scope, camera, fire } = setupGlobeDrag();
  const canvas = grid.getRenderer()!.domElement;
  let timeStamp = 0;
  /** A touch event, to the scene's listeners and to OrbitControls' own. */
  const touch = (type: string, pointerId: number, x: number, y: number) => {
    const event = Object.assign(new Event(type), {
      pointerId,
      pointerType: "touch",
      button: 0,
      clientX: x,
      clientY: y,
      pageX: x,
      pageY: y,
    });
    Object.defineProperty(event, "timeStamp", { value: (timeStamp += 100) });
    fire(type, event);
    (type === "pointerdown" ? canvas : canvas.ownerDocument).dispatchEvent(
      event
    );
  };
  const cursorAt = (x: number, y: number) =>
    new THREE.Vector2((x / CANVAS.width) * 2 - 1, 1 - (y / CANVAS.height) * 2);
  setGlobeView(camera, { lat: -80, lon: 30, bearing: 140 }, 4);
  grid.redraw();

  touch("pointerdown", 1, 300, 300);
  touch("pointerdown", 2, 500, 300);
  const below = camera.position.clone().normalize();
  touch("pointermove", 2, 600, 300);
  // a pinch: closer, about the centre of the view, and nothing grabbed
  expect(camera.position.length()).toBeLessThan(3.9);
  expect(camera.position.clone().normalize().distanceTo(below)).toBeLessThan(
    1e-12
  );
  // the rotation waits for the pinch
  grid.toggleRotate();
  await vi.advanceTimersByTimeAsync(160);
  expect(camera.position.clone().normalize().distanceTo(below)).toBeLessThan(
    1e-12
  );
  grid.toggleRotate();

  touch("pointerup", 2, 600, 300);
  const altitude = camera.position.length();
  const grabbed = globePointAt(camera, cursorAt(300, 300))!;
  for (const x of [320, 350, 390]) {
    touch("pointermove", 1, x, 310);
    expect(
      globePointAt(camera, cursorAt(x, 310))!.distanceTo(grabbed)
    ).toBeLessThan(1e-9);
    expect(camera.position.length()).toBeCloseTo(altitude, 12);
  }

  // the second finger back down: a pinch again, and no grab beside it
  touch("pointerdown", 2, 500, 300);
  const direction = camera.position.clone().normalize();
  touch("pointermove", 1, 300, 310);
  touch("pointermove", 2, 450, 300);
  expect(camera.position.length()).not.toBeCloseTo(altitude, 3);
  expect(
    camera.position.clone().normalize().distanceTo(direction)
  ).toBeLessThan(1e-12);
  // and nothing glides when both are lifted
  touch("pointerup", 1, 300, 310);
  touch("pointerup", 2, 450, 300);
  const lifted = camera.position.clone();
  await vi.advanceTimersByTimeAsync(500);
  expect(camera.position.distanceTo(lifted)).toBeLessThan(1e-12);
  scope.stop();
});

it("opens north up from a centre and from a preset", async () => {
  const { grid, scope, camera, center } = setupGlobeDrag();
  const roll = () => {
    setGlobeView(camera, { bearing: 200 });
    return roundBearing(getGlobeView(camera).bearing);
  };
  expect(roundBearing(getGlobeView(camera).bearing)).toBe(0);

  expect(roll()).toBe(200);
  center.value = { lat: 20, lon: 5 };
  await vi.advanceTimersByTimeAsync(0);
  expect(getGlobeView(camera).lat).toBeCloseTo(20, 9);
  expect(roundBearing(getGlobeView(camera).bearing)).toBe(0);

  expect(roll()).toBe(200);
  grid.applyCameraPreset({ position: [0, 3, 0], quaternion: [0, 0, 0, 1] });
  expect(getGlobeView(camera).lon).toBeCloseTo(90, 9);
  expect(roundBearing(getGlobeView(camera).bearing)).toBe(0);
  scope.stop();
});

afterEach(() => {
  unmounted.splice(0).forEach((callback) => callback());
  mounted.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { frameDuration: 4, center: { lat: 0, lon: 0 } },
  { frameDuration: 16, center: { lat: 0, lon: 0 } },
  { frameDuration: 16, center: { lat: 35, lon: 139 } },
  { frameDuration: 16, center: { lat: 35, lon: 139 }, stopLayer: true },
])(
  "saves the closest altitude ($frameDuration ms, $center, stopLayer=$stopLayer)",
  // eslint-disable-next-line max-lines-per-function
  async ({ frameDuration, center, stopLayer }) => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { innerWidth: 800, innerHeight: 600 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), frameDuration)
    );
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    setActivePinia(createPinia());
    const scope = effectScope();
    const cameraState = useGridCameraState();
    const grid = scope.run(() =>
      useGridScene({
        projectionHelper: computed(
          () =>
            new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, center)
        ),
        projectionCenter: ref(center),
        controlPanelVisible: ref(false),
        cameraState,
      })
    )!;
    mounted.forEach((callback) => callback());
    const camera = grid.getCamera() as THREE.PerspectiveCamera;
    const previousAltitude = useUrlParameterStore().paramCameraAlt;
    camera.position.setLength(0.5);
    const animateLayer = vi.fn();
    const stopAnimation = grid.registerAnimationCallback(animateLayer);
    if (stopLayer) {
      stopAnimation();
    }

    try {
      await vi.advanceTimersByTimeAsync(1200);
      expect(useUrlParameterStore().paramCameraAlt).not.toBe(previousAltitude);
      expect(useUrlParameterStore().paramCameraAlt).toBe(
        String(Math.round(0.0002 * EARTH_RADIUS_METERS))
      );
      expect(camera.near).toBeCloseTo(0.0001);
      const surfacePoint = camera.position.clone().normalize();
      camera.updateMatrixWorld();
      const surfaceDepth = surfacePoint.project(camera).z;
      expect(surfaceDepth).toBeGreaterThan(-1);
      expect(surfaceDepth).toBeLessThan(1);
      const frameCount = animateLayer.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      if (stopLayer) {
        expect(animateLayer.mock.calls.length).toBe(frameCount);
        expect(vi.getTimerCount()).toBe(0);
      } else {
        expect(animateLayer.mock.calls.length).toBeGreaterThan(frameCount);
      }
    } finally {
      stopAnimation();
      scope.stop();
    }
  }
);
