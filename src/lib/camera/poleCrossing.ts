import { Quaternion, Vector3 } from "three";

/**
 * The camera math that lets a drag carry the globe camera across a pole.
 *
 * OrbitControls keeps the camera's polar angle inside [0, π] of the frame
 * whose axis is `camera.up`, so with the globe's axis as up a drag stops at
 * a pole. The frame is re-based on the camera's own screen-up just before
 * the drag would hit the pole, where the camera sits on the frame's equator
 * and can go on, and once the camera is away from the poles again the frame
 * is turned back to the globe's axis, or its opposite when that is nearer
 * the roll the crossing left, a step per frame so the roll settles without
 * a jump. The pure functions here are what useFreeOrbit applies.
 */

/** The globe's axis: the camera's up on the globe, +Z. */
export const POLE_AXIS = new Vector3(0, 0, 1);

/** The polar angle the frame keeps clear of its poles, radians (0.6°). */
const POLE_LIMIT = 0.01;

/**
 * How far from a pole the camera has to be, in radians (6°), before a
 * rolled frame is turned back to the globe's axis.
 */
const POLE_MARGIN = 0.1;

/** The most a rolled frame turns back per update, radians. */
const ROLL_STEP = 0.05;

/** The world direction of the camera's screen-up, from its rotation. */
export function screenUp(quaternion: Quaternion, target = new Vector3()) {
  return target.set(0, 1, 0).applyQuaternion(quaternion);
}

/** The polar angle of `offset` in the frame whose axis is `up`. */
function polarAngle(offset: Vector3, up: Vector3) {
  const cosine = offset.dot(up) / (offset.length() * up.length());
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

/**
 * Whether a change of `phiDelta` in the polar angle takes the camera, at
 * `offset` from its target, within `limit` of a pole of the frame whose
 * axis is `up`: where OrbitControls would clamp the move.
 */
export function crossesPole(
  offset: Vector3,
  up: Vector3,
  phiDelta: number,
  limit = POLE_LIMIT
) {
  const next = polarAngle(offset, up) + phiDelta;
  return next < limit || next > Math.PI - limit;
}

/**
 * `up` turned towards `target` by at most `step` radians; the target
 * itself once within the step, so the frame comes to rest exactly on it.
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
 * The up vector the control frame should use for the next update of a
 * globe camera at `offset` from its target, about to change its polar
 * angle by `phiDelta`: the camera's screen-up when the move would reach a
 * pole of the current frame; the frame turned back towards the globe's
 * axis, or its opposite when the screen's up points that way, when the
 * frame is rolled and the camera is clear of the poles; else the frame as
 * it is.
 */
export function nextFrameUp(
  up: Vector3,
  offset: Vector3,
  quaternion: Quaternion,
  phiDelta: number,
  axis = POLE_AXIS
) {
  if (crossesPole(offset, up, phiDelta)) {
    return screenUp(quaternion);
  }
  const onAxis = Math.abs(up.dot(axis)) > 1 - 1e-9;
  if (onAxis || crossesPole(offset, axis, 0, POLE_MARGIN)) {
    return up;
  }
  const southUp = screenUp(quaternion).dot(axis) < 0;
  return turnTowards(
    up,
    axis.clone().multiplyScalar(southUp ? -1 : 1),
    ROLL_STEP
  );
}
