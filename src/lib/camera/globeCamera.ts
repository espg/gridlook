import {
  Quaternion,
  Raycaster,
  Sphere,
  Vector3,
  type Camera,
  type PerspectiveCamera,
  type Vector2,
} from "three";

import { getVisibleVerticalSpan } from "./cameraSettings.ts";

/*
 * The globe camera is a rigid rotation about the globe's centre plus an
 * altitude: every move turns its position and its up vector together and
 * then looks at the centre. Nothing keeps north up.
 */

/** The point below a globe camera and which way up it is seen, in degrees. */
export type TGlobeView = {
  lat: number;
  lon: number;
  // compass direction of screen-up at that point, clockwise from north
  bearing: number;
};

const RADIANS = Math.PI / 180;
const CENTRE = new Vector3();
const GLOBE = new Sphere(CENTRE, 1);
const raycaster = new Raycaster();

/**
 * The directions north and east at a point of the globe (radians). At a
 * pole, where there are none, those of the meridian `lon` running into it:
 * that is what lets lat/lon/bearing describe every view.
 */
function northAndEast(lat: number, lon: number) {
  return {
    north: new Vector3(
      -Math.sin(lat) * Math.cos(lon),
      -Math.sin(lat) * Math.sin(lon),
      Math.cos(lat)
    ),
    east: new Vector3(-Math.sin(lon), Math.cos(lon), 0),
  };
}

function isAbovePole(camera: Camera) {
  const { x, y, z } = camera.position;
  return Math.hypot(x, y) <= 1e-9 * Math.abs(z);
}

export function getGlobeView(camera: Camera): TGlobeView {
  const { x, y, z } = camera.position;
  const lat = Math.atan2(z, Math.hypot(x, y));
  // Straight above a pole the position has no longitude, only rounding
  // noise. The view is then given as north up along the meridian it has up
  // the screen (down, above the north pole).
  const lon = isAbovePole(camera)
    ? Math.atan2(-Math.sign(z) * camera.up.y, -Math.sign(z) * camera.up.x)
    : Math.atan2(y, x);
  const { north, east } = northAndEast(lat, lon);
  const bearing = Math.atan2(camera.up.dot(east), camera.up.dot(north));
  return {
    lat: lat / RADIANS,
    lon: lon / RADIANS,
    bearing: (bearing / RADIANS + 360) % 360,
  };
}

/** Place the camera; what `view` leaves out stays as the camera has it. */
export function setGlobeView(
  camera: Camera,
  view: Partial<TGlobeView>,
  distance = camera.position.length()
) {
  const { lat, lon, bearing } = { ...getGlobeView(camera), ...view };
  const { north, east } = northAndEast(lat * RADIANS, lon * RADIANS);
  camera.position
    .set(
      Math.cos(lat * RADIANS) * Math.cos(lon * RADIANS),
      Math.cos(lat * RADIANS) * Math.sin(lon * RADIANS),
      Math.sin(lat * RADIANS)
    )
    .multiplyScalar(distance);
  camera.up
    .copy(north)
    .multiplyScalar(Math.cos(bearing * RADIANS))
    .addScaledVector(east, Math.sin(bearing * RADIANS));
  camera.lookAt(CENTRE);
}

/**
 * Turn the view about the point below the camera until north is up. Straight
 * above a pole every way up is north up; there the view is turned as maps of
 * the poles have it, the prime meridian down the screen at the north pole
 * and up it at the south.
 */
export function turnGlobeNorthUp(camera: Camera) {
  setGlobeView(
    camera,
    isAbovePole(camera) ? { lon: 0, bearing: 0 } : { bearing: 0 }
  );
}

/** A bearing as the URL and the compass give it: hundredths, in [0, 360). */
export function roundBearing(bearing: number) {
  return (Math.round(bearing * 100) / 100) % 360;
}

/** Turn the camera about the globe's centre. */
function turnGlobe(camera: Camera, turn: Quaternion) {
  camera.position.applyQuaternion(turn);
  camera.up.applyQuaternion(turn);
  camera.lookAt(CENTRE);
}

/** Turn the camera about `turn`, by its length in radians. */
export function turnGlobeBy(camera: Camera, turn: Vector3) {
  turnGlobe(
    camera,
    new Quaternion().setFromAxisAngle(turn.clone().normalize(), turn.length())
  );
}

