import * as THREE from "three";

import gpuProjectedPolygonFragmentShader from "@/lib/layers/glsl/gpuProjectedPolygon.frag.glsl";
import gpuProjectedPolygonVertexShader from "@/lib/layers/glsl/gpuProjectedPolygon.vert.glsl";
import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import {
  AZIMUTHAL_CLIP_ANGLE,
  type ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

type TGpuProjectedPolygonOptions = {
  color: THREE.ColorRepresentation;
  opacity: number;
  radius: number;
  zOffset: number;
};

const OVERLAY_AZIMUTHAL_CLIP_MARGIN_DEGREES = 1.0;

export function makeGpuProjectedPolygonMaterial(
  options: TGpuProjectedPolygonOptions
) {
  return new THREE.ShaderMaterial({
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
    },
    transparent: true,
    depthWrite: false,
    // winding flips between globe and flat projections; fills are always thin
    side: THREE.DoubleSide,
    vertexShader: gpuProjectedPolygonVertexShader,
    fragmentShader: gpuProjectedPolygonFragmentShader,
  });
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
