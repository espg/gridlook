/**
 * Golden boundary test (espg/gridlook#8): the acceptance harness for the
 * morton -> healpix-geo render path. Drives the fixture's packed words
 * through the TS codec (word -> order + NESTED) and healpix-geo at the
 * pinned authalic-WGS84 convention, and asserts vertex agreement with
 * boundaries mortie itself emitted (scripts/generate_morton_boundary_golden.py)
 * -- index-by-index in ring order, because healpix-geo enumerates the corners
 * in z-order and a set-level match would certify a bowtie.
 *
 * The negative control makes the pin load-bearing: flipping the grid to
 * plain-sphere-raw-geodetic mode (the superseded convention in the issue #8
 * body) moves the mid-latitude cell's corners by ~0.1283 deg (~14.26 km) and
 * MUST fail the tolerance by orders of magnitude.
 */
import healpixGeoPackage from "healpix-geo/package.json";
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

/**
 * Max over reference corners of the distance to the nearest test corner.
 *
 * Set-level only (a directed Hausdorff distance): it certifies WHICH four
 * points a grid produced, never their order. Kept as a secondary guard; the
 * primary assertion is index-by-index, see MORTIE_RING_FROM_ZORDER.
 */
function maxCornerDeviationDeg(reference: Corners, corners: Corners): number {
  return Math.max(
    ...reference.map((ref) =>
      Math.min(...corners.map((corner) => vertexDeviationDeg(ref, corner)))
    )
  );
}

/**
 * z-order slot of each mortie ring vertex.
 *
 * `vertices(cell, 2)` walks the 2x2 subdivision in z-order -- (u, v) =
 * (0,0), (0,1), (1,0), (1,1), "i outer, j inner" per the Grid.vertices doc,
 * with the offsets measured from the cell's SOUTH vertex -- so the four slots
 * are S, W, E, N. That is NOT a ring: traversed in place it is the
 * self-intersecting bowtie S -> W -> E -> N. mortie's mort2polygon emits a
 * real ring, N -> W -> S -> E (counter-clockwise in lon-east/lat-north, the
 * GeoJSON exterior-ring winding), and this permutation maps z-order onto it.
 * Anything that feeds these corners to a LineLoop, a THREE.Shape or a GeoJSON
 * ring must go through here, not through the raw enumeration.
 */
const MORTIE_RING_FROM_ZORDER = [3, 1, 0, 2];

/** The 4 [lat, lon] corners of a cell from a healpix-geo grid, in ring order. */
function gridCorners(
  grid: { vertices(cell: bigint, steps: number): Float64Array },
  nested: bigint
): Corners {
  const coords = grid.vertices(nested, 2); // 2x2 subdivision = the 4 corners
  // interleaved lon,lat
  return MORTIE_RING_FROM_ZORDER.map((slot) => [
    coords[2 * slot + 1],
    coords[2 * slot],
  ]);
}

/** The same 4 corners in healpix-geo's raw z-order enumeration. */
function zOrderCorners(
  grid: { vertices(cell: bigint, steps: number): Float64Array },
  nested: bigint
): Corners {
  const coords = grid.vertices(nested, 2);
  return [0, 1, 2, 3].map((slot) => [coords[2 * slot + 1], coords[2 * slot]]);
}

it("the fixture records the toolchain it was validated against", () => {
  // The corners come from mortie and are compared against healpix-geo, and the
  // tolerance is sized by a healpix-geo-internal kernel residual -- so a bump on
  // either side has to show up as a named failure here, not as silently eaten
  // headroom. The npm range is a caret, so `npm update` can move the installed
  // healpix-geo out from under a fixture nobody regenerated.
  expect(golden.mortie_version).toBe("1.0.0");
  expect(golden.healpix_geo_version).toBe(healpixGeoPackage.version);
});

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
    // Index-by-index, in ring order: the corner ORDER is part of the contract,
    // and the set-level check below cannot see it.
    cell.corners_lat_lon.forEach((reference, index) => {
      expect(vertexDeviationDeg(reference, corners[index])).toBeLessThan(
        TOLERANCE_DEG
      );
    });
    expect(maxCornerDeviationDeg(cell.corners_lat_lon, corners)).toBeLessThan(
      TOLERANCE_DEG
    );
  }
);

it.each(golden.cells)(
  "$label: the raw z-order enumeration is a bowtie, not the ring",
  async (cell) => {
    // Guards MORTIE_RING_FROM_ZORDER: without the permutation the corners are
    // the same four points (so maxCornerDeviationDeg still passes) walked in an
    // order that self-intersects. If healpix-geo ever changes its enumeration
    // this goes red and the permutation gets re-derived, rather than the ring
    // silently becoming a bowtie downstream.
    const { Grid } = await import("healpix-geo");
    using grid = new Grid({
      scheme: "nested",
      level: cell.order,
      ellipsoid: MORTON_STORE_ELLIPSOID,
    });
    const zOrder = zOrderCorners(grid, BigInt(cell.nested));
    expect(maxCornerDeviationDeg(cell.corners_lat_lon, zOrder)).toBeLessThan(
      TOLERANCE_DEG
    );
    const inOrder = Math.max(
      ...cell.corners_lat_lon.map((reference, index) =>
        vertexDeviationDeg(reference, zOrder[index])
      )
    );
    // In tolerance units, not degrees: cells shrink with order, so the bowtie
    // displaces a base-cell corner by ~90 deg but an o24 corner by only ~7e-6
    // deg -- still ~70x the tolerance the correctly ordered ring clears by
    // ~4e-9 deg.
    expect(inOrder).toBeGreaterThan(10 * TOLERANCE_DEG);
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

it("healpix-geo's inverse authalic series matches mortie's reference vectors", async () => {
  // The direction the boundary path actually runs: healpix-geo computes a
  // vertex/centre on the authalic sphere and converts authalic -> geodetic on
  // egress. Take the level-29 cell holding a reference authalic latitude, then
  // read that same cell's centre back through both grids: the sphere gives the
  // authalic centre, the ellipsoidal grid the geodetic one, so their difference
  // IS the inverse series evaluated at that centre. Comparing the two offsets
  // (rather than the latitudes) divides out the level-29 quantisation: the cell
  // centre sits within ~1.1e-7 deg of the reference latitude, and the offset
  // moves by <1e-9 deg over that span, so this pins the inverse series ~2
  // orders tighter than the corner tolerance.
  const { Grid } = await import("healpix-geo");
  using authalic = new Grid({
    scheme: "nested",
    level: 29,
    ellipsoid: MORTON_STORE_ELLIPSOID,
  });
  using sphere = new Grid({ scheme: "nested", level: 29 });
  for (const lon of [0, 12.0, 123.456, -77.7]) {
    for (const [authalicLat, geodetic] of golden.geodetic_pairs_deg) {
      const cell = sphere.lonLatToHealpix(new Float64Array([lon, authalicLat]));
      const sphereCentre = sphere.healpixToLonLat(cell);
      const geodeticCentre = authalic.healpixToLonLat(cell);
      expect(
        Math.abs(geodeticCentre[1] - sphereCentre[1] - (geodetic - authalicLat))
      ).toBeLessThan(1e-9);
      // ...and the egress latitude itself lands on the geodetic partner, to
      // within the level-29 cell the reference latitude was quantised into.
      expect(Math.abs(geodeticCentre[1] - geodetic)).toBeLessThan(2e-7);
    }
  }
});
