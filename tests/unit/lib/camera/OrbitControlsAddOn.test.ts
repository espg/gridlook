import {
  PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  type CustomOrbitControls,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { expect, it, vi } from "vitest";

import {
  dragGlobe,
  getGlobeView,
  globePointAt,
  setGlobeView,
  type TGlobeView,
} from "@/lib/camera/globeCamera.ts";
import {
  handleKeyDown,
  useSurfaceZoom,
} from "@/lib/camera/OrbitControlsAddOn.ts";

it.each(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])(
  "slows %s near the surface while preserving distant rotation",
  (key) => {
    for (const distance of [16, 2, 1.1461, 1.146, 1.1459, 1.1, 1.01, 1.001]) {
      const camera = new PerspectiveCamera();
      camera.position.set(distance, 0, 0);
      const controls = new OrbitControls(camera);
      controls.update();
      const before = camera.position.clone();
      handleKeyDown(
        { key, preventDefault() {} } as KeyboardEvent,
        controls,
        false
      );
      controls.update();
      const angle = before.angleTo(camera.position);
      // the camera goes the way the arrow points on the screen
      camera.updateMatrixWorld();
      const seen = before.clone().project(camera);
      const [x, y] = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [1, 0],
        ArrowRight: [-1, 0],
      }[key]!;
      expect(seen.x * x + seen.y * y).toBeGreaterThan(0);
      expect(seen.x * y - seen.y * x).toBeCloseTo(0, 9);
      if (distance >= 2) {
        expect(angle).toBeCloseTo(0.025, 6);
      } else {
        // Around 930 km and below, use at most 1/8 of the previous 0.025 step
        // per unit altitude, without making close navigation unresponsive.
        const stepPerAltitude = angle / (distance - 1);
        expect(stepPerAltitude).toBeGreaterThan(0.0024);
        expect(stepPerAltitude).toBeLessThan(0.025 / 8);
      }
      expect(camera.position.length()).toBeCloseTo(distance, 12);
    }
  }
);

it("preserves arrow-key panning in flat projections", () => {
  const camera = new PerspectiveCamera();
  camera.position.set(0, 0, 0.1);
  const controls: OrbitControls = new OrbitControls(camera);
  const pan = vi
    .spyOn(controls as CustomOrbitControls, "_pan")
    .mockImplementation(() => {});
  handleKeyDown(
    { key: "ArrowRight", preventDefault() {} } as KeyboardEvent,
    controls,
    true
  );
  expect(pan).toHaveBeenCalledWith(controls.keyPanSpeed, 0);
});

it("takes small altitude steps down to the limit and zooms back out", () => {
  const camera = new PerspectiveCamera();
  camera.position.set(1.02, 0, 0);
  const controls = new OrbitControls(camera);
  controls.minDistance = 1.001;
  useSurfaceZoom(controls, () => false);

  let steps = 0;
  while (camera.position.length() > controls.minDistance + 1e-12) {
    const previousAltitude = camera.position.length() - 1;
    controls.dollyIn(0.95);
    expect(camera.position.length() - 1).toBeCloseTo(
      Math.max(0.001, previousAltitude * 0.95),
      12
    );
    expect(++steps).toBeLessThan(100);
  }
  expect(steps).toBe(59);
  controls.dollyOut(0.95);
  expect(camera.position.length() - 1).toBeCloseTo(0.001 / 0.95, 12);
});

it("scales accumulated keyboard zoom and preserves flat projection zoom", () => {
  const camera = new PerspectiveCamera();
  camera.position.set(1.01, 0, 0);
  const controls = new OrbitControls(camera);
  let isFlat = false;
  useSurfaceZoom(controls, () => isFlat);
  const event = { key: "+", preventDefault() {} } as KeyboardEvent;
  handleKeyDown(event, controls, false);
  handleKeyDown(event, controls, false);
  controls.update();
  expect(camera.position.length() - 1).toBeCloseTo(
    0.01 * 0.95 ** (0.96 * 2),
    12
  );

  isFlat = true;
  const previousDistance = camera.position.length();
  controls.dollyIn(0.95);
  expect(camera.position.length()).toBeCloseTo(previousDistance * 0.95, 12);
});

