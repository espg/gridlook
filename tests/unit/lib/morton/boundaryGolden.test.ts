/**
 * Golden boundary test (espg/gridlook#8): the acceptance harness for the
 * morton -> healpix-geo render path. Drives the fixture's packed words
 * through the TS codec (word -> order + NESTED) and healpix-geo at the
 * pinned authalic-WGS84 convention, and asserts vertex agreement with
 * boundaries mortie itself emitted (scripts/generate_morton_boundary_golden.py).
 *
 * The negative control makes the pin load-bearing: flipping the grid to
 * plain-sphere-raw-geodetic mode (the superseded convention in the issue #8
 * body) moves the mid-latitude cell's corners by ~0.1283 deg (~14.26 km) and
 * MUST fail the tolerance by orders of magnitude.
 */
import { expect, it } from "vitest";

import golden from "../../../data/morton_boundary_golden.json";

import { MORTON_STORE_ELLIPSOID } from "@/lib/morton/convention.ts";
import { wordToNested } from "@/lib/morton/word.ts";

/** Max corner disagreement accepted for the pinned convention, in degrees. */
const TOLERANCE_DEG = 1e-7; // ~1.1 cm; observed agreement is ~4e-9 deg
/** [lat, lon] corner list. */
type Corners = number[][];

/**
 * Angular deviation between two vertices in degrees: latitude difference
 * plus wrapped longitude difference scaled by cos(lat), so the degenerate
 * longitude at the poles and the -180/+180 seam do not inflate it.
 */
function vertexDeviationDeg(a: number[], b: number[]): number {
  const dLat = a[0] - b[0];
  const dLonWrapped = ((((a[1] - b[1]) % 360) + 540) % 360) - 180;
  const lonScale = Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLonWrapped * lonScale);
}

/** Max over reference corners of the distance to the nearest test corner. */
function maxCornerDeviationDeg(reference: Corners, corners: Corners): number {
  return Math.max(
    ...reference.map((ref) =>
      Math.min(...corners.map((corner) => vertexDeviationDeg(ref, corner)))
    )
  );
}

/** The 4 [lat, lon] corners of a cell from a healpix-geo grid. */
function gridCorners(
  grid: { vertices(cell: bigint, steps: number): Float64Array },
  nested: bigint
): Corners {
  const coords = grid.vertices(nested, 2); // 2x2 subdivision = the 4 corners
  const corners: Corners = [];
  for (let i = 0; i < 4; i++) {
    corners.push([coords[2 * i + 1], coords[2 * i]]); // interleaved lon,lat
  }
  return corners;
}

it.each(golden.cells)(
  "$label: word -> NESTED matches the mortie decode",
  (cell) => {
    const { order, nested } = wordToNested(BigInt(cell.word));
    expect(order).toBe(cell.order);
    expect(nested).toBe(BigInt(cell.nested));
  }
);

it.each(golden.cells)(
  "$label: healpix-geo boundary matches mortie under the pinned convention",
  async (cell) => {
    const { Grid } = await import("healpix-geo");
    using grid = new Grid({
      scheme: "nested",
      level: cell.order,
      ellipsoid: MORTON_STORE_ELLIPSOID,
    });
    const corners = gridCorners(grid, BigInt(cell.nested));
    expect(maxCornerDeviationDeg(cell.corners_lat_lon, corners)).toBeLessThan(
      TOLERANCE_DEG
    );
  }
);

it("negative control: plain-sphere-raw-geodetic mode fails the golden", async () => {
  const { Grid } = await import("healpix-geo");
  const control = golden.negative_control;
  const cell = golden.cells.find((c) => c.label === control.cell)!;
  using sphere = new Grid({ scheme: "nested", level: cell.order });
  const deviation = maxCornerDeviationDeg(
    cell.corners_lat_lon,
    gridCorners(sphere, BigInt(cell.nested))
  );
  // The superseded convention is not a small perturbation: ~0.1283 deg
  // (~14.26 km) at 45 deg latitude, six orders of magnitude over tolerance.
  expect(deviation).toBeGreaterThan(control.min_sphere_deviation_deg);
  // The magnitude is derived by the generator (max |geodetic - authalic| over
  // this cell's corners), not remembered, so it is held to 6 decimals -- not
  // tighter: the spherical vertex kernel residual is ~4.2e-9 deg.
  expect(deviation).toBeCloseTo(control.expected_sphere_deviation_deg, 6);
});

it("healpix-geo's authalic series matches mortie's reference vectors", async () => {
  // Parity of the geodetic->authalic conversion itself (mortie spec
  // section 9 vectors): the ellipsoidal grid fed geodetic latitudes must
  // land every point in the same level-29 cell as the sphere grid fed the
  // pre-converted authalic latitudes.
  const { Grid } = await import("healpix-geo");
  using authalic = new Grid({
    scheme: "nested",
    level: 29,
    ellipsoid: MORTON_STORE_ELLIPSOID,
  });
  using sphere = new Grid({ scheme: "nested", level: 29 });
  for (const lon of [0, 12.0, 123.456, -77.7]) {
    for (const [geodetic, authalicLat] of golden.authalic_pairs_deg) {
      const fromGeodetic = authalic.lonLatToHealpix(
        new Float64Array([lon, geodetic])
      )[0];
      const fromAuthalic = sphere.lonLatToHealpix(
        new Float64Array([lon, authalicLat])
      )[0];
      expect(fromGeodetic).toBe(fromAuthalic);
    }
  }
});