/**
 * The turn, as `turnGlobeBy` takes it, between two camera quaternions: the
 * shorter way round, as a quaternion and its negative are the same rotation
 * and `lookAt` gives either.
 */
export function turnBetween(before: Quaternion, after: Quaternion) {
  const { x, y, z, w } = after.clone().multiply(before.clone().invert());
  const turn = new Vector3(x, y, z).multiplyScalar(w < 0 ? -1 : 1);
  const sine = turn.length();
  return turn.multiplyScalar(
    sine && (2 * Math.atan2(sine, Math.abs(w))) / sine
  );
}

/**
 * Turn the camera about the screen's axes: a positive angle about the one
 * to the right moves the camera down the screen, about the one up, to the
 * right.
 */
export function turnGlobeAboutScreen(
  camera: Camera,
  aboutRight: number,
  aboutUp: number
) {
  turnGlobeBy(
    camera,
    new Vector3(aboutRight, aboutUp, 0).applyQuaternion(camera.quaternion)
  );
}

/** The point of the globe under `cursor` (normalised device coordinates). */
export function globePointAt(camera: Camera, cursor: Vector2) {
  camera.updateMatrixWorld();
  raycaster.setFromCamera(cursor, camera);
  return (
    raycaster.ray.intersectSphere(GLOBE, new Vector3())?.normalize() ?? null
  );
}

/**
 * Turn the camera the shortest way that brings `point` of the globe under
 * `cursor`. False, and no turn, where the cursor is off the globe.
 */
export function holdGlobePoint(
  camera: Camera,
  point: Vector3,
  cursor: Vector2
) {
  const under = globePointAt(camera, cursor);
  if (under) {
    turnGlobe(camera, new Quaternion().setFromUnitVectors(under, point));
  }
  return under !== null;
}

/**
 * One pointer move of a drag, from `from` to `to`: `grabbed`, the point of
 * the globe taken hold of, stays under the pointer. With the pointer off the
 * globe the drag turns it as a grab in the middle of the view would, by at
 * most a full turn per height of the view, and lets go: the point the
 * pointer comes back onto is grabbed anew, so nothing jumps. Returns the
 * point held from here on.
 */
export function dragGlobe(
  camera: PerspectiveCamera,
  grabbed: Vector3 | null,
  from: Vector2,
  to: Vector2
) {
  if (grabbed && holdGlobePoint(camera, grabbed, to)) {
    return grabbed;
  }
  const under = globePointAt(camera, to);
  if (!under) {
    const turnPerHeight = Math.min(
      2 * Math.PI,
      getVisibleVerticalSpan(camera.position.length() - 1, camera.fov)
    );
    turnGlobeAboutScreen(
      camera,
      ((to.y - from.y) * turnPerHeight) / 2,
      ((from.x - to.x) * camera.aspect * turnPerHeight) / 2
    );
  }
  return under;
}

// ponytail: the glide after a drag decays per frame, not per second, as the
// damping of OrbitControls it replaces did (dampingFactor 0.08): it runs on
// faster on a slower display. The upgrade path is a decay over elapsed time.
const GLIDE_DAMPING = 0.08;
// The glide ends once a frame turns the globe by less than this share of the
// camera's altitude: about a hundredth of a pixel.
const GLIDE_REST = 1e-6;

/**
 * One frame of the momentum of a drag. `pending` is the turn still to come:
 * the turns of the drag are added to it, and every frame takes a share off
 * it. While the globe is `held` that share is dropped, as the drag already
 * moved the camera; once it is let go the camera is turned by it, until the
 * share is too small to see and `pending` is set to nothing. A drag at a
 * steady rate so glides on by 11.5 frames of it, as it did when OrbitControls
 * turned the globe with damping.
 */
export function glideGlobe(camera: Camera, pending: Vector3, held: boolean) {
  const turn = pending.clone().multiplyScalar(GLIDE_DAMPING);
  pending.sub(turn);
  if (held) {
    return;
  }
  if (turn.length() < (camera.position.length() - 1) * GLIDE_REST) {
    pending.set(0, 0, 0);
    return;
  }
  turnGlobeBy(camera, turn);
}
