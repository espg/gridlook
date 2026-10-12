import * as healpixGeo from "healpix-geo";
import * as THREE from "three";
import {
  computed,
  onScopeDispose,
  watch,
  type ComputedRef,
  type ShallowRef,
} from "vue";

import { CAMERA_VERTICAL_FOV_DEGREES } from "@/lib/camera/cameraSettings.ts";
import { viewHeightAt, type TPivotLeftDrag } from "@/lib/camera/pointPivot.ts";
import { currentLevel } from "@/lib/data/levels.ts";
import { storeReaders, type TLeafReaders } from "@/lib/digest/digestField.ts";
import { createByteLru } from "@/lib/digest/digestReader.ts";
import { strataBytesFactor } from "@/lib/digest/strata.ts";
import { healpixViewBlocks } from "@/lib/grids/healpixWindow.ts";
import { MORTON_STORE_ELLIPSOID } from "@/lib/morton/convention.ts";
import {
  decimatedCount,
  decimationStride,
  maxWindowChunks,
  NOISE_POINT_SIZE,
  OBSERVATION_CHUNK_BYTES,
  OBSERVATION_FETCH_CAP,
  OBSERVATION_MARGIN,
} from "@/lib/points/pointBudget.ts";
import {
  decimatePointChunk,
  decodePointChunk,
  pointChunkBytes,
  unitVector,
  withTimes,
  type TPointChunk,
} from "@/lib/points/pointChunk.ts";
import { neighbourhoodRange, pointRange } from "@/lib/points/pointRange.ts";
import {
  locationsArrayOf,
  pointArrayPath,
  pointTierSources,
  timesArrayOf,
  type TPointStratum,
} from "@/lib/points/pointSource.ts";
import { POINT_COLOURS, type TPointColour } from "@/lib/points/pointTimes.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import type { TViewFootprint } from "@/lib/projection/viewFootprint.ts";
import {
  getColormapScaleOffset,
  makeHeightPointMaterial,
} from "@/lib/shaders/gridShaders.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";
import type { useGridHistogram } from "@/ui/grids/composables/useGridHistogram.ts";

/** Device pixels of a point at the pivot's depth (clamped to 1..8). */
const POINT_PIXELS = 4;
/** Decoded chunks kept across windows, bytes. */
const POINT_CACHE_BYTES = 64 * 2 ** 20;
/** Drawn after the (hidden) level (0) and before the overlays. */
const POINT_RENDER_ORDER = 0.5;
/** The muted cloud is drawn first, so the signal's reads over it. */
const MUTED_RENDER_ORDER = 0.4;

type TPointLayerOptions = {
  getDatasources: () => TSources | undefined;
  getScene: () => THREE.Scene | undefined;
  redraw: () => void;
  registerUpdateLOD: (update: () => void) => void;
  onColormapChange: (callback: () => void) => void;
  updateColormap: (meshes: (THREE.Points | undefined)[]) => void;
  updateHistogram: ReturnType<typeof useGridHistogram>["updateHistogram"];
  /** The level's histogram again, when the tier is left. */
  restoreHistogram: () => void;
  projectionHelper: ComputedRef<ProjectionHelper>;
  pointPivot: {
    enter: () => void;
    leave: () => void;
    tiltTo: (degrees: number) => void;
    setHeight: (above: number) => void;
    setLeftDrag: (mode: TPivotLeftDrag) => void;
    ground: Readonly<ShallowRef<{ lat: number; lon: number } | null>>;
    direction: () => THREE.Vector3 | undefined;
    distance: () => number | undefined;
  };
};

/** A grid of the store's ellipsoid per order, made once. */
function createGrids() {
  const grids = new Map<number, healpixGeo.Grid>();
  return (order: number) => {
    let grid = grids.get(order);
    if (!grid) {
      grid = new healpixGeo.Grid({
        scheme: "nested",
        level: order,
        ellipsoid: MORTON_STORE_ELLIPSOID,
      });
      grids.set(order, grid);
    }
    return grid;
  };
}

