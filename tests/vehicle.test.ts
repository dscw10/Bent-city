import { describe, it, expect } from 'vitest';
import { V, TUNE, makeCar, resetCar, stepVehicle } from '../src/vehicle/vehicle';
import { terrainAt, slopeAt } from '../src/core/terrain';
import { TILE } from '../src/core/city-layout';
import { nodePos, PITCH } from './helpers/lattice';
import { P } from '../src/core/config';

/**
 * The four worst bugs in this vehicle were all found by running it headlessly
 * and printing state over time, not by driving it. These are the invariants
 * that came out of that, kept as tests so they cannot quietly come back.
 */

/** Run the truck for `seconds`, with the same substepping the game uses. */
function drive(seconds: number, thr: number, str: number, startA = 0, x = nodePos(2), z = nodePos(2)) {
  const car = makeCar();
  resetCar(car, x, z, startA);
  const dt = 1 / 60;
  const trace: Array<{ t: number; v: number; roll: number; pitch: number; y: number }> = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, thr, str);
    trace.push({ t: i * dt, v: car.v, roll: car.roll, pitch: car.pitch, y: car.y });
  }
  return { car, trace };
}

describe('the rollover rule', () => {
  /**
   * Grip once exceeded the rollover threshold, so the truck physically
   * two-wheeled in EVERY corner. Correct physics, terrible vehicle.
   * mu must stay comfortably below track / (2 × centre-of-mass height).
   */
  it('keeps grip below the rollover threshold', () => {
    const track = V.halfTrack * 2;
    const threshold = track / (2 * V.comH);
    expect(threshold).toBeGreaterThan(1.6);
    expect(V.mu).toBeLessThan(threshold);
    // A deliberately slim margin: it should lift an inside wheel at full lock,
    // because that is correct for a kei truck and it reads well.
    expect(threshold - V.mu).toBeLessThan(0.4);
  });

  it('puts front cornering stiffness above the rear, so it rotates', () => {
    expect(V.cornerF).toBeGreaterThan(V.cornerR);
  });
});

describe('straight-line performance', () => {
  it('accelerates briskly but tops out at a speed a kei truck could reach', () => {
    const { trace } = drive(30, 1, 0);
    const to20 = trace.find(s => s.v >= 20);
    expect(to20).toBeDefined();
    expect(to20!.t).toBeGreaterThan(1.5);
    expect(to20!.t).toBeLessThan(6);

    const top = Math.max(...trace.map(s => s.v));
    // 25-33 m/s is 90-120 km/h. It used to do 167, which is not a kei truck.
    expect(top).toBeGreaterThan(23);
    expect(top).toBeLessThan(34);
  });

  it('leaves time to read the map at cruising speed', () => {
    /* A design invariant, not a physics one. The city's block pitch is 58m; at
       full power the truck used to cross one in 1.9s, which is not long enough
       to look up at the plan region and act on it. Cruising has to be slower
       than that or the whole projection goes unused. */
    /* Measured against P.vMax, the declared reference speed the steering
       falloff, the bend response and the engine audio all use — not against a
       peak, which varies by several m/s depending on which hill you measured on. */
    const cruise = P.vMax * 0.7;
    expect(PITCH / cruise).toBeGreaterThan(2.2);
  });

  it('brakes through a stop and then reverses', () => {
    // Holding the brake used to end at a standstill because there was no
    // reverse gear. Now it should pass THROUGH zero and back up, which is what
    // a player holding the pedal actually expects.
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 6; i++) for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0);
    const before = car.v;
    expect(before).toBeGreaterThan(20);

    let slowest = Infinity;
    for (let i = 0; i < 60 * 5; i++) {
      for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, -1, 0);
      slowest = Math.min(slowest, Math.abs(car.v));
    }
    expect(slowest).toBeLessThan(1);       // it really did come to a stop
    expect(car.v).toBeLessThan(-3);        // and carried on into reverse
  });

  it('dives under braking, which is weight transfer actually working', () => {
    // Without the contact-patch torque term the loads never change and the
    // suspension is purely decorative.
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 6; i++) for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0);
    const cruiseFront = car.load[0] + car.load[1];
    let peakPitch = 0;
    for (let i = 0; i < 60; i++) {
      for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, -1, 0);
      peakPitch = Math.min(peakPitch, car.pitch);
    }
    const brakingFront = car.load[0] + car.load[1];
    expect(brakingFront).toBeGreaterThan(cruiseFront * 1.3);
    expect(Math.abs(peakPitch)).toBeGreaterThan(0.005);
  });
});

