import { useLog } from "./useLog.ts";

import {
  loadVectorLayerFromUrl,
  readVectorLayerFile,
  vectorLayerNameFromUrl,
} from "@/lib/layers/vectorLayerFormats.ts";
import {
  LAYER_KINDS,
  useGlobeControlStore,
  type TVectorLayerStyle,
} from "@/store/store.ts";
import type { TVectorLayerSpec } from "@/store/vectorLayerParams.ts";

type TVectorLayerUrlOptions = {
  visible?: boolean;
  style?: Partial<TVectorLayerStyle>;
};

// Module-scoped so overlapping restore passes never double-add the same source
// URL. `addVectorLayerFromUrl` awaits a network fetch before the entry lands in
// the stack, so a same-URL caller that starts during that window can't see the
// pending layer via a stack scan; this in-flight set closes that gap. Realistic
// trigger: a `hashchange` (e.g. rapid presenter/display re-navigation) firing
// the restore watch while onMounted's restore is still fetching.
const inFlightVectorLayerUrls = new Set<string>();

type TGlobeControlStore = ReturnType<typeof useGlobeControlStore>;
type TAddVectorLayerFromUrl = (
  url: string,
  options?: TVectorLayerUrlOptions
) => Promise<boolean>;

/**
 * Reconcile the URL-sourced vector layers in the stack against the decoded
 * `vectorlayers` deep-link specs (the restore-on-hashchange path). Removes
 * URL-sourced layers whose source is absent from `specs`, re-applies
 * visibility/style to ones still present without re-fetching, and adds the
 * missing ones. File/drag-drop layers (no `vectorSourceUrl`) are untouched.
 *
 * No explicit loop guard is needed: `useUrlSync` re-serializes the stack to a
 * byte-stable `vectorlayers` value, so re-applying identical state produces an
 * unchanged parameter and its debounced watcher never rewrites the hash.
 */
async function reconcileVectorLayerStack(
  store: TGlobeControlStore,
  addVectorLayerFromUrl: TAddVectorLayerFromUrl,
  specs: TVectorLayerSpec[]
): Promise<void> {
  const desiredUrls = new Set(specs.map((spec) => spec.url));

  // Drop URL-sourced layers no longer named by the param (snapshot the stack
  // first — removeVectorLayer reassigns it).
  for (const entry of [...store.layerStack]) {
    if (
      entry.kind === LAYER_KINDS.VECTOR &&
      entry.vectorSourceUrl &&
      !desiredUrls.has(entry.vectorSourceUrl)
    ) {
      store.removeVectorLayer(entry.id);
    }
  }

  // Re-apply present layers in place; add missing ones. Specs load in reverse
  // so unshift keeps their top → bottom order.
  for (const spec of [...specs].reverse()) {
    const existing = store.layerStack.find(
      (entry) =>
        entry.kind === LAYER_KINDS.VECTOR && entry.vectorSourceUrl === spec.url
    );
    if (existing) {
      store.updateVectorLayer(existing.id, { visible: spec.visible ?? true });
      if (spec.style) {
        store.updateVectorLayerStyle(existing.id, spec.style);
      }
      continue;
    }
    await addVectorLayerFromUrl(spec.url, {
      visible: spec.visible,
      style: spec.style,
    });
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

  async function addVectorLayerFromUrl(
    url: string,
    options?: TVectorLayerUrlOptions
  ): Promise<boolean> {
    // Another add for this URL is already mid-fetch; skip rather than race it
    // to a duplicate entry (dedup across the fetch window, see the set above).
    if (inFlightVectorLayerUrls.has(url)) {
      return false;
    }
    inFlightVectorLayerUrls.add(url);
    try {
      const data = await loadVectorLayerFromUrl(url);
      const id = crypto.randomUUID();
      store.addVectorLayer(
        id,
        vectorLayerNameFromUrl(url),
        data,
        options?.visible ?? true,
        url
      );
      if (options?.style) {
        store.updateVectorLayerStyle(id, options.style);
      }
      return true;
    } catch (error) {
      logError(error, "Couldn't load the URL as a vector layer");
      return false;
    } finally {
      inFlightVectorLayerUrls.delete(url);
    }
  }

  return {
    addVectorLayerFromFile,
    addVectorLayerFromUrl,
    reconcileVectorLayersFromSpecs: (specs: TVectorLayerSpec[]) =>
      reconcileVectorLayerStack(store, addVectorLayerFromUrl, specs),
  };
}
