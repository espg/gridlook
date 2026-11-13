import { PerspectiveCamera, Vector2, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { expect, it } from "vitest";

import {
  dragGlobe,
  getGlobeView,
  glideGlobe,
  globePointAt,
  roundBearing,
  setGlobeView,
  turnBetween as turnVectorBetween,
  turnGlobeBy,
  turnGlobeAboutScreen,
  type TGlobeView,
} from "@/lib/camera/globeCamera.ts";

function cameraAt(view: TGlobeView, distance: number) {
  const camera = new PerspectiveCamera(7.5, 4 / 3, 1e-4);
  setGlobeView(camera, view, distance);
  return camera;
}

/** The angle between how two cameras are turned. */
function turnBetween(a: PerspectiveCamera, b: PerspectiveCamera) {
  return a.quaternion.angleTo(b.quaternion);
}

/** Where a point of the globe is seen, in normalised device coordinates. */
function seenAt(camera: PerspectiveCamera, point: Vector3) {
  camera.updateMatrixWorld();
  const { x, y } = point.clone().project(camera);
  return new Vector2(x, y);
}

const VIEWS: TGlobeView[] = [];
for (const lat of [-90, -89.99995, -65, 0, 30, 89.99995, 90]) {
  for (const lon of [-180, -62, 0, 37.5, 179.99995]) {
    for (const bearing of [0, 0.004, 77, 180, 359.996]) {
      VIEWS.push({ lat, lon, bearing });
    }
  }
}

it("looks at the centre with the bearing clockwise from north", () => {
  const camera = cameraAt({ lat: 0, lon: 0, bearing: 90 }, 4);
  expect(camera.position.distanceTo(new Vector3(4, 0, 0))).toBeLessThan(1e-12);
  // east is up: north is to the left of the screen
  expect(seenAt(camera, new Vector3(1, 0, 0)).length()).toBeLessThan(1e-12);
  expect(seenAt(camera, new Vector3(1, 0.01, 0).normalize()).y).toBeGreaterThan(
    0
  );
  expect(seenAt(camera, new Vector3(1, 0, 0.01).normalize()).x).toBeLessThan(0);
  for (const view of VIEWS) {
    const forward = cameraAt(view, 4).getWorldDirection(new Vector3());
    expect(forward.angleTo(cameraAt(view, 4).position)).toBeCloseTo(Math.PI, 6);
  }
});

it("gives every view back from its latitude, longitude and bearing", () => {
  for (const view of VIEWS) {
    for (const distance of [16, 1.0002]) {
      const camera = cameraAt(view, distance);
      const read = getGlobeView(camera);
      expect(turnBetween(cameraAt(read, distance), camera)).toBeLessThan(1e-7);
      expect(read.lat).toBeCloseTo(view.lat, 9);
      if (Math.abs(view.lat) < 90) {
        expect(Math.cos(((read.lon - view.lon) * Math.PI) / 180)).toBeCloseTo(
          1,
          12
        );
        expect(
          Math.cos(((read.bearing - view.bearing) * Math.PI) / 180)
        ).toBeCloseTo(1, 12);
      }
      // as the URL writes it: the centre to 1e-4 degrees, the bearing to 0.01
      const written = {
        lat: Math.round(read.lat * 1e4) / 1e4,
        lon: Math.round(read.lon * 1e4) / 1e4,
        bearing: Number(String(roundBearing(read.bearing))),
      };
      expect(written.bearing).toBeGreaterThanOrEqual(0);
      expect(written.bearing).toBeLessThan(360);
      expect(turnBetween(cameraAt(written, distance), camera)).toBeLessThan(
        2e-4
      );
    }
  }
});

it("reads a view from any camera, also one straight above a pole", () => {
  const turns = [
    new Vector3(),
    new Vector3(0, 0, 2.5),
    new Vector3(1, 2, -1).setLength(1.9),
  ];
  for (const pole of [1, -1]) {
    for (const turn of turns) {
      const camera = new PerspectiveCamera();
      camera.position.set(0, 0, 3 * pole);
      camera.up.set(1, 0, 0).applyAxisAngle(new Vector3(0, 0, 1), 0.7);
      camera.lookAt(0, 0, 0);
      turnGlobeBy(camera, turn);
      const read = getGlobeView(camera);
      expect(turnBetween(cameraAt(read, 3), camera)).toBeLessThan(1e-7);
      if (turn.x === 0) {
        // still above the pole: a longitude that rounding noise in the
        // position does not change, with north up
        expect(roundBearing(read.bearing)).toBe(0);
        camera.position.x += 1e-15;
        camera.position.y -= 3e-15;
        expect(getGlobeView(camera).lon).toBeCloseTo(read.lon, 9);
      }
    }
  }
});

it("resets north about the point below the camera", () => {
  for (const view of VIEWS) {
    const camera = cameraAt(view, 2.5);
    const position = camera.position.clone();
    setGlobeView(camera, { bearing: 0 });
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-12);
    expect(roundBearing(getGlobeView(camera).bearing)).toBe(0);
    if (Math.abs(view.lat) < 89) {
      // north of the point below the camera is straight up the screen
      const north = cameraAt({ ...view, lat: view.lat + 0.5 }, 1).position;
      const seen = seenAt(camera, north);
      expect(seen.x).toBeCloseTo(0, 9);
      expect(seen.y).toBeGreaterThan(0);
    }
  }
});

