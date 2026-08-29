import { describe, it, expect } from 'vitest';
import { V, makeCar, resetCar, stepVehicle } from '../src/vehicle/vehicle';
import { terrainAt, slopeAt } from '../src/core/terrain';
import { nodePos, TILE } from '../src/core/city-layout';
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
  it('reaches 30 m/s in a few seconds and settles at a sane top speed', () => {
    const { trace } = drive(22, 1, 0);
    const to30 = trace.find(s => s.v >= 30);
    expect(to30).toBeDefined();
    expect(to30!.t).toBeGreaterThan(1.5);
    expect(to30!.t).toBeLessThan(8);

    const top = Math.max(...trace.map(s => s.v));
    expect(top).toBeGreaterThan(40);
    expect(top).toBeLessThan(70);
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
