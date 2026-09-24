// Serialization for the `vectorlayers` URL parameter: URL-sourced vector
// layers (source URL + per-layer visibility, opacity and style) round-trip
// through the hash so a view can be deep-linked. File/drag-drop layers have
// no reachable source and stay session-only.
//
// The value is base64url-encoded JSON (like the volume state). Keys are
// emitted in a fixed order so re-encoding an unchanged stack is byte-stable,
// which keeps the URL watcher and the hash-change restore from feeding each
// other.

import { availableColormaps } from "@/lib/shaders/colormapShaders.ts";
import {
  LAYER_KINDS,
  VECTOR_LAYER_OPACITY,
  type TLayerEntry,
  type TVectorLayerStyle,
} from "@/store/store.ts";
import { base64UrlDecode, base64UrlEncode } from "@/utils/base64Url.ts";

export type TVectorLayerSpec = {
  url: string;
  visible?: boolean;
  opacity?: number;
  style?: Partial<TVectorLayerStyle>;
};

const STRING_STYLE_KEYS = ["fillColor", "strokeColor", "colorBy"] as const;
const NUMBER_STYLE_KEYS = ["rangeLow", "rangeHigh"] as const;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// keep only known style keys with plausible values; an unknown colormap
// would index past the shader LUT, so it is dropped instead
function sanitizeStyle(style: unknown): Partial<TVectorLayerStyle> {
  if (!style || typeof style !== "object") {
    return {};
  }
  const source = style as Record<string, unknown>;
  const clean: Partial<TVectorLayerStyle> = {};
  for (const key of STRING_STYLE_KEYS) {
    if (typeof source[key] === "string") {
      clean[key] = source[key];
    }
  }
  for (const key of NUMBER_STYLE_KEYS) {
    const value = finiteNumber(source[key]);
    if (value !== undefined) {
      clean[key] = value;
    }
  }
  if (
    typeof source.colormap === "string" &&
    source.colormap in availableColormaps
  ) {
    clean.colormap = source.colormap as TVectorLayerStyle["colormap"];
  }
  return clean;
}

/** URL-sourced vector layers of the stack, top to bottom. */
export function vectorLayerSpecsFromStack(
  stack: TLayerEntry[]
): TVectorLayerSpec[] {
  const specs: TVectorLayerSpec[] = [];
  for (const entry of stack) {
    if (entry.kind === LAYER_KINDS.VECTOR && entry.vectorSourceUrl) {
      specs.push(
        normalizeSpec({
          url: entry.vectorSourceUrl,
          visible: entry.visible,
          opacity: entry.opacity,
          style: entry.vectorStyle,
        })
      );
    }
  }
  return specs;
}

// canonical key order and complete keys, so equal specs always encode to the
// same string: an omitted opacity normalizes to the default the layer restores
// at, otherwise the first re-encode of a hand-written link would differ from
// the link itself
function normalizeSpec(spec: TVectorLayerSpec): TVectorLayerSpec {
  return {
    url: spec.url,
    visible: spec.visible ?? true,
    opacity: finiteNumber(spec.opacity) ?? VECTOR_LAYER_OPACITY,
    style: sanitizeStyle(spec.style),
  };
}

/** Empty string when there is nothing to encode (deletes the parameter). */
export function encodeVectorLayersParam(specs: TVectorLayerSpec[]): string {
  if (specs.length === 0) {
    return "";
  }
  return base64UrlEncode(JSON.stringify(specs.map(normalizeSpec)));
}

/** Tolerant decode: malformed input yields no layers, never a throw. */
export function decodeVectorLayersParam(encoded: string): TVectorLayerSpec[] {
  if (!encoded) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(encoded));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const specs: TVectorLayerSpec[] = [];
  for (const item of parsed as Record<string, unknown>[]) {
    if (!item || typeof item.url !== "string" || !item.url) {
      continue;
    }
    specs.push(
      normalizeSpec({
        url: item.url,
        visible: typeof item.visible === "boolean" ? item.visible : true,
        opacity: item.opacity as number | undefined,
        style: item.style as Partial<TVectorLayerStyle> | undefined,
      })
    );
  }
  return specs;
}
