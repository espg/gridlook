import { Quaternion, Vector3, type CustomOrbitControls } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { getGlobeMovementScale } from "./cameraSettings.ts";
import { POLE_AXIS, screenUp, settleRoll } from "./poleCrossing.ts";

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
    _sphericalDelta: { theta: number; phi: number };
    _getAutoRotationAngle: (deltaTime: number | null) => number;
    // -1 while no pointer is down (OrbitControls' _STATE.NONE)
    state: number;
    // the rotation from `object.up` to +Y, built once from the up vector
    // the controls were constructed with
    _quat: Quaternion;
    _quatInverse: Quaternion;
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

export type TFreeOrbitOptions = {
  isFlatProjection: () => boolean;
  /** The up of a projected dataset's grid (see gridUpOfCrs), when it has one. */
  getGridUp?: () => Vector3 | undefined;
};

/**
 * Let a drag carry the globe camera across a pole and settle its roll (see
 * poleCrossing.ts). The controls' frame is kept on the camera's screen-up,
 * so their polar angle is always π/2 and never clamps: a vertical drag
 * crosses a pole and keeps the roll. The horizontal part of a drag (and
 * the keyboard's, and auto-rotation) is taken out of the controls and
 * applied here as a turn of the camera and its up about the globe's axis,
 * along a parallel or, over a pole, about the pole. After each update the
 * frame is read back from the camera's rotation, so the roll is whatever
 * the moves left, until it settles. Not while the controls are disabled (a
 * presenter display), where the camera is set from outside and keeps the
 * roll it is given.
 */
// eslint-disable-next-line max-lines-per-function
export function useFreeOrbit(
  controls: OrbitControls,
  options: TFreeOrbitOptions
) {
  const orbitControls = controls as CustomOrbitControls;
  const update = orbitControls.update.bind(orbitControls);
  const frameUp = new Vector3();
  const offset = new Vector3();
  let resetting = false;

  function syncFrame(up: Vector3) {
    if (!frameUp.equals(up)) {
      frameUp.copy(up);
      orbitControls._quat.setFromUnitVectors(frameUp, new Vector3(0, 1, 0));
      orbitControls._quatInverse.copy(orbitControls._quat).invert();
    }
  }

  /** Turn the camera and its up about the globe's axis by the pending azimuth. */
  function applyAzimuth(deltaTime: number | null) {
    const camera = orbitControls.object;
    const damping = orbitControls.enableDamping
      ? orbitControls.dampingFactor
      : 1;
    let pending = orbitControls._sphericalDelta.theta;
    if (orbitControls.autoRotate && orbitControls.state === -1) {
      pending += orbitControls._getAutoRotationAngle(deltaTime) * -1;
    }
    const applied = pending * damping;
    orbitControls._sphericalDelta.theta = pending - applied;
    if (applied === 0) {
      return;
    }
    offset.copy(camera.position).sub(orbitControls.target);
    offset.applyAxisAngle(POLE_AXIS, applied);
    camera.position.copy(orbitControls.target).add(offset);
    camera.up.applyAxisAngle(POLE_AXIS, applied);
  }

  orbitControls.update = (deltaTime = null) => {
    const camera = orbitControls.object;
    if (options.isFlatProjection() || !orbitControls.enabled) {
      syncFrame(camera.up);
      return update(deltaTime);
    }
    // the frame on the screen-up the last update left, as the roll to keep
    screenUp(camera.quaternion, camera.up);
    applyAzimuth(deltaTime);
    offset.copy(camera.position).sub(orbitControls.target);
    const settled = settleRoll(camera.up, offset, camera.quaternion, {
      dragging: orbitControls.state !== -1,
      resetting,
      gridUp: options.getGridUp?.(),
    });
    if (settled === null) {
      resetting = false;
    } else {
      camera.up.copy(settled);
    }
    syncFrame(camera.up);
    // the controls' own auto-rotation was applied above, about the axis
    const autoRotate = orbitControls.autoRotate;
    orbitControls.autoRotate = false;
    try {
      return update(deltaTime);
    } finally {
      orbitControls.autoRotate = autoRotate;
    }
  };

  return {
    /** Settle the roll on the resting up from the next updates on, wherever the camera is. */
    resetRoll() {
      resetting = true;
    },
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
    orbitControls._rotateUp(
      getKeyboardRotationSpeed(orbitControls, isFlatProjection)
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
    orbitControls._rotateUp(
      -getKeyboardRotationSpeed(orbitControls, isFlatProjection)
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
    orbitControls._rotateLeft(
      getKeyboardRotationSpeed(orbitControls, isFlatProjection)
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
    orbitControls._rotateLeft(
      -getKeyboardRotationSpeed(orbitControls, isFlatProjection)
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
