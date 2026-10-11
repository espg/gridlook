import * as THREE from "three";
import type { CustomOrbitControls } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { EARTH_RADIUS_METERS } from "./cameraSettings.ts";

/**
 * The camera of the point tier: OrbitControls pivoting about a point of the
 * ground instead of the globe's centre (gridlook#21). While it is on:
 *
 * - `controls.target` is a point of the unit sphere, the pivot, and the
 *   camera's up is the local vertical there, so the polar angle is the tilt
 *   from nadir (0) to `POINT_PIVOT_MAX_TILT_DEGREES` and the azimuth turns
 *   about the vertical: the left button (one finger, the arrow keys) orbits
 *   the pivot that way;
 * - the right button (two fingers) pans: it moves the pivot in its tangent
 *   plane (`screenSpacePanning` off with a vertical up) and the pivot is put
 *   back on the sphere after every update, so a drag slides it along the
 *   surface; near nadir the roll is carried over from frame to frame rather
 *   than taken from the vertical;
 * - the wheel is handled here, not by OrbitControls: the camera dollies
 *   toward the ground point under the cursor, which therefore stays under
 *   the cursor, and the pivot becomes the ground point under the view
 *   centre again (`dollyTowardGround`);
 * - a dolly is a plain scaling of the distance to the pivot, so the surface
 *   zoom of the globe orbit (`useSurfaceZoom`) has to stand aside.
 *
 * Leaving puts the camera back on the globe orbit above the pivot at its
 * altitude: the ground under the view centre stays there, only the tilt and
 * the azimuth go.
 */

/** The farthest the camera tilts from nadir, degrees. */
export const POINT_PIVOT_MAX_TILT_DEGREES = 85;
/** The camera comes no closer than this to the pivot, metres. */
export const POINT_PIVOT_MIN_DISTANCE_METERS = 200;
/** The camera stays this far above the surface when zooming in, metres. */
export const POINT_PIVOT_MIN_ALTITUDE_METERS = 100;
/**
 * The near plane as a fraction of the camera's altitude above the sphere:
 * the cloud reaches from the sphere up to the camera, and the depth buffer
 * is not needed for the points themselves.
 */
const POINT_PIVOT_NEAR_FRACTION = 1 / 50;
/** A full-height drag turns this fraction of a turn about the pivot. */
const POINT_PIVOT_ROTATE_SPEED = 0.5;
/**
 * An arrow key turns or tilts this far about the pivot, radians: the globe
 * orbit's step scales with the distance to its target, which is nil here.
 */
export const POINT_PIVOT_KEY_STEP = 0.05;
/**
 * The roll: a tilted camera keeps the horizon up (its up is the local
 * vertical), but near nadir the vertical is nearly the view direction and
 * `lookAt` would set the roll from the azimuth of a tiny offset, turning the
 * view on every zoom toward the cursor. Below `ROLL_VERTICAL_FROM_DEGREES`
 * of tilt the previous frame's screen-up is kept instead, blended into the
 * vertical up to `ROLL_VERTICAL_TO_DEGREES`, so north stays up at nadir, as
 * on the globe orbit, and the roll never jumps.
 */
const ROLL_VERTICAL_FROM_DEGREES = 5;
const ROLL_VERTICAL_TO_DEGREES = 20;
/** A pivot this far from the sphere was moved by something else: give up. */
const PIVOT_OFF_SPHERE = 0.5;

const Y_UP = new THREE.Vector3(0, 1, 0);
const UNIT_SPHERE = new THREE.Sphere(new THREE.Vector3(), 1);

type TSavedControls = Pick<
  OrbitControls,
  | "minDistance"
  | "maxDistance"
  | "minPolarAngle"
  | "maxPolarAngle"
  | "enablePan"
  | "screenSpacePanning"
  | "enableZoom"
  | "rotateSpeed"
  | "mouseButtons"
  | "touches"
> & { up: THREE.Vector3 };

/** The camera's near plane on the pivot, at `altitude` above the sphere. */
export function pivotNearPlane(altitude: number) {
  return Math.max(altitude, 0) * POINT_PIVOT_NEAR_FRACTION;
}

