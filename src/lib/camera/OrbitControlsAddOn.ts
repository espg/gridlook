import type { CustomOrbitControls, Quaternion, Vector3 } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { getGlobeMovementScale } from "./cameraSettings.ts";

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
    _rotateUp: (angle: number) => void;
    _rotateLeft: (angle: number) => void;
    _pan: (deltaX: number, deltaY: number) => void;
    _getZoomScale: (delta: number) => number;
    _dollyIn: (scale: number) => void;
    _dollyOut: (scale: number) => void;
    _scale: number;
    // the frame the spherical coordinates are taken in: `object.up` to +Y,
    // set once at construction
    _quat: Quaternion;
    _quatInverse: Quaternion;
    // the pan still to be applied, world space
    _panOffset: Vector3;
  }
}

const ZOOM_STEP = 96;
const KEYBOARD_ROTATION_SPEED = 0.025; // Radians per key press

export function useSurfaceZoom(
  controls: OrbitControls,
  isFlatProjection: () => boolean
) {
  const orbitControls = controls as CustomOrbitControls;
  const update = orbitControls.update.bind(orbitControls);
  orbitControls.update = (deltaTime) => {
    if (!isFlatProjection() && orbitControls._scale !== 1) {
      const distance = orbitControls.object.position.distanceTo(
        orbitControls.target
      );
      // Convert the pending wheel/pinch/keyboard dolly into altitude scaling.
      orbitControls._scale =
        (1 + (distance - 1) * orbitControls._scale) / distance;
    }
    return update(deltaTime);
  };
}

function getKeyboardRotationSpeed(
  orbitControls: CustomOrbitControls,
  isFlatProjection: boolean,
  step?: number
) {
  if (step !== undefined) {
    return step;
  }
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
  isFlatProjection: boolean,
  step?: number
) {
  if (isFlatProjection && orbitControls.enablePan) {
    orbitControls._pan(0, -orbitControls.keyPanSpeed);
  } else {
    orbitControls._rotateUp(
      getKeyboardRotationSpeed(orbitControls, isFlatProjection, step)
    );
  }
}

function handleArrowDown(
  orbitControls: CustomOrbitControls,
  isFlatProjection: boolean,
  step?: number
) {
  if (isFlatProjection && orbitControls.enablePan) {
    orbitControls._pan(0, orbitControls.keyPanSpeed);
  } else {
    orbitControls._rotateUp(
      -getKeyboardRotationSpeed(orbitControls, isFlatProjection, step)
    );
  }
}

function handleArrowLeft(
  orbitControls: CustomOrbitControls,
  isFlatProjection: boolean,
  step?: number
) {
  if (isFlatProjection && orbitControls.enablePan) {
    orbitControls._pan(-orbitControls.keyPanSpeed, 0);
  } else {
    orbitControls._rotateLeft(
      getKeyboardRotationSpeed(orbitControls, isFlatProjection, step)
    );
  }
}

function handleArrowRight(
  orbitControls: CustomOrbitControls,
  isFlatProjection: boolean,
  step?: number
) {
  if (isFlatProjection && orbitControls.enablePan) {
    orbitControls._pan(orbitControls.keyPanSpeed, 0);
  } else {
    orbitControls._rotateLeft(
      -getKeyboardRotationSpeed(orbitControls, isFlatProjection, step)
    );
  }
}

/**
 * The arrows rotate the globe, or pan a flat map, and +/- zoom. With
 * `rotationStep` (radians) the arrows rotate by that much instead, whatever
 * the distance: the point tier's pivot camera asks for it.
 */
export function handleKeyDown(
  event: KeyboardEvent,
  oC: OrbitControls,
  isFlatProjection: boolean,
  rotationStep?: number
) {
  const orbitControls = oC as CustomOrbitControls;
  switch (event.key) {
    case "ArrowUp":
      handleArrowUp(orbitControls, isFlatProjection, rotationStep);
      break;
    case "ArrowDown":
      handleArrowDown(orbitControls, isFlatProjection, rotationStep);
      break;
    case "ArrowLeft":
      handleArrowLeft(orbitControls, isFlatProjection, rotationStep);
      break;
    case "ArrowRight":
      handleArrowRight(orbitControls, isFlatProjection, rotationStep);
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