const VIEW = { left: 10, top: 20, width: 800, height: 600 };

/** Controls as the scene sets them up, with a canvas rectangle to aim at. */
function controlsFor(camera: PerspectiveCamera, flat = false) {
  const orbitControls: OrbitControls = new OrbitControls(camera);
  const controls = orbitControls as CustomOrbitControls;
  controls.domElement = {
    getBoundingClientRect: () => VIEW,
  } as HTMLElement;
  controls.minDistance = flat ? 0.001 : 1.0002;
  controls.enableRotate = false;
  useSurfaceZoom(controls, () => flat);
  if (flat) {
    // the app's controls keep the frame of the globe camera they began with
    camera.up.set(0, 1, 0);
    controls.target.set(camera.position.x, camera.position.y, 0);
  }
  controls.update();
  return controls;
}

function newCamera() {
  const camera = new PerspectiveCamera(7.5, VIEW.width / VIEW.height, 1e-4);
  // as the scene has it when it constructs the controls
  camera.up.set(0, 0, 1);
  return camera;
}

function globeAt(view: TGlobeView, distance: number) {
  const camera = newCamera();
  camera.position.set(30, 0, 0);
  const controls = controlsFor(camera);
  setGlobeView(camera, view, distance);
  controls.update();
  return { camera, controls };
}

function mapAt(position: Vector3) {
  const camera = newCamera();
  camera.position.copy(position);
  return { camera, controls: controlsFor(camera, true) };
}

/** One wheel step with the pointer at (x, y) in normalised device coordinates. */
function wheel(
  controls: CustomOrbitControls,
  [x, y]: number[],
  deltaY: number
) {
  controls._handleMouseWheel({
    clientX: VIEW.left + ((x + 1) / 2) * VIEW.width,
    clientY: VIEW.top + ((1 - y) / 2) * VIEW.height,
    deltaY,
  });
}

/** The same zoom step without a pointer. */
function centreZoom(controls: CustomOrbitControls, deltaY: number) {
  const scale = controls._getZoomScale(deltaY);
  if (deltaY < 0) {
    controls._dollyIn(scale);
  } else {
    controls._dollyOut(scale);
  }
  controls.update();
}

const raycaster = new Raycaster();

function mapPointUnder(camera: PerspectiveCamera, [x, y]: number[]) {
  camera.updateMatrixWorld();
  raycaster.setFromCamera(new Vector2(x, y), camera);
  return raycaster.ray.intersectPlane(
    new Plane(new Vector3(0, 0, 1), 0),
    new Vector3()
  )!;
}

function globePointUnder(camera: PerspectiveCamera, [x, y]: number[]) {
  return globePointAt(camera, new Vector2(x, y));
}

const ANTARCTIC_PENINSULA = { lat: -65, lon: -62 };
const PLACES = [
  { lat: 90, lon: 0 },
  { lat: 89.9, lon: 20 },
  { lat: 45, lon: 100 },
  { lat: 0, lon: 0 },
  ANTARCTIC_PENINSULA,
  { lat: -89.5, lon: -170 },
  { lat: -90, lon: 37 },
];
const CAMERA_FLOOR = 1.0002;

it("keeps the globe point under the cursor through a wheel step", () => {
  let anchored = 0;
  let centred = 0;
  for (const place of PLACES) {
    for (const bearing of [0, 77, 200]) {
      for (const distance of [16, 4, 1.5, 1.01, 1.0005, CAMERA_FLOOR]) {
        for (let x = -0.9; x < 1; x += 0.45) {
          for (let y = -0.9; y < 1; y += 0.45) {
            for (const deltaY of [-100, 100]) {
              const view = { ...place, bearing };
              const { camera, controls } = globeAt(view, distance);
              const anchor = globePointUnder(camera, [x, y]);
              wheel(controls, [x, y], deltaY);
              const plain = globeAt(view, distance);
              centreZoom(plain.controls, deltaY);
              const moved = globePointUnder(plain.camera, [x, y]);

              // a centre zoom's altitude, still looking at the centre
              expect(camera.position.length()).toBeCloseTo(
                plain.camera.position.length(),
                12
              );
              expect(controls.target.length()).toBe(0);
              const forward = camera.getWorldDirection(new Vector3());
              expect(forward.angleTo(camera.position)).toBeCloseTo(Math.PI, 6);
              const turn = camera.quaternion.angleTo(plain.camera.quaternion);
              if (!anchor || !moved) {
                // off the globe, or the globe shrank away from the cursor
                expect(turn).toBeLessThan(1e-7);
                centred++;
                continue;
              }
              anchored++;
              expect(
                globePointUnder(camera, [x, y])!.distanceTo(anchor)
              ).toBeLessThan(1e-9);
              // the shortest turn there is: the angle between the two points
              expect(turn).toBeCloseTo(moved.angleTo(anchor), 6);
            }
          }
        }
      }
    }
  }
  expect(anchored).toBeGreaterThan(4000);
  expect(centred).toBeGreaterThan(100);
});