it("keeps the bearing and the latitude turning about the globe's axis", () => {
  const camera = cameraAt({ lat: -65, lon: -62, bearing: 77 }, 3);
  turnGlobeBy(camera, new Vector3(0, 0, 1));
  const view = getGlobeView(camera);
  expect(view.lat).toBeCloseTo(-65, 9);
  expect(view.bearing).toBeCloseTo(77, 9);
  expect(view.lon).toBeCloseTo(-62 + 180 / Math.PI, 9);
});

it("turns about the screen's axes whatever the bearing", () => {
  for (const view of VIEWS) {
    const camera = cameraAt(view, 3);
    const below = camera.position.clone().normalize();
    turnGlobeAboutScreen(camera, 0.02, 0);
    // the camera went down the screen, so what was below it went up
    expect(seenAt(camera, below).x).toBeCloseTo(0, 9);
    expect(seenAt(camera, below).y).toBeGreaterThan(0);
    expect(camera.position.clone().normalize().angleTo(below)).toBeCloseTo(
      0.02,
      12
    );
    expect(camera.position.length()).toBeCloseTo(3, 12);
    below.copy(camera.position).normalize();
    turnGlobeAboutScreen(camera, 0, 0.02);
    expect(seenAt(camera, below).y).toBeCloseTo(0, 9);
    expect(seenAt(camera, below).x).toBeLessThan(0);
  }
});

it("holds the grabbed point under the pointer across a pole, rolled", () => {
  for (const pole of [90, -90]) {
    for (const distance of [16, 2, 1.01]) {
      const camera = cameraAt(
        { lat: pole * 0.97, lon: 20, bearing: 130 },
        distance
      );
      const start = new Vector2(0.1, -0.3);
      let cursor = start;
      let grabbed = globePointAt(camera, cursor);
      const held = grabbed!;
      const poleSeen = seenAt(camera, new Vector3(0, 0, pole / 90));
      // the pointer sweeps past where the pole was and out to the far side
      for (let step = 1; step <= 40; step++) {
        const next = start.clone().lerp(poleSeen, step / 20);
        if (!globePointAt(camera, next)) {
          break;
        }
        grabbed = dragGlobe(camera, grabbed, cursor, next);
        cursor = next;
        expect(grabbed).toBe(held);
        expect(globePointAt(camera, cursor)!.distanceTo(held)).toBeLessThan(
          1e-9
        );
        expect(camera.position.length()).toBeCloseTo(distance, 12);
      }
      expect(cursor.distanceTo(start)).toBeGreaterThan(0.2);
    }
  }
});

