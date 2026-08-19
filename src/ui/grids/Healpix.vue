<script lang="ts" setup>
import * as healpixGeo from "healpix-geo";
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { onBeforeMount, onBeforeUnmount, ref, watch } from "vue";
import * as zarr from "zarrita";

import {
  useGridHoverLookup,
  type TGridHoverLookupResult,
} from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
  decodeVariableDataInPlace,
  getFillValue,
  getMissingValue,
} from "@/lib/data/variableDecoding.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  createTriangleWrapProjectionGeometry,
  createWrappedProjectionMesh,
  setupProjectionGeometryWrap,
  updateProjectionMeshes,
} from "@/lib/projection/projectionEdgeQuality.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  getColormapScaleOffset,
  makeGpuProjectedTextureMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
import type {
  TDimensionRange,
  TSources,
  TZarrDggsMetadata,
  TEllipsoid,
} from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import {
  HOVERED_GRID_POINT_STATUS,
  useGlobeControlStore,
} from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";
import {
  HISTOGRAM_SUMMARY_BINS,
  buildHistogramSummary,
  type THistogramSummary,
} from "@/utils/histogram.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

type TIndexingScheme = healpixGeo.GridOptions["scheme"];
class GridParameters {
  nside: number;
  indexingScheme: TIndexingScheme;
  ellipsoid: TEllipsoid;

  constructor(
    nside: number,
    indexingScheme: TIndexingScheme,
    ellipsoid: TEllipsoid
  ) {
    this.nside = nside;
    this.indexingScheme = indexingScheme;
    this.ellipsoid = ellipsoid;
  }
}
// By convention, HEALPIX uses -1.6375e+30 to mark invalid or unseen pixels.
const HEALPIX_UNSEEN = -1.6375e30;

function getHealpixMissingAndFillValues(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const missingValue = getMissingValue(datavar);
  const fillValue = getFillValue(datavar);
  if (Number.isNaN(missingValue)) {
    return { missingValue: HEALPIX_UNSEEN, fillValue };
  }
  if (Number.isNaN(fillValue)) {
    return { missingValue, fillValue: HEALPIX_UNSEEN };
  }
  return { missingValue, fillValue };
}

const store = useGlobeControlStore();
const { logError } = useLog();
const { varnameSelector, colormap, invertColormap, dimSlidersValues, varinfo } =
  storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

const {
  getScene,
  redraw,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  getDataVar,
  fetchDimensionDetails,
  updateLandSeaMask,
  updateColormap,
  updateHistogram,
  projectionHelper,
  isSceneInMotion,
  onProjectionChange,
  onMotionStateChange,
  onColormapChange,
  canvas,
  box,
  hoveredGeoPoint,
} = useSharedGridLogic();

const { setHoverLookup, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

const hoverData = ref<Float32Array | null>(null);
const hoverCellIndexMap = ref<Map<bigint, number> | null>(null);
const healpixGrid = ref<GridParameters | null>(null);
const gridPrepared = ref<boolean>(false);

// Reusable wasm handles: constructed once per component instance and freed on
// unmount, so the ellipsoid parsing and scheme dispatch happen outside the hot
// loops. GlobeView re-keys this component (`:key="globeKey"`) on any dataset or
// variable change, so a grid-parameter change is always a fresh mount rather
// than a rebuild in place. `dataGrid` lives at the dataset's level and scheme
// (hover lookups); `baseGrid` at level 0 for the 12 base-cell meshes, whose
// geometry is scheme-independent (nested ids 0..11).
let dataGrid: healpixGeo.Grid | null = null;
let baseGrid: healpixGeo.Grid | null = null;
// Set on unmount: `onBeforeMount` is async and Vue does not await it, so the
// tail of that hook can resume after the component is already gone.
let disposed = false;

const HEALPIX_NUMCHUNKS = 12;

let mainMeshes: Array<THREE.Mesh | undefined> = new Array(HEALPIX_NUMCHUNKS);

onColormapChange(() => updateColormap(mainMeshes));

onProjectionChange(updateMeshProjectionUniforms);
onMotionStateChange(updateMeshProjectionUniforms);

/**
 * Update projection uniforms on all mesh materials.
 * This is the fast path - no geometry rebuild needed.
 */
function updateMeshProjectionUniforms() {
  updateProjectionMeshes(mainMeshes, {
    redraw,
    projectionHelper: projectionHelper.value,
    isSceneInMotion: isSceneInMotion.value,
  });
}

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  clearHoverLookup,
  prepareDatasource: fetchGrid,
  updateLandSeaMask,
  updateColormap: () => updateColormap(mainMeshes),
});