it("anchors a wheel event that arrives through the canvas listener", () => {
  const listeners: Record<string, (event: object) => void> = {};
  const root = { addEventListener() {}, removeEventListener() {} };
  const canvas = {
    ...root,
    style: {},
    ownerDocument: root,
    getRootNode: () => root,
    getBoundingClientRect: () => VIEW,
    addEventListener(type: string, listener: (event: object) => void) {
      listeners[type] = listener;
    },
  };
  const camera = newCamera();
  camera.position.set(30, 0, 0);
  const controls = new OrbitControls(camera, canvas as unknown as HTMLElement);
  controls.minDistance = CAMERA_FLOOR;
  useSurfaceZoom(controls, () => false);
  setGlobeView(camera, { ...ANTARCTIC_PENINSULA, bearing: 40 }, 4);
  controls.update();

  const cursor = [0.6, -0.4];
  const anchor = globePointUnder(camera, cursor)!;
  const before = camera.position.clone();
  listeners.wheel({
    clientX: VIEW.left + ((cursor[0] + 1) / 2) * VIEW.width,
    clientY: VIEW.top + ((1 - cursor[1]) / 2) * VIEW.height,
    deltaY: -100,
    deltaMode: 0,
    ctrlKey: false,
    preventDefault() {},
  });
  expect(camera.position.length()).toBeLessThan(3.9);
  expect(camera.position.angleTo(before)).toBeGreaterThan(1e-3);
  expect(globePointUnder(camera, cursor)!.distanceTo(anchor)).toBeLessThan(
    1e-9
  );
});

it("turns the globe evenly through a run of wheel steps", () => {
  for (const place of PLACES) {
    for (const cursor of [
      [0.5, 0.3],
      [-0.2, -0.6],
    ]) {
      for (const deltaY of [-100, 100]) {
        const view = { ...place, bearing: 120 };
        const { camera, controls } = globeAt(view, deltaY < 0 ? 16 : 1.001);
        const anchor = globePointUnder(camera, cursor);
        const turns: number[] = [];
        for (let step = 0; step < 150; step++) {
          const before = camera.position.clone();
          wheel(controls, cursor, deltaY);
          if (!anchor || !globePointUnder(camera, cursor)?.equals(anchor)) {
            // from here on the globe is too small to be under the cursor
            expect(
              globePointUnder(camera, cursor)?.distanceTo(anchor!) ?? 0
            ).toBeLessThan(1e-9);
          }
          turns.push(before.angleTo(camera.position));
        }
        const held = turns.filter((turn) => turn > 1e-12);
        expect(held.length).toBeGreaterThan(deltaY < 0 ? 100 : 50);
        for (let step = 1; step < held.length; step++) {
          expect(held[step]).toBeLessThan(1.6 * held[step - 1] + 1e-9);
        }
      }
    }
  }
});

