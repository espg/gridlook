import { useDebounceFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import type * as THREE from "three";

import { EARTH_RADIUS_METERS } from "@/lib/camera/cameraSettings.ts";
import { getGlobeView, roundBearing } from "@/lib/camera/globeCamera.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import { isDisplayMode } from "@/store/usePresenterSync.ts";

export type TCameraState = {
  position: number[];
  quaternion: number[];
};

export type TCameraUrlState = {
  px: number;
  py: number;
  alt: number;
  bearing: number;
};

export type TGridCameraState = {
  encodeCameraToURL: (camera: THREE.PerspectiveCamera, isFlat: boolean) => void;
  decodeCameraFromURL: () => TCameraUrlState | null;
  applyCameraState: (
    camera: THREE.PerspectiveCamera,
    data: TCameraState
  ) => void;
  debouncedEncodeCameraToURL: (
    camera: THREE.PerspectiveCamera,
    isFlat: boolean
  ) => void;
};

export { EARTH_RADIUS_METERS };

function formatCameraParam(value: number) {
  const rounded = Math.round(value);
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function parseCameraParam(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function cameraDistanceToAltitude(distance: number, isFlat: boolean) {
  return (distance - (isFlat ? 0 : 1)) * EARTH_RADIUS_METERS;
}

export function altitudeToCameraDistance(altitude: number, isFlat: boolean) {
  return altitude / EARTH_RADIUS_METERS + (isFlat ? 0 : 1);
}

/* eslint-disable-next-line max-lines-per-function */
export function useGridCameraState(): TGridCameraState {
  const urlParameterStore = useUrlParameterStore();
  const { paramCameraPx, paramCameraPy, paramCameraAlt, paramCameraBearing } =
    storeToRefs(urlParameterStore);

  function encodeCameraToURL(camera: THREE.PerspectiveCamera, isFlat: boolean) {
    // A presenter display keeps the camera its controller sent. Its own
    // would differ straight above a pole, where a bearing is read back as
    // part of the longitude.
    if (isDisplayMode.value) {
      return;
    }
    paramCameraPx.value = formatCameraParam(
      isFlat ? camera.position.x * EARTH_RADIUS_METERS : 0
    );
    paramCameraPy.value = formatCameraParam(
      isFlat ? camera.position.y * EARTH_RADIUS_METERS : 0
    );
    const distance = isFlat ? camera.position.z : camera.position.length();
    paramCameraAlt.value = formatCameraParam(
      cameraDistanceToAltitude(distance, isFlat)
    );
    // Written only for a globe whose north is not up.
    const bearing = isFlat ? 0 : roundBearing(getGlobeView(camera).bearing);
    paramCameraBearing.value = bearing ? String(bearing) : undefined;
  }

  function decodeCameraFromURL(): TCameraUrlState | null {
    const alt = parseCameraParam(paramCameraAlt.value);
    if (alt === undefined) {
      return null;
    }
    return {
      px: parseCameraParam(paramCameraPx.value) ?? 0,
      py: parseCameraParam(paramCameraPy.value) ?? 0,
      alt,
      bearing: parseCameraParam(paramCameraBearing.value) ?? 0,
    };
  }

  function applyCameraState(
    camera: THREE.PerspectiveCamera,
    data: TCameraState
  ) {
    if (!data) {
      return;
    }

    if (data.position && data.position.length === 3) {
      camera.position.fromArray(data.position);
    }

    if (data.quaternion && data.quaternion.length === 4) {
      camera.quaternion.fromArray(data.quaternion);
    }
    camera.updateProjectionMatrix();
  }

  const debouncedEncodeCameraToURL = useDebounceFn(
    (camera: THREE.PerspectiveCamera, isFlat: boolean) => {
      encodeCameraToURL(camera, isFlat);
    },
    300
  );

  return {
    encodeCameraToURL,
    decodeCameraFromURL,
    applyCameraState,
    debouncedEncodeCameraToURL,
  };
}
