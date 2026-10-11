import { beforeEach, expect, it, vi } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { DIGEST_PRODUCTS } from "@/lib/digest/digestVariables.ts";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { default: DigestControls } =
  await import("@/ui/overlays/controls/DigestControls.vue");

const digest = {
  array: "h_tdigest_signal",
  product: DIGEST_PRODUCTS.PERCENTILE,
  stratum: "signal",
};

beforeEach(() => setActivePinia(createPinia()));

function render(derivedLevel: boolean) {
  return renderToString(createSSRApp(DigestControls, { digest, derivedLevel }));
}

it("offers the gap smoothing on a derived level only", async () => {
  const store = useGlobeControlStore();
  store.setGapFill(true);
  store.setGapFillSize(9);
  const derived = await render(true);
  expect(derived).toContain("Smooth gaps");
  expect(derived).toContain("Smoothing kernel size");
  expect(derived).toContain("σ = 1.33 cells");
  // a stored level: the percentile stays, the smoothing row is not there
  const stored = await render(false);
  expect(stored).toContain("Percentile");
  expect(stored).not.toContain("Smooth gaps");
  expect(stored).not.toContain("Smoothing kernel size");
  // the setting is kept for the next derived level
  expect(store.gapFill).toBe(true);
  expect(store.gapFillSize).toBe(9);
});
