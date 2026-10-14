import { afterEach, describe, expect, it } from "vitest";

import {
  digestCellBytes,
  DEFAULT_VIEW_BUDGET_BYTES,
  MIN_VIEW_BUDGET_BYTES,
  viewBudgetBytes,
} from "@/lib/data/levels.ts";
import {
  learnedCellBytes,
  meterTransfers,
  recordCellBytes,
  recordTransfer,
  resetTransferMeter,
  transferRate,
} from "@/lib/data/transferMeter.ts";

const MB = 2 ** 20;

afterEach(resetTransferMeter);

describe("transferRate", () => {
  it("is unknown until enough bytes are read", () => {
    recordTransfer(0, 100, MB);
    expect(transferRate(100)).toBeUndefined();
  });

  it("divides bytes by the time a read was in flight, overlaps once", () => {
    // two overlapping 1 s reads and one after a 5 s idle gap: 2.5 s busy
    recordTransfer(0, 1000, 4 * MB);
    recordTransfer(500, 1500, 4 * MB);
    recordTransfer(6500, 7500, 2 * MB);
    expect(transferRate(7500)).toBeCloseTo((10 * MB) / 2.5);
  });

  it("forgets reads older than its window", () => {
    recordTransfer(0, 1000, 8 * MB);
    expect(transferRate(60_000)).toBeUndefined();
  });

  it("is fed by a metered store", async () => {
    const store = meterTransfers({
      get: async () => new Uint8Array(5 * MB),
    });
    await store.get("/a");
    expect(transferRate()).toBeGreaterThan(0);
  });
});

describe("viewBudgetBytes", () => {
  it("is the default before a rate is known", () => {
    expect(viewBudgetBytes(undefined, 5)).toBe(DEFAULT_VIEW_BUDGET_BYTES);
  });

  it("is seconds at the rate, within its bounds", () => {
    expect(viewBudgetBytes(8 * MB, 5)).toBe(40 * MB);
    expect(viewBudgetBytes(MB, 5)).toBe(MIN_VIEW_BUDGET_BYTES);
    expect(viewBudgetBytes(1000 * MB, 5)).toBe(DEFAULT_VIEW_BUDGET_BYTES);
  });
});

describe("learnedCellBytes", () => {
  it("prices a level by its cheapest array as read", () => {
    recordCellBytes(14, "h_tdigest_signal", 410 * 256, 256);
    recordCellBytes(14, "h_tdigest_signal", 410 * 256, 256);
    recordCellBytes(14, "h_tdigest_noise", 900 * 256, 256);
    expect(learnedCellBytes(14)).toBeCloseTo(410);
    expect(digestCellBytes(14, 2)).toBeCloseTo(820);
  });

  it("falls back to the nearest coarser order read, else the listing", () => {
    recordCellBytes(13, "s", 550, 1);
    expect(learnedCellBytes(15)).toBe(550);
    expect(learnedCellBytes(12)).toBeUndefined();
    expect(digestCellBytes(12)).toBe(2000);
  });
});