function fetchGrid() {
  if (baseGrid === null) {
    throw new Error("failed to fetch grid parameters");
  }

  const gridStep = 64 + 1;
  try {
    for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ipix++) {
      const { geometry } = makeHealpixGeometry(
        baseGrid,
        BigInt(ipix),
        gridStep,
        projectionHelper.value
      );
      const mesh = mainMeshes[ipix];
      if (!mesh) {
        continue;
      }
      mesh.geometry.dispose();
      setupProjectionGeometryWrap(geometry);
      mesh.geometry = geometry;
    }
    // Update projection uniforms after geometry change
    updateMeshProjectionUniforms();
    redraw();
  } catch (error) {
    logError(error, "Could not fetch grid");
  }
}

async function getGridParameters(): Promise<GridParameters> {
  try {
    const crs = await ZarrDataManager.getCRSInfo(
      props.datasources!,
      varnameSelector.value
    );

    if ("grid_mapping_name" in crs.attrs) {
      return {
        nside: crs.attrs["healpix_nside"] as number,
        indexingScheme: "nested" as TIndexingScheme,
        ellipsoid: null,
      };
    }
  } catch {
    // ignore
  }

  const group = await ZarrDataManager.getParentGroup(
    props.datasources!,
    varnameSelector.value
  );
  if (!("dggs" in group.attrs)) {
    throw new Error("no grid metadata found");
  }
  const metadata = (group.attrs?.dggs as TZarrDggsMetadata) ?? {};
  if (!metadata) {
    throw new Error("grid metadata found but is empty");
  }
  const level = metadata["refinement_level"] as number;
  return {
    nside: 2 ** level,
    indexingScheme: metadata["indexing_scheme"] as TIndexingScheme,
    ellipsoid: metadata["ellipsoid"] ?? null,
  };
}

async function getCells() {
  let cellCoord = "cell";
  try {
    const group = await ZarrDataManager.getParentGroup(
      props.datasources!,
      varnameSelector.value
    );
    const metadata = (group.attrs["dggs"] as TZarrDggsMetadata) ?? {};

    const coordinate = metadata["coordinate"];
    if (coordinate) {
      cellCoord = coordinate;
    }
  } catch {
    // no dggs metadata found, continue with the default cell coordinate
  }

  try {
    const rawCells = (
      await ZarrDataManager.getVariableData(
        ZarrDataManager.getDatasetSource(
          props.datasources!,
          varnameSelector.value
        ),
        ZarrDataManager.resolveVariablePath(varnameSelector.value, cellCoord)
      )
    ).data as ArrayLike<number | bigint>;

    return Array.from(rawCells, (cell) => Number(cell));
  } catch {
    return undefined;
  }
}

function getHealpixChunkRange(ipix: number, numChunks: number, nside: number) {
  const chunksize = (12 * nside * nside) / numChunks;
  const pixelStart = ipix * chunksize;
  const pixelEnd = (ipix + 1) * chunksize;

  return { chunksize, pixelStart, pixelEnd };
}

async function fillGlobalHealpixChunkData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  localDimensionIndices: (number | zarr.Slice | null)[],
  pixelStart: number,
  pixelEnd: number,
  dataSlice: Float32Array
) {
  localDimensionIndices[localDimensionIndices.length - 1] = zarr.slice(
    pixelStart,
    pixelEnd
  );
  const data = (
    await ZarrDataManager.getVariableDataFromArray(
      datavar,
      localDimensionIndices
    )
  ).data as Float32Array;

  dataSlice.set(data);
}

