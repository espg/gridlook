import {
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  type CustomOrbitControls,
  type Quaternion,
} from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { getGlobeMovementScale } from "./cameraSettings.ts";
import {
  globePointAt,
  holdGlobePoint,
  turnGlobeAboutScreen,
} from "./globeCamera.ts";

/*
 * The regular OrbitControls type defintion does not include the "private" methods
 * of OrbitControls.
 * The default-behaviour of the OrbitControls keyboardListener moves the earth
 * instead of rotating it, which is not what we want.
 *
 * We declare a custom OrbitControls which expose the rotation-methods write our
 * own keyboardListener
 *
 * Keep in mind that we are using the internal API of OrbitControls here which might change
 * in the future.
 */
declare module "three" {
  interface CustomOrbitControls extends OrbitControls {
    domElement: HTMLElement;
    _pan: (deltaX: number, deltaY: number) => void;
    _getZoomScale: (delta: number) => number;
    _dollyIn: (scale: number) => void;
    _dollyOut: (scale: number) => void;
    _handleMouseWheel: (event: {
      clientX: number;
      clientY: number;
      deltaY: number;
    }) => void;
    _scale: number;
    state: number;
    _quat: Quaternion;
    _quatInverse: Quaternion;
  }
}

const ZOOM_STEP = 96;
const KEYBOARD_ROTATION_SPEED = 0.025; // Radians per key press

const FLAT_MAP = new Plane(new Vector3(0, 0, 1), 0);
// The pole of the frame OrbitControls works in, which it turns the up vector
// the camera has at construction onto.
const ORBIT_POLE = new Vector3(0, 1, 0);
const raycaster = new Raycaster();

/** The point of the flat map's plane under `cursor`. */
function mapPointAt(camera: CustomOrbitControls["object"], cursor: Vector2) {
  camera.updateMatrixWorld();
  raycaster.setFromCamera(cursor, camera);
  return raycaster.ray.intersectPlane(FLAT_MAP, new Vector3());
}

/**
 * After a dolly from `distanceBefore`, move the camera so that the surface
 * point that was under `cursor` is under it again: the shortest turn about
 * the globe's centre, a pan of camera and target on a flat map. The distance
 * to the target, so the altitude, is left as the dolly set it. Without a
 * surface point under the cursor, before or after, the camera is left where
 * the dolly put it (zoom towards the centre of the view).
 */
function anchorZoom(
  orbitControls: CustomOrbitControls,
  cursor: Vector2,
  isFlat: boolean,
  distanceBefore: number
) {
  const { object: camera, target } = orbitControls;
  const pointAt = isFlat ? mapPointAt : globePointAt;
  const dollied = camera.position.clone();
  // Where the cursor pointed before the dolly: the same line of sight at
  // the old distance.
  camera.position.sub(target).setLength(distanceBefore).add(target);
  const anchor = pointAt(camera, cursor);
  camera.position.copy(dollied);
  if (!anchor) {
    return;
  }
  if (!isFlat) {
    holdGlobePoint(camera, anchor, cursor);
    return;
  }
  const moved = pointAt(camera, cursor);
  if (moved) {
    const shift = anchor.sub(moved);
    camera.position.add(shift);
    target.add(shift);
  }
}

/** Whether OrbitControls is in the middle of a drag or a pinch of its own. */
export function isOrbitControlsBusy(controls: OrbitControls) {
  return (controls as CustomOrbitControls).state !== -1;
}

