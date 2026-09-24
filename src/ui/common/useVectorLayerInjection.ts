import { useLog } from "./useLog.ts";

import {
  loadVectorLayerFromUrl,
  readVectorLayerFile,
  vectorLayerNameFromUrl,
} from "@/lib/layers/vectorLayerFormats.ts";
import { LAYER_KINDS, useGlobeControlStore } from "@/store/store.ts";
import type { TVectorLayerSpec } from "@/store/vectorLayerParams.ts";

type TVectorLayerUrlOptions = Omit<TVectorLayerSpec, "url">;
type TGlobeControlStore = ReturnType<typeof useGlobeControlStore>;
type TAddVectorLayerFromUrl = (
  url: string,
  options?: TVectorLayerUrlOptions
) => Promise<boolean>;

// Module-scoped so overlapping restore passes never double-add the same
// source URL: `addVectorLayerFromUrl` awaits a fetch before the entry lands in
// the stack, so a same-URL caller starting in that window (e.g. a hashchange
// firing the restore watch while onMounted's restore is still fetching) can't
// see the pending layer via a stack scan.
const inFlightVectorLayerUrls = new Set<string>();

function applyLayerOptions(
  store: TGlobeControlStore,
  id: string,
  options?: TVectorLayerUrlOptions
) {
  const layer = store.layerStack.find((entry) => entry.id === id);
  if (!layer || !options) {
    return;
  }
  if (options.visible !== undefined && layer.visible !== options.visible) {
    store.toggleLayerVisibility(id);
  }
  if (options.opacity !== undefined) {
    store.updateLayerOpacity(id, options.opacity);
  }
  if (options.style) {
    store.updateVectorLayerStyle(id, options.style);
  }
}

/**
 * Reconcile the URL-sourced vector layers in the stack against the decoded
 * `vectorlayers` specs: remove URL-sourced layers no longer named, re-apply
 * visibility/opacity/style to ones still present without re-fetching, and
 * add the missing ones. File/drag-drop layers are untouched. Re-applying
 * identical state re-encodes to the same parameter, so the URL watcher does
 * not rewrite the hash.
 */
async function reconcileVectorLayerStack(
  store: TGlobeControlStore,
  addVectorLayerFromUrl: TAddVectorLayerFromUrl,
  specs: TVectorLayerSpec[]
) {
  const wanted = new Set(specs.map((spec) => spec.url));
  for (const entry of [...store.layerStack]) {
    if (
      entry.kind === LAYER_KINDS.VECTOR &&
      entry.vectorSourceUrl &&
      !wanted.has(entry.vectorSourceUrl)
    ) {
      store.removeLayer(entry.id);
    }
  }
  // specs load in reverse so unshift keeps their top-to-bottom order
  for (const { url, ...options } of [...specs].reverse()) {
    const existing = store.layerStack.find(
      (entry) =>
        entry.kind === LAYER_KINDS.VECTOR && entry.vectorSourceUrl === url
    );
    if (existing) {
      applyLayerOptions(store, existing.id, options);
    } else {
      await addVectorLayerFromUrl(url, options);
    }
  }
}

/**
 * Shared entry points for adding GeoJSON vector layers from user input
 * (file upload, drag-and-drop, URL) and from `vectorlayers` deep links.
 * Errors surface as toasts. URL-injected layers record their source URL so
 * they round-trip through the URL hash; file layers stay session-only.
 */
export function useVectorLayerInjection() {
  const store = useGlobeControlStore();
  const { logError } = useLog();

  async function addVectorLayerFromFile(file: File): Promise<boolean> {
    try {
      const data = await readVectorLayerFile(file);
      store.addVectorLayer(crypto.randomUUID(), file.name, data);
      return true;
    } catch (error) {
      logError(error, `Couldn't load "${file.name}" as a vector layer`);
      return false;
    }
  }

  const addVectorLayerFromUrl: TAddVectorLayerFromUrl = async (
    url,
    options
  ) => {
    if (inFlightVectorLayerUrls.has(url)) {
      return false;
    }
    inFlightVectorLayerUrls.add(url);
    try {
      const data = await loadVectorLayerFromUrl(url);
      const id = crypto.randomUUID();
      store.addVectorLayer(id, vectorLayerNameFromUrl(url), data, true, url);
      applyLayerOptions(store, id, options);
      return true;
    } catch (error) {
      logError(error, "Couldn't load the URL as a vector layer");
      return false;
    } finally {
      inFlightVectorLayerUrls.delete(url);
    }
  };

  return {
    addVectorLayerFromFile,
    addVectorLayerFromUrl,
    reconcileVectorLayersFromSpecs: (specs: TVectorLayerSpec[]) =>
      reconcileVectorLayerStack(store, addVectorLayerFromUrl, specs),
  };
}
