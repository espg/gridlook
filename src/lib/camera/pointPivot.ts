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
 *   about the vertical: the right button, shift + left and two fingers
 *   orbit the pivot that way (espg's ruling, gridlook#25); `tiltTo`
 *   animates the tilt to a given angle, the Top and Oblique buttons,
 *   keeping the azimuth, the pivot and the distance;
 * - the pivot is lifted off the sphere by `setHeight`, to the cloud's
 *   mid-height, so that an orbit turns about the cloud and an oblique
 *   view centres it rather than the ground; the lifted pivot keeps its
 *   place on the sphere's vertical and the camera moves with it, so the
 *   view keeps its tilt, azimuth and distance as the lift changes;
 * - the left button (one finger, the arrow keys) pans: it moves the pivot
 *   in its tangent plane (`screenSpacePanning` off with a vertical up) and
 *   the pivot is put back on the sphere after every update, so a drag
 *   slides it along the ground; near nadir the roll is carried over from
 *   frame to frame rather than taken from the vertical. `setLeftDrag` makes
 *   the left button (one finger) orbit instead; shift + left and the right
 *   button orbit either way (OrbitControls reads shift on a pan button as
 *   an orbit, so a shift press in orbit mode is shown a pan button);
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
/** What a plain left drag (one finger) does. */
export const POINT_PIVOT_LEFT_DRAGS = { PAN: "pan", ORBIT: "orbit" } as const;
export type TPivotLeftDrag =
  (typeof POINT_PIVOT_LEFT_DRAGS)[keyof typeof POINT_PIVOT_LEFT_DRAGS];
/**
 * The tilts the view buttons animate to, degrees from nadir: the oblique
 * view at 60° (espg's ruling on gridlook#25: a side view pulls in a huge
 * window from the perspective shift).
 */
export const POINT_PIVOT_TILTS = { TOP: 0, OBLIQUE: 60 } as const;
/** Seconds a view button's tilt animation takes. */
const TILT_ANIMATION_SECONDS = 0.6;
/** The camera comes no closer than this to the pivot, metres. */
export const POINT_PIVOT_MIN_DISTANCE_METERS = 200;
/** The camera stays this far above the surface when zooming in, metres. */
export const POINT_PIVOT_MIN_ALTITUDE_METERS = 100;
/**
 * The near plane as a fraction of the camera's altitude above the sphere:
 * the cloud reaches from the sphere up to the camera, and the depth buffer
 * is not needed for the points themselves. A camera tilted far at a short
 * distance can be below the altitude floor: its near plane is taken there.
 */
const POINT_PIVOT_NEAR_FRACTION = 1 / 50;
/** A full-height drag turns this fraction of a turn about the pivot. */
const POINT_PIVOT_ROTATE_SPEED = 0.5;
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
/**
 * At nadir the azimuth is meaningless, yet it is the way a drag tilts the
 * camera: within this many degrees of nadir it is put behind the bottom of
 * the screen, so a tilt from nadir leans the view the way it faces, the
 * horizon comes up where the carried screen-up is, and the roll blend has
 * nothing to turn.
 */
const NADIR_DEGREES = 0.1;
/** The tilt a camera at nadir is given to carry an azimuth, radians. */
const NADIR_LEAN = 1e-6;
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

/** The view's height at `distance` from the camera, for a vertical field of view in degrees. */
export function viewHeightAt(distance: number, fovDegrees: number) {
  return 2 * distance * Math.tan(THREE.MathUtils.degToRad(fovDegrees / 2));
}

/** The camera's near plane on the pivot, at `altitude` above the sphere. */
export function pivotNearPlane(
  altitude: number,
  minAltitude = POINT_PIVOT_MIN_ALTITUDE_METERS / EARTH_RADIUS_METERS
) {
  return Math.max(altitude, minAltitude) * POINT_PIVOT_NEAR_FRACTION;
}

/**
 * Where a ray meets the sphere of `radius` (the unit sphere, the ground),
 * nearest first; null when it misses.
 */
export function groundPointOnRay(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  radius = 1
): THREE.Vector3 | null {
  return new THREE.Ray(origin, direction).intersectSphere(
    radius === 1 ? UNIT_SPHERE : new THREE.Sphere(UNIT_SPHERE.center, radius),
    new THREE.Vector3()
  );
}

/**
 * The point of the sphere of `radius` a ray looks at: where it meets it,
 * else the point under its closest approach to the centre.
 */
export function surfacePointNearRay(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  radius = 1
): THREE.Vector3 {
  return (
    groundPointOnRay(origin, direction, radius) ??
    new THREE.Ray(origin, direction)
      .closestPointToPoint(UNIT_SPHERE.center, new THREE.Vector3())
      .setLength(radius)
  );
}

/**
 * The camera after a dolly toward `ground`, the point of the surface under
 * the cursor: its distance to the ground point scales by `scale` (below 1
 * zooms in) along the line between them, so the ground point stays under
 * the cursor, and the pivot becomes the surface point under the view centre
 * (the `forward` ray from the new position, on the sphere of
 * `pivotRadius`). Zooming in stops at `minAltitude` above the surface, in
 * scene units, and a camera already below that (tilted far at a short
 * distance) stops `minDistance` short of the ground point instead; null
 * when the camera is already there.
 */
export function dollyTowardGround(
  position: THREE.Vector3,
  forward: THREE.Vector3,
  ground: THREE.Vector3,
  scale: number,
  minAltitude = POINT_PIVOT_MIN_ALTITUDE_METERS / EARTH_RADIUS_METERS,
  minDistance = POINT_PIVOT_MIN_DISTANCE_METERS / EARTH_RADIUS_METERS,
  pivotRadius = 1
): { position: THREE.Vector3; target: THREE.Vector3 } | null {
  const toCamera = position.clone().sub(ground);
  const floor = 1 + minAltitude;
  let step = scale;
  if (scale < 1) {
    if (position.length() <= floor) {
      const distance = toCamera.length();
      if (distance - minDistance < 1e-12) {
        return null;
      }
      step = Math.max(scale, minDistance / distance);
    }
    const next = ground.clone().addScaledVector(toCamera, step);
    if (position.length() > floor && next.length() < floor) {
      // |ground + toCamera · s| = floor: the larger root is the one in (0, 1)
      const a = toCamera.lengthSq();
      const b = 2 * ground.dot(toCamera);
      const c = ground.lengthSq() - floor * floor;
      step = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
    }
  }
  const next = ground.clone().addScaledVector(toCamera, step);
  return {
    position: next,
    target: surfacePointNearRay(next, forward, pivotRadius),
  };
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
  // the pivot's height above the sphere, scene units
  let height = 0;
  let leftDrag: TPivotLeftDrag = POINT_PIVOT_LEFT_DRAGS.PAN;

  /** The left button as OrbitControls should read it under `shift`. */
  function leftButton(shift: boolean) {
    return leftDrag === POINT_PIVOT_LEFT_DRAGS.ORBIT && !shift
      ? THREE.MOUSE.ROTATE
      : THREE.MOUSE.PAN;
  }

  function applyLeftDrag(shift = false) {
    orbit.mouseButtons.LEFT = leftButton(shift);
    orbit.touches.ONE =
      leftDrag === POINT_PIVOT_LEFT_DRAGS.ORBIT
        ? THREE.TOUCH.ROTATE
        : THREE.TOUCH.PAN;
  }

  // before OrbitControls' own listener: the button it is about to read
  const onPointerDown = (event: PointerEvent) => {
    if (active && event.button === 0) {
      applyLeftDrag(event.shiftKey);
    }
  };
  orbit.domElement.addEventListener("pointerdown", onPointerDown, true);

  /** Set what a plain left drag does; shift + left and the right button orbit either way. */
  function setLeftDrag(mode: TPivotLeftDrag) {
    leftDrag = mode;
    if (active) {
      applyLeftDrag();
    }
  }

  function vertical() {
    return orbit.target.clone().normalize();
  }

  /** The pivot back at its height on the sphere's vertical. */
  function settlePivot() {
    orbit.target.setLength(1 + height);
  }

  /** The spherical frame follows the pivot's vertical. */
  function alignToPivot() {
    if (Math.abs(orbit.target.length() - 1) > PIVOT_OFF_SPHERE) {
      drop();
      return;
    }
    settlePivot();
    camera.up.copy(vertical());
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
    const up = vertical();
    const tilt = THREE.MathUtils.radToDeg(
      camera.position.clone().sub(orbit.target).angleTo(up)
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
      .addScaledVector(up, weight)
      .normalize();
    camera.lookAt(orbit.target);
    // OrbitControls pans along `up`: it stays the vertical
    camera.up.copy(up);
  }

  /** The camera's tilt from nadir, degrees. */
  function tilt() {
    return THREE.MathUtils.radToDeg(
      camera.position.clone().sub(orbit.target).angleTo(orbit.target)
    );
  }

  /**
   * The direction along the ground the camera lies in from the pivot, its
   * azimuth; at nadir, where there is none, behind the bottom of the
   * screen, so an oblique view keeps looking the way the view faces.
   */
  function azimuthDirection() {
    const up = vertical();
    const along = camera.position.clone().sub(orbit.target);
    along.addScaledVector(up, -along.dot(up));
    if (along.lengthSq() < 1e-18) {
      along.set(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(-1);
      along.addScaledVector(up, -along.dot(up));
    }
    return along.normalize();
  }

  /** The camera `distance` from the pivot, `radians` from nadir toward `along`. */
  function place(radians: number, distance: number, along: THREE.Vector3) {
    camera.position
      .copy(orbit.target)
      .addScaledVector(vertical(), distance * Math.cos(radians))
      .addScaledVector(along, distance * Math.sin(radians));
  }

  /** Put the camera `distance` from the pivot at `degrees` from nadir, keeping the azimuth. */
  function setTilt(degrees: number, distance: number) {
    const radians = THREE.MathUtils.degToRad(
      THREE.MathUtils.clamp(degrees, 0, POINT_PIVOT_MAX_TILT_DEGREES)
    );
    place(radians, distance, azimuthDirection());
    orbit.update();
  }

  /** At nadir, the azimuth behind the bottom of the screen (`screenUp`). */
  function faceNadir(screenUp: THREE.Vector3) {
    const offset = camera.position.clone().sub(orbit.target);
    const up = vertical();
    const radians = offset.angleTo(up);
    const along = screenUp.clone().negate();
    along.addScaledVector(up, -along.dot(up));
    if (
      radians >= THREE.MathUtils.degToRad(NADIR_DEGREES) ||
      along.lengthSq() < 1e-18
    ) {
      return;
    }
    place(Math.max(radians, NADIR_LEAN), offset.length(), along.normalize());
  }

  /**
   * An animation of the tilt to `degrees` over `seconds`, eased in and out:
   * `advance(dt)` moves it and is true while it has further to go.
   */
  function tiltTo(degrees: number, seconds = TILT_ANIMATION_SECONDS) {
    const from = tilt();
    const distance = pivotDistance();
    let elapsed = 0;
    return {
      advance(deltaSeconds: number) {
        if (!active) {
          return false;
        }
        elapsed += deltaSeconds;
        const s = Math.min(elapsed / seconds, 1);
        setTilt(from + (degrees - from) * s * s * (3 - 2 * s), distance);
        return s < 1;
      },
    };
  }

  /**
   * Lift the pivot `above` the sphere (scene units): the cloud's mid-height.
   * The camera rises with it, so the view keeps its tilt, azimuth and
   * distance and does not turn as the lift changes.
   */
  function setHeight(above: number) {
    const rise = Math.max(above, 0) - height;
    height += rise;
    if (active) {
      camera.position.addScaledVector(vertical(), rise);
      settlePivot();
      orbit.update();
    }
  }

  function pivotDistance() {
    return camera.position.distanceTo(orbit.target);
  }

  /**
   * Ground metres a pixel spans at the pivot's depth, on a view `heightPx`
   * tall: the scale the view is read at, whatever the tilt (tilted, the
   * ground below the camera leaves the view).
   */
  function metersPerPixel(heightPx: number) {
    return (
      (viewHeightAt(pivotDistance(), camera.fov) * EARTH_RADIUS_METERS) /
      heightPx
    );
  }

  orbit.update = (deltaTime) => {
    if (!active) {
      return update(deltaTime);
    }
    alignToPivot();
    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
      camera.quaternion
    );
    if (active) {
      faceNadir(screenUp);
    }
    const changed = update(deltaTime);
    if (active) {
      // a pan is tangent to the surface: put the pivot back on it
      settlePivot();
      settleRoll(screenUp);
    }
    return changed;
  };

  /**
   * Forget the motion a damped drag still has to apply: it was taken in the
   * other camera's frame (an orbit about the pivot is not one about the
   * globe's centre, a pan of the pivot moves the globe's target).
   */
  function stopMotion() {
    orbit._sphericalDelta.set(0, 0, 0);
    orbit._panOffset.set(0, 0, 0);
    orbit._scale = 1;
  }

  /** Restore the globe orbit's settings, leaving the camera where it is. */
  function drop() {
    if (!saved) {
      return;
    }
    active = false;
    stopMotion();
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
    height = 0;
    stopMotion();
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
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    orbit.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    applyLeftDrag();
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
      vertical();
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const next = dollyTowardGround(
      camera.position,
      forward,
      ground,
      scale,
      undefined,
      undefined,
      1 + height
    );
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
    tilt,
    tiltTo,
    setHeight,
    setLeftDrag,
    get active() {
      return active;
    },
    /** The camera's distance to the pivot, scene units. */
    pivotDistance,
    metersPerPixel,
  };
}
