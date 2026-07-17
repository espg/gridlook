import { storeToRefs } from "pinia";
import * as THREE from "three";
import { watch, type ComputedRef, type Ref } from "vue";

import {
  applyLayerStackPosition,
  createEquirectLayerMesh,
  createImageLayerTexture,
  disposeLayerMesh,
  updateEquirectLayerProjection,
  type TImageLayerTexture,
} from "@/lib/layers/equirectLayer.ts";
import { geojson2gpuLineSegmentsGeometry } from "@/lib/layers/geojson.ts";
import {
  applyVectorFeatureValues,
  geojson2gpuPolygonFillGeometry,
  polygonsToOutlines,
} from "@/lib/layers/geojsonPolygons.ts";
import {
  makeGpuProjectedLineMaterial,
  updateGpuProjectedLineMaterial,
} from "@/lib/layers/gpuProjectedLines.ts";
import {
  makeGpuProjectedPolygonMaterial,
  updateGpuProjectedPolygonChoropleth,
  updateGpuProjectedPolygonMaterial,
} from "@/lib/layers/gpuProjectedPolygons.ts";
import {
  getLandSeaMask,
  LAND_SEA_MASK_MODES,
  type TLandSeaMaskMode,
} from "@/lib/layers/landSeaMask.ts";
import { ResourceCache } from "@/lib/layers/ResourceCache.ts";
import { getTexture } from "@/lib/layers/textureStore.ts";
import {
  featurePropertyValues,
  resolveChoroplethRange,
} from "@/lib/layers/vectorChoropleth.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  COASTLINE_RESOLUTIONS,
  GRATICULE_SPACINGS,
  LAYER_KINDS,
  LAYER_OPACITY,
  useGlobeControlStore,
  VECTOR_LAYER_STYLE_DEFAULTS,
  type TCoastlineResolution,
  type TGraticuleSpacing,
  type TLayerEntry,
} from "@/store/store";

type UseGridOverlaysOptions = {
  projectionHelper: ComputedRef<ProjectionHelper>;
  showCoastLines: Ref<boolean>;
  showGraticules: Ref<boolean>;
  landSeaMaskChoice: Ref<TLandSeaMaskMode | undefined>;
  landSeaMaskUseTexture: Ref<boolean>;
  getScene: () => THREE.Scene | undefined;
  redraw: () => void;
};

type TOverlayLineStyle = {
  color: string;
  radius: number;
  zOffset: number;
};

const coastStyle: TOverlayLineStyle = {
  color: "#ffffff",
  radius: 1.002,
  zOffset: 0.01,
} as const;

const graticuleStyle: TOverlayLineStyle = {
  color: "#888888",
  radius: 1.002,
  zOffset: 0.01,
} as const;

const COASTLINE_GEOJSON_PATHS: Record<TCoastlineResolution, string> = {
  [COASTLINE_RESOLUTIONS.TEN_M]: "static/ne_10m_coastline.geojson",
  [COASTLINE_RESOLUTIONS.FIFTY_M]: "static/ne_50m_coastline.geojson",
};

// placement only; colors/opacity come from the layer entry's vectorStyle
const vectorFillPlacement = {
  radius: 1.001,
  zOffset: 0.008,
} as const;

const vectorStrokePlacement = {
  radius: 1.002,
  zOffset: 0.01,
} as const;

const GRATICULE_GEOJSON_PATHS: Record<TGraticuleSpacing, string> = {
  [GRATICULE_SPACINGS.FIFTEEN_DEGREES]: "static/ne_50m_graticules_15.geojson",
  [GRATICULE_SPACINGS.THIRTY_DEGREES]: "static/ne_50m_graticules_30.geojson",
};

