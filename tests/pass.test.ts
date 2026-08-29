import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TRACK, PASS_LENGTH, PASS_ROAD_HALF, PASS_CLIMB, PASS_RIPPLE_A,
  PASS_PRIMS, PASS_STRIDE, PASS_GLSL,
  trackPoint, trackHeading, trackNearest, trackRadius, trackCurvature,
  passTerrainAt, passFloor, passWall, passOffroad, passSpawn, passUniformValues
} from '../src/core/pass-shape';
import { buildPassNetwork, PASS_SPACING } from '../src/world/networks/pass';
import { findCorners, gradeFor, noteText, PASS_DISTANCE } from '../src/game/pace-notes';
import { CHECKPOINTS, gradeAt, clockText } from '../src/game/pass-run';
import { setTerrain, terrainAt, slopeAt } from '../src/core/terrain';
import { setPlace, wrapDelta, wrap, PLACE } from '../src/core/place';
import { TILE, onOffroad } from '../src/core/city-layout';
import { V, makeCar, resetCar, stepVehicle } from '../src/vehicle/vehicle';

/**
 * The pass is generated from a track of straights and arcs, so almost
 * everything about it is checkable rather than eyeballable: where the road is,
 * whether it joins up, how steep the walls are, which corners are tight, how
 * far apart the gates ended up. These are the facts the rest of the level leans
 * on — and two of them caught real bugs.
 */

function usePass(): void {
  setTerrain('pass');
  setPlace({ wrapSize: 0, offroad: passOffroad });
}
function useCity(): void {
  setTerrain('city');
  setPlace({ wrapSize: TILE, offroad: onOffroad });
}

describe('the track', () => {
  it('joins up: no jumps in position or in heading at any piece boundary', () => {
    /* This is the one that caught the sweep sign being inverted. Every piece
       was individually correct, the road was one connected curve, and the only
       symptom was that each arc left its entry point travelling BACKWARDS —
       which the self-consistency checks could not see. */
    for (const p of TRACK) {
      if (p.s0 === 0) continue;
      const a = trackPoint(p.s0 - 0.01), b = trackPoint(p.s0 + 0.01);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(0.1);

      const dh = trackHeading(p.s0 - 0.01) - trackHeading(p.s0 + 0.01);
      expect(Math.abs(Math.atan2(Math.sin(dh), Math.cos(dh)))).toBeLessThan(0.01);
    }
  });

  it('finds itself exactly, from any point on itself', () => {
    // The nearest-point solve is exact, not an approximation — which is the
    // whole reason the road stopped being a function of z.
    let worstD = 0, worstS = 0;
    for (let s = 0; s <= PASS_LENGTH; s += 3.3) {
      const [x, z] = trackPoint(s);
      const n = trackNearest(x, z);
      worstD = Math.max(worstD, n.d);
      worstS = Math.max(worstS, Math.abs(n.s - s));
    }
    expect(worstD).toBeLessThan(1e-6);
    expect(worstS).toBeLessThan(1e-6);
  });

  it('never runs back into itself', () => {
    /* Two legs of a hairpin passing within a road's width of each other is not
       a near miss, it is a defect: the terrain would have two roads at two
       heights fighting over the same ground, and you could drive from one to
       the other. The first recipe crossed itself at 0.6 metres. */
    const pts: Array<[number, number, number]> = [];
    for (let s = 0; s <= PASS_LENGTH; s += 4) pts.push([s, ...trackPoint(s)]);
    let worst = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 25; j < pts.length; j++) {          // >100m apart on the road
        worst = Math.min(worst, Math.hypot(pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]));
      }
    }
    expect(worst).toBeGreaterThan(30);
  });

  it('has real hairpins, which is the entire reason it is a track', () => {
    /* The old road was x = S(z), and the arithmetic said it could never have
       one: at the apex of a turn the radius is 1/S″, so a 30m apex needs S″
       held over 180 metres — and at the ends of that swing the same S″ gives a
       717m radius. Tight for an instant, nearly straight either side. A hairpin
       is a SUSTAINED tight radius through 160-odd degrees. */
    const hairpins = TRACK.filter(p =>
      p.kind !== 0 && p.r < 32 && Math.abs(p.sweep) > 150 * Math.PI / 180);
    expect(hairpins.length).toBeGreaterThanOrEqual(4);
    /* They come in PAIRS of opposite hand — a switchback — so the road works
       its way across the mountain instead of tying itself in a knot. Three the
       same way running would be a spiral, and a spiral crosses itself. */
    expect(hairpins.some(p => p.kind === 1)).toBe(true);
    expect(hairpins.some(p => p.kind === -1)).toBe(true);
    for (let i = 2; i < hairpins.length; i++) {
      const run = hairpins[i].kind === hairpins[i - 1].kind
        && hairpins[i - 1].kind === hairpins[i - 2].kind;
      expect(run).toBe(false);
    }
  });

  it('is a road you could drive rather than a set of unrelated corners', () => {
    expect(PASS_LENGTH).toBeGreaterThan(4000);
    expect(TRACK.filter(p => p.kind === 0).length).toBeGreaterThan(15);
    expect(TRACK.length).toBeLessThanOrEqual(PASS_PRIMS);     // fits the uniform block
  });
});

