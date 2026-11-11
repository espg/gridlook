import { PerspectiveCamera, Quaternion, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { expect, it } from "vitest";

import { useFreeOrbit } from "@/lib/camera/OrbitControlsAddOn.ts";
import {
  crossesPole,
  nextFrameUp,
  POLE_AXIS,
  screenUp,
  turnTowards,
} from "@/lib/camera/poleCrossing.ts";

const DEGREES = Math.PI / 180;

/** A camera at `distance` over `lat`/`lon` of the unit globe, north up. */
function globeCamera(lat: number, lon: number, distance = 3) {
  const camera = new PerspectiveCamera();
  camera.up.copy(POLE_AXIS);
  camera.position.set(
    Math.cos(lat * DEGREES) * Math.cos(lon * DEGREES),
    Math.cos(lat * DEGREES) * Math.sin(lon * DEGREES),
    Math.sin(lat * DEGREES)
  );
  camera.position.multiplyScalar(distance);
  camera.lookAt(0, 0, 0);
  return camera;
}

function latitude(position: Vector3) {
  return Math.asin(position.z / position.length()) / DEGREES;
}

function longitude(position: Vector3) {
  return Math.atan2(position.y, position.x) / DEGREES;
}

it("tells when a move would reach a pole of the frame", () => {
  const offset = globeCamera(89.5, 0).position;
  // another half degree north crosses, half a degree south does not
  expect(crossesPole(offset, POLE_AXIS, -0.6 * DEGREES)).toBe(true);
  expect(crossesPole(offset, POLE_AXIS, 0.5 * DEGREES)).toBe(false);
  // in the frame of its own screen-up the camera is on the equator
  const camera = globeCamera(89.5, 0);
  expect(crossesPole(offset, screenUp(camera.quaternion), -5 * DEGREES)).toBe(
    false
  );
});

it("turns a rolled frame back to the pole axis a step at a time", () => {
  const rolled = new Vector3(1, 0, 0.2).normalize();
  const turned = turnTowards(rolled, POLE_AXIS, 0.1);
  expect(turned.angleTo(POLE_AXIS)).toBeCloseTo(
    rolled.angleTo(POLE_AXIS) - 0.1,
    9
  );
  expect(turned.length()).toBeCloseTo(1, 9);
  // within a step of the axis the frame comes to rest exactly on it
  expect(turnTowards(turned, POLE_AXIS, Math.PI)).toEqual(POLE_AXIS);
});

it("re-bases the frame on the screen-up only at a pole", () => {
  const camera = globeCamera(45, 10);
  const offset = camera.position;
  // clear of the poles, the globe's axis stays the frame
  expect(nextFrameUp(POLE_AXIS, offset, camera.quaternion, -0.1)).toBe(
    POLE_AXIS
  );
  // about to cross: the camera's own up
  const polar = globeCamera(89.9, 10);
  const up = nextFrameUp(POLE_AXIS, polar.position, polar.quaternion, -0.01);
  expect(up.angleTo(screenUp(polar.quaternion))).toBeLessThan(1e-9);
  // rolled and clear of the poles: turned back, a step at a time
  const rolled = new Vector3(0, 1, 1).normalize();
  const back = nextFrameUp(rolled, offset, camera.quaternion, 0);
  expect(back.angleTo(POLE_AXIS)).toBeLessThan(rolled.angleTo(POLE_AXIS));
  expect(back.angleTo(POLE_AXIS)).toBeGreaterThan(0);
  // rolled but still near a pole: left alone until the camera is clear
  const nearPole = globeCamera(88, 0);
  expect(nextFrameUp(rolled, nearPole.position, nearPole.quaternion, 0)).toBe(
    rolled
  );
});

function dragNorth(controls: OrbitControls, camera: PerspectiveCamera) {
  const path: number[] = [];
  for (let step = 0; step < 40; step++) {
    (controls as unknown as { _rotateUp: (a: number) => void })._rotateUp(
      1 * DEGREES
    );
    controls.update();
    path.push(latitude(camera.position));
  }
  return path;
}

it("stops at the pole without the add-on", () => {
  const camera = globeCamera(80, 0);
  const controls = new OrbitControls(camera);
  controls.enableDamping = false;
  const path = dragNorth(controls, camera);
  expect(Math.max(...path)).toBeGreaterThan(89.9);
  expect(path[path.length - 1]).toBeGreaterThan(89.9);
});

it("carries the camera across the pole and settles south up beyond it", () => {
  const camera = globeCamera(80, 0);
  const controls = new OrbitControls(camera);
  controls.enableDamping = false;
  useFreeOrbit(controls, () => false);
  const path = dragNorth(controls, camera);
  // up to the pole and down the far side, at the same distance
  expect(Math.max(...path)).toBeGreaterThan(89);
  expect(path[path.length - 1]).toBeCloseTo(60, 0);
  expect(Math.abs(longitude(camera.position))).toBeCloseTo(180, 5);
  expect(camera.position.length()).toBeCloseTo(3, 9);
  // the view keeps turning smoothly: no step is larger than the drag
  for (let i = 1; i < path.length; i++) {
    expect(Math.abs(path[i] - path[i - 1])).toBeLessThan(1.5);
  }
  // once past the pole the frame comes to rest on the globe's axis, south
  // up, since that is the roll a straight crossing leaves
  for (let step = 0; step < 20; step++) {
    controls.update();
  }
  expect(camera.up.z).toBe(-1);
  expect(screenUp(camera.quaternion).z).toBeLessThan(0);
  // and a horizontal drag now moves along a parallel
  const before = latitude(camera.position);
  (controls as unknown as { _rotateLeft: (a: number) => void })._rotateLeft(
    10 * DEGREES
  );
  controls.update();
  expect(latitude(camera.position)).toBeCloseTo(before, 6);
});

it("keeps the frame in step with an up vector set from outside", () => {
  const camera = globeCamera(30, 0);
  const controls = new OrbitControls(camera);
  controls.enableDamping = false;
  useFreeOrbit(controls, () => false);
  controls.update();
  // a flat map sets +Y up and disables rotation: the frame follows the up
  camera.up.set(0, 1, 0);
  camera.position.set(0.2, 0.1, 2);
  controls.target.set(0.2, 0.1, 0);
  controls.update();
  expect(camera.position.x).toBeCloseTo(0.2, 9);
  expect(camera.position.y).toBeCloseTo(0.1, 9);
  expect(camera.position.z).toBeCloseTo(2, 9);
  // disabled controls (a presenter display) leave the roll they are given
  controls.enabled = false;
  const rolled = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
  camera.up.set(0, 1, 0).applyQuaternion(rolled);
  controls.update();
  expect(camera.up.x).toBeCloseTo(-Math.sin(0.3), 9);
});
