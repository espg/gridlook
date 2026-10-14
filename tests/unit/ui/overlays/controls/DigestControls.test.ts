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

function render(strata?: string[]) {
  return renderToString(createSSRApp(DigestControls, { digest, strata }));
}

const button = (html: string, label: string) =>
  html.match(new RegExp(`<button[^>]*>\\s*${label}\\s*</button>`))?.[0];

it("offers the stratum choice once the store holds two strata", async () => {
  const store = useGlobeControlStore();
  const html = await render(["signal", "noise"]);
  expect(html).toContain("Photons");
  expect(button(html, "signal")).toContain("is-selected");
  expect(button(html, "noise")).not.toContain("is-selected");
  expect(button(html, "both")).not.toContain("disabled");
  store.setDigestStratum("both");
  expect(button(await render(["signal", "noise"]), "both")).toContain(
    "is-selected"
  );
  // one stratum: no choice to make; a noise-less store cannot merge
  expect(await render(["signal"])).not.toContain("Photons");
  expect(await render()).not.toContain("Photons");
  const odd = await render(["signal", "ocean"]);
  expect(button(odd, "noise")).toContain("disabled");
  expect(button(odd, "both")).toContain("disabled");
});

it("offers the gap smoothing off, at 15 cells, on any level", async () => {
  const store = useGlobeControlStore();
  const html = await render();
  expect(html).toContain("Smooth gaps");
  expect(html).toContain("Smoothing kernel size");
  expect(html).toContain("σ = 2.33 cells");
  expect(store.gapFill).toBe(false);
  expect(store.gapFillSize).toBe(15);
  store.setGapFillSize(9);
  expect(await render()).toContain("σ = 1.33 cells");
});
