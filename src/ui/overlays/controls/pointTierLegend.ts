import {
  POINT_PIVOT_LEFT_DRAGS,
  type TPivotLeftDrag,
} from "@/lib/camera/pointPivot.ts";

/**
 * The one-line legend of the point tier's controls (docs/levels.md) for
 * what a plain left drag does, shown under the level picker while the
 * tier is on and in the points option's tooltip.
 */
export function pointTierLegend(leftDrag: TPivotLeftDrag) {
  return leftDrag === POINT_PIVOT_LEFT_DRAGS.ORBIT
    ? "Drag or right-drag orbits · arrows pan · wheel zooms to the cursor"
    : "Drag pans · Shift+drag or right-drag orbits · wheel zooms to the cursor";
}

export function pointTierLegendTitle(leftDrag: TPivotLeftDrag) {
  return leftDrag === POINT_PIVOT_LEFT_DRAGS.ORBIT
    ? "The left button, shift + left and the right button turn about the point under the view and tilt; the arrow keys slide the ground; the wheel zooms toward the ground under the cursor"
    : "The left button slides the ground under the pointer; the right button or shift + left turns about the point under the view and tilts; the wheel zooms toward the ground under the cursor";
}