/* eslint-disable-next-line max-lines-per-function */
export function useGridOverlays(options: UseGridOverlaysOptions) {
  const store = useGlobeControlStore();
  const {
    coastlineResolution,
    graticuleSpacing,
    showCoastLines,
    showGraticules,
  } = storeToRefs(store);

  const {
    projectionHelper,
    landSeaMaskChoice,
    landSeaMaskUseTexture,
    getScene,
    redraw,
  } = options;

  let coast: THREE.LineSegments | undefined = undefined;
  let graticules: THREE.LineSegments | undefined = undefined;
  let landSeaMask: THREE.Object3D | undefined = undefined;
  let coastlineUpdateId = 0;
  let graticuleUpdateId = 0;
  const textureLayerMeshes = new Map<string, THREE.Mesh>();
  const vectorLayerGroups = new Map<string, THREE.Group>();
  const textureCache = new Map<
    string,
    { maskMode: TLandSeaMaskMode; layerTexture: TImageLayerTexture }
  >();
  let textureLayersUpdating = false;
  let textureLayersDirty = false;
  let textureLayersPendingForceRebuild = false;

  watch(
    () => showCoastLines.value,
    () => {
      updateCoastlines();
    }
  );

  watch(
    () => showGraticules.value,
    () => {
      updateGraticules();
    }
  );

  watch(
    () => coastlineResolution.value,
    () => {
      resetCoastlines();
      void updateCoastlines();
    }
  );

  watch(
    () => graticuleSpacing.value,
    () => {
      resetGraticules();
      void updateGraticules();
    }
  );

  function getLineProjectionOptions(
    style: Pick<TOverlayLineStyle, "radius" | "zOffset">
  ) {
    return {
      radius: projectionHelper.value.isFlat ? 1 : style.radius,
      zOffset: projectionHelper.value.isFlat ? style.zOffset : 0,
    };
  }

  function updateLineProjection(
    line: THREE.LineSegments | undefined,
    style: TOverlayLineStyle
  ) {
    if (!line) {
      return;
    }

    updateGpuProjectedLineMaterial(
      line.material as THREE.ShaderMaterial,
      projectionHelper.value,
      getLineProjectionOptions(style)
    );
  }

  async function getCoastlines(updateId: number) {
    if (!coast) {
      const selectedResolution = coastlineResolution.value;
      const lineSegments = await createLineSegments(
        COASTLINE_GEOJSON_PATHS[selectedResolution],
        coastStyle,
        "coastlines"
      );
      if (
        updateId !== coastlineUpdateId ||
        selectedResolution !== coastlineResolution.value
      ) {
        disposeLineSegments(lineSegments);
        return undefined;
      }
      coast = lineSegments;
    }
    updateLineProjection(coast, coastStyle);
    return coast;
  }

  async function getGraticulesLayer(updateId: number) {
    if (!graticules) {
      const selectedSpacing = graticuleSpacing.value;
      const lineSegments = await createLineSegments(
        GRATICULE_GEOJSON_PATHS[selectedSpacing],
        graticuleStyle,
        "graticules"
      );
      if (
        updateId !== graticuleUpdateId ||
        selectedSpacing !== graticuleSpacing.value
      ) {
        disposeLineSegments(lineSegments);
        return undefined;
      }
      graticules = lineSegments;
    }
    updateLineProjection(graticules, graticuleStyle);
    return graticules;
  }

  async function createLineSegments(
    geojsonPath: string,
    style: TOverlayLineStyle,
    name: string
  ) {
    const coastlineData = await ResourceCache.loadGeoJSON(geojsonPath);
    const geometry = geojson2gpuLineSegmentsGeometry(
      coastlineData,
      projectionHelper.value,
      getLineProjectionOptions(style)
    );
    const material = makeGpuProjectedLineMaterial({
      color: style.color,
      ...getLineProjectionOptions(style),
    });
    const lineSegments = new THREE.LineSegments(geometry, material);
    lineSegments.name = name;
    lineSegments.renderOrder = 20;
    lineSegments.frustumCulled = false;
    updateLineProjection(lineSegments, style);
    return lineSegments;
  }

  function disposeLineSegments(lineSegments: THREE.LineSegments) {
    lineSegments.geometry.dispose();
    const material = lineSegments.material;
    if (Array.isArray(material)) {
      for (const item of material) {
        item.dispose();
      }
    } else {
      material.dispose();
    }
  }

  function resetCoastlines() {
    if (!coast) {
      return;
    }
    getScene()?.remove(coast);
    disposeLineSegments(coast);
    coast = undefined;
  }

  function resetGraticules() {
    if (!graticules) {
      return;
    }
    getScene()?.remove(graticules);
    disposeLineSegments(graticules);
    graticules = undefined;
  }

  async function updateCoastlines() {
    const updateId = ++coastlineUpdateId;
    const scene = getScene();
    if (!scene) {
      return;
    }
    if (showCoastLines.value === false) {
      if (coast) {
        scene.remove(coast);
      }
    } else {
      const lineSegments = await getCoastlines(updateId);
      if (
        !lineSegments ||
        updateId !== coastlineUpdateId ||
        store.showCoastLines === false
      ) {
        return;
      }
      scene.add(lineSegments);
    }
    applyLayerOrders();
    redraw();
  }

  async function updateGraticules() {
    const updateId = ++graticuleUpdateId;
    const scene = getScene();
    if (!scene) {
      return;
    }
    if (showGraticules.value === false) {
      if (graticules) {
        scene.remove(graticules);
      }
    } else {
      const lineSegments = await getGraticulesLayer(updateId);
      if (
        !lineSegments ||
        updateId !== graticuleUpdateId ||
        store.showGraticules === false
      ) {
        return;
      }
      scene.add(lineSegments);
    }
    applyLayerOrders();
    redraw();
  }

  async function updateLandSeaMask() {
    const choice = landSeaMaskChoice.value ?? LAND_SEA_MASK_MODES.OFF;
    const scene = getScene();
    if (landSeaMask) {
      scene?.remove(landSeaMask);
      if (landSeaMask instanceof THREE.Mesh) {
        disposeLayerMesh(landSeaMask);
      }
      landSeaMask = undefined;
    }
    if (choice === LAND_SEA_MASK_MODES.OFF) {
      redraw();
      return;
    }

    const mask = await getLandSeaMask(
      landSeaMaskChoice.value!,
      landSeaMaskUseTexture.value!,
      projectionHelper.value
    );
    landSeaMask = mask;
    if (landSeaMask) {
      scene?.add(landSeaMask);
    }
    applyLayerOrders();
    redraw();
  }

  /**
   * Apply render order and blending to all layer meshes from their position
   * in the layer stack relative to the data grid (renderOrder 0).
   * Layers above the grid land in 11.. (above the flat crop at 5). Layers
   * below the grid get negative orders (above the base surface at -10).
   */
  function applyLayerOrders() {
    const stack = store.layerStack;
    const gridIndex = stack.findIndex(
      (entry) => entry.kind === LAYER_KINDS.GRID
    );
    for (const [index, entry] of stack.entries()) {
      const layer = getLayerObject(entry);
      if (!layer) {
        continue;
      }
      const delta = gridIndex - index;
      const renderOrder = delta > 0 ? 10 + delta : Math.max(delta, -9);
      if (layer instanceof THREE.Mesh) {
        applyLayerStackPosition(
          layer,
          renderOrder,
          entry.opacity ?? LAYER_OPACITY.MAX
        );
      } else if (layer instanceof THREE.LineSegments) {
        applyLineStackPosition(layer, renderOrder);
      } else if (layer instanceof THREE.Group) {
        applyVectorStackPosition(layer, renderOrder);
      }
    }
  }

  function getLayerObject(entry: TLayerEntry) {
    if (entry.kind === LAYER_KINDS.COASTLINES) {
      return coast;
    }
    if (entry.kind === LAYER_KINDS.GRATICULES) {
      return graticules;
    }
    if (entry.kind === LAYER_KINDS.MASK) {
      return landSeaMask;
    }
    if (entry.kind === LAYER_KINDS.TEXTURE) {
      return textureLayerMeshes.get(entry.id);
    }
    if (entry.kind === LAYER_KINDS.VECTOR) {
      return vectorLayerGroups.get(entry.id);
    }
    return undefined;
  }

  function applyLineStackPosition(
    lineSegments: THREE.LineSegments,
    renderOrder: number
  ) {
    const material = lineSegments.material as THREE.ShaderMaterial;
    lineSegments.renderOrder = renderOrder;
    material.transparent = renderOrder > 0;
    material.needsUpdate = true;
  }

  function applyVectorStackPosition(group: THREE.Group, renderOrder: number) {
    for (const child of group.children) {
      if (child instanceof THREE.LineSegments) {
        // outlines draw just above their fill
        applyLineStackPosition(child, renderOrder + 0.5);
      } else if (child instanceof THREE.Mesh) {
        child.renderOrder = renderOrder;
      }
    }
  }

  async function getLayerTexture(entry: TLayerEntry) {
    const cached = textureCache.get(entry.id);
    if (cached && cached.maskMode === entry.maskMode) {
      return cached.layerTexture;
    }
    cached?.layerTexture.texture.dispose();
    textureCache.delete(entry.id);
    const stored = await getTexture(entry.id);
    if (!stored) {
      return undefined;
    }
    const layerTexture = await createImageLayerTexture(
      stored.blob,
      entry.maskMode,
      stored.name
    );
    textureCache.set(entry.id, { maskMode: entry.maskMode, layerTexture });
    return layerTexture;
  }

  // Removes the mesh but keeps the cached texture (disposed separately).
  function removeTextureLayerMesh(id: string) {
    const mesh = textureLayerMeshes.get(id);
    if (!mesh) {
      return;
    }
    getScene()?.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.ShaderMaterial).dispose();
    textureLayerMeshes.delete(id);
  }

  /**
   * Sync texture layer meshes with the store's layer stack.
   * Pass `forceRebuild` when the projection mode changed (the geometry type
   * differs between globe and flat projections).
   */
  async function updateTextureLayers(forceRebuild = false) {
    if (textureLayersUpdating) {
      textureLayersDirty = true;
      textureLayersPendingForceRebuild ||= forceRebuild;
      return;
    }
    textureLayersUpdating = true;
    try {
      await syncTextureLayers(forceRebuild);
    } finally {
      textureLayersUpdating = false;
    }
    if (textureLayersDirty) {
      const shouldForceRebuild = textureLayersPendingForceRebuild;
      textureLayersDirty = false;
      textureLayersPendingForceRebuild = false;
      await updateTextureLayers(shouldForceRebuild);
    }
  }

  async function syncTextureLayers(forceRebuild: boolean) {
    const scene = getScene();
    if (!scene) {
      return;
    }
    const entries = store.layerStack.filter(
      (entry) => entry.kind === LAYER_KINDS.TEXTURE
    );
    const wanted = new Set(entries.map((entry) => entry.id));

    for (const id of [...textureLayerMeshes.keys()]) {
      if (!wanted.has(id)) {
        removeTextureLayerMesh(id);
        textureCache.get(id)?.layerTexture.texture.dispose();
        textureCache.delete(id);
      }
    }

    for (const entry of entries) {
      const maskModeChanged =
        textureLayerMeshes.has(entry.id) &&
        textureCache.get(entry.id)?.maskMode !== entry.maskMode;
      if (forceRebuild || maskModeChanged) {
        removeTextureLayerMesh(entry.id);
      }
      let mesh = textureLayerMeshes.get(entry.id);
      if (!mesh && entry.visible) {
        const layerTexture = await getLayerTexture(entry);
        if (!layerTexture) {
          continue;
        }
        mesh = createEquirectLayerMesh(
          layerTexture.texture,
          projectionHelper.value,
          `textureLayer:${entry.id}`,
          layerTexture.bounds
        );
        textureLayerMeshes.set(entry.id, mesh);
        scene.add(mesh);
      }
      if (mesh) {
        mesh.visible = entry.visible;
      }
    }

    applyLayerOrders();
    redraw();
  }

  function getFillProjectionOptions() {
    return {
      radius: projectionHelper.value.isFlat ? 1 : vectorFillPlacement.radius,
      zOffset: projectionHelper.value.isFlat ? vectorFillPlacement.zOffset : 0,
    };
  }

  function getVectorStyle(entry: TLayerEntry) {
    return entry.vectorStyle ?? VECTOR_LAYER_STYLE_DEFAULTS;
  }

  function createVectorLayerGroup(entry: TLayerEntry) {
    const data = entry.vectorData;
    if (!data) {
      return undefined;
    }
    const helper = projectionHelper.value;
    const style = getVectorStyle(entry);
    const fill = new THREE.Mesh(
      geojson2gpuPolygonFillGeometry(data, helper, getFillProjectionOptions()),
      makeGpuProjectedPolygonMaterial({
        color: style.fillColor,
        opacity: style.fillOpacity,
        ...getFillProjectionOptions(),
      })
    );
    fill.name = `vectorFill:${entry.id}`;
    fill.frustumCulled = false;
    const outline = new THREE.LineSegments(
      geojson2gpuLineSegmentsGeometry(
        polygonsToOutlines(data),
        helper,
        getLineProjectionOptions(vectorStrokePlacement)
      ),
      makeGpuProjectedLineMaterial({
        color: style.strokeColor,
        ...getLineProjectionOptions(vectorStrokePlacement),
      })
    );
    outline.name = `vectorOutline:${entry.id}`;
    outline.frustumCulled = false;
    const group = new THREE.Group();
    group.name = `vectorLayer:${entry.id}`;
    group.add(fill, outline);
    return group;
  }

  // style changes are pure uniform updates; geometry is never rebuilt (a
  // colorBy change refills the featureValue attribute, nothing more)
  function applyVectorLayerStyle(group: THREE.Group, entry: TLayerEntry) {
    const style = getVectorStyle(entry);
    for (const child of group.children) {
      const material = (child as THREE.Mesh | THREE.LineSegments)
        .material as THREE.ShaderMaterial;
      if (child instanceof THREE.LineSegments) {
        (material.uniforms.lineColor.value as THREE.Color).set(
          style.strokeColor
        );
      } else if (child instanceof THREE.Mesh) {
        (material.uniforms.fillColor.value as THREE.Color).set(style.fillColor);
        material.uniforms.fillOpacity.value = style.fillOpacity;
        applyVectorChoropleth(child, entry, style);
      }
    }
  }

  // Per-feature values ride the featureValue attribute (raw property values,
  // refilled only when colorBy changes); colormap and range are uniforms.
  function applyVectorChoropleth(
    mesh: THREE.Mesh,
    entry: TLayerEntry,
    style: ReturnType<typeof getVectorStyle>
  ) {
    const material = mesh.material as THREE.ShaderMaterial;
    const data = entry.vectorData;
    if (!data || !style.colorBy) {
      delete mesh.userData.choroplethProperty;
      delete mesh.userData.choroplethValues;
      updateGpuProjectedPolygonChoropleth(material, undefined);
      return;
    }
    if (mesh.userData.choroplethProperty !== style.colorBy) {
      const values = featurePropertyValues(data, style.colorBy);
      applyVectorFeatureValues(mesh.geometry, values);
      mesh.userData.choroplethProperty = style.colorBy;
      mesh.userData.choroplethValues = values;
    }
    const range = resolveChoroplethRange(
      mesh.userData.choroplethValues as Float32Array,
      style
    );
    updateGpuProjectedPolygonChoropleth(
      material,
      range ? { colormap: style.colormap, ...range } : undefined
    );
  }

  function updateVectorGroupProjection(group: THREE.Group) {
    for (const child of group.children) {
      if (child instanceof THREE.LineSegments) {
        updateGpuProjectedLineMaterial(
          child.material as THREE.ShaderMaterial,
          projectionHelper.value,
          getLineProjectionOptions(vectorStrokePlacement)
        );
      } else if (child instanceof THREE.Mesh) {
        updateGpuProjectedPolygonMaterial(
          child.material as THREE.ShaderMaterial,
          projectionHelper.value,
          getFillProjectionOptions()
        );
      }
    }
  }

  function removeVectorLayerGroup(id: string) {
    const group = vectorLayerGroups.get(id);
    if (!group) {
      return;
    }
    getScene()?.remove(group);
    for (const child of group.children) {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.ShaderMaterial).dispose();
      }
    }
    vectorLayerGroups.delete(id);
  }

  /**
   * Sync vector layer groups (fill mesh + outline lines) with the store's
   * layer stack. Geometry is GPU-projected from lat/lon attributes, so
   * projection changes only need material uniform updates, no rebuilds.
   */
  function updateVectorLayers() {
    const scene = getScene();
    if (!scene) {
      return;
    }
    const entries = store.layerStack.filter(
      (entry) => entry.kind === LAYER_KINDS.VECTOR
    );
    const wanted = new Set(entries.map((entry) => entry.id));

    for (const id of [...vectorLayerGroups.keys()]) {
      if (!wanted.has(id)) {
        removeVectorLayerGroup(id);
      }
    }

    for (const entry of entries) {
      let group = vectorLayerGroups.get(entry.id);
      if (!group) {
        group = createVectorLayerGroup(entry);
        if (!group) {
          continue;
        }
        vectorLayerGroups.set(entry.id, group);
        scene.add(group);
      }
      group.visible = entry.visible;
      applyVectorLayerStyle(group, entry);
      updateVectorGroupProjection(group);
    }

    applyLayerOrders();
    redraw();
  }

  function updateLayerProjectionUniforms() {
    if (landSeaMask) {
      updateEquirectLayerProjection(landSeaMask, projectionHelper.value);
    }
    for (const mesh of textureLayerMeshes.values()) {
      updateEquirectLayerProjection(mesh, projectionHelper.value);
    }
    for (const group of vectorLayerGroups.values()) {
      updateVectorGroupProjection(group);
    }
    redraw();
  }

  async function updateOverlayProjectionUniforms(forceRebuild = false) {
    if (forceRebuild) {
      await Promise.all([updateCoastlines(), updateGraticules()]);
      return;
    }
    updateLineProjection(coast, coastStyle);
    updateLineProjection(graticules, graticuleStyle);
    redraw();
  }

  return {
    updateCoastlines,
    updateGraticules,
    updateLandSeaMask,
    updateTextureLayers,
    updateVectorLayers,
    updateLayerProjectionUniforms,
    updateOverlayProjectionUniforms,
  };
}