async function fillLimitedAreaHealpixChunkData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  cellCoord: number[],
  localDimensionIndices: (number | zarr.Slice | null)[],
  pixelStart: number,
  pixelEnd: number,
  dataSlice: Float32Array
) {
  // Limited-area data case: need to map cellCoord to global positions
  dataSlice.fill(NaN);

  // Find which indices in cellCoord fall within this chunk's range
  const relevantIndices: number[] = [];
  const localPositions: number[] = [];

  for (let i = 0; i < cellCoord.length; i++) {
    const globalPixel = cellCoord[i];
    if (globalPixel >= pixelStart && globalPixel < pixelEnd) {
      relevantIndices.push(i); // Index in the data array
      localPositions.push(globalPixel - pixelStart); // Position in chunk
    }
  }

  // Only fetch data if this chunk has any relevant cells
  if (relevantIndices.length === 0) {
    return;
  }

  // Check if indices are contiguous for optimization
  const start = relevantIndices[0];
  const end = relevantIndices[relevantIndices.length - 1] + 1;
  localDimensionIndices[localDimensionIndices.length - 1] = zarr.slice(
    start,
    end
  );
  const data = (
    await ZarrDataManager.getVariableDataFromArray(
      datavar,
      localDimensionIndices
    )
  ).data as Float32Array;
  const isContiguous =
    relevantIndices.length > 1 &&
    relevantIndices[relevantIndices.length - 1] - relevantIndices[0] ===
      relevantIndices.length - 1;

  if (isContiguous) {
    // Contiguous: use slice for efficient fetching
    for (let i = 0; i < relevantIndices.length; i++) {
      dataSlice[localPositions[i]] = data[i];
    }
  } else {
    // Non-contiguous: fetch the entire range and skip what we don't need
    for (let i = 0; i < relevantIndices.length; i++) {
      const dataIdx = relevantIndices[i] - start;
      dataSlice[localPositions[i]] = data[dataIdx];
    }
  }
}

async function fillHealpixChunkData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  cellCoord: number[] | undefined,
  localDimensionIndices: (number | zarr.Slice | null)[],
  pixelStart: number,
  pixelEnd: number,
  dataSlice: Float32Array
) {
  if (cellCoord === undefined) {
    await fillGlobalHealpixChunkData(
      datavar,
      localDimensionIndices,
      pixelStart,
      pixelEnd,
      dataSlice
    );
  } else {
    await fillLimitedAreaHealpixChunkData(
      datavar,
      cellCoord,
      localDimensionIndices,
      pixelStart,
      pixelEnd,
      dataSlice
    );
  }
}

async function getHealpixData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  cellCoord: number[] | undefined, // Optional - undefined for global data
  ipix: number,
  numChunks: number,
  nside: number,
  dimensionIndices: (number | zarr.Slice | null)[]
) {
  const localDimensionIndices = dimensionIndices.slice();
  const { chunksize, pixelStart, pixelEnd } = getHealpixChunkRange(
    ipix,
    numChunks,
    nside
  );
  const dataSlice = new Float32Array(chunksize);

  await fillHealpixChunkData(
    datavar,
    cellCoord,
    localDimensionIndices,
    pixelStart,
    pixelEnd,
    dataSlice
  );

  const { missingValue, fillValue } = getHealpixMissingAndFillValues(datavar);
  const { min, max } = decodeVariableDataAndGetBounds(
    datavar,
    dataSlice,
    missingValue,
    fillValue
  );

  // Filter out missing and fill values before building histogram
  return {
    texture: data2texture(dataSlice, {}),
    histogramSummary: buildHistogramSummary(
      dataSlice,
      min,
      max,
      HISTOGRAM_SUMMARY_BINS,
      fillValue,
      missingValue
    ),
    min,
    max,
    missingValue,
    fillValue,
  };
}

function distanceSquared(
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number
): number {
  return (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1) + (z2 - z1) * (z2 - z1);
}

function createGeometry(
  positionValues: Float32Array,
  uv: Float32Array,
  latLonValues: Float32Array,
  indices: number[]
) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positionValues, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  // Add latLon attribute for GPU projection
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(latLonValues, 2)
  );
  return createTriangleWrapProjectionGeometry(geometry);
}

