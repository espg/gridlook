import { describe, expect, it } from "vitest";

import {
  EARTH_RADIUS_KM,
  kmPerPixel,
  ladderFromCatalog,
  pickRung,
  rungForCamera,
  rungForSource,
  type TLadderRung,
} from "@/lib/data/orderLadder.ts";
import type { TCatalog } from "@/utils/catalog.ts";

// mortie order2res-style resolutions: RMS cell spacing halves per order.
const RES0_KM = 6519.6;
function res(order: number) {
  return RES0_KM / 2 ** order;
}

function rung(cellOrder: number): TLadderRung {
  const entry = {
    url: `https://hub/gridlook/hive/id${cellOrder}`,
    cell_order: cellOrder, // eslint-disable-line camelcase
    resolution_km: res(cellOrder), // eslint-disable-line camelcase
  };
  return { cellOrder, resolutionKm: res(cellOrder), url: entry.url, entry };
}

// A dense ladder, orders 12..4 (the CA v2 store minus its oversize leaf).
const LADDER = [12, 11, 10, 9, 8, 7, 6, 5, 4].map(rung);

describe("ladderFromCatalog", () => {
  it("keeps entries with an integer cell_order and a positive resolution, finest first", () => {
    const catalog: TCatalog = {
      type: "gridlook_catalog",
      datasets: [
        { url: "a", cell_order: 4, resolution_km: res(4) }, // eslint-disable-line camelcase
        { url: "plain dataset" },
        { url: "b", cell_order: 8, resolution_km: res(8) }, // eslint-disable-line camelcase
        { url: "bad", cell_order: 6.5, resolution_km: res(6) }, // eslint-disable-line camelcase
        { url: "bad2", cell_order: 6, resolution_km: 0 }, // eslint-disable-line camelcase
      ],
    };
    const rungs = ladderFromCatalog(catalog);
    expect(rungs.map((r) => r.cellOrder)).toEqual([8, 4]);
    expect(rungs[0].url).toBe("b");
    expect(rungs[0].entry).toBe(catalog.datasets[2]);
  });

  it("is empty without a catalog", () => {
    expect(ladderFromCatalog(undefined)).toEqual([]);
  });
});

describe("rungForSource", () => {
  it("matches a source URL ignoring a trailing slash", () => {
    expect(rungForSource(LADDER, "https://hub/gridlook/hive/id9/")).toBe(
      LADDER[3]
    );
    expect(rungForSource(LADDER, "https://hub/other")).toBeUndefined();
    expect(rungForSource(LADDER, undefined)).toBeUndefined();
  });
});

describe("kmPerPixel", () => {
  it("scales with the camera's height above the surface and the field of view", () => {
    // A 7.5° camera 30 radii from the centre: 29 radii above the surface,
    // view height 2·29·tan(3.75°) radii over 1000 px.
    const expected =
      ((2 * 29 * Math.tan((7.5 * Math.PI) / 360)) / 1000) * EARTH_RADIUS_KM;
    expect(kmPerPixel(30, 7.5, 1000)).toBeCloseTo(expected, 6);
    expect(kmPerPixel(2, 7.5, 1000)).toBeCloseTo(expected / 29, 6);
    expect(kmPerPixel(30, 15, 1000)).toBeGreaterThan(expected);
  });

  it("never divides by zero at the surface or on a zero-height viewport", () => {
    expect(Number.isFinite(kmPerPixel(1, 7.5, 1000))).toBe(true);
    expect(Number.isFinite(kmPerPixel(30, 7.5, 0))).toBe(true);
  });
});

describe("pickRung", () => {
  it("picks the rung nearest the target in log2 cell size when nothing is active", () => {
    expect(pickRung(LADDER, res(8), undefined)?.cellOrder).toBe(8);
    // Halfway (geometrically) between 8 and 7 is a tie; slightly finer wins.
    expect(pickRung(LADDER, res(7.6), undefined)?.cellOrder).toBe(8);
    expect(pickRung(LADDER, res(7.4), undefined)?.cellOrder).toBe(7);
  });

  it("clamps to the ladder's ends", () => {
    expect(pickRung(LADDER, res(20), undefined)?.cellOrder).toBe(12);
    expect(pickRung(LADDER, res(0), undefined)?.cellOrder).toBe(4);
  });

  it("holds the active rung inside the hysteresis band", () => {
    const active = rung(8);
    const rungs = [rung(9), active, rung(7)];
    // Ideal is 7.6: rung 8 mismatches by 0.4, rung 7 by 0.6 → keep 8.
    expect(pickRung(rungs, res(7.6), active)).toBe(active);
    // Ideal 7.4: rung 7 is closer by 0.2 — inside the 0.35 band, keep 8.
    expect(pickRung(rungs, res(7.4), active)).toBe(active);
    // Ideal 7.2: rung 7 closer by 0.6 → switch.
    expect(pickRung(rungs, res(7.2), active)?.cellOrder).toBe(7);
    // Symmetric on the way back: from 7, ideal 7.6 still holds 7 …
    expect(pickRung(rungs, res(7.6), rungs[2])?.cellOrder).toBe(7);
    // … and 7.8 switches back to 8.
    expect(pickRung(rungs, res(7.8), rungs[2])?.cellOrder).toBe(8);
  });

  it("never oscillates for a resting camera", () => {
    let active: TLadderRung | undefined = undefined;
    for (const target of [res(7.5), res(7.5), res(7.5)]) {
      const next = pickRung(LADDER, target, active);
      if (active) {
        expect(next).toBe(active);
      }
      active = next;
    }
  });

  it("returns the active rung for an empty ladder or a bad target", () => {
    const active = rung(8);
    expect(pickRung([], res(8), active)).toBe(active);
    expect(pickRung(LADDER, 0, active)).toBe(active);
    expect(pickRung(LADDER, Number.NaN, undefined)).toBeUndefined();
  });

  it("treats an active rung not on the ladder as no active rung", () => {
    expect(pickRung(LADDER, res(6), rung(3))?.cellOrder).toBe(6);
  });
});

describe("rungForCamera", () => {
  it("goes finer as the camera approaches and coarser as it recedes", () => {
    const cam = (distance: number) => ({
      distance,
      fovDegrees: 7.5,
      viewportHeightPx: 1000,
    });
    const far = rungForCamera(LADDER, cam(30), undefined)!;
    const near = rungForCamera(LADDER, cam(1.05), undefined)!;
    expect(near.cellOrder).toBeGreaterThan(far.cellOrder);
    // Two pixels per cell: at 30 radii each pixel is ~ 24 km, so ~48 km cells (order 7).
    expect(far.cellOrder).toBe(7);
    expect(near.cellOrder).toBe(12);
  });
});
