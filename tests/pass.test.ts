import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PASS_LENGTH, PASS_ROAD_HALF, PASS_CLIMB, PASS_RIPPLE_A, SWAY,
  spineX, spineSlope, offCentre, passTerrainAt, passFloor, passWall, passOffroad,
  passUniformValues, PASS_GLSL
} from '../src/core/pass-shape';
import { buildPassNetwork, passSpawn, PASS_SPACING } from '../src/world/networks/pass';
import {
  findCorners, gradeFor, radiusAt, arcAt, noteText, PASS_DISTANCE
} from '../src/game/pace-notes';
import { CHECKPOINTS, gradeAt, clockText } from '../src/game/pass-run';
import { setTerrain, terrainAt, slopeAt } from '../src/core/terrain';
import { setPlace, wrapDelta, wrap, PLACE } from '../src/core/place';
import { TILE, onOffroad } from '../src/core/city-layout';
import { V, makeCar, resetCar, stepVehicle } from '../src/vehicle/vehicle';

/**
 * The pass is generated from one analytic curve, so almost everything about it
 * is checkable rather than eyeballable: where the road is, how steep the walls
 * are, which corners are tight, how far apart the gates ended up. These are the
 * facts the rest of the level leans on.
 */

/** Everything in here drives on the pass, so put the world there. */
function usePass(): void {
  setTerrain('pass');
  setPlace({ wrapSize: 0, offroad: passOffroad });
}
function useCity(): void {
  setTerrain('city');
  setPlace({ wrapSize: TILE, offroad: onOffroad });
}

describe('the pass, as a shape', () => {
  beforeEach(usePass);
  afterEach(useCity);

  it('never turns so far from its own axis that the corridor stops making sense', () => {
    /* The terrain measures distance from the road by dividing the horizontal
       offset by √(1+S′²), which is a first-order approximation and degrades as
       the road turns away from +Z. Keeping |S′| under about 1.6 — 58° — is what
       makes that approximation good enough to paint a road on. */
    let worst = 0;
    for (let z = 0; z <= PASS_LENGTH; z += 2) worst = Math.max(worst, Math.abs(spineSlope(z)));
    expect(worst).toBeLessThan(1.6);
  });

  it('is flat across the carriageway and steep off it', () => {
    for (let z = 0; z <= PASS_LENGTH; z += 137) {
      const cx = spineX(z);
      // On the centreline the wall contributes nothing at all.
      expect(passTerrainAt(cx, z)).toBeCloseTo(passFloor(z), 9);

      // Across the road, the ground rises by less than a kerb.
      const n = Math.sqrt(1 + spineSlope(z) ** 2);
      const edge = passTerrainAt(cx + PASS_ROAD_HALF * n, z);
      expect(Math.abs(edge - passFloor(z))).toBeLessThan(0.02);
    }
  });

  it('walls the valley steeply enough that gravity beats the tyres', () => {
    // Drive force is V.drive newtons on V.mass kilos; anything steeper than
    // that in m/s² is a slope the truck cannot climb.
    const climbable = V.drive / V.mass / 9.81;
    const top = passWall(PASS_ROAD_HALF + 80) - passWall(PASS_ROAD_HALF + 79);
    expect(top).toBeGreaterThan(climbable);
  });

  it('climbs to a summit and comes back down', () => {
    // Both ends are at the bottom, give or take the ripple laid over the climb.
    expect(Math.abs(passFloor(0))).toBeLessThan(PASS_RIPPLE_A + 1e-6);
    expect(Math.abs(passFloor(PASS_LENGTH))).toBeLessThan(PASS_RIPPLE_A + 1e-6);
    expect(passFloor(PASS_LENGTH / 2)).toBeGreaterThan(PASS_CLIMB * 0.9);
  });

  it('agrees with the shader about which terrain to use', () => {
    // The GLSL cannot be executed here, but the two halves at least have to be
    // fed the same numbers and use the same names.
    const u = passUniformValues();
    expect(u.A).toEqual([SWAY[0].a, SWAY[1].a, SWAY[2].a]);
    expect(u.B[0]).toBeCloseTo(2 * Math.PI / SWAY[0].lambda, 12);
    expect(u.D).toEqual([PASS_CLIMB, PASS_ROAD_HALF, 80, PASS_LENGTH]);
    for (const name of ['uPassA', 'uPassB', 'uPassC', 'uPassD', 'uPassE']) {
      expect(PASS_GLSL).toContain(name);
    }
  });

  it('calls you off the road exactly where the tarmac ends', () => {
    for (let z = 40; z < PASS_LENGTH; z += 311) {
      const n = Math.sqrt(1 + spineSlope(z) ** 2);
      expect(passOffroad(spineX(z), z)).toBe(false);
      expect(passOffroad(spineX(z) + (PASS_ROAD_HALF - 1) * n, z)).toBe(false);
      expect(passOffroad(spineX(z) + (PASS_ROAD_HALF + 1) * n, z)).toBe(true);
    }
  });
});