function generateHealpixIndices(positionValues: Float32Array, steps: number) {
  const indices = [];
  for (let i = 0; i < steps - 1; ++i) {
    for (let j = 0; j < steps - 1; ++j) {
      const a = i * steps + (j + 1);
      const b = i * steps + j;
      const c = (i + 1) * steps + j;
      const d = (i + 1) * steps + (j + 1);
      const dac2 = distanceSquared(
        positionValues[3 * a + 0],
        positionValues[3 * a + 1],
        positionValues[3 * a + 2],
        positionValues[3 * c + 0],
        positionValues[3 * c + 1],
        positionValues[3 * c + 2]
      );
      const dbd2 = distanceSquared(
        positionValues[3 * b + 0],
        positionValues[3 * b + 1],
        positionValues[3 * b + 2],
        positionValues[3 * d + 0],
        positionValues[3 * d + 1],
        positionValues[3 * d + 2]
      );
      if (dac2 < dbd2) {
        indices.push(a, c, d);
        indices.push(b, c, a);
      } else {
        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }
  }
  return indices;
}

function makeHealpixGeometry(
  grid: healpixGeo.Grid,
  ipix: bigint,
  steps: number,
  helper: ProjectionHelper
) {
  const vertexCount = steps * steps;
  const positionValues = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const latitudes = new Float32Array(vertexCount);
  const longitudes = new Float32Array(vertexCount);
  const latLonValues = new Float32Array(vertexCount * 2);
  let vertexIndex = 0;

  // One wasm call for the whole steps × steps subdivision: interleaved
  // [lon, lat, ...] with `i` outer and `j` inner, u = i / (steps - 1) —
  // the same layout as the loops below.
  const lonlats = grid.vertices(ipix, steps);

  for (let i = 0; i < steps; ++i) {
    const u = i / (steps - 1);
    for (let j = 0; j < steps; ++j) {
      const v = j / (steps - 1);
      const lon = lonlats[vertexIndex * 2];
      const lat = lonlats[vertexIndex * 2 + 1];

      latitudes[vertexIndex] = lat;
      longitudes[vertexIndex] = lon;
      const positionOffset = vertexIndex * 3;
      helper.projectLatLonToArrays(
        lat,
        lon,
        positionValues,
        positionOffset,
        latLonValues,
        vertexIndex * 2
      );
      const uvIndex = vertexIndex * 2;
      uv[uvIndex] = u;
      uv[uvIndex + 1] = v;
      vertexIndex++;
    }
  }

  const indices = generateHealpixIndices(positionValues, steps);
  const geometry = createGeometry(positionValues, uv, latLonValues, indices);
  return { geometry, latitudes, longitudes };
}

function getUnshuffleIndex(
  size: number,
  unshuffleIndex: { [key: number]: Float32Array }
): Float32Array {
  if (unshuffleIndex[size] === undefined) {
    // The z-order table only depends on `size`, so a throwaway
    // level-log2(size) grid produces it in a single wasm call; entry
    // `row * size + col` holds bitCombine(col, row). Float32 represents
    // these indices exactly through 2^24 (size 4096).
    const grid = new healpixGeo.Grid({
      scheme: "nested",
      level: Math.log2(size),
    });
    try {
      unshuffleIndex[size] = Float32Array.from(
        grid.bitCombineTable(size),
        Number
      );
    } finally {
      grid.free();
    }
  }
  return unshuffleIndex[size];
}

function unshuffleMortonArray(
  arr: Float32Array,
  unshuffleIndex: { [key: number]: Float32Array }
): Float32Array {
  const out = arr.slice(); // makes a copy
  const size = Math.floor(Math.sqrt(arr.length));
  const uidx = getUnshuffleIndex(size, unshuffleIndex);
  for (let i = 0; i < out.length; ++i) {
    out[i] = arr[uidx[i]];
  }
  return out;
}

function data2texture(
  arr: Float32Array,
  unshuffleIndex: { [key: number]: Float32Array }
) {
  const size = Math.floor(Math.sqrt(arr.length));
  arr = castDataVarToFloat32(arr);
  const mortonArr = unshuffleMortonArray(arr, unshuffleIndex);
  const texture = new THREE.DataTexture(
    mortonArr,
    size,
    size,
    THREE.RedFormat,
    THREE.FloatType,
    THREE.UVMapping
  );
  texture.needsUpdate = true;
  return texture;
}

async function prepareDimensionData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const dimensionNames = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  const { dimensionRanges, indices } = buildDimensionRangesAndIndices(
    datavar,
    dimensionNames,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    [datavar.shape.length - 1],
    varinfo.value?.dimRanges
  );

  return { dimensionRanges, indices };
}

