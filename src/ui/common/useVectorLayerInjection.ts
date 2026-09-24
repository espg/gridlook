import { useLog } from "./useLog.ts";

import {
  loadVectorLayerFromUrl,
  readVectorLayerFile,
  vectorLayerNameFromUrl,
} from "@/lib/layers/vectorLayerFormats.ts";
import { useGlobeControlStore } from "@/store/store.ts";

/**
 * Shared entry points for adding GeoJSON vector layers from user input
 * (file upload, drag-and-drop, URL). Errors surface as toasts.
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

  async function addVectorLayerFromUrl(url: string): Promise<boolean> {
    try {
      const data = await loadVectorLayerFromUrl(url);
      store.addVectorLayer(
        crypto.randomUUID(),
        vectorLayerNameFromUrl(url),
        data
      );
      return true;
    } catch (error) {
      logError(error, "Couldn't load the URL as a vector layer");
      return false;
    }
  }

  return { addVectorLayerFromFile, addVectorLayerFromUrl };
}
