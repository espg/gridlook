<script setup lang="ts">
import * as THREE from "three";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  availableColormaps,
  type TColorMap,
} from "@/lib/shaders/colormapShaders.ts";
import { makeCompressedColormapLutMaterial } from "@/lib/shaders/gridShaders.ts";

// Minimal colormap gradient strip: the ColorBar's LUT rendering without the
// histogram/slider chrome, so vector legends sample the exact same shader
// colormaps the fills use.
const props = defineProps<{ colormap: TColorMap }>();

const GRADIENT_WIDTH = 160;
const GRADIENT_HEIGHT = 10;

const canvasRef = ref<HTMLCanvasElement>();

let scene: THREE.Scene | undefined;
let renderer: THREE.WebGLRenderer | undefined;
let camera: THREE.PerspectiveCamera | undefined;
let lutMesh: THREE.Mesh | undefined;

function render() {
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

onMounted(() => {
  const lutGeometry = new THREE.PlaneGeometry(2, 2);
  lutGeometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(Float32Array.from([0, 1, 0, 1]), 1)
  );
  lutMesh = new THREE.Mesh(
    lutGeometry,
    makeCompressedColormapLutMaterial(props.colormap, 0, 1)
  );

  scene = new THREE.Scene();
  scene.add(lutMesh);
  // the LUT vertex shader draws a screen quad; the camera is a formality
  camera = new THREE.PerspectiveCamera();

  renderer = new THREE.WebGLRenderer({
    canvas: canvasRef.value as HTMLCanvasElement,
  });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(GRADIENT_WIDTH, GRADIENT_HEIGHT, false);
  render();
});

watch(
  () => props.colormap,
  () => {
    if (!lutMesh) {
      return;
    }
    const material = lutMesh.material as THREE.ShaderMaterial;
    material.uniforms.colormap.value = availableColormaps[props.colormap];
    render();
  }
);

onBeforeUnmount(() => {
  lutMesh?.geometry.dispose();
  (lutMesh?.material as THREE.ShaderMaterial)?.dispose();
  scene?.clear();
  renderer?.dispose();
  scene = undefined;
  camera = undefined;
  renderer = undefined;
  lutMesh = undefined;
});
</script>

<template>
  <canvas ref="canvasRef" class="choropleth-gradient"></canvas>
</template>

<style scoped>
.choropleth-gradient {
  display: block;
  width: 100%;
  height: 10px;
  border-radius: 3px;
}
</style>