async function getDimensionValues(
  dimensionRanges: TDimensionRange[],
  indices: (number | zarr.Slice | null)[]
) {
  const dimValues = await fetchDimensionDetails(
    varnameSelector.value,
    props.datasources!,
    dimensionRanges,
    indices
  );
  return dimValues;
}

async function processHealpixChunks(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  cellCoord: number[] | undefined,
  nside: number,
  indices: (number | zarr.Slice | null)[]
): Promise<{
  dataMin: number;
  dataMax: number;
  histogramSummaries: THistogramSummary[];
}> {
  let dataMin = Number.POSITIVE_INFINITY;
  let dataMax = Number.NEGATIVE_INFINITY;
  const histogramSummaries: THistogramSummary[] = [];

  await Promise.all(
    [...Array(HEALPIX_NUMCHUNKS).keys()].map(async (ipix) => {
      const texData = await getHealpixData(
        datavar,
        cellCoord,
        ipix,
        HEALPIX_NUMCHUNKS,
        nside,
        indices
      );
      if (texData === undefined) {
        const mesh = mainMeshes[ipix];
        if (!mesh) {
          return;
        }
        const material = mesh.material as THREE.ShaderMaterial;
        material.uniforms.data.value.dispose();
        return;
      }

      histogramSummaries.push(texData.histogramSummary);
      dataMin = dataMin > texData.min ? texData.min : dataMin;
      dataMax = dataMax < texData.max ? texData.max : dataMax;

      const mesh = mainMeshes[ipix];
      if (!mesh) {
        return;
      }
      const material = mesh.material as THREE.ShaderMaterial;
      material.uniforms.data.value.dispose();
      material.uniforms.data.value = texData.texture;

      redraw();
    })
  );

  return { dataMin, dataMax, histogramSummaries };
}

function healpixHoverLookup(
  lat: number,
  lon: number
): TGridHoverLookupResult | null {
  if (!hoverData.value || dataGrid === null) {
    return null;
  }

  const normalizedLon = ProjectionHelper.normalizeLongitude(lon);
  // The only inputs healpix-geo rejects here are non-finite longitudes and
  // latitudes outside [-90, 90] (longitude wrap is fine, exact poles are fine).
  // Check them explicitly rather than catching, so genuine errors still surface.
  if (!Number.isFinite(normalizedLon) || !(lat >= -90 && lat <= 90)) {
    return null;
  }
  const pixelIndex = dataGrid.lonLatToHealpix(
    new Float64Array([normalizedLon, lat])
  )[0];

  const dataIndex = hoverCellIndexMap.value
    ? hoverCellIndexMap.value.get(pixelIndex)
    : Number(pixelIndex);
  if (
    dataIndex === undefined ||
    dataIndex < 0 ||
    dataIndex >= hoverData.value.length
  ) {
    return {
      lat,
      lon: normalizedLon,
      value: null,
      status: HOVERED_GRID_POINT_STATUS.MISSING,
    };
  }
  const value = hoverData.value[dataIndex];
  const [pixelLon, pixelLat] = dataGrid.healpixToLonLat(
    new BigUint64Array([pixelIndex])
  );

  const isMissing = !Number.isFinite(value) || value === HEALPIX_UNSEEN;
  return {
    lat: pixelLat,
    lon: ProjectionHelper.normalizeLongitude(pixelLon),
    value: isMissing ? null : value,
    status: isMissing
      ? HOVERED_GRID_POINT_STATUS.MISSING
      : HOVERED_GRID_POINT_STATUS.VALUE,
  };
}