/** The window's chunks nearest the centre first. */
function nearestFirst(
  chunks: number[],
  grid: healpixGeo.Grid,
  centre: { lat: number; lon: number }
) {
  const centres = grid.healpixToLonLat(
    BigUint64Array.from(chunks, (chunk) => BigInt(chunk))
  );
  const at = unitVector(centre.lon, centre.lat);
  const distance = chunks.map((_, i) => {
    const [x, y, z] = unitVector(centres[2 * i], centres[2 * i + 1]);
    return -(x * at[0] + y * at[1] + z * at[2]);
  });
  return chunks
    .map((chunk, index) => ({ chunk, index }))
    .sort((a, b) => distance[a.index] - distance[b.index])
    .map(({ chunk }) => chunk);
}

/** The drawn points: their places, heights and what colours them. */
function pointGeometry(drawn: TPointChunk, colour: TPointColour) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(drawn.offsets, 3)
  );
  geometry.setAttribute("height", new THREE.BufferAttribute(drawn.heights, 1));
  const values =
    colour === POINT_COLOURS.TIME && drawn.times ? drawn.times : drawn.heights;
  geometry.setAttribute("data_value", new THREE.BufferAttribute(values, 1));
  return geometry;
}

/**
 * The point tier (gridlook#21, phase A): past the finest derived level, the
 * observations of the leaf chunks under the view, drawn at their height in
 * place of that level, which the grid hides meanwhile (its data stays for
 * the probe). On while the store says so and the globe is drawn; the camera
 * then pivots on the ground (`pointPivot`). The chunks are those the finest
 * level reads for the same view, from the same caches, so a view that just
 * left it reads nothing new; over the point budget every k-th point of
 * every chunk is drawn. The colour range and the histogram are the drawn
 * values' (`pointRange`), heights or times (phase B: the times sibling is
 * read only when the colour asks for it), refreshed as the window changes,
 * until the tier is left and the level's rule again. The stratum choice
 * (strata.ts) says which digests are drawn: one cloud per stratum, the
 * noise of a `both` choice beneath the signal and muted, the range, the
 * histogram and the point budget over their union.
 */