describe('the pass, as a network', () => {
  const net = buildPassNetwork();

  it('is one connected chain with two ends and no wrap', () => {
    expect(net.wrapSize).toBe(0);
    expect(net.connected()).toBe(true);
    const ends = net.nodes.filter(n => n.links.length === 1);
    expect(ends.length).toBe(2);
    expect(net.nodes.every(n => n.links.length <= 2)).toBe(true);
  });

  it('puts every junction on the centreline', () => {
    for (const n of net.nodes) expect(n.x).toBeCloseTo(spineX(n.z), 9);
  });

  it('samples finely enough that the route does not cut the apex', () => {
    /* The chord between two nodes falls inside the true curve by
       r(1 − cos(θ/2)), and at the tightest corner on the pass that has to stay
       inside the width of the painted line — otherwise the ribbon visibly cuts
       across the road it is supposed to be drawn on. */
    let tightest = Infinity;
    for (let z = 0; z <= PASS_LENGTH; z += 2) tightest = Math.min(tightest, radiusAt(z));
    const theta = PASS_SPACING / tightest;
    const sagitta = tightest * (1 - Math.cos(theta / 2));
    expect(sagitta).toBeLessThan(0.6);
  });

  it('routes end to end, and the route is the road', () => {
    const route = net.path(0, net.nodes.length - 1);
    expect(route.length).toBe(net.nodes.length);
    // Length through the network is the road's real length, not the valley's.
    expect(net.length(route)).toBeGreaterThan(PASS_LENGTH);
    expect(net.length(route)).toBeCloseTo(PASS_DISTANCE, -1);
  });

  it('starts on the line, pointing up the valley', () => {
    const s = passSpawn();
    expect(s.x).toBeCloseTo(spineX(s.z), 9);
    expect(s.z).toBeLessThan(100);
    expect(Math.abs(s.heading)).toBeLessThan(Math.PI / 2);   // facing +Z
  });
});

describe('pace notes', () => {
  const corners = findCorners();

  it('finds a road full of corners rather than a handful or a hundred', () => {
    expect(corners.length).toBeGreaterThan(25);
    expect(corners.length).toBeLessThan(60);
  });

  it('grades every one of them from its own tightest radius', () => {
    for (const c of corners) {
      expect(c.grade).toBe(gradeFor(c.radius));
      expect(c.grade).toBeGreaterThanOrEqual(1);
      expect(c.grade).toBeLessThanOrEqual(6);
      expect(c.radius).toBeCloseTo(radiusAt(c.apexZ), 6);
    }
  });

  it('keeps the tight ones rare, which is what makes hearing one mean anything', () => {
    const tight = corners.filter(c => c.grade <= 2).length;
    expect(tight).toBeGreaterThan(0);
    expect(tight / corners.length).toBeLessThan(0.3);
  });

  it('lists them in order, without overlaps', () => {
    for (let i = 1; i < corners.length; i++) {
      expect(corners[i].startZ).toBeGreaterThan(corners[i - 1].endZ);
    }
  });

  it('reads them out the way a co-driver would', () => {
    for (const c of corners.slice(0, 6)) {
      expect(noteText(c)).toMatch(/^[LR][1-6]$/);
      expect(noteText(c)[0]).toBe(c.dir < 0 ? 'L' : 'R');
    }
  });

  it('agrees with its own lookup table', () => {
    for (const c of corners) {
      expect(gradeAt((c.startZ + c.endZ) / 2)).toBe(c.grade);
    }
    // Somewhere on a straight it must read as a straight.
    const straights = [];
    for (let z = 0; z < PASS_LENGTH; z += 20) if (radiusAt(z) > 600) straights.push(z);
    expect(straights.length).toBeGreaterThan(0);
    expect(gradeAt(straights[Math.floor(straights.length / 2)])).toBe(6);
  });

  it('measures distance along the ROAD, not along the valley', () => {
    // Every metre of z is at least a metre of driving, and over the pass as a
    // whole it is meaningfully more — that gap is why the table exists.
    let prev = 0;
    for (let z = 0; z <= PASS_LENGTH; z += 50) {
      const a = arcAt(z);
      expect(a).toBeGreaterThanOrEqual(prev);
      expect(a).toBeGreaterThanOrEqual(z - 1e-6);
      prev = a;
    }
    expect(PASS_DISTANCE).toBeGreaterThan(PASS_LENGTH * 1.1);
  });
});

describe('checkpoints', () => {
  it('are spread by road distance and never sit on an apex', () => {
    expect(CHECKPOINTS.length).toBeGreaterThan(5);
    for (let i = 0; i < CHECKPOINTS.length; i++) {
      // Gates are on a piece of road you can actually see one from.
      expect(radiusAt(CHECKPOINTS[i].z)).toBeGreaterThan(150);
      if (i > 0) {
        const gap = CHECKPOINTS[i].arc - CHECKPOINTS[i - 1].arc;
        expect(gap).toBeGreaterThan(300);
        expect(gap).toBeLessThan(1100);
      }
    }
    // The last one leaves a run to the line rather than being the line.
    expect(CHECKPOINTS[CHECKPOINTS.length - 1].z).toBeLessThan(PASS_LENGTH - 50);
  });

  it('formats a run time to a tenth, which is what separates two of them', () => {
    expect(clockText(0)).toBe('0:00.0');
    expect(clockText(9.44)).toBe('0:09.4');
    expect(clockText(65.5)).toBe('1:05.5');
    expect(clockText(600)).toBe('10:00.0');
  });
});

