import { useLog } from "./useLog.ts";

import {
  loadVectorLayerFromUrl,
  readVectorLayerFile,
  vectorLayerNameFromUrl,
} from "@/lib/layers/vectorLayerFormats.ts";
import { useGlobeControlStore, type TVectorLayerStyle } from "@/store/store.ts";

type TVectorLayerUrlOptions = {
  visible?: boolean;
  style?: Partial<TVectorLayerStyle>;
};

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
    }
  }

  return { addVectorLayerFromFile, addVectorLayerFromUrl };
}
