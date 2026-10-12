import { expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

vi.stubGlobal("localStorage", { getItem: () => null });

const { createPinia, setActivePinia } = await import("pinia");
const { useGlobeControlStore } = await import("@/store/store.ts");
const { useUrlSync } = await import("@/store/useUrlSync.ts");
const { STORE_PARAM_MAPPING } = await import("@/store/paramStore.ts");

it("shares the magnitude request while retaining the underlying scalar", async () => {
  setActivePinia(createPinia());
  const location = {
    pathname: "/",
    hash: "#https://example.test/data.zarr::varname=temperature::streamlines=true",
  };
  vi.stubGlobal("location", location);
  vi.stubGlobal("document", { location });
  vi.stubGlobal("history", {
    replaceState: (_state: unknown, _title: string, url: string) => {
      location.hash = url.slice(url.indexOf("#"));
    },
  });
  const store = useGlobeControlStore();
  store.varnameSelector = "temperature";
  store.setStreamlineLayerEnabled(true);
  const scope = effectScope();
  scope.run(useUrlSync);
  try {
    store.setStreamlineMagnitudeDisplayed(true);
    await nextTick();
    expect(location.hash).toContain("::streamlinemagnitude=true");
    expect(location.hash).toContain("::varname=temperature");

    store.setStreamlineMagnitudeInfo(undefined);
    await nextTick();
    expect(store.streamlineMagnitudeDisplayed).toBe(false);
    expect(location.hash).toContain("::streamlinemagnitude=true");

    store.setStreamlineMagnitudeDisplayed(false);
    await nextTick();
    expect(location.hash).not.toContain("streamlinemagnitude");

    store.setStreamlineMagnitudeDisplayed(true);
    await nextTick();
    store.setStreamlineLayerEnabled(false);
    await nextTick();
    expect(location.hash).not.toContain("streamlinemagnitude");
    expect(location.hash).toContain("::varname=temperature");
  } finally {
    scope.stop();
    vi.unstubAllGlobals();
  }
});

it("shares the stratum choice as `stratum`, read back from the hash", async () => {
  setActivePinia(createPinia());
  const location = {
    pathname: "/",
    hash: "#hive+https://example.test/data.zarr::varname=h_percentile_signal",
  };
  vi.stubGlobal("location", location);
  vi.stubGlobal("document", { location });
  vi.stubGlobal("history", {
    replaceState: (_state: unknown, _title: string, url: string) => {
      location.hash = url.slice(url.indexOf("#"));
    },
  });
  const store = useGlobeControlStore();
  const scope = effectScope();
  scope.run(useUrlSync);
  try {
    store.setDigestStratum("both");
    await nextTick();
    expect(location.hash).toContain("::stratum=both");
    // the hash parameter lands in the parameter store as `paramStratum`
    const param = new URLSearchParams(
      location.hash.split("::").slice(1).join("&")
    ).get("stratum");
    expect(STORE_PARAM_MAPPING.stratum).toBe("paramStratum");
    store.setDigestStratum(param);
    expect(store.digestStratum).toBe("both");
    store.setDigestStratum("signal");
    await nextTick();
    expect(location.hash).toContain("::stratum=signal");
  } finally {
    scope.stop();
    vi.unstubAllGlobals();
  }
});
