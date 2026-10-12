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
import {
  POINT_PIVOT_TILTS,
  type TPivotLeftDrag,
} from "@/lib/camera/pointPivot.ts";
import { currentLevel } from "@/lib/data/levels.ts";
import { storeReaders, type TLeafReaders } from "@/lib/digest/digestField.ts";
import { createByteLru } from "@/lib/digest/digestReader.ts";
import { healpixViewBlocks } from "@/lib/grids/healpixWindow.ts";
import { MORTON_STORE_ELLIPSOID } from "@/lib/morton/convention.ts";
import { viewHeightAt } from "@/lib/points/pointAxes.ts";
import {
  decimatedCount,
  decimationStride,
  maxWindowChunks,
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
  pointTierSource,
  timesArrayOf,
  type TPointSource,
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
import { usePointAxes } from "@/ui/grids/composables/usePointAxes.ts";

/** Device pixels of a point at the pivot's depth (clamped to 1..8). */
const POINT_PIXELS = 4;
/** Decoded chunks kept across windows, bytes. */
const POINT_CACHE_BYTES = 64 * 2 ** 20;
/** Drawn after the (hidden) level (0) and before the overlays. */
const POINT_RENDER_ORDER = 0.5;

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
    tiltTo: (degrees: number, fitHeight?: number) => void;
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
 * until the tier is left and the level's rule again.
 */
// eslint-disable-next-line max-lines-per-function
export function usePointLayer(options: TPointLayerOptions) {
  const store = useGlobeControlStore();
  const { logError } = useLog();
  const gridAt = createGrids();
  const cache = createByteLru<TPointChunk>(POINT_CACHE_BYTES, pointChunkBytes);
  const axes = usePointAxes({ getScene: options.getScene });
  // the window on screen: its chunks, decoded, what is drawn of each
  // (every stride-th point) and their objects
  const window = new Map<
    number,
    { chunk: TPointChunk; drawn: TPointChunk; points: THREE.Points }
  >();
  let loaded: { chunks: number[]; chunkOrder: number } | undefined;
  let stride = 1;
  // what the window cost so far, for the selector's readout
  let started = 0;
  let firstPointsMs: number | undefined;
  let decodeMs = 0;
  let material: THREE.ShaderMaterial | undefined;
  let revision = 0;
  // the relief around the pivot, metres above the datum: the pivot sits at
  // its middle, a profile fits it
  let band: { low: number; high: number } | undefined;

  const source = computed(() => {
    const sources = options.getDatasources();
    return sources
      ? pointTierSource(currentLevel(sources), store.varnameSelector)
      : undefined;
  });
  const active = computed(
    () =>
      store.pointTier &&
      !options.projectionHelper.value.isFlat &&
      source.value !== undefined
  );

  function pointMaterial() {
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
    }
    return material;
  }

  function drawn() {
    return [...window.values()].map(({ points }) => points);
  }

  /** Scene units a height above the datum is drawn at (the shader's lift). */
  function lift(metres: number) {
    return (
      (metres * (material?.uniforms.heightExaggeration.value ?? 1)) /
      MORTON_STORE_ELLIPSOID.semi_major_axis
    );
  }

  /** The point size and the axes follow the camera's distance to the pivot. */
  function updatePointSize() {
    const distance = options.pointPivot.distance();
    const pivot = options.pointPivot.direction();
    if (!material || distance === undefined || !pivot) {
      axes.update(undefined);
      return;
    }
    material.uniforms.basePointSize.value = POINT_PIXELS * distance;
    axes.update({
      pivot,
      distance,
      exaggeration: material.uniforms.heightExaggeration.value,
    });
  }

  function remove(index: number) {
    const entry = window.get(index);
    if (entry) {
      entry.points.geometry.dispose();
      options.getScene()?.remove(entry.points);
      window.delete(index);
    }
  }

  function clear() {
    revision++;
    for (const index of [...window.keys()]) {
      remove(index);
    }
    loaded = undefined;
    stride = 1;
    band = undefined;
    axes.update(undefined);
    store.setPointTierStats(undefined);
    if (store.pointTierBounds) {
      store.setPointTierBounds(undefined);
      options.restoreHistogram();
    }
  }

  /**
   * The datum and the relief around the pivot: the lowest and highest
   * drawn height within the view's height of it, so a profile, which sees
   * to the horizon, keeps the datum under the cloud. The points are lifted
   * from the datum; the pivot sits at the middle of the relief.
   */
  function publishDatum() {
    const pivot = options.pointPivot.direction();
    const distance = options.pointPivot.distance();
    if (!material || !pivot || distance === undefined) {
      return;
    }
    const around = neighbourhoodRange(
      [...window.values()].map(({ drawn }) => drawn),
      pivot.toArray(),
      viewHeightAt(distance, CAMERA_VERTICAL_FOV_DEGREES)
    );
    if (!around) {
      return;
    }
    material.uniforms.heightReference.value = around.min;
    band = { low: 0, high: around.max - around.min };
    options.pointPivot.setHeight(lift(band.high / 2));
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
      chunks: loaded?.chunks.length ?? 0,
      loaded: window.size,
      photons,
      drawn,
      stride,
      firstPointsMs,
      windowMs: complete ? performance.now() - started : undefined,
      decodeMs,
    });
  }

  function draw(index: number, chunk: TPointChunk) {
    const scene = options.getScene();
    if (!scene) {
      return;
    }
    const drawn = decimatePointChunk(chunk, stride);
    const geometry = pointGeometry(drawn, store.pointTierColour);
    const entry = window.get(index);
    if (entry) {
      entry.points.geometry.dispose();
      entry.points.geometry = geometry;
      entry.chunk = chunk;
      entry.drawn = drawn;
      return;
    }
    const points = new THREE.Points(geometry, pointMaterial());
    points.frustumCulled = false;
    points.renderOrder = POINT_RENDER_ORDER;
    points.position.set(...chunk.origin);
    scene.add(points);
    window.set(index, { chunk, drawn, points });
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
    for (const [index, { chunk }] of window) {
      draw(index, chunk);
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
    const chunks = healpixViewBlocks(
      grid,
      { ...footprint, centreLat: centre.lat, centreLon: centre.lon },
      margin,
      maxWindowChunks(),
      0
    );
    return nearestFirst(chunks, grid, centre);
  }

  /** One chunk's points, decoded once per store. */
  async function decodedChunk(
    readers: TLeafReaders,
    from: TPointSource,
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
    from: TPointSource,
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
  async function open(from: TPointSource) {
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

  async function loadWindow() {
    const from = source.value;
    const footprint = store.viewFootprint;
    if (!from || !footprint) {
      return;
    }
    const request = ++revision;
    started = performance.now();
    firstPointsMs = undefined;
    decodeMs = 0;
    const { readers, arrays } = await open(from);
    if (request !== revision) {
      return;
    }
    store.setPointTierTimed(arrays.times !== undefined);
    const chunkOrder = arrays.chunkOrder;
    const chunks = windowChunks(footprint, chunkOrder, OBSERVATION_MARGIN);
    const wanted = new Set(chunks);
    for (const index of [...window.keys()]) {
      if (!wanted.has(index)) {
        remove(index);
      }
    }
    loaded = { chunks, chunkOrder };
    redecimate();
    // every read is issued at once (the store coalesces neighbours); each
    // chunk is drawn as it lands, thinned again when the total asks for it
    await Promise.all(
      chunks.map(async (index) => {
        const chunk = await pointChunk(readers, from, arrays, index);
        if (request !== revision || !chunk) {
          return;
        }
        firstPointsMs ??= performance.now() - started;
        draw(index, chunk);
        redecimate();
        updatePointSize();
        publishStats(false);
        publishRange();
        options.redraw();
      })
    );
    if (request === revision) {
      publishStats(true);
    }
  }

  function windowStale() {
    const from = source.value;
    const footprint = store.viewFootprint;
    if (!from || !footprint) {
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
  // the colour choice: the window is drawn again, its times read if asked
  watch(
    () => store.pointTierColour,
    () => {
      if (active.value) {
        reload();
      }
    }
  );
  // the mode buttons: what a plain left drag does
  watch(
    () => store.pointTierLeftDrag,
    (mode) => options.pointPivot.setLeftDrag(mode),
    { immediate: true }
  );
  // the view buttons: the camera tilts to a profile, framing the drawn
  // heights' band, or back to the top
  watch(
    () => store.pointTierTilt,
    (request) => {
      if (request && active.value) {
        const fit =
          request.degrees === POINT_PIVOT_TILTS.PROFILE && band
            ? lift(band.high - band.low)
            : undefined;
        options.pointPivot.tiltTo(request.degrees, fit);
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
    material?.dispose();
  });

  return { active };
}