describe('reverse', () => {
  /**
   * There was no reverse gear at all: negative input was always a brake
   * opposing the wheel's current direction, so the instant the truck started
   * rolling backwards the same input pushed it forwards again. Nose into a
   * building and you buzzed against it forever.
   */
  const hold = (car: ReturnType<typeof makeCar>, seconds: number, thr: number, str = 0) => {
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, thr, str);
    }
  };

  it('reverses from a standstill and keeps going', () => {
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    const z0 = car.z;
    hold(car, 4, -1);
    expect(car.v).toBeLessThan(-3);                       // actually moving backwards
    expect(car.z - z0).toBeLessThan(-8);                  // and has covered ground
  });

  it('brakes to a stop first when it is rolling forwards', () => {
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    hold(car, 5, 1);
    const cruising = car.v;
    expect(cruising).toBeGreaterThan(15);
    hold(car, 1.2, -1);
    // A second of brake from speed must SLOW it, not fling it into reverse.
    expect(car.v).toBeGreaterThan(-1);
    expect(car.v).toBeLessThan(cruising - 5);
  });

  it('caps reverse well below the forward top speed', () => {
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    hold(car, 25, -1);
    expect(Math.abs(car.v)).toBeLessThan(V.reverseMax + 2);
    expect(Math.abs(car.v)).toBeLessThan(20);
  });

  it('lets the throttle stop a reverse and drive out forwards', () => {
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    hold(car, 3, -1);
    expect(car.v).toBeLessThan(-2);
    hold(car, 4, 1);
    expect(car.v).toBeGreaterThan(2);
  });
});

describe('cornering', () => {
  it('turns, leans, and never spins like a top', () => {
    const { car, trace } = drive(12, 1, 1);
    expect(Math.abs(car.yaw)).toBeLessThanOrEqual(V.maxYawRate + 1e-6);
    const peakRoll = Math.max(...trace.map(s => Math.abs(s.roll)));
    expect(peakRoll).toBeGreaterThan(0.02);       // it does lean
    expect(peakRoll).toBeLessThanOrEqual(0.16 + 1e-9);  // and the stop holds
  });

  it('follows its nose rather than sliding forever', () => {
    // Velocity redirection: the truck should end up travelling roughly where it
    // is pointing, not drifting sideways indefinitely.
    const { car } = drive(10, 1, 0.7);
    const vdir = Math.atan2(car.vx, car.vz);
    let slip = car.a - vdir;
    slip = Math.atan2(Math.sin(slip), Math.cos(slip));
    expect(Math.abs(slip)).toBeLessThan(0.6);
  });
});