describe('a place with edges', () => {
  afterEach(useCity);

  it('does not fold distances when nothing wraps', () => {
    usePass();
    expect(PLACE.wrapSize).toBe(0);
    // 4000 metres apart is 4000 metres apart, not 4000 − TILE.
    expect(wrapDelta(4000, 0)).toBe(4000);
    expect(wrap(-30)).toBe(-30);
    expect(wrap(9000)).toBe(9000);
  });

  it('still folds them in the city, where it always did', () => {
    useCity();
    expect(wrapDelta(TILE - 10, 10)).toBeCloseTo(-20, 6);
    expect(wrap(-30)).toBeCloseTo(TILE - 30, 6);
  });
});

describe('driving the pass', () => {
  beforeEach(usePass);
  afterEach(useCity);

  /** Full throttle from a point, with a fixed steering input. */
  function run(x: number, z: number, a: number, seconds: number, str = 0) {
    const car = makeCar();
    resetCar(car, x, z, a);
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, str);
    }
    return car;
  }

  it('does not wrap the truck back to the start line', () => {
    // In the city this same code folds position into the tile every step. Here
    // it must not: driving off the summit and reappearing on the line at ninety
    // kilometres an hour is exactly the bug the place switch exists to stop.
    const car = run(spineX(300), 300, Math.atan2(spineSlope(300), 1), 12);
    expect(car.z).toBeGreaterThan(300);
    expect(car.z).toBeLessThan(PASS_LENGTH);
  });

  it('keeps the wheels on the ground the whole way up', () => {
    for (const z of [120, 900, 2100, 2600, 3900, 5000]) {
      const car = makeCar();
      resetCar(car, spineX(z), z, Math.atan2(spineSlope(z), 1));
      const dt = 1 / 60;
      let worst = 0;
      for (let i = 0; i < 60 * 6; i++) {
        for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0);
        worst = Math.max(worst, Math.abs(car.y - terrainAt(car.x, car.z) - V.comH));
        expect(Number.isFinite(car.y)).toBe(true);
      }
      expect(worst).toBeLessThan(0.8);
    }
  });

  it('throws you back off the valley wall rather than letting you climb out', () => {
    /* Straight at the wall, flat out, from the middle of the road. The wall
       has to stop the climb — there is no barrier up here on purpose, and this
       gradient is the only thing standing between an arcade mountain road and
       a driveable hillside. */
    const z = 2000;
    const n = Math.sqrt(1 + spineSlope(z) ** 2);
    const car = makeCar();
    resetCar(car, spineX(z), z, Math.atan2(spineSlope(z), 1) - Math.PI / 2);  // straight off left
    car.vx = Math.sin(car.a) * 26;
    car.vz = Math.cos(car.a) * 26;
    const dt = 1 / 60;
    let furthest = 0;
    for (let i = 0; i < 60 * 8; i++) {
      for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0);
      furthest = Math.max(furthest, offCentre(car.x, car.z));
    }
    expect(furthest).toBeGreaterThan(PASS_ROAD_HALF);        // it does leave the road
    expect(furthest).toBeLessThan(PASS_ROAD_HALF + 80 / n);  // and never tops the ramp
    expect(car.offroad).toBe(true);
  });

  it('costs speed on the climb and gives it back on the descent', () => {
    // Coast, so the only thing acting on it is the hillside.
    const coast = (z: number, back = false) => {
      const car = makeCar();
      const a = Math.atan2(spineSlope(z), 1) + (back ? Math.PI : 0);
      resetCar(car, spineX(z), z, a);
      car.vx = Math.sin(a) * 24;
      car.vz = Math.cos(a) * 24;
      const dt = 1 / 60;
      for (let i = 0; i < 60 * 3; i++) for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 0, 0);
      return Math.abs(car.v);
    };
    // z = 1300 is on the way up, so climbing costs more than descending.
    expect(coast(1300)).toBeLessThan(coast(1300, true));
  });

  it('reads the same height from the shader-side and the physics-side terrain', () => {
    // slopeAt has to be sampling the PASS now, not the city it defaults to.
    for (const [x, z] of [[spineX(700) + 30, 700], [spineX(2400) - 55, 2400]]) {
      const [gx] = slopeAt(x, z);
      const numeric = (terrainAt(x + 1, z) - terrainAt(x - 1, z)) * 0.5;
      expect(gx).toBeCloseTo(numeric, 12);
      expect(terrainAt(x, z)).toBeCloseTo(passTerrainAt(x, z), 12);
    }
  });
});