it("hands a drag over at the globe's edge without a jump", () => {
  const camera = cameraAt({ lat: 40, lon: -100, bearing: 250 }, 16);
  const step = 0.01;
  // out over the right edge of the globe, on along the outside, back in
  let cursor = new Vector2(0.4, 0.1);
  let grabbed = globePointAt(camera, cursor);
  expect(grabbed).not.toBeNull();
  const turns: { turn: number; from: boolean; to: boolean }[] = [];
  for (const direction of [1, -1]) {
    for (let moves = 0; moves < 60; moves++) {
      const next = new Vector2(cursor.x + direction * step, cursor.y);
      const before = camera.clone();
      const wasHeld = grabbed !== null;
      grabbed = dragGlobe(camera, grabbed, cursor, next);
      cursor = next;
      turns.push({
        turn: turnBetween(before, camera),
        from: wasHeld,
        to: grabbed !== null,
      });
    }
  }
  const off = turns.filter(({ from, to }) => !from && !to);
  expect(off.length).toBeGreaterThan(20);
  // letting go: the move that leaves the globe turns it as those after it do
  const leaving = turns.find(({ from, to }) => from && !to)!;
  expect(leaving.turn).toBeCloseTo(off[0].turn, 9);
  for (const { turn } of off) {
    expect(turn).toBeCloseTo(off[0].turn, 9);
    expect(turn).toBeGreaterThan(0);
    expect(turn).toBeLessThan(0.02);
  }
  // taking hold again: the move that comes back onto the globe turns nothing
  const landing = turns.find(({ from, to }) => !from && to)!;
  expect(landing.turn).toBeLessThan(1e-7);
  expect(globePointAt(camera, cursor)!.distanceTo(grabbed!)).toBeLessThan(1e-9);
  expect(turns[turns.length - 1].turn).toBeGreaterThan(0);
});

it("turns the globe after the pointer where the drag is off it", () => {
  for (const distance of [16, 40]) {
    for (const bearing of [0, 140]) {
      const camera = cameraAt({ lat: 10, lon: 50, bearing }, distance);
      const below = camera.position.clone().normalize();
      const from = new Vector2(0.95, 0.95);
      expect(globePointAt(camera, from)).toBeNull();
      const move = new Vector2(-0.03, 0.02);
      expect(dragGlobe(camera, null, from, from.clone().add(move))).toBeNull();
      // the middle of the view goes with the pointer, as if grabbed there
      expect(seenAt(camera, below).distanceTo(move)).toBeLessThan(1e-3);
    }
  }
  // far out, where that would spin the globe: a full turn per view height
  const camera = cameraAt({ lat: 10, lon: 50, bearing: 0 }, 900);
  const before = camera.clone();
  dragGlobe(camera, null, new Vector2(0.5, 0.5), new Vector2(0.5, 0.6));
  expect(turnBetween(before, camera)).toBeCloseTo(0.1 * Math.PI, 9);
});

it("starts a drag off the globe and takes hold where it comes onto it", () => {
  const camera = cameraAt({ lat: -80, lon: 0, bearing: 30 }, 16);
  let cursor = new Vector2(-0.99, 0);
  let grabbed = globePointAt(camera, cursor);
  expect(grabbed).toBeNull();
  let previous = 0;
  for (let moves = 0; moves < 80; moves++) {
    const next = new Vector2(cursor.x + 0.01, 0);
    const before = camera.clone();
    const wasHeld = grabbed;
    grabbed = dragGlobe(camera, grabbed, cursor, next);
    cursor = next;
    const turn = turnBetween(before, camera);
    if (wasHeld) {
      expect(grabbed).toBe(wasHeld);
      expect(globePointAt(camera, cursor)!.distanceTo(wasHeld)).toBeLessThan(
        1e-9
      );
      // from the edge inwards the same pointer step turns the globe less
      expect(turn).toBeLessThan(previous || Infinity);
      previous = turn;
    }
  }
  expect(previous).toBeGreaterThan(0);
});

