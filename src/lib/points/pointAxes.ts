/**
 * The axes gizmo of the point tier (gridlook#21, phase B): east, north and
 * up bars at the datum under the pivot, ticked in metres, kept at about a
 * quarter of the view and rescaled with the zoom. The numbers here are
 * pure; `usePointAxes.ts` draws them.
 */

/** A bar is the largest nice length within this fraction of the view's height. */
export const AXIS_VIEW_FRACTION = 0.25;
/** Nice lengths are these times a power of ten, metres. */
const AXIS_NICE_STEPS = [1, 2, 5] as const;
/** Where a bar is ticked and labelled, as fractions of its length. */
export const AXIS_TICKS = [0.5, 1] as const;

export type TLocalFrame = {
  east: [number, number, number];
  north: [number, number, number];
  up: [number, number, number];
};

/** The largest nice length (1, 2, 5 × 10^k) at most `metres`; 1 m at least. */
export function niceAxisLength(metres: number): number {
  if (!(metres >= 1)) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(metres));
  const normalized = metres / magnitude;
  let step: number = AXIS_NICE_STEPS[0];
  for (const candidate of AXIS_NICE_STEPS) {
    if (normalized >= candidate) {
      step = candidate;
    }
  }
  return step * magnitude;
}

/** A tick's label: `50 m`, `2.5 km`. */
export function axisLabel(metres: number): string {
  const km = metres >= 1000;
  const value = km ? metres / 1000 : metres;
  return `${Number(value.toPrecision(3))} ${km ? "km" : "m"}`;
}

/** The view's height at `distance` from the camera, for a vertical field of view in degrees. */
export function viewHeightAt(distance: number, fovDegrees: number) {
  return 2 * distance * Math.tan((fovDegrees * Math.PI) / 360);
}

/**
 * The east, north and up unit vectors at a point of the unit sphere
 * (x toward lon 0, z toward the north pole); at a pole, east follows the
 * point's longitude.
 */
export function localFrame(point: [number, number, number]): TLocalFrame {
  const [x, y, z] = point;
  const length = Math.hypot(x, y, z) || 1;
  const up: [number, number, number] = [x / length, y / length, z / length];
  const flat = Math.hypot(up[0], up[1]);
  const east: [number, number, number] =
    flat < 1e-12 ? [0, 1, 0] : [-up[1] / flat, up[0] / flat, 0];
  const north: [number, number, number] = [
    up[1] * east[2] - up[2] * east[1],
    up[2] * east[0] - up[0] * east[2],
    up[0] * east[1] - up[1] * east[0],
  ];
  return { east, north, up };
}
