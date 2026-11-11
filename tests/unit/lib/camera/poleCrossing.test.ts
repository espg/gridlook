import proj4 from "proj4";
import { PerspectiveCamera, Quaternion, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { expect, it } from "vitest";

import { useFreeOrbit } from "@/lib/camera/OrbitControlsAddOn.ts";
import {
  gridUpOfCrs,
  nearPole,
  POLE_AXIS,
  POLE_CAP,
  restingUp,
  screenUp,
  settleRoll,
  turnTowards,
} from "@/lib/camera/poleCrossing.ts";

const DEGREES = Math.PI / 180;
const ANTARCTIC_CRS =
  "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";
const GREENLAND_CRS =
  "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";

/** A camera at `distance` over `lat`/`lon` of the unit globe, north up. */
function globeCamera(lat: number, lon: number, distance = 3) {
  const camera = new PerspectiveCamera();
  camera.up.copy(POLE_AXIS);
  camera.position.set(
    Math.cos(lat * DEGREES) * Math.cos(lon * DEGREES),
    Math.cos(lat * DEGREES) * Math.sin(lon * DEGREES),
    Math.sin(lat * DEGREES)
  );
  camera.position.multiplyScalar(distance);
  camera.lookAt(0, 0, 0);
  return camera;
}

function latitude(position: Vector3) {
  return Math.asin(position.z / position.length()) / DEGREES;
}

function longitude(position: Vector3) {
  return Math.atan2(position.y, position.x) / DEGREES;
}

/** The direction from the surface point below the camera towards `lon`/`lat`. */
function bearingVector(camera: PerspectiveCamera, lon: number, lat: number) {
  const target = globeCamera(lat, lon, 1).position;
  const here = camera.position.clone().normalize();
  return target.addScaledVector(here, -target.dot(here)).normalize();
}

type TControls = OrbitControls & {
  _rotateUp: (angle: number) => void;
  _rotateLeft: (angle: number) => void;
  state: number;
};

function freeControls(camera: PerspectiveCamera, gridUp?: Vector3) {
  const controls = new OrbitControls(camera) as unknown as TControls;
  controls.enableDamping = false;
  const orbit = useFreeOrbit(controls, {
    isFlatProjection: () => false,
    getGridUp: () => gridUp,
  });
  controls.update();
  return { controls, orbit };
}

it("tells a camera within the cap of a pole", () => {
  expect(nearPole(globeCamera(80, 0).position)).toBe(true);
  expect(nearPole(globeCamera(-80, 120).position)).toBe(true);
  expect(nearPole(globeCamera(70, 0).position)).toBe(false);
  expect(POLE_CAP).toBeCloseTo(15 * DEGREES, 12);
});

it("turns a roll towards its target a step at a time", () => {
  const rolled = new Vector3(1, 0, 0.2).normalize();
  const turned = turnTowards(rolled, POLE_AXIS, 0.1);
  expect(turned.angleTo(POLE_AXIS)).toBeCloseTo(
    rolled.angleTo(POLE_AXIS) - 0.1,
    9
  );
  expect(turned.length()).toBeCloseTo(1, 9);
  expect(turnTowards(turned, POLE_AXIS, Math.PI)).toEqual(POLE_AXIS);
});

it("takes the grid's up from a polar stereographic CRS", () => {
  // EPSG:3031: +y points from the south pole along 0°E
  const antarctic = gridUpOfCrs(ANTARCTIC_CRS)!;
  expect(antarctic.x).toBeCloseTo(1, 9);
  expect(antarctic.y).toBeCloseTo(0, 9);
  expect(antarctic.z).toBe(0);
  // EPSG:3413: +y points from the north pole along 135°E, away from 45°W
  const greenland = gridUpOfCrs(GREENLAND_CRS)!;
  expect(greenland.x).toBeCloseTo(-Math.SQRT1_2, 9);
  expect(greenland.y).toBeCloseTo(Math.SQRT1_2, 9);
  // which is where the projections themselves put +y: a point a little
  // way along the up from the pole has x = 0 and y > 0
  for (const [crs, up, pole] of [
    [ANTARCTIC_CRS, antarctic, -90],
    [GREENLAND_CRS, greenland, 90],
  ] as const) {
    const lon = Math.atan2(up.y, up.x) / DEGREES;
    const [x, y] = proj4("EPSG:4326", crs).forward([
      lon,
      pole + (pole < 0 ? 1 : -1),
    ]);
    expect(x).toBeCloseTo(0, 3);
    expect(y).toBeGreaterThan(0);
  }
  // a WKT of EPSG:3031 reads the same, and other projections have none
  expect(
    gridUpOfCrs(
      'PROJCS["WGS 84 / Antarctic Polar Stereographic",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Polar_Stereographic"],PARAMETER["latitude_of_origin",-71],PARAMETER["central_meridian",0],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3031"]]'
    )!.x
  ).toBeCloseTo(1, 9);
  expect(gridUpOfCrs("EPSG:3857")).toBeUndefined();
  expect(gridUpOfCrs("not a crs")).toBeUndefined();
});

it("rests on the grid's up across the surface, else north or south up", () => {
  // over Greenland (45°W) the grid's up is north, within a few degrees
  const greenland = globeCamera(72, -40);
  const up = restingUp(
    greenland.position,
    greenland.quaternion,
    gridUpOfCrs(GREENLAND_CRS)
  );
  expect(up.angleTo(bearingVector(greenland, -40, 89))).toBeLessThan(
    6 * DEGREES
  );
  // over the Antarctic Peninsula (60°W) the grid's up points at 0°E across
  // the pole: north turned towards the east, so the Peninsula lies up-left
  const peninsula = globeCamera(-67, -60);
  const antarctic = restingUp(
    peninsula.position,
    peninsula.quaternion,
    gridUpOfCrs(ANTARCTIC_CRS)
  );
  const north = bearingVector(peninsula, -60, -50);
  const east = bearingVector(peninsula, -50, -67);
  expect(antarctic.dot(north)).toBeGreaterThan(0.3);
  expect(antarctic.dot(east)).toBeGreaterThan(0.3);
  // without a grid, north or south across the surface, as the roll is nearer
  const camera = globeCamera(30, 0);
  const northHere = bearingVector(camera, 0, 89);
  expect(
    restingUp(camera.position, camera.quaternion).angleTo(northHere)
  ).toBeLessThan(1e-6);
  const rolled = new Quaternion().setFromAxisAngle(
    camera.position.clone().normalize(),
    Math.PI
  );
  rolled.multiply(camera.quaternion);
  expect(restingUp(camera.position, rolled).angleTo(northHere)).toBeCloseTo(
    Math.PI,
    6
  );
});

it("leaves the roll alone while dragging and within the cap", () => {
  const camera = globeCamera(45, 10);
  const north = bearingVector(camera, 10, 89);
  const rolled = bearingVector(camera, 40, 60);
  const offset = camera.position;
  // clear of the poles and released: a step towards north up
  const settled = settleRoll(rolled, offset, camera.quaternion, {
    dragging: false,
  })!;
  expect(settled.angleTo(north)).toBeLessThan(rolled.angleTo(north));
  expect(settled.angleTo(north)).toBeGreaterThan(0);
  // pointer down: untouched
  expect(
    settleRoll(rolled, offset, camera.quaternion, { dragging: true })
  ).toBe(rolled);
  // within the cap: untouched, released or not
  const polar = globeCamera(80, 0);
  expect(
    settleRoll(rolled, polar.position, polar.quaternion, { dragging: false })
  ).toBe(rolled);
  // except on an explicit reset
  const polarNorth = bearingVector(polar, 0, 89);
  const reset = settleRoll(rolled, polar.position, polar.quaternion, {
    dragging: false,
    resetting: true,
  })!;
  expect(reset.angleTo(polarNorth)).toBeLessThan(rolled.angleTo(polarNorth));
  // at rest: null
  expect(
    settleRoll(north, offset, camera.quaternion, { dragging: false })
  ).toBeNull();
});

it("carries the camera across the pole and keeps the roll it has", () => {
  const camera = globeCamera(80, 0);
  const { controls } = freeControls(camera);
  const path: number[] = [];
  for (let step = 0; step < 40; step++) {
    controls._rotateUp(1 * DEGREES);
    controls.update();
    path.push(latitude(camera.position));
  }
  // up to the pole and down the far side, at the same distance
  expect(Math.max(...path)).toBeGreaterThan(89);
  expect(path[path.length - 1]).toBeCloseTo(60, 6);
  expect(Math.abs(longitude(camera.position))).toBeCloseTo(180, 5);
  expect(camera.position.length()).toBeCloseTo(3, 9);
  for (let i = 1; i < path.length; i++) {
    expect(Math.abs(path[i] - path[i - 1])).toBeLessThan(1.5);
  }
  // a straight crossing leaves the view south up, and clear of the pole it
  // settles there exactly, since that is the nearer axis
  for (let step = 0; step < 40; step++) {
    controls.update();
  }
  const south = bearingVector(camera, 180, -89);
  expect(screenUp(camera.quaternion).angleTo(south)).toBeLessThan(1e-6);
  expect(restingUp(camera.position, camera.quaternion).angleTo(south)).toBe(0);
  // a horizontal drag now moves along a parallel
  const before = latitude(camera.position);
  controls._rotateLeft(10 * DEGREES);
  controls.update();
  expect(latitude(camera.position)).toBeCloseTo(before, 6);
});

it("spins the view about the pole on a horizontal drag, and keeps it", () => {
  const camera = globeCamera(-86, 30);
  const { controls } = freeControls(camera, gridUpOfCrs(ANTARCTIC_CRS));
  const before = screenUp(camera.quaternion);
  controls.state = 0; // a pointer is down
  controls._rotateLeft(40 * DEGREES);
  controls.update();
  controls.state = -1;
  // the camera went round the pole (the way OrbitControls turns it about
  // its up), its up with it
  expect(latitude(camera.position)).toBeCloseTo(-86, 6);
  expect(longitude(camera.position)).toBeCloseTo(-10, 6);
  // (the ups sit in tangent planes 4° off the pole, so their angle is a
  // shade under the turn)
  const after = screenUp(camera.quaternion);
  expect(after.angleTo(before)).toBeCloseTo(40 * DEGREES, 2);
  // and nothing undoes it once released: within the cap the roll sticks
  for (let step = 0; step < 60; step++) {
    controls.update();
  }
  expect(screenUp(camera.quaternion).angleTo(after)).toBeLessThan(1e-9);
  // crossing the pole (down the screen, away from the up) and coming back
  // keeps it too
  controls._rotateUp(-10 * DEGREES);
  controls.update();
  expect(latitude(camera.position)).toBeCloseTo(-84, 6);
  expect(longitude(camera.position)).toBeCloseTo(170, 6);
  controls._rotateUp(10 * DEGREES);
  controls.update();
  expect(longitude(camera.position)).toBeCloseTo(-10, 6);
  expect(screenUp(camera.quaternion).angleTo(after)).toBeLessThan(1e-9);
});

it("resets the roll to the grid's up on request, even over the pole", () => {
  const camera = globeCamera(-86, 30);
  const gridUp = gridUpOfCrs(ANTARCTIC_CRS);
  const { controls, orbit } = freeControls(camera, gridUp);
  controls.state = 0;
  controls._rotateLeft(90 * DEGREES);
  controls.update();
  controls.state = -1;
  const target = restingUp(camera.position, camera.quaternion, gridUp);
  expect(screenUp(camera.quaternion).angleTo(target)).toBeGreaterThan(1);
  orbit.resetRoll();
  for (let step = 0; step < 60; step++) {
    controls.update();
  }
  expect(screenUp(camera.quaternion).angleTo(target)).toBeLessThan(1e-6);
  // 0°E is now up on screen (to within the camera's 4° off the pole): the
  // Peninsula (60°W) lies to the upper left
  expect(target.angleTo(bearingVector(camera, 0, -60))).toBeLessThan(
    8 * DEGREES
  );
});

it("keeps the frame in step with an up vector set from outside", () => {
  const camera = globeCamera(30, 0);
  const controls = new OrbitControls(camera);
  controls.enableDamping = false;
  useFreeOrbit(controls, { isFlatProjection: () => false });
  controls.update();
  // a flat map sets +Y up and disables rotation: the frame follows the up
  camera.up.set(0, 1, 0);
  camera.position.set(0.2, 0.1, 2);
  controls.target.set(0.2, 0.1, 0);
  controls.update();
  expect(camera.position.x).toBeCloseTo(0.2, 9);
  expect(camera.position.y).toBeCloseTo(0.1, 9);
  expect(camera.position.z).toBeCloseTo(2, 9);
  // disabled controls (a presenter display) leave the roll they are given
  controls.enabled = false;
  const rolled = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
  camera.up.set(0, 1, 0).applyQuaternion(rolled);
  controls.update();
  expect(camera.up.x).toBeCloseTo(-Math.sin(0.3), 9);
});
