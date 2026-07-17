import * as THREE from "three";

import gpuProjectedPolygonFragmentShader from "@/lib/layers/glsl/gpuProjectedPolygon.frag.glsl";
import gpuProjectedPolygonVertexShader from "@/lib/layers/glsl/gpuProjectedPolygon.vert.glsl";
import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import {
  AZIMUTHAL_CLIP_ANGLE,
  type ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";
import {
  availableColormaps,
  type TColorMap,
} from "@/lib/shaders/colormapShaders.ts";
import { getColormapScaleOffset } from "@/lib/shaders/gridShaders.ts";

type TGpuProjectedPolygonOptions = {
  color: THREE.ColorRepresentation;
  opacity: number;
  radius: number;
  zOffset: number;
};

export type TGpuPolygonChoropleth = {
  colormap: TColorMap;
  low: number;
  high: number;
};

const OVERLAY_AZIMUTHAL_CLIP_MARGIN_DEGREES = 1.0;

export function makeGpuProjectedPolygonMaterial(
  options: TGpuProjectedPolygonOptions
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      fillColor: { value: new THREE.Color(options.color) },
      fillOpacity: { value: options.opacity },
      projectionType: { value: 0 },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: options.radius },
      azimuthalClipRadius: {
        value:
          ((AZIMUTHAL_CLIP_ANGLE - OVERLAY_AZIMUTHAL_CLIP_MARGIN_DEGREES) *
            Math.PI) /
          180.0,
      },
      zOffset: { value: options.zOffset },
      // choropleth (off by default; see updateGpuProjectedPolygonChoropleth)
      useChoropleth: { value: 0 },
      colormap: { value: 0 },
      addOffset: { value: 0.0 },
      scaleFactor: { value: 1.0 },
    },
    transparent: true,
    depthWrite: false,
    // winding flips between globe and flat projections; fills are always thin
    side: THREE.DoubleSide,
    vertexShader: gpuProjectedPolygonVertexShader,
    fragmentShader: gpuProjectedPolygonFragmentShader,
  });
  (material.defaultAttributeValues as Record<string, unknown>).featureValue = [
    0,
  ];
  return material;
}

export function updateGpuProjectedPolygonMaterial(
  material: THREE.ShaderMaterial,
  helper: ProjectionHelper,
  options: Omit<TGpuProjectedPolygonOptions, "color" | "opacity">
) {
  material.uniforms.projectionType.value = getProjectionTypeFromMode(
    helper.type
  );
  material.uniforms.centerLon.value = helper.center.lon;
  material.uniforms.centerLat.value = helper.center.lat;
  material.uniforms.projectionRadius.value = options.radius;
  material.uniforms.zOffset.value = options.zOffset;
  material.depthTest = !helper.isFlat;
}

/**
 * Toggle/update the choropleth uniforms. Uniform-only: colormap and range
 * changes never touch geometry. The range maps to the same addOffset/
 * scaleFactor normalization the grid materials use (constant ranges land on
 * the colormap midpoint).
 */
export function updateGpuProjectedPolygonChoropleth(
  material: THREE.ShaderMaterial,
  choropleth: TGpuPolygonChoropleth | undefined
) {
  material.uniforms.useChoropleth.value = choropleth ? 1 : 0;
  if (!choropleth) {
    return;
  }
  const { addOffset, scaleFactor } = getColormapScaleOffset(
    choropleth.low,
    choropleth.high,
    false
  );
  material.uniforms.colormap.value = availableColormaps[choropleth.colormap];
  material.uniforms.addOffset.value = addOffset;
  material.uniforms.scaleFactor.value = scaleFactor;
}
