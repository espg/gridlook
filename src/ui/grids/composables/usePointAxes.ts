import * as THREE from "three";
import { onScopeDispose } from "vue";

import { CAMERA_VERTICAL_FOV_DEGREES } from "@/lib/camera/cameraSettings.ts";
import { MORTON_STORE_ELLIPSOID } from "@/lib/morton/convention.ts";
import {
  AXIS_TICKS,
  AXIS_VIEW_FRACTION,
  axisLabel,
  localFrame,
  niceAxisLength,
  viewHeightAt,
} from "@/lib/points/pointAxes.ts";

/** Drawn over the points (0.5), under nothing of the overlays. */
const AXES_RENDER_ORDER = 0.75;
/** A tick's half-length and a label's size, as fractions of the bar. */
const TICK_HALF = 0.03;
const LABEL_HEIGHT = 0.14;
const LABEL_WIDTH = 0.56;
const LABEL_GAP = 0.05;
const NAME_AT = 1.15;
const AXIS_COLOURS = {
  east: new THREE.Color("#e8a33d"),
  north: new THREE.Color("#6fcf6f"),
  up: new THREE.Color("#5aa9ff"),
};

type TAxesFrame = {
  /** The pivot's direction, a unit vector: the gizmo sits at the datum below it. */
  pivot: THREE.Vector3;
  /** The camera's distance to the pivot, scene units. */
  distance: number;
  exaggeration: number;
};
type TLabel = {
  text: string;
  at: [number, number, number];
  anchor: [number, number];
};

/** The label sprites' textures, drawn once per text. */
function labelTexture(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) {
    return undefined;
  }
  context.font = "bold 40px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineWidth = 8;
  context.strokeStyle = "rgba(0, 0, 0, 0.9)";
  context.strokeText(text, 128, 32);
  context.fillStyle = "#ffffff";
  context.fillText(text, 128, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The bars and their ticks, in local metres, coloured per axis. */
function barsGeometry(length: number) {
  const positions: number[] = [];
  const colours: number[] = [];
  const segment = (
    from: [number, number, number],
    to: [number, number, number],
    colour: THREE.Color
  ) => {
    positions.push(...from, ...to);
    colours.push(colour.r, colour.g, colour.b, colour.r, colour.g, colour.b);
  };
  const half = TICK_HALF * length;
  segment([0, 0, 0], [length, 0, 0], AXIS_COLOURS.east);
  segment([0, 0, 0], [0, length, 0], AXIS_COLOURS.north);
  segment([0, 0, 0], [0, 0, length], AXIS_COLOURS.up);
  for (const tick of AXIS_TICKS) {
    const t = tick * length;
    segment([t, -half, 0], [t, half, 0], AXIS_COLOURS.east);
    segment([-half, t, 0], [half, t, 0], AXIS_COLOURS.north);
    segment([-half, 0, t], [half, 0, t], AXIS_COLOURS.up);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  return geometry;
}

/** The tick labels of each bar and its name past the end. */
function labelsOf(length: number): TLabel[] {
  const gap = LABEL_GAP * length;
  const labels: TLabel[] = [];
  for (const tick of AXIS_TICKS) {
    const t = tick * length;
    const text = axisLabel(t);
    labels.push({ text, at: [t, -gap, 0], anchor: [0.5, 1] });
    labels.push({ text, at: [-gap, t, 0], anchor: [1, 0.5] });
    labels.push({ text, at: [gap, 0, t], anchor: [0, 0.5] });
  }
  const end = NAME_AT * length;
  labels.push({ text: "E", at: [end, 0, 0], anchor: [0, 0.5] });
  labels.push({ text: "N", at: [0, end, 0], anchor: [0.5, 0] });
  labels.push({ text: "Up", at: [0, 0, end], anchor: [0.5, 0] });
  return labels;
}

/** Fill `group` with the bars and labels of a `length`-metre gizmo; what to dispose. */
function buildGizmo(
  group: THREE.Group,
  length: number,
  material: THREE.LineBasicMaterial
) {
  const disposables: { dispose(): void }[] = [];
  const bars = new THREE.LineSegments(barsGeometry(length), material);
  bars.raycast = () => {};
  bars.renderOrder = AXES_RENDER_ORDER;
  group.add(bars);
  disposables.push(bars.geometry);
  for (const { text, at, anchor } of labelsOf(length)) {
    const map = labelTexture(text);
    if (!map) {
      continue;
    }
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map, depthTest: false, transparent: true })
    );
    sprite.raycast = () => {};
    sprite.renderOrder = AXES_RENDER_ORDER;
    sprite.position.set(...at);
    sprite.center.set(...anchor);
    sprite.scale.set(LABEL_WIDTH * length, LABEL_HEIGHT * length, 1);
    group.add(sprite);
    disposables.push(map, sprite.material);
  }
  return disposables;
}

/** The group's matrix: local metres to scene units at the datum under the pivot. */
function placeGizmo(group: THREE.Group, frame: TAxesFrame) {
  const metres = MORTON_STORE_ELLIPSOID.semi_major_axis;
  const { east, north, up } = localFrame(frame.pivot.toArray());
  group.matrix
    .makeBasis(
      new THREE.Vector3(...east).divideScalar(metres),
      new THREE.Vector3(...north).divideScalar(metres),
      new THREE.Vector3(...up).multiplyScalar(frame.exaggeration / metres)
    )
    .setPosition(frame.pivot.clone().normalize());
  group.matrixWorldNeedsUpdate = true;
}

/**
 * The axes gizmo (pointAxes.ts): a group at the datum under the pivot
 * whose local unit is the metre, east/north/up along its axes, the up axis
 * scaled by the exaggeration like the points. The bars and labels are
 * rebuilt only when the nice length changes; the group's matrix follows
 * the pivot every frame. Nothing here answers the click probe.
 */
export function usePointAxes(options: {
  getScene: () => THREE.Scene | undefined;
}) {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.renderOrder = AXES_RENDER_ORDER;
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    depthTest: false,
    transparent: true,
  });
  let length = 0;
  let disposables: { dispose(): void }[] = [];

  function empty() {
    length = 0;
    for (const disposable of disposables.splice(0)) {
      disposable.dispose();
    }
    group.clear();
  }

  /** Place and size the gizmo for `frame`; hidden without one. */
  function update(frame: TAxesFrame | undefined) {
    const scene = options.getScene();
    if (!frame || !scene) {
      group.removeFromParent();
      return;
    }
    const next = niceAxisLength(
      viewHeightAt(frame.distance, CAMERA_VERTICAL_FOV_DEGREES) *
        MORTON_STORE_ELLIPSOID.semi_major_axis *
        AXIS_VIEW_FRACTION
    );
    if (next !== length) {
      empty();
      length = next;
      disposables = buildGizmo(group, next, material);
    }
    placeGizmo(group, frame);
    if (group.parent !== scene) {
      scene.add(group);
    }
  }

  onScopeDispose(() => {
    group.removeFromParent();
    empty();
    material.dispose();
  });

  return { update, axisLength: () => length };
}