/** Where a ray meets the unit sphere, nearest first; null when it misses. */
export function groundPointOnRay(
  origin: THREE.Vector3,
  direction: THREE.Vector3
): THREE.Vector3 | null {
  return new THREE.Ray(origin, direction).intersectSphere(
    UNIT_SPHERE,
    new THREE.Vector3()
  );
}

/**
 * The point of the surface a ray looks at: where it meets the sphere, else
 * the surface point under its closest approach to the centre.
 */
export function surfacePointNearRay(
  origin: THREE.Vector3,
  direction: THREE.Vector3
): THREE.Vector3 {
  return (
    groundPointOnRay(origin, direction) ??
    new THREE.Ray(origin, direction)
      .closestPointToPoint(UNIT_SPHERE.center, new THREE.Vector3())
      .normalize()
  );
}

/**
 * The camera after a dolly toward `ground`, the point of the surface under
 * the cursor: its distance to the ground point scales by `scale` (below 1
 * zooms in) along the line between them, so the ground point stays under
 * the cursor, and the pivot becomes the surface point under the view centre
 * (the `forward` ray from the new position). Zooming in stops at
 * `minAltitude` above the surface, in scene units; null when the camera is
 * already there.
 */
export function dollyTowardGround(
  position: THREE.Vector3,
  forward: THREE.Vector3,
  ground: THREE.Vector3,
  scale: number,
  minAltitude = POINT_PIVOT_MIN_ALTITUDE_METERS / EARTH_RADIUS_METERS
): { position: THREE.Vector3; target: THREE.Vector3 } | null {
  const toCamera = position.clone().sub(ground);
  const floor = 1 + minAltitude;
  let step = scale;
  if (scale < 1) {
    if (position.length() <= floor) {
      return null;
    }
    const next = ground.clone().addScaledVector(toCamera, scale);
    if (next.length() < floor) {
      // |ground + toCamera · s| = floor: the larger root is the one in (0, 1)
      const a = toCamera.lengthSq();
      const b = 2 * ground.dot(toCamera);
      const c = ground.lengthSq() - floor * floor;
      step = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
    }
  }
  const next = ground.clone().addScaledVector(toCamera, step);
  return { position: next, target: surfacePointNearRay(next, forward) };
}

/**
 * The dolly scale of a wheel event, as OrbitControls reads one: 0.95 to the
 * hundredth of the delta, lines and pages scaled to pixels, a trackpad
 * pinch (ctrl) ten times; below 1 for a turn toward the screen.
 */
export function wheelDollyScale(
  event: Pick<WheelEvent, "deltaY" | "deltaMode" | "ctrlKey">,
  zoomSpeed = 1
) {
  let delta = event.deltaY;
  if (event.deltaMode === 1) {
    delta *= 16;
  } else if (event.deltaMode === 2) {
    delta *= 100;
  }
  if (event.ctrlKey) {
    delta *= 10;
  }
  const step = 0.95 ** (zoomSpeed * Math.abs(delta) * 0.01);
  return delta < 0 ? step : 1 / step;
}

export type TPointPivot = ReturnType<typeof createPointPivot>;

/**
 * Wrap `controls` (as `useSurfaceZoom` does) with the local-pivot
 * behaviour, switched by `enter` and `leave`. Wrap before `useSurfaceZoom`,
 * whose predicate has to include `active`.
 */
