export const CAMERA_VERTICAL_FOV_DEGREES = 7.5;

// The renderer models Earth as a unit sphere. The IUGG mean Earth radius
// exposes that sphere in physical metres (URL camera state, level selection).
export const EARTH_RADIUS_METERS = 6_371_008.8;

export function getGlobeMovementScale(distance: number) {
  // Below one globe radius of altitude, keep navigation proportional to height.
  return Math.min(1, Math.max(0, distance - 1));
}

export function getVisibleVerticalSpan(
  distance: number,
  fovDegrees = CAMERA_VERTICAL_FOV_DEGREES
) {
  const halfFovRadians = (fovDegrees * Math.PI) / 360;
  return 2 * distance * Math.tan(halfFovRadians);
}

export function getCameraDistanceForVerticalSpan(
  span: number,
  fovDegrees = CAMERA_VERTICAL_FOV_DEGREES
) {
  const halfFovRadians = (fovDegrees * Math.PI) / 360;
  return span / (2 * Math.tan(halfFovRadians));
}