export function useSurfaceZoom(
  controls: OrbitControls,
  isFlatProjection: () => boolean
) {
  const orbitControls = controls as CustomOrbitControls;
  const update = orbitControls.update.bind(orbitControls);
  const flatFrame = orbitControls._quat.clone();
  // The wheel event's pointer, set only while that event's dolly is applied:
  // keyboard and pinch zoom have none and zoom towards the centre.
  let cursor: Vector2 | undefined = undefined;
  const handleMouseWheel = orbitControls._handleMouseWheel.bind(orbitControls);
  orbitControls._handleMouseWheel = (event) => {
    const rect = orbitControls.domElement.getBoundingClientRect();
    cursor = new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    handleMouseWheel(event);
    cursor = undefined;
  };
  orbitControls.update = (deltaTime) => {
    const isFlat = isFlatProjection();
    const distance = orbitControls.object.position.distanceTo(
      orbitControls.target
    );
    // OrbitControls keeps the camera off the poles of its frame. The globe
    // camera turns freely, so there the frame follows the camera's up
    // vector, which has the camera on its equator.
    if (isFlat) {
      orbitControls._quat.copy(flatFrame);
    } else {
      orbitControls._quat.setFromUnitVectors(
        orbitControls.object.up,
        ORBIT_POLE
      );
    }
    orbitControls._quatInverse.copy(orbitControls._quat).invert();
    if (!isFlat && orbitControls._scale !== 1) {
      // Convert the pending wheel/pinch/keyboard dolly into altitude scaling.
      orbitControls._scale =
        (1 + (distance - 1) * orbitControls._scale) / distance;
    }
    const updated = update(deltaTime);
    if (cursor) {
      anchorZoom(orbitControls, cursor, isFlat, distance);
    }
    return updated;
  };
}

function getKeyboardRotationSpeed(
  orbitControls: CustomOrbitControls,
  isFlatProjection: boolean
) {
  const distance = orbitControls.object.position.distanceTo(
    orbitControls.target
  );
  const movementScale = getGlobeMovementScale(distance);
  // Fine arrow steps at low altitude, blending back to full speed farther out.
  const keyboardScale = movementScale * (0.1 + 0.9 * movementScale ** 2);
  return KEYBOARD_ROTATION_SPEED * (isFlatProjection ? 1 : keyboardScale);
}

function handleArrowUp(
  orbitControls: CustomOrbitControls,
  isFlatProjection: boolean
) {
  if (isFlatProjection && orbitControls.enablePan) {
    orbitControls._pan(0, -orbitControls.keyPanSpeed);
  } else {
    turnGlobeAboutScreen(
      orbitControls.object,
      -getKeyboardRotationSpeed(orbitControls, isFlatProjection),
      0
    );
  }
}

function handleArrowDown(
  orbitControls: CustomOrbitControls,
  isFlatProjection: boolean
) {
  if (isFlatProjection && orbitControls.enablePan) {
    orbitControls._pan(0, orbitControls.keyPanSpeed);
  } else {
    turnGlobeAboutScreen(
      orbitControls.object,
      getKeyboardRotationSpeed(orbitControls, isFlatProjection),
      0
    );
  }
}

function handleArrowLeft(
  orbitControls: CustomOrbitControls,
  isFlatProjection: boolean
) {
  if (isFlatProjection && orbitControls.enablePan) {
    orbitControls._pan(-orbitControls.keyPanSpeed, 0);
  } else {
    turnGlobeAboutScreen(
      orbitControls.object,
      0,
      -getKeyboardRotationSpeed(orbitControls, isFlatProjection)
    );
  }
}

function handleArrowRight(
  orbitControls: CustomOrbitControls,
  isFlatProjection: boolean
) {
  if (isFlatProjection && orbitControls.enablePan) {
    orbitControls._pan(orbitControls.keyPanSpeed, 0);
  } else {
    turnGlobeAboutScreen(
      orbitControls.object,
      0,
      getKeyboardRotationSpeed(orbitControls, isFlatProjection)
    );
  }
}

export function handleKeyDown(
  event: KeyboardEvent,
  oC: OrbitControls,
  isFlatProjection: boolean
) {
  const orbitControls = oC as CustomOrbitControls;
  switch (event.key) {
    case "ArrowUp":
      handleArrowUp(orbitControls, isFlatProjection);
      break;
    case "ArrowDown":
      handleArrowDown(orbitControls, isFlatProjection);
      break;
    case "ArrowLeft":
      handleArrowLeft(orbitControls, isFlatProjection);
      break;
    case "ArrowRight":
      handleArrowRight(orbitControls, isFlatProjection);
      break;
    case "+":
      orbitControls._dollyIn(orbitControls._getZoomScale(-ZOOM_STEP));
      break;
    case "-":
      orbitControls._dollyOut(orbitControls._getZoomScale(ZOOM_STEP));
      break;
  }

  event.preventDefault();
}