describe('the pass, as a shape', () => {
  beforeEach(usePass);
  afterEach(useCity);

  it('is flat across the carriageway and steep off it', () => {
    for (let s = 0; s <= PASS_LENGTH; s += 137) {
      const [cx, cz] = trackPoint(s);
      // On the centreline the wall contributes nothing at all.
      expect(passTerrainAt(cx, cz)).toBeCloseTo(passFloor(s), 6);

      // Across the road, the ground rises by less than a kerb.
      const h = trackHeading(s);
      const ex = cx + Math.cos(h) * PASS_ROAD_HALF, ez = cz - Math.sin(h) * PASS_ROAD_HALF;
      expect(Math.abs(passTerrainAt(ex, ez) - passFloor(s))).toBeLessThan(0.05);
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

  it('hands the shader the same road the CPU is using', () => {
    // The GLSL cannot be executed here, but the two halves at least have to be
    // fed the same numbers, in the same layout, and use the same names.
    const u = passUniformValues();
    expect(u.track.length).toBe(PASS_PRIMS * PASS_STRIDE);
    expect(u.D).toEqual([PASS_CLIMB, PASS_ROAD_HALF, 80, PASS_LENGTH]);

    for (let i = 0; i < TRACK.length; i++) {
      const p = TRACK[i];
      expect(u.track[i * PASS_STRIDE]).toEqual([p.kind, p.ax, p.az, p.r]);
      expect(u.track[i * PASS_STRIDE + 2]).toEqual([p.aStart, p.sweep, p.s0, p.len]);
    }
    // Unused slots must be switched off, or the shader finds phantom road.
    for (let i = TRACK.length; i < PASS_PRIMS; i++) {
      expect(u.track[i * PASS_STRIDE + 3][2]).toBeLessThan(0);
    }
    for (const name of ['uTrack', 'uPassD', 'uPassE']) expect(PASS_GLSL).toContain(name);
    expect(PASS_GLSL).toContain(`#define PASS_PRIMS ${PASS_PRIMS}`);
  });

  it('calls you off the road exactly where the tarmac ends', () => {
    for (let s = 40; s < PASS_LENGTH; s += 311) {
      const [cx, cz] = trackPoint(s);
      const h = trackHeading(s);
      const off = (w: number) => passOffroad(cx + Math.cos(h) * w, cz - Math.sin(h) * w);
      expect(off(0)).toBe(false);
      expect(off(PASS_ROAD_HALF - 1)).toBe(false);
      expect(off(PASS_ROAD_HALF + 1)).toBe(true);
      expect(off(-(PASS_ROAD_HALF + 1))).toBe(true);
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

  it('puts every junction on the road', () => {
    for (const n of net.nodes) expect(trackNearest(n.x, n.z).d).toBeLessThan(1e-6);
  });

  it('samples finely enough that the route does not cut the apex', () => {
    /* The chord between two nodes falls inside the true curve by
       r(1 − cos(θ/2)), and at the tightest corner on the pass that has to stay
       inside the width of the painted line — otherwise the route ribbon cuts
       clean across the road it is supposed to be drawn on. */
    const tightest = Math.min(...TRACK.filter(p => p.kind !== 0).map(p => p.r));
    const theta = PASS_SPACING / tightest;
    expect(tightest * (1 - Math.cos(theta / 2))).toBeLessThan(0.8);
  });

  it('routes end to end, and the route is the road', () => {
    const route = net.path(0, net.nodes.length - 1);
    expect(route.length).toBe(net.nodes.length);
    expect(net.length(route)).toBeCloseTo(PASS_LENGTH, -2);
  });

  it('starts on the line, pointing up the road', () => {
    const s = passSpawn();
    expect(trackNearest(s.x, s.z).d).toBeLessThan(1e-6);
    expect(trackNearest(s.x, s.z).s).toBeLessThan(60);
  });
});

describe('pace notes', () => {
  const corners = findCorners();

  it('is every arc on the track, and nothing else', () => {
    // The whole finding-a-corner problem went away with the track rewrite.
    expect(corners.length).toBe(TRACK.filter(p => p.kind !== 0).length);
    for (const c of corners) expect(c.exit).toBeGreaterThan(c.entry);
  });

  it('grades every one of them from its own radius', () => {
    for (const c of corners) {
      expect(c.grade).toBe(gradeFor(c.radius));
      expect(c.grade).toBeGreaterThanOrEqual(1);
      expect(c.grade).toBeLessThanOrEqual(6);
      expect(trackRadius((c.entry + c.exit) / 2)).toBeCloseTo(c.radius, 6);
    }
  });

  it('spreads the grades across the road rather than bunching them', () => {
    const seen = new Set(corners.map(c => c.grade));
    expect(seen.size).toBeGreaterThanOrEqual(5);
    // And the tightest grade means the hairpins, not "most corners".
    const ones = corners.filter(c => c.grade === 1).length;
    expect(ones).toBeGreaterThan(2);
    expect(ones / corners.length).toBeLessThan(0.45);
  });

  it('lists them in order, without overlaps', () => {
    for (let i = 1; i < corners.length; i++) {
      expect(corners[i].entry).toBeGreaterThanOrEqual(corners[i - 1].exit - 1e-9);
    }
  });

  it('reads them out the way a co-driver would', () => {
    for (const c of corners) {
      expect(noteText(c)).toMatch(/^[LR][1-6]$/);
      expect(noteText(c)[0]).toBe(c.dir < 0 ? 'L' : 'R');
      expect(Math.sign(trackCurvature((c.entry + c.exit) / 2))).toBe(c.dir);
    }
  });

  it('agrees with its own lookup table', () => {
    for (const c of corners) expect(gradeAt((c.entry + c.exit) / 2)).toBe(c.grade);
    // And a straight reads as a straight.
    const straight = TRACK.find(p => p.kind === 0 && p.len > 200)!;
    expect(gradeAt(straight.s0 + straight.len / 2)).toBe(6);
  });

  it('measures distance along the ROAD, because that is now the parameter', () => {
    expect(PASS_DISTANCE).toBe(PASS_LENGTH);
  });
});

describe('checkpoints', () => {
  it('are spread along the road and never sit on an apex', () => {
    expect(CHECKPOINTS.length).toBeGreaterThan(5);
    for (let i = 0; i < CHECKPOINTS.length; i++) {
      // Gates are on a piece of road you can actually see one from.
      expect(trackRadius(CHECKPOINTS[i].s)).toBeGreaterThan(150);
      if (i > 0) {
        const gap = CHECKPOINTS[i].s - CHECKPOINTS[i - 1].s;
        expect(gap).toBeGreaterThan(300);
        expect(gap).toBeLessThan(1100);
      }
    }
    // The last one leaves a run to the line rather than being the line.
    expect(CHECKPOINTS[CHECKPOINTS.length - 1].s).toBeLessThan(PASS_LENGTH - 50);
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

  const dt = 1 / 60;

  it('does not wrap the truck back to the start line', () => {
    /* In the city this same code folds position into the tile every step. Here
       it must not: driving off the summit and reappearing on the line at ninety
       kilometres an hour is exactly the bug the place switch exists to stop. */
    const car = makeCar();
    const [x, z] = trackPoint(300);
    resetCar(car, x, z, trackHeading(300));
    for (let i = 0; i < 60 * 12; i++) for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0);
    expect(trackNearest(car.x, car.z).s).toBeGreaterThan(300);
  });

  it('keeps the wheels on the ground the whole way up', () => {
    for (const s of [120, 900, 1800, 2600, 3400, 4400]) {
      const car = makeCar();
      const [x, z] = trackPoint(s);
      resetCar(car, x, z, trackHeading(s));
      let worst = 0;
      for (let i = 0; i < 60 * 5; i++) {
        for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0);
        worst = Math.max(worst, Math.abs(car.y - terrainAt(car.x, car.z) - V.comH));
        expect(Number.isFinite(car.y)).toBe(true);
      }
      expect(worst).toBeLessThan(0.8);
    }
  });

  it('throws you back off the valley wall rather than letting you climb out', () => {
    /* Straight at the wall, flat out, from the middle of a straight. The wall
       has to stop the climb — there is no barrier up here on purpose, and this
       gradient is the only thing standing between an arcade mountain road and
       a driveable hillside. */
    const piece = TRACK.find(p => p.kind === 0 && p.len > 250)!;
    const s = piece.s0 + piece.len / 2;
    const [x, z] = trackPoint(s);
    const car = makeCar();
    resetCar(car, x, z, trackHeading(s) - Math.PI / 2);       // straight off left
    car.vx = Math.sin(car.a) * 26;
    car.vz = Math.cos(car.a) * 26;
    let furthest = 0;
    for (let i = 0; i < 60 * 8; i++) {
      for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0);
      furthest = Math.max(furthest, trackNearest(car.x, car.z).d);
    }
    expect(furthest).toBeGreaterThan(PASS_ROAD_HALF);        // it does leave the road
    expect(furthest).toBeLessThan(PASS_ROAD_HALF + 80);      // and never tops the ramp
    expect(car.offroad).toBe(true);
  });

  it('can be driven round a hairpin, and cannot be driven round it flat out', () => {
    /* The point of putting hairpins in. At 24 metres of radius, arriving at
       cruising speed and simply steering is not enough — you have to have got
       rid of the speed first. Both halves matter: a corner nobody can take is
       as bad as one everybody can. */
    const pin = TRACK.find(p => p.kind !== 0 && p.r < 32)!;
    const entry = pin.s0 - 30;

    const run = (speed: number) => {
      const car = makeCar();
      const [x, z] = trackPoint(entry);
      resetCar(car, x, z, trackHeading(entry));
      car.vx = Math.sin(car.a) * speed;
      car.vz = Math.cos(car.a) * speed;
      let off = 0;
      for (let i = 0; i < 60 * 12; i++) {
        // Steer toward the road a little way ahead: a simple, honest driver.
        const here = trackNearest(car.x, car.z);
        const [tx, tz] = trackPoint(Math.min(PASS_LENGTH, here.s + 18));
        let e = Math.atan2(tx - car.x, tz - car.z) - car.a;
        e = Math.atan2(Math.sin(e), Math.cos(e));
        const str = Math.max(-1, Math.min(1, -e * 2.2));
        for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 0.35, str);
        off = Math.max(off, here.d);
      }
      return { car, off, s: trackNearest(car.x, car.z).s };
    };

    const slow = run(11);
    expect(slow.off).toBeLessThan(PASS_ROAD_HALF + 4);       // stayed on the road
    expect(slow.s).toBeGreaterThan(pin.s0 + pin.len);        // and got round it

    const fast = run(28);
    expect(fast.off).toBeGreaterThan(slow.off + 3);          // ran wide
  });

  it('reads the same height from the shader-side and the physics-side terrain', () => {
    // slopeAt has to be sampling the PASS now, not the city it defaults to.
    for (const s of [700, 2400]) {
      const [cx, cz] = trackPoint(s);
      const x = cx + 30, z = cz - 55;
      const [gx] = slopeAt(x, z);
      expect(gx).toBeCloseTo((terrainAt(x + 1, z) - terrainAt(x - 1, z)) * 0.5, 12);
      expect(terrainAt(x, z)).toBeCloseTo(passTerrainAt(x, z), 12);
    }
  });
});