async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>
) {
  const { dimensionRanges, indices } = await prepareDimensionData(datavar);

  const cellCoord = await getCells();
  if (dataGrid === null) {
    throw new Error("no grid parameters available");
  }

  hoverData.value = castDataVarToFloat32(
    (await ZarrDataManager.getVariableDataFromArray(datavar, indices)).data
  );
  const { missingValue, fillValue } = getHealpixMissingAndFillValues(datavar);
  decodeVariableDataInPlace(
    hoverData.value,
    datavar.attrs,
    missingValue,
    fillValue
  );
  if (cellCoord) {
    const cellIndexMap = new Map<bigint, number>();
    for (let index = 0; index < cellCoord.length; index++) {
      cellIndexMap.set(BigInt(cellCoord[index]), index);
    }
    hoverCellIndexMap.value = cellIndexMap;
  } else {
    hoverCellIndexMap.value = null;
  }
  setHoverLookup(healpixHoverLookup);
  const { dataMin, dataMax, histogramSummaries } = await processHealpixChunks(
    datavar,
    cellCoord,
    dataGrid.nside,
    indices
  );

  updateHistogram(histogramSummaries, dataMin, dataMax);

  const dimInfo = await getDimensionValues(dimensionRanges, indices);

  store.updateVarInfo(
    {
      attrs: datavar.attrs,
      dimInfo,
      bounds: { low: dataMin, high: dataMax },
      dimRanges: dimensionRanges,
    },
    indices as number[]
  );
}

watch(healpixGrid, async () => {
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    const mesh = mainMeshes[ipix];
    if (mesh) {
      getScene()!.add(mesh);
    }
  }
});

// Returns the `[dataGrid, baseGrid]` pair described at the top of this module.
function makeGridHandles(
  grid: GridParameters
): [healpixGeo.Grid, healpixGeo.Grid] {
  return [
    new healpixGeo.Grid({
      scheme: grid.indexingScheme,
      level: Math.log2(grid.nside),
      ellipsoid: grid.ellipsoid,
    }),
    new healpixGeo.Grid({
      scheme: "nested",
      level: 0,
      ellipsoid: grid.ellipsoid,
    }),
  ];
}

onBeforeMount(async () => {
  const low = store.selection?.low as number;
  const high = store.selection?.high as number;
  const { addOffset, scaleFactor } = getColormapScaleOffset(
    low,
    high,
    invertColormap.value
  );

  const grid = await getGridParameters();
  if (disposed) {
    // Unmounted while the metadata fetch was in flight. Nothing has been
    // allocated yet, so bailing here both keeps the wasm handles below from
    // outliving the component and stops the mesh loop from stranding meshes
    // that `onBeforeUnmount` has already run past.
    return;
  }
  healpixGrid.value = grid;

  const [data, base] = makeGridHandles(grid);
  dataGrid = data;
  baseGrid = base;

  const gridStep = 64 + 1;
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    // Use GPU-projected material for instant projection center changes
    const material = makeGpuProjectedTextureMaterial(
      new THREE.Texture(),
      colormap.value,
      addOffset,
      scaleFactor
    );
    material.uniforms.useTriangleWrapCull.value = 1;
    // Set initial projection uniforms
    const helper = projectionHelper.value;
    updateProjectionUniforms(material, helper);

    const { geometry } = makeHealpixGeometry(
      baseGrid,
      BigInt(ipix),
      gridStep,
      projectionHelper.value
    );
    const mesh = createWrappedProjectionMesh(
      geometry,
      material,
      projectionHelper.value.type
    );
    mainMeshes[ipix] = mesh;
    // Disable frustum culling - GPU projection changes actual positions
    mesh.frustumCulled = false;
  }
  await datasourceUpdate();
  gridPrepared.value = true;
});

onBeforeUnmount(() => {
  disposed = true;
  for (let ipix = 0; ipix < HEALPIX_NUMCHUNKS; ++ipix) {
    const mesh = mainMeshes[ipix];
    if (!mesh) {
      continue;
    }
    mesh.geometry.dispose();
    const mat = mesh.material as THREE.ShaderMaterial;
    if (mat) {
      if (mat.uniforms?.data?.value?.dispose) {
        mat.uniforms.data.value.dispose();
      }
      mat.dispose();
    }
    getScene()?.remove(mesh);
    mainMeshes[ipix] = undefined;
  }
  dataGrid?.free();
  baseGrid?.free();
  dataGrid = null;
  baseGrid = null;
});

defineExpose({
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
});
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