it("keeps the map point under the cursor through a wheel step", () => {
  for (const height of [3, 0.05]) {
    for (const cursor of [
      [0.6, 0.4],
      [-0.9, -0.7],
    ]) {
      for (const deltaY of [-100, 100]) {
        const start = new Vector3(0.3, -0.2, height);
        const { camera, controls } = mapAt(start);
        const anchor = mapPointUnder(camera, cursor);
        wheel(controls, cursor, deltaY);

        expect(mapPointUnder(camera, cursor).distanceTo(anchor)).toBeLessThan(
          1e-9
        );
        const plain = mapAt(start);
        centreZoom(plain.controls, deltaY);
        expect(camera.position.z).toBeCloseTo(plain.camera.position.z, 12);
        expect(camera.position.z).not.toBeCloseTo(height, 6);
        // still straight above its target on the map
        expect(controls.target.z).toBeCloseTo(0, 12);
        expect(
          Math.hypot(
            camera.position.x - controls.target.x,
            camera.position.y - controls.target.y
          )
        ).toBeLessThan(1e-5 * height);
        expect(camera.position.x).not.toBeCloseTo(plain.camera.position.x, 4);
      }
    }
  }
});

it("zooms towards the centre without a pointer", () => {
  // keyboard zoom has none, also right after a wheel step
  const { camera, controls } = globeAt({ lat: 30, lon: 20, bearing: 50 }, 4);
  wheel(controls, [0.6, 0.4], -100);
  const direction = camera.position.clone().normalize();
  const up = camera.up.clone();
  handleKeyDown(
    { key: "+", preventDefault() {} } as KeyboardEvent,
    controls,
    false
  );
  controls.update();
  expect(camera.position.length()).toBeLessThan(3.8);
  expect(
    camera.position.clone().normalize().distanceTo(direction)
  ).toBeLessThan(1e-12);
  expect(camera.up.distanceTo(up)).toBe(0);
});

it("leaves a camera at rest where it is, also straight above a pole", () => {
  for (const place of PLACES) {
    for (const distance of [16, CAMERA_FLOOR]) {
      const { camera, controls } = globeAt(
        { ...place, bearing: 300 },
        distance
      );
      wheel(controls, [0.3, 0.2], 100);
      handleKeyDown(
        { key: "ArrowLeft", preventDefault() {} } as KeyboardEvent,
        controls,
        false
      );
      setGlobeView(camera, { ...place, bearing: 300 });
      controls.update();
      const position = camera.position.clone();
      const quaternion = camera.quaternion.clone();
      const up = camera.up.clone();
      for (let frame = 0; frame < 500; frame++) {
        const last = camera.position.clone();
        expect(controls.update()).toBe(false);
        // the scene's threshold for a camera that moved
        expect(last.distanceToSquared(camera.position)).toBeLessThan(1e-24);
      }
      expect(camera.position.distanceTo(position)).toBeLessThan(1e-10);
      expect(camera.quaternion.angleTo(quaternion)).toBeLessThan(1e-7);
      expect(camera.up.equals(up)).toBe(true);
      // not pushed off the axis OrbitControls was constructed with
      const { lat } = getGlobeView(camera);
      expect(lat).toBeCloseTo(place.lat, 9);
    }
  }
});

it("holds a dragged point through a wheel step under the pointer", () => {
  for (const deltaY of [-100, 100]) {
    const { camera, controls } = globeAt(
      { ...ANTARCTIC_PENINSULA, bearing: 0 },
      6
    );
    const cursors = [
      [0.1, 0.1],
      [0.14, 0.12],
      [0.18, 0.14],
    ].map(([x, y]) => new Vector2(x, y));
    const grabbed = globePointAt(camera, cursors[0])!;
    const start = camera.clone();
    expect(dragGlobe(camera, grabbed, cursors[0], cursors[1])).toBe(grabbed);
    controls.update();
    const dragTurn = camera.clone();
    wheel(controls, cursors[1].toArray(), deltaY);
    expect(camera.position.length()).not.toBeCloseTo(6, 2);
    expect(globePointAt(camera, cursors[1])!.distanceTo(grabbed)).toBeLessThan(
      1e-9
    );
    const zoomed = camera.clone();
    expect(dragGlobe(camera, grabbed, cursors[1], cursors[2])).toBe(grabbed);
    controls.update();
    expect(globePointAt(camera, cursors[2])!.distanceTo(grabbed)).toBeLessThan(
      1e-9
    );
    // the move after the step turns the globe as the one before it did
    const ratio =
      zoomed.quaternion.angleTo(camera.quaternion) /
      start.quaternion.angleTo(dragTurn.quaternion);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  }
});
