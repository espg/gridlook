import type { Camera } from "three";

import { screenToGeo, type TViewport } from "./distanceScale.ts";
import type { ProjectionHelper } from "./projectionUtils.ts";

/** Lat/lon box (degrees) holding the part of the surface the camera sees. */
export type TViewFootprint = {
  latMin: number;
  latMax: number;
  // western edge in [-180, 180) and extent eastward; 360 is every longitude
  lonStart: number;
  lonSpan: number;
};

const SAMPLES_PER_AXIS = 9;
const DEGREES = 180 / Math.PI;

function normalizeLon(lon: number) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** The cap of the unit globe a camera sees when the horizon is in view. */
function globeCap(camera: Camera): TViewFootprint {
  const { x, y, z } = camera.position;
  const distance = camera.position.length();
  const lat = Math.asin(z / distance) * DEGREES;
  const radius = Math.acos(Math.min(1, 1 / distance)) * DEGREES;
  if (lat + radius >= 90 || lat - radius <= -90) {
    return {
      latMin: lat - radius <= -90 ? -90 : lat - radius,
      latMax: lat + radius >= 90 ? 90 : lat + radius,
      lonStart: -180,
      lonSpan: 360,
    };
  }
  const halfSpan =
    Math.asin(Math.sin(radius / DEGREES) / Math.cos(lat / DEGREES)) * DEGREES;
  return {
    latMin: lat - radius,
    latMax: lat + radius,
    lonStart: normalizeLon(Math.atan2(y, x) * DEGREES - halfSpan),
    lonSpan: 2 * halfSpan,
  };
}

/** The shortest arc holding every longitude, as its western edge and extent. */
function longitudeArc(lons: number[]) {
  const sorted = lons.map(normalizeLon).sort((a, b) => a - b);
  let gap = sorted[0] + 360 - sorted[sorted.length - 1];
  let start = sorted[0];
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index] - sorted[index - 1] > gap) {
      gap = sorted[index] - sorted[index - 1];
      start = sorted[index];
    }
  }
  return { lonStart: start, lonSpan: 360 - gap };
}

function boundingBox(lons: number[], lats: number[]): TViewFootprint {
  let latMin = lats[0];
  let latMax = lats[0];
  for (const lat of lats) {
    latMin = lat < latMin ? lat : latMin;
    latMax = lat > latMax ? lat : latMax;
  }
  const arc = longitudeArc(lons);
  if (arc.lonSpan <= 180) {
    return { latMin, latMax, ...arc };
  }
  // An arc past 180° wraps a pole: the view holds every longitude up to it.
  return {
    latMin: -latMin > latMax ? -90 : latMin,
    latMax: -latMin > latMax ? latMax : 90,
    lonStart: -180,
    lonSpan: 360,
  };
}

/**
 * The lat/lon box of what a camera sees, from a lattice of screen points
 * unprojected onto the surface. On the globe a screen point off the sphere
 * means the horizon is in view; the box is then the whole visible cap.
 * Null when no screen point hits the surface.
 */
export function viewFootprint(
  camera: Camera,
  helper: ProjectionHelper,
  rect: TViewport
): TViewFootprint | null {
  const lons: number[] = [];
  const lats: number[] = [];
  for (let i = 0; i < SAMPLES_PER_AXIS; i++) {
    for (let j = 0; j < SAMPLES_PER_AXIS; j++) {
      const geo = screenToGeo(
        camera,
        helper,
        rect,
        rect.left + (rect.width * i) / (SAMPLES_PER_AXIS - 1),
        rect.top + (rect.height * j) / (SAMPLES_PER_AXIS - 1)
      );
      if (geo) {
        lons.push(geo[0]);
        lats.push(geo[1]);
      } else if (!helper.isFlat) {
        return globeCap(camera);
      }
    }
  }
  return lats.length > 0 ? boundingBox(lons, lats) : null;
}
