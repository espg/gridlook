import * as THREE from "three";
import type { CustomOrbitControls } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { describe, expect, it } from "vitest";

import { EARTH_RADIUS_METERS } from "@/lib/camera/cameraSettings.ts";
import { useSurfaceZoom } from "@/lib/camera/OrbitControlsAddOn.ts";
import {
  createPointPivot,
  dollyTowardGround,
  groundPointOnRay,
  pivotNearPlane,
  POINT_PIVOT_LEFT_DRAGS,
  POINT_PIVOT_MAX_TILT_DEGREES,
  POINT_PIVOT_MIN_ALTITUDE_METERS,
  POINT_PIVOT_MIN_DISTANCE_METERS,
  POINT_PIVOT_TILTS,
  surfacePointNearRay,
  viewHeightAt,
  wheelDollyScale,
} from "@/lib/camera/pointPivot.ts";

const R = EARTH_RADIUS_METERS;
const SIERRA = { lat: 37, lon: -119.5 };

function onSphere(lat: number, lon: number, radius = 1) {
  const latRad = THREE.MathUtils.degToRad(lat);
  const lonRad = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    Math.cos(latRad) * Math.cos(lonRad),
    Math.cos(latRad) * Math.sin(lonRad),
    Math.sin(latRad)
  ).multiplyScalar(radius);
}