// eslint-disable-next-line max-lines-per-function
export function usePointLayer(options: TPointLayerOptions) {
  const store = useGlobeControlStore();
  const { logError } = useLog();
  const gridAt = createGrids();
  const cache = createByteLru<TPointChunk>(POINT_CACHE_BYTES, pointChunkBytes);
  // the window on screen: one entry per stratum and chunk, decoded, what is
  // drawn of each (every stride-th point) and their objects
  const window = new Map<
    string,
    {
      source: TPointStratum;
      index: number;
      chunk: TPointChunk;
      drawn: TPointChunk;
      points: THREE.Points;
    }
  >();
  let loaded: { chunks: number[]; chunkOrder: number } | undefined;
  let stride = 1;
  // what the window cost so far, for the selector's readout
  let started = 0;
  let firstPointsMs: number | undefined;
  let decodeMs = 0;
  // the signal's material and the muted one, by `muted`
  const materials = new Map<boolean, THREE.ShaderMaterial>();
  let revision = 0;

  const sources = computed(() => {
    const sources = options.getDatasources();
    return sources
      ? pointTierSources(
          currentLevel(sources),
          store.varnameSelector,
          store.digestStratum
        )
      : [];
  });
  const active = computed(
    () =>
      store.pointTier &&
      !options.projectionHelper.value.isFlat &&
      sources.value.length > 0
  );

  const entryKey = (source: TPointStratum, index: number) =>
    `${source.array}/${index}`;
  const renderOrder = (source: TPointStratum) =>
    source.muted ? MUTED_RENDER_ORDER : POINT_RENDER_ORDER;

  function updateOpacity(material: THREE.ShaderMaterial, muted: boolean) {
    material.uniforms.pointOpacity.value =
      store.pointTierOpacity * (muted ? store.pointTierNoiseOpacity : 1);
  }

  function pointMaterial(muted: boolean) {
    let material = materials.get(muted);
    if (!material) {
      const { addOffset, scaleFactor } = getColormapScaleOffset(
        store.selection?.low as number,
        store.selection?.high as number,
        store.invertColormap
      );
      material = makeHeightPointMaterial(
        store.colormap,
        addOffset,
        scaleFactor,
        MORTON_STORE_ELLIPSOID.semi_major_axis
      );
      updateOpacity(material, muted);
      materials.set(muted, material);
    }
    return material;
  }

  function drawn() {
    return [...window.values()].map(({ points }) => points);
  }

  /** Scene units a height above the datum is drawn at (the shader's lift). */
  function lift(metres: number) {
    const material = materials.get(false) ?? materials.get(true);
    return (
      (metres * (material?.uniforms.heightExaggeration.value ?? 1)) /
      MORTON_STORE_ELLIPSOID.semi_major_axis
    );
  }

  function updatePointSize() {
    const distance = options.pointPivot.distance();
    if (distance === undefined) {
      return;
    }
    for (const [muted, material] of materials) {
      material.uniforms.basePointSize.value =
        POINT_PIXELS * (muted ? NOISE_POINT_SIZE : 1) * distance;
    }
  }

  function remove(key: string) {
    const entry = window.get(key);
    if (entry) {
      entry.points.geometry.dispose();
      options.getScene()?.remove(entry.points);
      window.delete(key);
    }
  }

  function clear() {
    revision++;
    for (const key of [...window.keys()]) {
      remove(key);
    }
    loaded = undefined;
    stride = 1;
    store.setPointTierStats(undefined);
    if (store.pointTierBounds) {
      store.setPointTierBounds(undefined);
      options.restoreHistogram();
    }
  }

  /**
   * The datum and the relief around the pivot: the lowest and highest
   * drawn height within the view's height of it, so a tilted view, which sees
   * farther, keeps the datum under the cloud. The points are lifted from
   * the datum; the pivot sits at the middle of the relief. A muted cloud
   * (the noise under `both`, spread over kilometres of height) is context
   * and does not move either: the signal's relief is the ground's.
   */
  function publishDatum() {
    const pivot = options.pointPivot.direction();
    const distance = options.pointPivot.distance();
    if (materials.size === 0 || !pivot || distance === undefined) {
      return;
    }
    const around = neighbourhoodRange(
      [...window.values()]
        .filter(({ source }) => !source.muted)
        .map(({ drawn }) => drawn),
      pivot.toArray(),
      viewHeightAt(distance, CAMERA_VERTICAL_FOV_DEGREES)
    );
    if (!around) {
      return;
    }
    for (const material of materials.values()) {
      material.uniforms.heightReference.value = around.min;
    }
    options.pointPivot.setHeight(lift((around.max - around.min) / 2));
  }

  /** The drawn heights' range and histogram, as the store's data range. */
  function publishRange() {
    publishDatum();
    const range = pointRange(
      drawn().map(
        ({ geometry }) =>
          geometry.getAttribute("data_value").array as Float32Array
      )
    );
    if (!range) {
      return;
    }
    store.setPointTierBounds({ low: range.low, high: range.high });
    options.updateHistogram(
      range.sample,
      range.sample[0],
      range.sample[range.sample.length - 1]
    );
  }

  function publishStats(complete: boolean) {
    let photons = 0;
    let drawn = 0;
    for (const { chunk } of window.values()) {
      photons += chunk.count;
      drawn += decimatedCount(chunk.count, stride);
    }
    store.setPointTierStats({
      chunks: (loaded?.chunks.length ?? 0) * sources.value.length,
      loaded: window.size,
      photons,
      drawn,
      stride,
      firstPointsMs,
      windowMs: complete ? performance.now() - started : undefined,
      decodeMs,
    });
  }

  function draw(source: TPointStratum, index: number, chunk: TPointChunk) {
    const scene = options.getScene();
    if (!scene) {
      return;
    }
    const drawn = decimatePointChunk(chunk, stride);
    const geometry = pointGeometry(drawn, store.pointTierColour);
    const key = entryKey(source, index);
    const entry = window.get(key);
    if (entry) {
      // the same array may go from muted to full strength (noise, after both)
      entry.points.geometry.dispose();
      entry.points.geometry = geometry;
      entry.points.material = pointMaterial(source.muted);
      entry.points.renderOrder = renderOrder(source);
      Object.assign(entry, { source, chunk, drawn });
      return;
    }
    const points = new THREE.Points(geometry, pointMaterial(source.muted));
    points.frustumCulled = false;
    points.renderOrder = renderOrder(source);
    points.position.set(...chunk.origin);
    scene.add(points);
    window.set(key, { source, index, chunk, drawn, points });
    options.updateColormap([points]);
  }

  /** Every chunk of the window at the stride its total asks for. */
  function redecimate() {
    let total = 0;
    for (const { chunk } of window.values()) {
      total += chunk.count;
    }
    const next = decimationStride(total, window.size);
    if (next === stride) {
      return;
    }
    stride = next;
    for (const { source, index, chunk } of window.values()) {
      draw(source, index, chunk);
    }
  }

  /** The chunks under the view plus the margin, nearest the pivot first. */
  function windowChunks(
    footprint: TViewFootprint,
    chunkOrder: number,
    margin: number
  ) {
    const grid = gridAt(chunkOrder);
    const centre = options.pointPivot.ground.value ?? {
      lat: footprint.centreLat,
      lon: footprint.centreLon,
    };
    // priced at every stratum the choice reads
    const chunks = healpixViewBlocks(
      grid,
      { ...footprint, centreLat: centre.lat, centreLon: centre.lon },
      margin,
      maxWindowChunks(
        OBSERVATION_FETCH_CAP,
        OBSERVATION_CHUNK_BYTES * strataBytesFactor(store.digestStratum).chunk
      ),
      0
    );
    return nearestFirst(chunks, grid, centre);
  }

  /** One chunk's points, decoded once per store. */
  async function decodedChunk(
    readers: TLeafReaders,
    from: TPointStratum,
    locations: string,
    chunkOrder: number,
    index: number
  ) {
    const key = `${from.store}/${from.dataset}/${from.array}/${index}`;
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    const [digest, located] = await Promise.all([
      readers.digests.chunk(pointArrayPath(from), index),
      readers.words.chunk(pointArrayPath(from, locations), index),
    ]);
    if (!digest || !located) {
      return undefined;
    }
    const centre = gridAt(chunkOrder).healpixToLonLat(
      BigUint64Array.of(BigInt(index))
    );
    const before = performance.now();
    const chunk = decodePointChunk(
      digest,
      located,
      unitVector(centre[0], centre[1]),
      gridAt
    );
    decodeMs += performance.now() - before;
    cache.set(key, chunk);
    return chunk;
  }

  /** One chunk's points, with their times when the colour asks for them. */
  async function pointChunk(
    readers: TLeafReaders,
    from: TPointStratum,
    arrays: { locations: string; times?: string; chunkOrder: number },
    index: number
  ) {
    const chunk = await decodedChunk(
      readers,
      from,
      arrays.locations,
      arrays.chunkOrder,
      index
    );
    if (
      !chunk ||
      chunk.times ||
      !arrays.times ||
      store.pointTierColour !== POINT_COLOURS.TIME
    ) {
      return chunk;
    }
    const timed = await readers.words.chunk(
      pointArrayPath(from, arrays.times),
      index
    );
    if (!timed) {
      return chunk;
    }
    const withTime = withTimes(chunk, timed);
    cache.set(`${from.store}/${from.dataset}/${from.array}/${index}`, withTime);
    return withTime;
  }

  /** The leaf readers and what the source's arrays are. */
  async function open(from: TPointStratum) {
    const readers = await storeReaders(from.store);
    if (!readers) {
      throw new Error("the point tier reads a hive store");
    }
    const metadata = await readers.store.get(
      `/${pointArrayPath(from)}/zarr.json`
    );
    const attributes = metadata
      ? JSON.parse(new TextDecoder().decode(metadata))
      : {};
    const locations = locationsArrayOf(attributes);
    if (!locations) {
      throw new Error(`${from.array} has no located centroids`);
    }
    const times = timesArrayOf(attributes);
    const { chunkCells } = await readers.digests.array(pointArrayPath(from));
    const chunkOrder = Number(from.dataset) - Math.log2(chunkCells) / 2;
    return { readers, arrays: { locations, times, chunkOrder } };
  }

  /** One chunk of one stratum, drawn as it lands. */
  async function land(
    opened: Awaited<ReturnType<typeof open>>,
    from: TPointStratum,
    index: number,
    request: number
  ) {
    const chunk = await pointChunk(opened.readers, from, opened.arrays, index);
    if (request !== revision || !chunk) {
      return;
    }
    firstPointsMs ??= performance.now() - started;
    draw(from, index, chunk);
    redecimate();
    updatePointSize();
    publishStats(false);
    publishRange();
    options.redraw();
  }

  async function loadWindow() {
    const from = sources.value;
    const footprint = store.viewFootprint;
    if (from.length === 0 || !footprint) {
      return;
    }
    const request = ++revision;
    started = performance.now();
    firstPointsMs = undefined;
    decodeMs = 0;
    const opened = await Promise.all(from.map(open));
    if (request !== revision) {
      return;
    }
    store.setPointTierTimed(
      opened.every(({ arrays }) => arrays.times !== undefined)
    );
    const chunkOrder = opened[0].arrays.chunkOrder;
    const chunks = windowChunks(footprint, chunkOrder, OBSERVATION_MARGIN);
    const wanted = new Set(
      from.flatMap((source) => chunks.map((index) => entryKey(source, index)))
    );
    for (const key of [...window.keys()]) {
      if (!wanted.has(key)) {
        remove(key);
      }
    }
    loaded = { chunks, chunkOrder };
    redecimate();
    // every read is issued at once (the store coalesces neighbours); each
    // chunk is drawn as it lands, thinned again when the total asks for it
    await Promise.all(
      opened.flatMap((source, s) =>
        chunks.map((index) => land(source, from[s], index, request))
      )
    );
    if (request === revision) {
      publishStats(true);
    }
  }

  function windowStale() {
    const footprint = store.viewFootprint;
    if (sources.value.length === 0 || !footprint) {
      return false;
    }
    if (loaded === undefined) {
      return true;
    }
    const current = new Set(loaded.chunks);
    return windowChunks(footprint, loaded.chunkOrder, 0).some(
      (chunk) => !current.has(chunk)
    );
  }

  function reload() {
    loadWindow().catch((error) =>
      logError(error, "Could not read the observations in view")
    );
  }

  watch(
    active,
    (on) => {
      if (on) {
        options.pointPivot.enter();
        reload();
      } else {
        options.pointPivot.leave();
        clear();
        options.redraw();
      }
    },
    { immediate: true }
  );
  watch([() => store.viewFootprint, options.pointPivot.ground], () => {
    if (active.value && windowStale()) {
      reload();
    }
  });
  // the colour choice: the window is drawn again, its times read if asked;
  // the stratum choice: the strata' chunks are read
  watch(
    () => [store.pointTierColour, store.digestStratum],
    () => {
      if (active.value) {
        reload();
      }
    }
  );
  // the opacity slider, the muted cloud at its fraction of it
  watch(
    () => store.pointTierOpacity,
    () => {
      for (const [muted, material] of materials) {
        updateOpacity(material, muted);
      }
      options.redraw();
    }
  );
  // the mode buttons: what a plain left drag does
  watch(
    () => store.pointTierLeftDrag,
    (mode) => options.pointPivot.setLeftDrag(mode),
    { immediate: true }
  );
  // the view buttons: the camera tilts to the oblique view, or back to the top
  watch(
    () => store.pointTierTilt,
    (request) => {
      if (request && active.value) {
        options.pointPivot.tiltTo(request.degrees);
      }
    }
  );
  // a level shown meanwhile (a slice, a window) brings its histogram along
  watch(
    () => store.varinfo,
    () => {
      if (active.value && window.size) {
        publishRange();
      }
    }
  );
  options.onColormapChange(() => options.updateColormap(drawn()));
  options.registerUpdateLOD(updatePointSize);
  onScopeDispose(() => {
    clear();
    for (const material of materials.values()) {
      material.dispose();
    }
  });

  return { active };
}