it("glides on from a drag as the damped OrbitControls did, to a full stop", () => {
  for (const frames of [3, 200]) {
    const rate = 0.004;
    // before: OrbitControls turning a north-up camera about the axis, damped
    const damped = cameraAt({ lat: 0, lon: 0, bearing: 0 }, 3);
    const controls = new OrbitControls(damped);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // now: the drag turns the camera itself and leaves the rest pending
    const camera = cameraAt({ lat: 0, lon: 0, bearing: 0 }, 3);
    const pending = new Vector3();
    for (let frame = 0; frame < frames; frame++) {
      // turns and updates
      controls.rotateLeft(rate);
      turnGlobeBy(camera, new Vector3(0, 0, -rate));
      pending.z -= rate;
      glideGlobe(camera, pending, true);
    }
    expect(getGlobeView(camera).lon).toBeCloseTo(
      (-frames * rate * 180) / Math.PI
    );
    const released = getGlobeView(camera).lon;
    const left = (pending.z * 180) / Math.PI;
    // at a steady rate: 11.5 frames of it
    expect(pending.z / -rate).toBeCloseTo(frames === 200 ? 11.5 : 2.55, 1);
    let before = getGlobeView(damped).lon;
    let updates = 0;
    while (pending.lengthSq() > 0) {
      const last = getGlobeView(camera).lon;
      glideGlobe(camera, pending, false);
      controls.update();
      // frame for frame the turn the damping gave, but for the last one,
      // which the damping would follow with ever smaller ones
      expect(getGlobeView(camera).lon - last).toBeCloseTo(
        pending.lengthSq() > 0 ? getGlobeView(damped).lon - before : 0,
        9
      );
      before = getGlobeView(damped).lon;
      expect(++updates).toBeLessThan(200);
    }
    expect(updates).toBeGreaterThan(50);
    // all of what was pending, less the part too slow to see
    expect(getGlobeView(camera).lon - released).toBeCloseTo(left, 2);
    const rest = camera.clone();
    for (let frame = 0; frame < 10; frame++) {
      glideGlobe(camera, pending, false);
    }
    expect(camera.position.equals(rest.position)).toBe(true);
    expect(camera.quaternion.equals(rest.quaternion)).toBe(true);
    expect(camera.up.equals(rest.up)).toBe(true);
  }
});

it("glides across a pole with a rolled view, and not when held still", () => {
  const camera = cameraAt({ lat: 89, lon: 10, bearing: 200 }, 1.5);
  const axis = new Vector3(0, 1, 0);
  const pending = axis.clone().multiplyScalar(-0.3);
  let updates = 0;
  while (pending.lengthSq() > 0) {
    glideGlobe(camera, pending, false);
    expect(camera.position.dot(axis)).toBeCloseTo(
      cameraAt({ lat: 89, lon: 10, bearing: 0 }, 1.5).position.y,
      12
    );
    expect(camera.position.length()).toBeCloseTo(1.5, 12);
    expect(++updates).toBeLessThan(200);
  }
  // 0.3 rad on from 1 degree short of the pole, the bearing turning with it
  const view = getGlobeView(camera);
  expect(view.lat).toBeLessThan(75);
  expect(Math.abs(view.lon - 10)).toBeGreaterThan(90);
  const forward = camera.getWorldDirection(new Vector3());
  expect(forward.angleTo(camera.position)).toBeCloseTo(Math.PI, 6);
  expect(camera.up.dot(camera.position)).toBeCloseTo(0, 12);

  // a pointer that stopped: the turn pending drains without moving the camera
  pending.set(0, 0, 0.3);
  const held = camera.clone();
  for (let frame = 0; frame < 200; frame++) {
    glideGlobe(camera, pending, true);
  }
  glideGlobe(camera, pending, false);
  expect(pending.lengthSq()).toBe(0);
  expect(camera.position.equals(held.position)).toBe(true);
});

it("reads a small turn as small whichever sign the camera quaternions have", () => {
  let flipped = 0;
  for (const view of VIEWS) {
    for (const turn of [
      new Vector3(0, 1e-3, 0),
      new Vector3(1e-3, 0, 0),
      new Vector3(3e-4, -2e-4, 9e-4),
    ]) {
      const camera = cameraAt(view, 4);
      const before = camera.quaternion.clone();
      turnGlobeBy(camera, turn);
      // lookAt gives q or -q: the same camera, the long way round as a turn
      flipped += before.dot(camera.quaternion) < 0 ? 1 : 0;
      expect(
        turnVectorBetween(before, camera.quaternion).distanceTo(turn)
      ).toBeLessThan(1e-9);
    }
  }
  expect(flipped).toBeGreaterThan(0);
  const camera = cameraAt({ lat: -90, lon: -180, bearing: 0 }, 4);
  const before = camera.quaternion.clone();
  turnGlobeBy(camera, new Vector3(0, 1e-3, 0));
  expect(turnVectorBetween(before, camera.quaternion).length()).toBeCloseTo(
    1e-3,
    9
  );
});