/** A globe camera `altitude` metres above a place, looking at the centre. */
function globeCamera(altitude: number) {
  const camera = new THREE.PerspectiveCamera(7.5, 1500 / 900, 0.1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.copy(onSphere(SIERRA.lat, SIERRA.lon, 1 + altitude / R));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

/** The ground point under a screen position (NDC) of a camera. */
function groundUnder(camera: THREE.Camera, x: number, y: number) {
  camera.updateMatrixWorld();
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
  return groundPointOnRay(raycaster.ray.origin, raycaster.ray.direction);
}

/** Where a point falls on a canvas `rect`, client coordinates; null behind the camera. */
function screenPointOf(
  point: THREE.Vector3,
  camera: THREE.Camera,
  rect: { left: number; top: number; width: number; height: number }
) {
  const ndc = point.clone().project(camera);
  return ndc.z < 1
    ? {
        clientX: rect.left + ((ndc.x + 1) * rect.width) / 2,
        clientY: rect.top + ((1 - ndc.y) * rect.height) / 2,
      }
    : null;
}

function forwardOf(camera: THREE.Camera) {
  return camera.getWorldDirection(new THREE.Vector3());
}

function domElement(clientHeight = 900) {
  return Object.assign(new EventTarget(), {
    ownerDocument: new EventTarget(),
    style: { touchAction: "" },
    getRootNode() {
      return this.ownerDocument;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    clientHeight,
    clientWidth: 1500,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 1500,
      height: clientHeight,
    }),
  }) as unknown as HTMLElement;
}

function pivotControls(altitude: number, onDrop?: () => void) {
  const camera = globeCamera(altitude);
  const controls: OrbitControls = new OrbitControls(camera, domElement());
  controls.enablePan = false;
  controls.minDistance = 1.0002;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  const pivot = createPointPivot(controls, onDrop);
  useSurfaceZoom(controls, () => pivot.active);
  return { camera, controls: controls as CustomOrbitControls, pivot };
}

describe("groundPointOnRay", () => {
  it("meets the unit sphere on its near side, and misses past the horizon", () => {
    const origin = new THREE.Vector3(2, 0, 0);
    expect(
      groundPointOnRay(origin, new THREE.Vector3(-1, 0, 0))!.toArray()
    ).toEqual([1, 0, 0]);
    expect(groundPointOnRay(origin, new THREE.Vector3(0, 1, 0))).toBeNull();
    // the surface point under the closest approach stands in for a miss
    expect(
      surfacePointNearRay(origin, new THREE.Vector3(0, 1, 0)).toArray()
    ).toEqual([1, 0, 0]);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("dollyTowardGround", () => {
  it("keeps the ground under the cursor under the cursor", () => {
    const camera = globeCamera(2000);
    for (const [x, y] of [
      [0.6, -0.4],
      [-0.9, 0.8],
      [0, 0],
    ]) {
      const before = groundUnder(camera, x, y)!;
      for (const scale of [0.7, 1.3]) {
        const next = dollyTowardGround(
          camera.position,
          forwardOf(camera),
          before,
          scale
        )!;
        const moved = camera.clone();
        moved.position.copy(next.position);
        moved.updateMatrixWorld();
        const after = groundUnder(moved, x, y)!;
        expect(after.distanceTo(before) * R).toBeLessThan(1e-3);
        // the pivot: on the surface, under the view centre
        expect(next.target.length()).toBeCloseTo(1, 12);
        expect(
          next.target.distanceTo(groundUnder(moved, 0, 0)!) * R
        ).toBeLessThan(1e-3);
        // the distance to the cursor's ground scaled as asked
        expect(next.position.distanceTo(before)).toBeCloseTo(
          camera.position.distanceTo(before) * scale,
          12
        );
      }
    }
  });

  it("stops at the altitude floor and refuses to go below it", () => {
    const camera = globeCamera(400);
    const ground = groundUnder(camera, 0.5, 0.5)!;
    const floor = 1 + POINT_PIVOT_MIN_ALTITUDE_METERS / R;
    const next = dollyTowardGround(
      camera.position,
      forwardOf(camera),
      ground,
      0.01
    )!;
    expect(next.position.length()).toBeCloseTo(floor, 12);
    expect(next.position.distanceTo(ground)).toBeLessThan(
      camera.position.distanceTo(ground)
    );
    const grounded = globeCamera(POINT_PIVOT_MIN_ALTITUDE_METERS / 2);
    expect(
      dollyTowardGround(grounded.position, forwardOf(grounded), ground, 0.9)
    ).toBeNull();
    // zooming out is never held back
    expect(
      dollyTowardGround(
        grounded.position,
        forwardOf(grounded),
        ground,
        1.5
      )!.position.length()
    ).toBeGreaterThan(grounded.position.length());
  });

  it("lets a camera at ground level close in on the pivot, to the distance limit", () => {
    // a camera 3 km from the pivot along the ground, a few
    // decimetres above the sphere, well below the altitude floor
    const pivot = onSphere(SIERRA.lat, SIERRA.lon);
    const east = new THREE.Vector3(0, 0, 1).cross(pivot).normalize();
    const position = pivot.clone().addScaledVector(east, 3000 / R);
    const forward = pivot.clone().sub(position).normalize();
    expect(position.length() - 1).toBeLessThan(
      POINT_PIVOT_MIN_ALTITUDE_METERS / R
    );
    const next = dollyTowardGround(position, forward, pivot, 0.5)!;
    expect(next.position.distanceTo(pivot) * R).toBeCloseTo(1500, 6);
    const held = dollyTowardGround(position, forward, pivot, 0.01)!;
    expect(held.position.distanceTo(pivot) * R).toBeCloseTo(
      POINT_PIVOT_MIN_DISTANCE_METERS,
      6
    );
    expect(dollyTowardGround(held.position, forward, pivot, 0.5)).toBeNull();
  });
});

describe("the view's geometry", () => {
  it("spans 393 m at 3 km under the 7.5° lens, and puts the pivot mid-canvas", () => {
    expect(viewHeightAt(3000, 7.5)).toBeCloseTo(393.26, 1);
    const { camera, controls, pivot } = pivotControls(3000);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    camera.updateMatrixWorld();
    const rect = { left: 10, top: 20, width: 1500, height: 900 };
    const at = screenPointOf(controls.target, camera, rect)!;
    expect(at.clientX).toBeCloseTo(760, 6);
    expect(at.clientY).toBeCloseTo(470, 6);
    // the ground a view-height below the pivot is at the bottom edge
    const down = new THREE.Vector3(0, -1, 0)
      .applyQuaternion(camera.quaternion)
      .multiplyScalar(viewHeightAt(3000, 7.5) / 2 / R);
    expect(
      screenPointOf(controls.target.clone().add(down), camera, rect)!.clientY
    ).toBeCloseTo(920, 3);
    // behind the camera is nowhere
    expect(
      screenPointOf(camera.position.clone().multiplyScalar(2), camera, rect)
    ).toBeNull();
  });
});

describe("pivotNearPlane", () => {
  it("follows the altitude down to the floor, and no further", () => {
    expect(pivotNearPlane(5000 / R) * R).toBeCloseTo(100, 9);
    expect(pivotNearPlane(0.3 / R) * R).toBeCloseTo(
      POINT_PIVOT_MIN_ALTITUDE_METERS / 50,
      9
    );
    expect(pivotNearPlane(-1)).toBeGreaterThan(0);
  });
});

describe("wheelDollyScale", () => {
  it("reads a wheel event as OrbitControls does", () => {
    const pixels = { deltaY: -100, deltaMode: 0, ctrlKey: false };
    expect(wheelDollyScale(pixels)).toBeCloseTo(0.95, 12);
    expect(wheelDollyScale({ ...pixels, deltaY: 100 })).toBeCloseTo(
      1 / 0.95,
      12
    );
    expect(wheelDollyScale({ ...pixels, deltaY: -100 }, 2)).toBeCloseTo(
      0.95 ** 2,
      12
    );
    expect(
      wheelDollyScale({ deltaY: -1, deltaMode: 1, ctrlKey: false })
    ).toBeCloseTo(0.95 ** 0.16, 12);
    expect(
      wheelDollyScale({ deltaY: -1, deltaMode: 2, ctrlKey: false })
    ).toBeCloseTo(0.95, 12);
    expect(
      wheelDollyScale({ ...pixels, deltaY: -10, ctrlKey: true })
    ).toBeCloseTo(0.95, 12);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("createPointPivot", () => {
  it("enters on the ground under the view without moving the camera, north up", () => {
    const { camera, controls, pivot } = pivotControls(2000);
    const position = camera.position.clone();
    const quaternion = camera.quaternion.clone();
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    expect(pivot.active).toBe(true);
    expect(controls.target.length()).toBeCloseTo(1, 12);
    expect(
      controls.target.distanceTo(onSphere(SIERRA.lat, SIERRA.lon)) * R
    ).toBeLessThan(1e-3);
    expect(camera.position.distanceTo(position) * R).toBeLessThan(0.01);
    // the roll is kept: north stays up on screen
    expect(1 - Math.abs(camera.quaternion.dot(quaternion))).toBeLessThan(1e-9);
    expect(pivot.pivotDistance() * R).toBeCloseTo(2000, 3);
    expect(controls.enablePan).toBe(true);
    expect(controls.enableZoom).toBe(true);
    expect(controls.screenSpacePanning).toBe(false);
    expect(controls.maxPolarAngle).toBeCloseTo(
      THREE.MathUtils.degToRad(POINT_PIVOT_MAX_TILT_DEGREES),
      12
    );
    expect(controls.minDistance * R).toBeCloseTo(
      POINT_PIVOT_MIN_DISTANCE_METERS,
      6
    );
    // the left button pans, the right one (and shift + left, as
    // OrbitControls reads a modifier on a pan button) orbits
    expect(controls.mouseButtons.LEFT).toBe(THREE.MOUSE.PAN);
    expect(controls.mouseButtons.MIDDLE).toBe(THREE.MOUSE.DOLLY);
    expect(controls.mouseButtons.RIGHT).toBe(THREE.MOUSE.ROTATE);
    expect(controls.touches.ONE).toBe(THREE.TOUCH.PAN);
    expect(controls.touches.TWO).toBe(THREE.TOUCH.DOLLY_ROTATE);
    expect(controls.enableRotate).toBe(true);
  });

  it("slides the pivot along the surface on a pan", () => {
    const { camera, controls, pivot } = pivotControls(2000);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    const start = controls.target.clone();
    const altitude = camera.position.length() - 1;
    for (let frame = 0; frame < 60; frame++) {
      // a drag of a tenth of the screen height per frame, down and right
      controls._pan(150, 90);
      controls.update();
      expect(controls.target.length()).toBeCloseTo(1, 12);
      // the camera follows at its height above the ground, within
      // centimetres over kilometres: a tangent step sags off the sphere by
      // its square
      expect(camera.position.length() - 1).toBeCloseTo(altitude, 8);
    }
    const moved = controls.target.distanceTo(start) * R;
    // the view spans 2 · 2000 m · tan(3.75°) ≈ 262 m over 900 px: a frame's
    // drag is ≈ 51 m, applied by the damping at 1 − 0.92^frame of it
    let frames = 0;
    for (let frame = 1; frame <= 60; frame++) {
      frames += 1 - 0.92 ** frame;
    }
    const step = (viewHeightAt(2000, 7.5) * Math.hypot(150, 90)) / 900;
    expect(moved / (step * frames)).toBeCloseTo(1, 1);
    // and the camera still looks at the pivot
    expect(
      surfacePointNearRay(camera.position, forwardOf(camera)).distanceTo(
        controls.target
      ) * R
    ).toBeLessThan(1e-3);
  });

  it("tilts from nadir to the limit and no further, about the local vertical", () => {
    const { camera, controls, pivot } = pivotControls(2000);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    controls.enableDamping = false;
    const distance = pivot.pivotDistance();
    controls._rotateUp(-THREE.MathUtils.degToRad(60));
    controls.update();
    const vertical = controls.target.clone().normalize();
    const offset = camera.position.clone().sub(controls.target);
    // within the nadir nudge (1e-6 rad)
    expect(THREE.MathUtils.radToDeg(offset.angleTo(vertical))).toBeCloseTo(
      60,
      3
    );
    expect(offset.length()).toBeCloseTo(distance, 12);
    controls._rotateUp(-THREE.MathUtils.degToRad(60));
    controls.update();
    const clamped = camera.position.clone().sub(controls.target);
    expect(THREE.MathUtils.radToDeg(clamped.angleTo(vertical))).toBeCloseTo(
      POINT_PIVOT_MAX_TILT_DEGREES,
      3
    );
    // the view centre is still the pivot
    expect(
      surfacePointNearRay(camera.position, forwardOf(camera)).distanceTo(
        controls.target
      ) * R
    ).toBeLessThan(1e-3);
  });

  it("zooms toward the cursor and dollies plainly from the keyboard", () => {
    const { camera, controls, pivot } = pivotControls(2000);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    controls.enableDamping = false;
    const cursor = new THREE.Vector2(0.7, -0.5);
    const before = groundUnder(camera, cursor.x, cursor.y)!;
    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
      camera.quaternion
    );
    // four turns of the wheel, a frame rendered between them
    for (let turn = 0; turn < 4; turn++) {
      pivot.zoom(0.85, cursor);
      controls.update();
      camera.updateMatrixWorld();
      expect(
        groundUnder(camera, cursor.x, cursor.y)!.distanceTo(before) * R
      ).toBeLessThan(1e-2);
      // and the view does not turn: north stays up
      expect(
        new THREE.Vector3(0, 1, 0)
          .applyQuaternion(camera.quaternion)
          .angleTo(screenUp)
      ).toBeLessThan(1e-4);
    }
    expect(controls.target.length()).toBeCloseTo(1, 12);
    expect(pivot.pivotDistance() * R).toBeLessThan(2000);
    // a keyboard dolly scales the distance to the pivot, not the altitude
    // above the globe's centre as the surface zoom would
    const distance = pivot.pivotDistance();
    controls._dollyIn(0.5);
    controls.update();
    expect(pivot.pivotDistance()).toBeCloseTo(distance * 0.5, 12);
    // and never closer than the limit
    for (let i = 0; i < 20; i++) {
      controls._dollyIn(0.5);
      controls.update();
    }
    expect(pivot.pivotDistance() * R).toBeCloseTo(
      POINT_PIVOT_MIN_DISTANCE_METERS,
      3
    );
  });

  it("dollies toward the cursor on a middle-button drag, the wheel left to zoom", () => {
    const { camera, controls, pivot } = pivotControls(2000);
    const element = controls.domElement;
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    controls.enableDamping = false;
    const pointer = (type: string, init: object, target: EventTarget) =>
      target.dispatchEvent(
        Object.assign(new Event(type), { pointerType: "mouse", ...init })
      );
    // a middle-button drag up from (1200, 300): in, the ground there kept
    const at = { clientX: 1200, clientY: 300 };
    const ndc = new THREE.Vector2(1200 / 750 - 1, 1 - 300 / 450);
    const ground = groundUnder(camera, ndc.x, ndc.y)!;
    const distance = pivot.pivotDistance();
    pointer("pointerdown", { button: 1, pointerId: 1, ...at }, element);
    pointer(
      "pointermove",
      { pointerId: 1, clientX: 1200, clientY: 200 },
      element.ownerDocument
    );
    pointer(
      "pointerup",
      { pointerId: 1, clientX: 1200, clientY: 200 },
      element.ownerDocument
    );
    controls.update();
    expect(pivot.pivotDistance() / distance).toBeCloseTo(0.95, 6);
    expect(
      groundUnder(camera, ndc.x, ndc.y)!.distanceTo(ground) * R
    ).toBeLessThan(1e-2);
    // a wheel turn is not OrbitControls' to take: the scene zooms
    const wheeled = pivot.pivotDistance();
    element.dispatchEvent(
      Object.assign(new Event("wheel"), {
        deltaY: -100,
        deltaMode: 0,
        clientX: 750,
        clientY: 450,
      })
    );
    controls.update();
    expect(pivot.pivotDistance()).toBeCloseTo(wheeled, 12);
  });

  it("dollies toward the fingers on a pinch", () => {
    const { camera, controls, pivot } = pivotControls(2000);
    const element = controls.domElement;
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    controls.enableDamping = false;
    // two fingers moving apart from 200 to 400 px: in, by half
    const touch = (type: string, id: number, x: number, target: EventTarget) =>
      target.dispatchEvent(
        Object.assign(new Event(type), {
          pointerType: "touch",
          pointerId: id,
          pageX: x,
          pageY: 450,
          clientX: x,
          clientY: 450,
        })
      );
    const pinched = pivot.pivotDistance();
    touch("pointerdown", 2, 650, element);
    touch("pointerdown", 3, 850, element);
    touch("pointermove", 3, 1050, element.ownerDocument);
    controls.update();
    expect(pivot.pivotDistance() / pinched).toBeCloseTo(0.5, 6);
    touch("pointerup", 3, 1050, element.ownerDocument);
    touch("pointerup", 2, 650, element.ownerDocument);
  });

  it("animates to the oblique view and back to the top, keeping azimuth, pivot and distance", () => {
    const { camera, controls, pivot } = pivotControls(3000);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    controls.enableDamping = false;
    const target = controls.target.clone();
    const distance = pivot.pivotDistance();
    // north is up at nadir: the oblique view backs away south and looks north
    const north = new THREE.Vector3(0, 0, 1)
      .addScaledVector(target, -target.z)
      .normalize();
    const animation = pivot.tiltTo(POINT_PIVOT_TILTS.OBLIQUE);
    const tilts: number[] = [];
    let moving = true;
    while (moving) {
      moving = animation.advance(0.1);
      tilts.push(pivot.tilt());
    }
    // six frames of 0.1 s; eased: slow, fast, slow, and monotone
    expect(tilts.length).toBe(6);
    expect(tilts[0]).toBeLessThan(tilts[1] - tilts[0]);
    expect([...tilts].sort((a, b) => a - b)).toEqual(tilts);
    expect(pivot.tilt()).toBeCloseTo(60, 6);
    expect(POINT_PIVOT_MAX_TILT_DEGREES).toBe(85);
    expect(controls.target.distanceTo(target) * R).toBeLessThan(1e-3);
    expect(pivot.pivotDistance()).toBeCloseTo(distance, 12);
    const offset = camera.position.clone().sub(controls.target).normalize();
    expect(offset.dot(north)).toBeCloseTo(-Math.sin(Math.PI / 3), 6);
    // the horizon is up (screen-up is the vertical's part across the view,
    // which leans north) and the view still centres the pivot
    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
      camera.quaternion
    );
    expect(screenUp.dot(north)).toBeGreaterThan(0.4);
    expect(screenUp.clone().cross(target).dot(north)).toBeCloseTo(0, 6);
    expect(
      surfacePointNearRay(camera.position, forwardOf(camera)).distanceTo(
        controls.target
      ) * R
    ).toBeLessThan(1e-3);
    // an orbit drag from there turns about the vertical at 60°
    controls._rotateLeft(Math.PI / 2);
    controls.update();
    expect(pivot.tilt()).toBeCloseTo(60, 3);
    expect(pivot.pivotDistance()).toBeCloseTo(distance, 12);
    const turned = camera.position.clone().sub(controls.target).normalize();
    expect(Math.abs(turned.dot(north))).toBeLessThan(1e-3);
    // and back to the top, from where the oblique view was
    const back = pivot.tiltTo(POINT_PIVOT_TILTS.TOP);
    while (back.advance(0.05)) {
      // frames
    }
    expect(pivot.tilt()).toBeLessThan(1e-3);
    expect(pivot.pivotDistance()).toBeCloseTo(distance, 12);
    expect(controls.target.distanceTo(target) * R).toBeLessThan(1e-3);
    // the animation gives up with the pivot
    pivot.leave();
    expect(pivot.tiltTo(POINT_PIVOT_TILTS.OBLIQUE).advance(0.1)).toBe(false);
  });

  it("lifts the pivot to the cloud's mid-height and keeps it there", () => {
    const { camera, controls, pivot } = pivotControls(3000);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    controls.enableDamping = false;
    const quaternion = camera.quaternion.clone();
    pivot.setHeight(250 / R);
    // the pivot rose along the vertical: a nadir view does not turn
    expect(controls.target.length()).toBeCloseTo(1 + 250 / R, 12);
    expect(
      controls.target.clone().normalize().distanceTo(onSphere(37, -119.5)) * R
    ).toBeLessThan(1e-3);
    expect(1 - Math.abs(camera.quaternion.dot(quaternion))).toBeLessThan(1e-9);
    // and the camera rose with it
    expect(pivot.pivotDistance() * R).toBeCloseTo(3000, 3);
    // a pan slides it at its height, a tilt orbits it there
    controls._pan(150, 90);
    controls.update();
    expect(controls.target.length()).toBeCloseTo(1 + 250 / R, 12);
    controls._rotateUp(-THREE.MathUtils.degToRad(60));
    controls.update();
    expect(controls.target.length()).toBeCloseTo(1 + 250 / R, 12);
    expect(pivot.tilt()).toBeCloseTo(60, 2);
    // a zoom toward the cursor keeps the view centre on the lifted pivot
    pivot.zoom(0.8, new THREE.Vector2(0.4, -0.3));
    controls.update();
    expect(controls.target.length()).toBeCloseTo(1 + 250 / R, 12);
    expect(
      surfacePointNearRay(
        camera.position,
        forwardOf(camera),
        1 + 250 / R
      ).distanceTo(controls.target) * R
    ).toBeLessThan(1e-3);
    // leaving drops it
    pivot.leave();
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    expect(controls.target.length()).toBeCloseTo(1, 12);
  });

  it("keeps a tilted view still as the lift changes", () => {
    const { camera, controls, pivot } = pivotControls(3000);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    controls.enableDamping = false;
    pivot.tiltTo(60).advance(1);
    const offset = camera.position.clone().sub(controls.target);
    const quaternion = camera.quaternion.clone();
    const position = camera.position.clone();
    pivot.setHeight(84 / R);
    expect(
      camera.position.clone().sub(controls.target).distanceTo(offset)
    ).toBeLessThan(1e-12);
    expect(pivot.pivotDistance()).toBeCloseTo(offset.length(), 12);
    expect(1 - Math.abs(camera.quaternion.dot(quaternion))).toBeLessThan(1e-12);
    // the camera only moved along the vertical, by the lift
    const moved = camera.position.clone().sub(position);
    expect(moved.length() * R).toBeCloseTo(84, 6);
    expect(moved.angleTo(controls.target)).toBeLessThan(1e-9);
  });

  it("lets the left button orbit instead, with shift + left orbiting either way", () => {
    const { camera, controls, pivot } = pivotControls(2000);
    const element = controls.domElement;
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    const press = (shiftKey: boolean) => {
      const pointer = {
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
        shiftKey,
      };
      element.dispatchEvent(Object.assign(new Event("pointerdown"), pointer));
      element.dispatchEvent(Object.assign(new Event("pointerup"), pointer));
    };
    pivot.setLeftDrag(POINT_PIVOT_LEFT_DRAGS.ORBIT);
    expect(controls.mouseButtons.LEFT).toBe(THREE.MOUSE.ROTATE);
    expect(controls.touches.ONE).toBe(THREE.TOUCH.ROTATE);
    expect(controls.mouseButtons.RIGHT).toBe(THREE.MOUSE.ROTATE);
    // OrbitControls turns a pan button into an orbit under shift: a shift
    // press in orbit mode is shown a pan button so that it orbits too
    press(true);
    expect(controls.mouseButtons.LEFT).toBe(THREE.MOUSE.PAN);
    press(false);
    expect(controls.mouseButtons.LEFT).toBe(THREE.MOUSE.ROTATE);
    pivot.setLeftDrag(POINT_PIVOT_LEFT_DRAGS.PAN);
    expect(controls.mouseButtons.LEFT).toBe(THREE.MOUSE.PAN);
    expect(controls.touches.ONE).toBe(THREE.TOUCH.PAN);
    press(true);
    expect(controls.mouseButtons.LEFT).toBe(THREE.MOUSE.PAN);
    // the mode is kept across the tier, and leaves the globe's buttons alone
    pivot.setLeftDrag(POINT_PIVOT_LEFT_DRAGS.ORBIT);
    pivot.leave();
    expect(controls.mouseButtons.LEFT).toBe(THREE.MOUSE.ROTATE);
    expect(controls.touches.ONE).toBe(THREE.TOUCH.ROTATE);
    controls.mouseButtons.LEFT = THREE.MOUSE.DOLLY;
    press(false);
    expect(controls.mouseButtons.LEFT).toBe(THREE.MOUSE.DOLLY);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    expect(controls.mouseButtons.LEFT).toBe(THREE.MOUSE.ROTATE);
  });

  it("keeps the horizon up when tilted, whichever way it looks", () => {
    const { camera, controls, pivot } = pivotControls(2000);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    controls.enableDamping = false;
    controls._rotateUp(-THREE.MathUtils.degToRad(60));
    controls.update();
    for (let step = 0; step < 12; step++) {
      controls._rotateLeft(Math.PI / 6);
      controls.update();
      const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
        camera.quaternion
      );
      const vertical = controls.target.clone().normalize();
      const forward = forwardOf(camera);
      // the vertical's part across the view is screen-up, exactly
      const horizon = vertical.addScaledVector(forward, -vertical.dot(forward));
      expect(screenUp.angleTo(horizon)).toBeLessThan(1e-6);
    }
  });

  it.each([
    [37, -119.5],
    [70, 45],
    [0, 0],
    [-75, 0],
  ])("tilts from nadir without rolling the view (%f, %f)", (lat, lon) => {
    const { camera, controls, pivot } = pivotControls(2000);
    camera.position.copy(onSphere(lat, lon, 1 + 2000 / R));
    camera.lookAt(0, 0, 0);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    controls.enableDamping = false;
    // a tilt pitches the camera about its own right: that stays put
    const right = () =>
      new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const start = right();
    let previous = start;
    for (let degree = 0; degree < 30; degree++) {
      controls._rotateUp(-THREE.MathUtils.degToRad(1));
      controls.update();
      const now = right();
      expect(THREE.MathUtils.radToDeg(now.angleTo(previous))).toBeLessThan(0.5);
      previous = now;
    }
    expect(pivot.tilt()).toBeCloseTo(30, 3);
    expect(THREE.MathUtils.radToDeg(previous.angleTo(start))).toBeLessThan(1);
  });

  it("leaves onto the globe orbit above the pivot at its altitude", () => {
    const { camera, controls, pivot } = pivotControls(5000);
    const before = {
      minDistance: controls.minDistance,
      enablePan: controls.enablePan,
      up: camera.up.clone(),
      buttons: { ...controls.mouseButtons },
    };
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    controls.enableDamping = false;
    controls._pan(300, 0);
    controls._rotateUp(-1);
    controls.update();
    const pivotPoint = controls.target.clone();
    const altitude = camera.position.length() - 1;
    pivot.leave();
    expect(pivot.active).toBe(false);
    expect(controls.target.toArray()).toEqual([0, 0, 0]);
    expect(camera.position.length() - 1).toBeCloseTo(altitude, 9);
    expect(
      camera.position.clone().normalize().distanceTo(pivotPoint) * R
    ).toBeLessThan(1e-3);
    expect(camera.up.toArray()).toEqual(before.up.toArray());
    expect(controls.minDistance).toBe(before.minDistance);
    expect(controls.enablePan).toBe(before.enablePan);
    expect(controls.mouseButtons).toEqual(before.buttons);
    // the surface zoom is back in charge: a dolly scales the altitude
    controls._dollyIn(0.5);
    controls.update();
    expect(camera.position.length() - 1).toBeCloseTo(altitude * 0.5, 9);
  });

  it("leaves and enters without replaying a damped drag's tail", () => {
    const { camera, controls, pivot } = pivotControls(3000);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    // an orbit flick and a pan, one damped frame of them applied
    controls._rotateLeft(0.3);
    controls._pan(100, 0);
    controls.update();
    pivot.leave();
    const position = camera.position.clone();
    for (let frame = 0; frame < 100; frame++) {
      controls.update();
    }
    expect(camera.position.distanceTo(position) * R).toBeLessThan(1e-3);
    expect(controls.target.toArray()).toEqual([0, 0, 0]);
    // and a globe drag's tail is not replayed about the pivot
    controls._rotateLeft(0.3);
    controls.update();
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    const entered = camera.position.clone();
    for (let frame = 0; frame < 100; frame++) {
      controls.update();
    }
    expect(camera.position.distanceTo(entered) * R).toBeLessThan(1e-3);
  });

  it("gives up when something else moved the pivot off the sphere, and says so", () => {
    let dropped = 0;
    const { camera, controls, pivot } = pivotControls(2000, () => dropped++);
    pivot.enter(surfacePointNearRay(camera.position, forwardOf(camera)));
    controls.target.set(0, 0, 0);
    controls.update();
    expect(pivot.active).toBe(false);
    expect(dropped).toBe(1);
    expect(controls.enablePan).toBe(false);
    expect(camera.up.toArray()).toEqual([0, 0, 1]);
  });
});
