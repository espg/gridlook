import proj4 from "proj4";
import { Quaternion, Vector3 } from "three";

/**
 * The camera math that lets a drag carry the globe camera across a pole
 * and sets which way is up.
 *
 * OrbitControls keeps the camera's polar angle inside [0, π] of the frame
 * whose axis is `camera.up`, so with the globe's axis as up a drag stops at
 * a pole. useFreeOrbit instead keeps the frame on the camera's own
 * screen-up, where the camera always sits on the frame's equator: a
 * vertical drag turns the camera about its screen-right and crosses a
 * pole, keeping the roll it has, and a horizontal drag turns the camera
 * about the globe's axis, which moves it along a parallel and, over a
 * pole, spins the view about the pole. Neither is undone afterwards: the
 * roll is left alone while the pointer is down and anywhere within
 * POLE_CAP of a pole, where which way is up is the user's choice. Clear of
 * the poles, once the pointer is up, the roll settles a step per update on
 * the resting up: the grid's up for a projected dataset (gridUp), else
 * north or south up, whichever is nearer. The roll is not saved: the URL
 * holds the camera's position only, and a reload opens on the resting up.
 */

/** The globe's axis, +Z. */
export const POLE_AXIS = new Vector3(0, 0, 1);

/**
 * Within this angle of a pole, radians (15°), the roll is never settled:
 * which way is up over a pole is whatever the user turned it to.
 */
export const POLE_CAP = (15 * Math.PI) / 180;

/** The most the roll settles per update, radians. */
const ROLL_STEP = 0.05;

/** The world direction of the camera's screen-up, from its rotation. */
export function screenUp(quaternion: Quaternion, target = new Vector3()) {
  return target.set(0, 1, 0).applyQuaternion(quaternion);
}

/** The angle between `offset` and `axis`, radians. */
function polarAngle(offset: Vector3, axis: Vector3) {
  const cosine = offset.dot(axis) / (offset.length() * axis.length());
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

/** Whether `offset` is within `cap` of either end of `axis`. */
export function nearPole(offset: Vector3, cap = POLE_CAP, axis = POLE_AXIS) {
  const angle = polarAngle(offset, axis);
  return angle < cap || angle > Math.PI - cap;
}

/**
 * `up` turned towards `target` by at most `step` radians; the target
 * itself once within the step, so the roll comes to rest exactly on it.
 */
export function turnTowards(up: Vector3, target: Vector3, step: number) {
  const angle = up.angleTo(target);
  if (angle <= step) {
    return target.clone();
  }
  const pivot = new Vector3().crossVectors(up, target);
  if (pivot.lengthSq() < 1e-12) {
    // up is along the axis already (or opposite, caught above)
    return target.clone();
  }
  return up.clone().applyAxisAngle(pivot.normalize(), step).normalize();
}

/**
 * The world direction a projected grid's +y axis points at the pole: the
 * up of the map as printed. For a polar stereographic CRS it is the
 * central meridian seen from the pole (EPSG:3031: 0°E, the Antarctic
 * Peninsula to the upper left; EPSG:3413: 135°E, from the north pole, so
 * Greenland on 45°W stands upright). Undefined for any other CRS, which
 * keeps north up.
 */
export function gridUpOfCrs(crs: string): Vector3 | undefined {
  let projection: { names?: string[]; lat0?: number; long0?: number };
  try {
    projection = new proj4.Proj(crs) as typeof projection;
  } catch {
    return undefined;
  }
  const { lat0, long0 } = projection;
  if (
    !projection.names?.includes("stere") ||
    lat0 === undefined ||
    long0 === undefined ||
    Math.abs(Math.abs(lat0) - Math.PI / 2) > 1e-6
  ) {
    return undefined;
  }
  // +y runs away from the pole along the central meridian on a south polar
  // map and towards it (so away along the opposite meridian) on a north one
  const sign = lat0 < 0 ? 1 : -1;
  return new Vector3(sign * Math.cos(long0), sign * Math.sin(long0), 0);
}

/**
 * The screen-up a camera at `offset` from the globe's centre settles on, a
 * direction across the surface below it: the grid's up, where a dataset
 * has one and the camera is not looking along it; else the globe's axis,
 * north or south up, whichever the camera's roll (its rotation) is nearer.
 * The camera's own screen-up when neither crosses the surface there (a
 * camera right over a pole without a grid).
 */
export function restingUp(
  offset: Vector3,
  quaternion: Quaternion,
  gridUp?: Vector3,
  axis = POLE_AXIS
) {
  const direction = offset.clone().normalize();
  const across = (vector: Vector3) =>
    vector.clone().addScaledVector(direction, -vector.dot(direction));
  if (gridUp) {
    const tangent = across(gridUp);
    if (tangent.length() > 0.5) {
      return tangent.normalize();
    }
  }
  const southUp = screenUp(quaternion).dot(axis) < 0;
  const tangent = across(axis).multiplyScalar(southUp ? -1 : 1);
  return tangent.length() > 1e-9 ? tangent.normalize() : screenUp(quaternion);
}

export type TRollOptions = {
  /** The pointer is down: the roll is the user's. */
  dragging: boolean;
  /** An explicit reset: settle on the resting up even over a pole. */
  resetting?: boolean;
  gridUp?: Vector3;
  axis?: Vector3;
};

/**
 * The up vector for the next update of a globe camera whose screen-up is
 * `up` and which sits at `offset` from its target: left alone while the
 * user drags and within POLE_CAP of a pole, else turned a step towards the
 * resting up. Null once at rest on it, so callers know the roll is settled.
 */
export function settleRoll(
  up: Vector3,
  offset: Vector3,
  quaternion: Quaternion,
  options: TRollOptions
): Vector3 | null {
  const axis = options.axis ?? POLE_AXIS;
  if (
    !options.resetting &&
    (options.dragging || nearPole(offset, POLE_CAP, axis))
  ) {
    return up;
  }
  const target = restingUp(offset, quaternion, options.gridUp, axis);
  if (up.angleTo(target) < 1e-6) {
    return null;
  }
  return turnTowards(up, target, ROLL_STEP);
}
