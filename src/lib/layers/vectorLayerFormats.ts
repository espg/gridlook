// Validation and naming for user-injected GeoJSON vector layers
// (mirrors textureLayerFormats.ts for the texture-layer upload path).

import type { FeatureCollection } from "geojson";

export const VECTOR_LAYER_MIME_TYPES = {
  GEOJSON: "application/geo+json",
  JSON: "application/json",
} as const;

export type TVectorLayerMimeType =
  (typeof VECTOR_LAYER_MIME_TYPES)[keyof typeof VECTOR_LAYER_MIME_TYPES];

export const VECTOR_LAYER_FILE_EXTENSIONS = {
  GEOJSON: ".geojson",
  JSON: ".json",
} as const;

export type TVectorLayerFileExtension =
  (typeof VECTOR_LAYER_FILE_EXTENSIONS)[keyof typeof VECTOR_LAYER_FILE_EXTENSIONS];

const SUPPORTED_VECTOR_LAYER_MIME_TYPES = Object.values(
  VECTOR_LAYER_MIME_TYPES
) as TVectorLayerMimeType[];

const SUPPORTED_VECTOR_LAYER_FILE_EXTENSIONS = Object.values(
  VECTOR_LAYER_FILE_EXTENSIONS
) as TVectorLayerFileExtension[];

export const VECTOR_LAYER_UPLOAD_ACCEPT = [
  ...SUPPORTED_VECTOR_LAYER_MIME_TYPES,
  ...SUPPORTED_VECTOR_LAYER_FILE_EXTENSIONS,
].join(",");

// generous cap: shardmap/footprint collections are a few MB; anything larger
// is a mistake and would stall triangulation
export const MAX_VECTOR_LAYER_BYTES = 50 * 1024 * 1024;

export function isSupportedVectorLayerFile(file: File) {
  const lowerName = file.name.toLowerCase();
  return (
    SUPPORTED_VECTOR_LAYER_MIME_TYPES.includes(
      file.type as TVectorLayerMimeType
    ) ||
    SUPPORTED_VECTOR_LAYER_FILE_EXTENSIONS.some((ext) =>
      lowerName.endsWith(ext)
    )
  );
}

function assertVectorLayerSize(bytes: number, label: string) {
  if (bytes > MAX_VECTOR_LAYER_BYTES) {
    const limitMb = MAX_VECTOR_LAYER_BYTES / (1024 * 1024);
    throw new Error(`${label} exceeds the ${limitMb} MB vector layer limit`);
  }
}

export function parseFeatureCollection(text: string): FeatureCollection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the file is not valid JSON");
  }
  const candidate = parsed as { type?: unknown; features?: unknown } | null;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    candidate.type !== "FeatureCollection"
  ) {
    throw new Error("the root object must be a GeoJSON FeatureCollection");
  }
  if (!Array.isArray(candidate.features)) {
    throw new Error("the FeatureCollection has no features array");
  }
  return parsed as FeatureCollection;
}

// layer display name from the URL basename (query/hash stripped)
export function vectorLayerNameFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, "");
  const base = path.split("/").pop() ?? "";
  let decoded = base;
  try {
    decoded = decodeURIComponent(base);
  } catch {
    /* keep the raw basename */
  }
  return decoded || "GeoJSON layer";
}

export async function readVectorLayerFile(
  file: File
): Promise<FeatureCollection> {
  assertVectorLayerSize(file.size, `"${file.name}"`);
  return parseFeatureCollection(await file.text());
}

export async function loadVectorLayerFromUrl(
  url: string
): Promise<FeatureCollection> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`the request failed with HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 0) {
    assertVectorLayerSize(contentLength, "the response");
  }
  const text = await response.text();
  assertVectorLayerSize(text.length, "the response");
  return parseFeatureCollection(text);
}
