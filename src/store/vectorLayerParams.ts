// Serialization for the `vectorlayers` URL parameter: URL-sourced vector
// layers (source URL + per-layer style/choropleth state) round-trip through
// the hash so a hub launcher can deep-link a shardmap + catalog view.
// File/drag-drop layers have no reachable source and stay session-only.
//
// The value is base64url-encoded JSON, matching the camerastate convention:
// changeURLHash re-serializes decoded parameter values verbatim on every
// hash write, so the alphabet must survive that cycle (no '&', ':', '=').

import { availableColormaps } from "@/lib/shaders/colormapShaders.ts";
import {
  LAYER_KINDS,
  type TLayerEntry,
  type TVectorLayerStyle,
} from "@/store/store.ts";

export type TVectorLayerSpec = {
  url: string;
  visible?: boolean;
  style?: Partial<TVectorLayerStyle>;
};

const STRING_STYLE_KEYS = ["fillColor", "strokeColor", "colorBy"] as const;
const NUMBER_STYLE_KEYS = ["fillOpacity", "rangeLow", "rangeHigh"] as const;

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (base64.length % 4)) % 4;
  const binary = atob(`${base64}${"=".repeat(paddingLength)}`);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (c) => c.charCodeAt(0))
  );
}

// keep only known style keys with plausible values; an unknown colormap
// would index past the shader LUT, so it falls back to the default instead
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
    if (typeof source[key] === "number" && Number.isFinite(source[key])) {
      clean[key] = source[key];
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

/** URL-sourced vector layers of the stack, top → bottom. */
export function vectorLayerSpecsFromStack(
  stack: TLayerEntry[]
): TVectorLayerSpec[] {
  return stack
    .filter(
      (entry) => entry.kind === LAYER_KINDS.VECTOR && entry.vectorSourceUrl
    )
    .map((entry) => ({
      url: entry.vectorSourceUrl!,
      visible: entry.visible,
      style: entry.vectorStyle ? sanitizeStyle(entry.vectorStyle) : undefined,
    }));
}

/** Empty string when there is nothing to encode (deletes the parameter). */
export function encodeVectorLayersParam(specs: TVectorLayerSpec[]): string {
  if (specs.length === 0) {
    return "";
  }
  return base64UrlEncode(JSON.stringify(specs));
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
  for (const item of parsed) {
    const candidate = item as { url?: unknown; visible?: unknown } | null;
    if (!candidate || typeof candidate.url !== "string" || !candidate.url) {
      continue;
    }
    specs.push({
      url: candidate.url,
      visible:
        typeof candidate.visible === "boolean" ? candidate.visible : true,
      style: sanitizeStyle((item as { style?: unknown }).style),
    });
  }
  return specs;
}