describe('steering feel', () => {
  /**
   * The road wheels used to snap to the commanded angle in a single step, so a
   * flick of a stick WAS full lock instantly. These pin the fix down, and pin
   * down which half of it actually mattered — rate limiting the wheels was the
   * smaller half; how eagerly the BODY rotates was the rest.
   */
  const dt = 1 / 60;
  const hold = (seconds: number, thr: number, str: number, car = makeCar()) => {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, thr, str);
    return car;
  };

  it('does not reach full lock in a single step', () => {
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 0, 1);
    expect(Math.abs(car.steer)).toBeGreaterThan(0);
    expect(Math.abs(car.steer)).toBeLessThan(V.maxSteer * 0.4);
  });

  it('comes back to centre quicker than it goes out', () => {
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    hold(0.1, 0.3, 1, car);
    const out = Math.abs(car.steer);
    hold(0.1, 0.3, 0, car);
    // Same elapsed time: it must have shed more than it gained.
    expect(Math.abs(car.steer)).toBeLessThan(out * 0.6);
  });

  it('takes lock away with speed', () => {
    const slow = makeCar();
    resetCar(slow, nodePos(2), nodePos(2), 0);
    hold(1.5, 0, 1, slow);
    const fast = makeCar();
    resetCar(fast, nodePos(2), nodePos(2), 0);
    hold(9, 1, 0, fast);
    hold(1.5, 1, 1, fast);
    expect(Math.abs(fast.v)).toBeGreaterThan(20);
    expect(Math.abs(fast.steer)).toBeLessThan(Math.abs(slow.steer) * 0.8);
  });

  it('is measurably calmer on the calm setting than the lively one', () => {
    const peakYaw = (setting: number) => {
      TUNE.steerSpeed = setting;
      const car = makeCar();
      resetCar(car, nodePos(2), nodePos(2), 0);
      hold(6, 1, 0, car);
      let peak = 0;
      for (let i = 0; i < 60 * 0.6; i++) {
        for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 0.4, 1);
        peak = Math.max(peak, Math.abs(car.yaw));
      }
      return peak;
    };
    const lively = peakYaw(1);
    const calm = peakYaw(0);
    TUNE.steerSpeed = 0.28;
    expect(calm).toBeLessThan(lively * 0.8);
  });

  it('still turns tightly enough to take a junction at junction speed', () => {
    /* Calmer must not mean it cannot get round a corner. The roads are 14m
       wide, so a turn taken at a sensible 10 m/s has to come in under about
       that. The speed is HELD through the corner — measuring at whatever speed
       the truck happens to reach measures the throttle, not the steering. */
    TUNE.steerSpeed = 0;
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    const target = 10;
    const drive = (str: number, seconds: number) => {
      for (let i = 0; i < Math.round(seconds / dt); i++) {
        const thr = Math.max(-1, Math.min(1, (target - car.v) * 0.35));
        for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, thr, str);
      }
    };
    drive(0, 6);
    drive(1, 3);
    const radius = Math.abs(car.v) / Math.abs(car.yaw);
    TUNE.steerSpeed = 0.28;
    expect(car.v).toBeGreaterThan(8);
    expect(radius).toBeLessThan(14);
  });
});

