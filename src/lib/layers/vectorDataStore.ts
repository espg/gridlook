// In-memory registry of the GeoJSON behind vector layers, keyed by layer id.
// The layer entry in the store carries only the id, mirroring how texture
// layers keep their blobs out of the stack: the stack is cloned through JSON
// by `resetExcept` on every source change, which would deep-copy the whole
// FeatureCollection, strip `markRaw` from it (Vue defines `__v_skip`
// non-enumerably) and change its identity, breaking the WeakMap pick-index
// cache keyed on it.

import type { FeatureCollection } from "geojson";

const vectorLayerData = new Map<string, FeatureCollection>();

export function setVectorLayerData(id: string, data: FeatureCollection) {
  vectorLayerData.set(id, data);
}

export function getVectorLayerData(id: string) {
  return vectorLayerData.get(id);
}

export function deleteVectorLayerData(id: string) {
  vectorLayerData.delete(id);
}