// eslint-disable-next-line max-lines-per-function
export function createPointPivot(controls: OrbitControls) {
  const orbit = controls as CustomOrbitControls;
  const camera = orbit.object as THREE.PerspectiveCamera;
  const update = orbit.update.bind(orbit);
  let active = false;
  let saved: TSavedControls | undefined;

  /** The spherical frame follows the pivot's vertical. */
  function alignToPivot() {
    if (Math.abs(orbit.target.length() - 1) > PIVOT_OFF_SPHERE) {
      drop();
      return;
    }
    orbit.target.normalize();
    camera.up.copy(orbit.target);
    orbit._quat.setFromUnitVectors(camera.up, Y_UP);
    orbit._quatInverse.copy(orbit._quat).invert();
    // a damped pan carries steps taken in earlier tangent planes: keep only
    // what is tangent here, so neither the pivot nor the camera drifts
    // radially
    const offset = orbit._panOffset;
    offset.addScaledVector(orbit.target, -offset.dot(orbit.target));
  }

  /** Re-aim at the pivot with the roll blended from `screenUp` to the vertical. */
  function settleRoll(screenUp: THREE.Vector3) {
    const vertical = orbit.target;
    const tilt = THREE.MathUtils.radToDeg(
      camera.position.clone().sub(vertical).angleTo(vertical)
    );
    const weight = THREE.MathUtils.clamp(
      (tilt - ROLL_VERTICAL_FROM_DEGREES) /
        (ROLL_VERTICAL_TO_DEGREES - ROLL_VERTICAL_FROM_DEGREES),
      0,
      1
    );
    camera.up
      .copy(screenUp)
      .multiplyScalar(1 - weight)
      .addScaledVector(vertical, weight)
      .normalize();
    camera.lookAt(vertical);
    // OrbitControls pans along `up`: it stays the vertical
    camera.up.copy(vertical);
  }

  orbit.update = (deltaTime) => {
    if (!active) {
      return update(deltaTime);
    }
    alignToPivot();
    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
      camera.quaternion
    );
    const changed = update(deltaTime);
    if (active) {
      // a pan is tangent to the surface: put the pivot back on it
      orbit.target.normalize();
      settleRoll(screenUp);
    }
    return changed;
  };

  /** Restore the globe orbit's settings, leaving the camera where it is. */
  function drop() {
    if (!saved) {
      return;
    }
    active = false;
    const { up, ...settings } = saved;
    Object.assign(orbit, settings);
    camera.up.copy(up);
    orbit._quat.setFromUnitVectors(camera.up, Y_UP);
    orbit._quatInverse.copy(orbit._quat).invert();
    saved = undefined;
  }

  function enter(ground: THREE.Vector3) {
    if (active) {
      return;
    }
    saved = {
      minDistance: orbit.minDistance,
      maxDistance: orbit.maxDistance,
      minPolarAngle: orbit.minPolarAngle,
      maxPolarAngle: orbit.maxPolarAngle,
      enablePan: orbit.enablePan,
      screenSpacePanning: orbit.screenSpacePanning,
      enableZoom: orbit.enableZoom,
      rotateSpeed: orbit.rotateSpeed,
      mouseButtons: { ...orbit.mouseButtons },
      touches: { ...orbit.touches },
      up: camera.up.clone(),
    };
    orbit.target.copy(ground).normalize();
    orbit.minPolarAngle = 0;
    orbit.maxPolarAngle = THREE.MathUtils.degToRad(
      POINT_PIVOT_MAX_TILT_DEGREES
    );
    orbit.minDistance = POINT_PIVOT_MIN_DISTANCE_METERS / EARTH_RADIUS_METERS;
    orbit.maxDistance = Infinity;
    orbit.enablePan = true;
    orbit.screenSpacePanning = false;
    orbit.enableZoom = false;
    orbit.rotateSpeed = POINT_PIVOT_ROTATE_SPEED;
    orbit.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    active = true;
    orbit.update();
  }

  function leave() {
    if (!active) {
      return;
    }
    // above the pivot at the camera's altitude, looking at the centre
    const radius = camera.position.length();
    camera.position.copy(orbit.target).normalize().multiplyScalar(radius);
    drop();
    orbit.target.set(0, 0, 0);
    camera.lookAt(orbit.target);
    orbit.update();
  }

  /** Dolly by `scale` toward the ground under the cursor (NDC). */
  function zoom(scale: number, cursor: THREE.Vector2) {
    if (!active) {
      return;
    }
    // the world matrix may lag the orientation `lookAt` set last frame
    camera.updateMatrixWorld();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(cursor, camera);
    const ground =
      groundPointOnRay(raycaster.ray.origin, raycaster.ray.direction) ??
      orbit.target.clone();
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const next = dollyTowardGround(camera.position, forward, ground, scale);
    if (!next) {
      return;
    }
    camera.position.copy(next.position);
    orbit.target.copy(next.target);
    orbit.update();
  }

  return {
    enter,
    leave,
    zoom,
    get active() {
      return active;
    },
    /** The camera's distance to the pivot, scene units. */
    pivotDistance: () => camera.position.distanceTo(orbit.target),
  };
}