describe('drift: hop in, then choose the angle', () => {
  const dt = 1 / 60;
  const slipOf = (c: ReturnType<typeof makeCar>) =>
    Math.atan2(Math.sin(c.a - Math.atan2(c.vx, c.vz)), Math.cos(c.a - Math.atan2(c.vx, c.vz)));

  const frame = (car: ReturnType<typeof makeCar>, thr: number, str: number, drift: boolean) => {
    // Both of these are cleared by the CALLER, not by stepVehicle — see the
    // notes on Car.boostFired and Car.spunOut.
    car.boostFired = 0;
    car.spunOut = false;
    for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, thr, str, drift);
  };

  /** Up to speed, then hand control to a pilot function for `seconds`. */
  function fly(seconds: number, pilot: (car: ReturnType<typeof makeCar>, t: number) => number,
               drift = true) {
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    for (let i = 0; i < 60 * 3; i++) frame(car, 1, 0, false);
    const entryV = car.v;
    const entryA = car.a;
    let spun = false;
    let peakAir = 0;
    let peakYaw = 0;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      frame(car, 0.9, pilot(car, i * dt), drift);
      peakAir = Math.max(peakAir, car.y - terrainAt(car.x, car.z) - V.comH);
      peakYaw = Math.max(peakYaw, Math.abs(car.yaw));
      if (car.spunOut) { spun = true; break; }
    }
    const turned = Math.atan2(Math.sin(car.a - entryA), Math.cos(car.a - entryA));
    return { car, spun, peakAir, peakYaw, entryV, turned };
  }

  /** Flick in, then hold the stick wherever the caller wants it. */
  const held = (after: number) => (_c: ReturnType<typeof makeCar>, t: number) =>
    t < 0.35 ? 1 : after;

  it('hops, and the wheels really leave the ground', () => {
    const r = fly(0.5, () => 1);
    expect(r.peakAir).toBeGreaterThan(0.1);
    expect(r.peakAir).toBeLessThan(1.2);           // a hop, not a jump
  });

  it('locks into the direction you were steering as it lands', () => {
    const right = fly(0.8, () => 1);
    expect(right.car.driftPhase).toBe('locked');
    expect(right.car.driftDir).toBe(1);
    const left = fly(0.8, () => -1);
    expect(left.car.driftDir).toBe(-1);
  });

  it('will not start below walking pace', () => {
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    for (let i = 0; i < 60 * 2; i++) frame(car, 0, 1, true);
    expect(car.driftPhase).toBe('none');
    expect(car.driftCharge).toBe(0);
  });

  /**
   * The heart of the Mario Kart model: the stick is not a torque, it is a
   * CHOICE OF ANGLE within a bounded range. Three settings, three drifts, and
   * the ordering is the whole mechanic.
   */
  it('gives a tighter drift the harder you hold into it', () => {
    const into = fly(2.0, held(1));
    const mid = fly(2.0, held(0));
    const wide = fly(2.0, held(-1));

    const s = (r: { car: ReturnType<typeof makeCar> }) => Math.abs(slipOf(r.car));
    expect(s(into)).toBeGreaterThan(s(mid));
    expect(s(mid)).toBeGreaterThan(s(wide));

    // And each one is near the angle it asked for, not somewhere it drifted to.
    expect(s(into)).toBeGreaterThan(V.driftTight * 0.7);
    expect(s(wide)).toBeLessThan(V.driftMid);
  });

  it('turns the same way whatever the stick does — counter is wider, not opposite', () => {
    /* The bug this pins: at full counter the front axle used to out-torque the
       drift controller and steer the truck the other way round. In a kart game
       holding away from a drift gives you a WIDE version of that corner, never
       the opposite corner. */
    const into = fly(2.0, held(1));
    const wide = fly(2.0, held(-1));
    expect(Math.sign(wide.turned)).toBe(Math.sign(into.turned));
    expect(Math.abs(wide.turned)).toBeLessThan(Math.abs(into.turned));
    expect(Math.abs(wide.turned)).toBeGreaterThan(0.4);   // still a real corner
  });

  it('does not spin out just because you stopped steering', () => {
    /* This is the behaviour that deliberately changed. It used to be the point
       — a constant destabilising torque meant doing nothing walked you into a
       spin. Measured from 20 m/s that reached 135 deg/s of yaw and spun inside
       1.25 seconds, dumping the truck to 8 m/s. That is what "steers too
       sharply" was. */
    const r = fly(4, held(0));
    expect(r.spun).toBe(false);
    expect(r.car.driftCharge).toBeGreaterThan(0.5);
  });

  it('keeps the angle bounded even at full commitment', () => {
    const r = fly(4, held(1));
    expect(r.spun).toBe(false);
    expect(Math.abs(slipOf(r.car))).toBeLessThan(V.driftSpin);
    expect(r.peakYaw).toBeLessThan(2.0);
  });

  it('is progressive: slamming the stick over is not a step input', () => {
    /* The target may only travel at driftAim rad/s, so a stick slammed from
       full counter to full into cannot move the truck instantly. Sampled the
       frame after the slam it must be part-way, not arrived. */
    const r = fly(1.6, held(-1));
    const before = r.car.driftTarget;
    frame(r.car, 0.9, 1, true);
    const after = r.car.driftTarget;
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeLessThanOrEqual(V.driftAim * dt + 1e-9);
    expect(after).toBeLessThan(V.driftTight * 0.6);       // nowhere near arrived
  });

  it('steers the front wheels far less than gripping does', () => {
    // The other half of the fix for the darting: one stick cannot do two jobs
    // at full authority, so the road wheels give up most of their lock.
    const drifting = fly(1.5, held(1));
    const gripping = fly(1.5, () => 1, false);
    expect(Math.abs(drifting.car.steer)).toBeLessThan(Math.abs(gripping.car.steer) * 0.6);
  });

  it('pays for commitment: harder drift, faster charge', () => {
    const into = fly(1.6, held(1));
    const mid = fly(1.6, held(0));
    expect(into.car.driftCharge).toBeGreaterThan(mid.car.driftCharge * 1.5);
  });

  it('earns nothing from a truck that is not actually sideways', () => {
    // Holding the button down a straight is not a drift. Steering nothing at
    // all never locks in, so there is no charge to farm.
    const r = fly(3, () => 0);
    expect(r.car.driftCharge).toBe(0);
  });

  it('drops the drift rather than becoming a slow pirouette', () => {
    // A big slip angle at walking pace is free rotation, not a drift. The
    // target tapers with speed and the drift ends outright below a floor.
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    for (let i = 0; i < 60 * 3; i++) frame(car, 1, 0, false);
    for (let i = 0; i < 60 * 2; i++) frame(car, 0.9, 1, true);
    expect(car.driftPhase).toBe('locked');
    // Now take the power away and let the speed wash off.
    for (let i = 0; i < 60 * 8; i++) frame(car, -0.2, 1, true);
    expect(car.driftPhase).toBe('none');
    expect(Math.abs(car.v)).toBeLessThan(V.driftMinSpeed);
  });

  it('cashes the charge in on release, once', () => {
    const r = fly(2.0, held(1));
    const charge = r.car.driftCharge;
    expect(charge).toBeGreaterThan(V.driftMinCharge);

    frame(r.car, 0.8, 0, false);                   // released
    expect(r.car.boostFired).toBeCloseTo(charge, 5);
    expect(r.car.boost).toBeGreaterThan(0);
    expect(r.car.driftCharge).toBe(0);

    frame(r.car, 0.8, 0, false);
    expect(r.car.boostFired).toBe(0);              // and not again
  });

  it('is worth doing: a committed drift turns tighter and leaves faster', () => {
    /* The arcade bargain, and the reason any of this exists. A full drift
       costs a lot of speed through the corner and hands it back as a boost, so
       it has to come out level with or ahead of simply gripping round —
       otherwise the button is decoration. */
    const drift = fly(2.0, held(1));
    const grip = fly(2.0, () => 1, false);
    expect(Math.abs(drift.turned)).toBeGreaterThan(Math.abs(grip.turned));
    expect(drift.car.v).toBeLessThan(grip.car.v);           // slower mid-corner

    // Now let both run on, so the drift can cash its boost.
    for (const r of [drift, grip]) {
      for (let i = 0; i < 60 * 1.6; i++) frame(r.car, 1, 0, false);
    }
    expect(drift.car.v).toBeGreaterThan(grip.car.v * 0.98);
  });

  it('pays nothing for a stab of the button', () => {
    const r = fly(0.5, () => 1);
    frame(r.car, 0.8, 0, false);
    expect(r.car.boostFired).toBe(0);
    expect(r.car.boost).toBe(0);
  });

  it('actually goes faster on boost, and the boost runs out', () => {
    const measure = (withBoost: boolean) => {
      const car = makeCar();
      resetCar(car, nodePos(2), nodePos(2), 0);
      for (let i = 0; i < 60 * 4; i++) frame(car, 1, 0, false);
      if (withBoost) car.boost = V.boostTime;
      for (let i = 0; i < 60 * 1.5; i++) frame(car, 1, 0, false);
      return car;
    };
    const boosted = measure(true);
    const plain = measure(false);
    expect(boosted.v).toBeGreaterThan(plain.v + 3);
    expect(boosted.boost).toBeGreaterThan(0);

    for (let i = 0; i < 60 * 3; i++) frame(boosted, 1, 0, false);
    expect(boosted.boost).toBe(0);
  });

  it('cannot be stacked past the ceiling', () => {
    const car = makeCar();
    resetCar(car, nodePos(2), nodePos(2), 0);
    for (let i = 0; i < 60 * 40; i++) {
      car.boost = V.boostTime;
      frame(car, 1, 0, false);
    }
    expect(car.v).toBeLessThan(P.vMax * V.boostCeiling + 6);
    expect(Number.isFinite(car.v)).toBe(true);
  });
});

describe('terrain', () => {
  it('costs speed uphill and gives it back downhill', () => {
    // Find the steepest slope on the map and coast down it, then up it.
    let best = { x: 0, z: 0, g: 0 };
    for (let x = 0; x < TILE; x += 6) {
      for (let z = 0; z < TILE; z += 6) {
        const [gx] = slopeAt(x, z);
        if (Math.abs(gx) > Math.abs(best.g)) best = { x, z, g: gx };
      }
    }
    // Heading +x is a = π/2.
    const uphill = best.g > 0 ? Math.PI / 2 : -Math.PI / 2;

    const run = (a: number) => {
      const car = makeCar();
      resetCar(car, best.x, best.z, a);
      car.vx = Math.sin(a) * 30;
      car.vz = Math.cos(a) * 30;
      const dt = 1 / 60;
      for (let i = 0; i < 60 * 4; i++) for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 0, 0);
      return car.v;
    };

    expect(run(uphill)).toBeLessThan(run(uphill + Math.PI));
  });

  it('keeps the truck on the ground everywhere, at any heading', () => {
    // Ride height must not diverge, and the truck must not sink through a hill.
    for (const [x, z] of [[40, 40], [200, 380], [430, 90], [261, 261], [500, 500]]) {
      for (const a of [0, 1.1, 2.4, -2.0]) {
        const car = makeCar();
        resetCar(car, x, z, a);
        const dt = 1 / 60;
        let worst = 0;
        for (let i = 0; i < 60 * 12; i++) {
          const steer = Math.sin(i / 90) * 0.8;
          for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, steer);
          const ride = car.y - terrainAt(car.x, car.z);
          worst = Math.max(worst, Math.abs(ride - V.comH));
          expect(Number.isFinite(car.x)).toBe(true);
        }
        expect(worst).toBeLessThan(0.6);
      }
    }
  });

  it('wraps position into the tile, always', () => {
    const { car } = drive(40, 1, 0.1);
    expect(car.x).toBeGreaterThanOrEqual(0);
    expect(car.x).toBeLessThan(TILE);
    expect(car.z).toBeGreaterThanOrEqual(0);
    expect(car.z).toBeLessThan(TILE);
  });
});

describe('framerate independence', () => {
  it('lands in roughly the same place at 30fps and at 144fps', () => {
    const run = (fps: number) => {
      const car = makeCar();
      resetCar(car, nodePos(3), nodePos(3), 0);
      const dt = 1 / fps;
      for (let i = 0; i < Math.round(6 * fps); i++) {
        for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0.3);
      }
      return car;
    };
    const slow = run(30);
    const fast = run(144);
    // Not identical — it is an explicit integrator — but the same corner.
    expect(Math.abs(slow.v - fast.v)).toBeLessThan(4);
    expect(Math.hypot(slow.x - fast.x, slow.z - fast.z)).toBeLessThan(28);
  });
});

describe('reference speed', () => {
  it('agrees with the projection about what full speed means', () => {
    // The speed-reactive bend measures |v| against P.vMax, and the steering
    // falloff uses the same number. If they drift apart the view stops
    // reacting where the handling does.
    const { trace } = drive(25, 1, 0);
    const top = Math.max(...trace.map(s => s.v));
    expect(top).toBeGreaterThan(P.vMax * 0.7);
    expect(top).toBeLessThan(P.vMax * 1.5);
  });
});
