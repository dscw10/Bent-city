import { describe, it, expect } from 'vitest';
import { makeCar, resetCar, stepVehicle } from '../src/vehicle/vehicle';
import { collideBlocks } from '../src/vehicle/collision';
import { Dispatch } from '../src/game/dispatch';
import { findMode } from '../src/game/modes';
import { nodePos, TILE, wrapDist, wrapDelta } from '../src/core/city-layout';
import type { Block } from '../src/render/city';
import { PAD } from '../src/vehicle/collision';
import { buildCityBlocks } from './helpers/city-blocks';

/**
 * Collision is per BUILDING rather than per block, which is what keeps
 * pavements and plazas open as shortcuts with a price. These check that the
 * push-out actually pushes, that it works across the tile seam, and that road
 * closures are things you hit rather than things you drive through.
 */

/** Drive the truck straight at something and report where it ends up. */
function driveInto(blocks: Block[], startX: number, startZ: number, heading: number, seconds = 4) {
  const car = makeCar();
  resetCar(car, startX, startZ, heading);
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0);
    collideBlocks(car, blocks);
  }
  return car;
}

describe('block collision', () => {
  it('stops the truck entering a building footprint', () => {
    const bx = nodePos(3), bz = nodePos(3) + 40;
    const blocks: Block[] = [{ x: bx, z: bz, w: 20, d: 20 }];
    const car = driveInto(blocks, bx, nodePos(3), 0, 5);
    // It must not end up inside the box, allowing for the 1.4 padding.
    const inside = Math.abs(car.x - bx) < 10 + 1.4 - 0.01 &&
                   Math.abs(car.z - bz) < 10 + 1.4 - 0.01;
    expect(inside).toBe(false);
  });

  it('reports an impact speed, so audio and the camera can react', () => {
    const car = makeCar();
    resetCar(car, 0, 0, 0);
    car.vz = 20;
    car.z = 8.5;
    const impact = collideBlocks(car, [{ x: 0, z: 10, w: 8, d: 8 }]);
    expect(impact).toBeGreaterThan(10);
  });

  it('works across the tile seam', () => {
    // A building at z ≈ 0 and a truck at z ≈ TILE−3 are three metres apart, and
    // the push-out has to know that.
    const car = makeCar();
    resetCar(car, 0, TILE - 3, 0);
    car.vz = 12;
    const impact = collideBlocks(car, [{ x: 0, z: 0, w: 8, d: 8 }]);
    expect(impact).toBeGreaterThan(0);
    // And it must be pushed to the near side, not flung a tile away.
    expect(wrapDist(car.x, car.z, 0, 0)).toBeLessThan(12);
  });

  it('leaves an empty pavement passable', () => {
    // No footprint means no wall: cutting the corner has to stay possible.
    const car = driveInto([], nodePos(2) + 20, nodePos(2) + 20, 0, 4);
    expect(Math.abs(car.v)).toBeGreaterThan(5);
  });
});

describe('bouncing off buildings', () => {
  /**
   * Footprints used to be padded on each axis separately, which makes the
   * collision surface a right angle at every corner. Clip one diagonally and
   * the least-penetration axis flips between x and z from step to step, each
   * flip scrubbing speed, and the truck stops dead on a spot it should have
   * glanced off. The padding is a circle now, so corners are round and the
   * normal turns smoothly through them.
   */
  const WALL: Block[] = [{ x: 0, z: 0, w: 20, d: 20 }];

  /** One contact in isolation: no engine, no suspension, just the response. */
  function contact(x: number, z: number, heading: number, speed = 22) {
    const car = makeCar();
    resetCar(car, x, z, heading);
    car.vx = Math.sin(heading) * speed;
    car.vz = Math.cos(heading) * speed;
    const dt = 1 / 240;
    for (let i = 0; i < 4000; i++) {
      car.x += car.vx * dt;
      car.z += car.vz * dt;
      const impact = collideBlocks(car, WALL);
      if (impact > 0) {
        return { car, impact, out: Math.hypot(car.vx, car.vz), kept: Math.hypot(car.vx, car.vz) / speed };
      }
    }
    return null;
  }

  it('bounces back off a flat face taken head on', () => {
    const r = contact(0, -30, 0);
    expect(r).not.toBeNull();
    expect(r!.car.vz).toBeLessThan(0);            // going back the way it came
    expect(r!.kept).toBeGreaterThan(0.2);         // with a real bounce, not a stop
    expect(r!.kept).toBeLessThan(0.6);
  });

  it('keeps most of its speed on a shallow hit', () => {
    /* Running ALONG the bottom face, angled very slightly into it. Starting x
       has to be between the corners, or the truck is aimed at a corner and the
       hit is head-on rather than glancing. */
    const r = contact(-5, -11.35, Math.PI / 2 - 0.09);
    expect(r).not.toBeNull();
    expect(r!.kept).toBeGreaterThan(0.8);
    expect(r!.car.vx).toBeGreaterThan(0);         // still going the same way
  });

  it('pushes out diagonally at a corner rather than along an axis', () => {
    // Approaching the corner at 45°, the normal must be diagonal. With square
    // padding it would have been purely x or purely z.
    const car = makeCar();
    resetCar(car, -10.9, -10.9, Math.PI / 4);
    const before = { x: car.x, z: car.z };
    collideBlocks(car, WALL);
    const movedX = Math.abs(car.x - before.x);
    const movedZ = Math.abs(car.z - before.z);
    expect(movedX).toBeGreaterThan(0.05);
    expect(movedZ).toBeGreaterThan(0.05);
    // and roughly equally, since the approach was symmetric
    expect(Math.abs(movedX - movedZ)).toBeLessThan(movedX * 0.35);
  });

  /**
   * The actual complaint. What you lose should scale with how deep you cut —
   * a graze costs almost nothing, a real bite costs real speed — and NEITHER
   * should ever park you, which is what the old square corners did.
   */
  function pastCorner(startX: number) {
    const car = makeCar();
    resetCar(car, startX, -26, 0);
    car.vz = 20;                                   // arrive at speed, as you would
    const dt = 1 / 60;
    let slowest = Infinity;
    for (let i = 0; i < 60 * 4; i++) {
      for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0);
      collideBlocks(car, WALL);
      if (car.z > -18) slowest = Math.min(slowest, Math.abs(car.v));
    }
    return { z: car.z, slowest };
  }

  it('lets a graze past almost untouched', () => {
    const r = pastCorner(11.3);
    expect(r.z).toBeGreaterThan(10);
    expect(r.slowest).toBeGreaterThan(14);
  });

  it('costs real speed for a deep cut, but never parks you', () => {
    const r = pastCorner(10.9);
    expect(r.z).toBeGreaterThan(10);               // still got past the building
    expect(r.slowest).toBeGreaterThan(5);          // and never came close to stopping
    // A deeper bite must cost more than a graze, or the corner has no shape.
    expect(r.slowest).toBeLessThan(pastCorner(11.3).slowest);
  });

  it('never leaves the truck inside a footprint', () => {
    for (const angle of [0, 0.4, 0.8, 1.2, 2.0, 2.9, -1.1]) {
      const car = makeCar();
      resetCar(car, -Math.sin(angle) * 30, -Math.cos(angle) * 30, angle);
      const dt = 1 / 60;
      for (let i = 0; i < 60 * 5; i++) {
        for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0);
        collideBlocks(car, WALL);
      }
      const insideX = Math.abs(car.x) < 10;
      const insideZ = Math.abs(car.z) < 10;
      expect(insideX && insideZ).toBe(false);
    }
  });
});

describe('getting unstuck', () => {
  /**
   * Two facing walls used to be resolved in the same pass, pushing the truck
   * opposite ways and scrubbing its speed from both sides at once. A truck that
   * had nosed into a narrow gap was pinned there with no way out.
   */
  it('does not pin the truck between two facing walls', () => {
    const car = makeCar();
    resetCar(car, 0, 0, 0);
    // A gap barely wider than the truck, walls either side.
    const blocks: Block[] = [
      { x: -4, z: 0, w: 4, d: 30 },
      { x: 4, z: 0, w: 4, d: 30 }
    ];
    const dt = 1 / 60;
    let moved = 0;
    for (let i = 0; i < 60 * 3; i++) {
      const before = car.z;
      for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, -1, 0);
      collideBlocks(car, blocks);
      moved += Math.abs(car.z - before);
    }
    expect(moved).toBeGreaterThan(5);
    expect(Math.abs(car.v)).toBeGreaterThan(1);
  });

  it('reverses back out of a building it has driven into', () => {
    const wall: Block[] = [{ x: 0, z: 30, w: 40, d: 40 }];
    const car = makeCar();
    resetCar(car, 0, 0, 0);
    const dt = 1 / 60;
    // Drive at it until it stops us.
    for (let i = 0; i < 60 * 4; i++) {
      for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, 1, 0);
      collideBlocks(car, wall);
    }
    const stuckAt = car.z;
    // Now back off.
    for (let i = 0; i < 60 * 3; i++) {
      for (let k = 0; k < 3; k++) stepVehicle(car, dt / 3, -1, 0);
      collideBlocks(car, wall);
    }
    // Measured through the wrap: reversing past zero puts car.z near TILE.
    expect(wrapDelta(car.z, stuckAt)).toBeLessThan(-6);
  });

  it('leaves every alley in the city wide enough for the truck', () => {
    // Whatever the block layouts do, no two footprints may leave a gap the
    // truck cannot fit through — that is a wedge trap, not a shortcut.
    const city = buildCityBlocks();
    let worst = Infinity;
    for (let i = 0; i < city.length; i++) {
      for (let j = i + 1; j < city.length; j++) {
        const a = city[i], b = city[j];
        const gapX = Math.abs(a.x - b.x) - (a.w + b.w) / 2 - 2 * PAD;
        const gapZ = Math.abs(a.z - b.z) - (a.d + b.d) / 2 - 2 * PAD;
        // Only pairs that actually face each other across a gap count.
        const facesX = Math.abs(a.z - b.z) < (a.d + b.d) / 2;
        const facesZ = Math.abs(a.x - b.x) < (a.w + b.w) / 2;
        if (facesX && gapX > 0) worst = Math.min(worst, gapX);
        if (facesZ && gapZ > 0) worst = Math.min(worst, gapZ);
      }
    }
    expect(worst).toBeGreaterThan(1.5);
  });
});

describe('road closures', () => {
  it('puts a barrier on every closed segment', () => {
    const d = new Dispatch();
    d.start(findMode('rush'));
    expect(d.closures.length).toBeGreaterThan(0);
    expect(d.barriers.length).toBe(d.closures.length);
    for (let i = 0; i < d.closures.length; i++) {
      expect(d.barriers[i].x).toBeCloseTo(d.closures[i].x, 6);
      expect(d.barriers[i].z).toBeCloseTo(d.closures[i].z, 6);
    }
  });

  it('is something you hit, not something you drive through', () => {
    const d = new Dispatch();
    d.start(findMode('rush'));
    const c = d.closures[0];
    // Approach along the road the barrier blocks.
    const heading = c.alongX ? 0 : Math.PI / 2;
    const start = c.alongX
      ? { x: c.x, z: c.z - 40 }
      : { x: c.x - 40, z: c.z };
    const car = driveInto(d.barriers, start.x, start.z, heading, 6);
    const past = c.alongX ? car.z - c.z : car.x - c.x;
    expect(past).toBeLessThan(0);
  });

  it('leaves a way round, because block interiors are drivable', () => {
    // The barrier spans the carriageway only. It must not seal the block, or a
    // closure stops being a detour and becomes a wall.
    const d = new Dispatch();
    d.start(findMode('rush'));
    for (const b of d.barriers) {
      const span = Math.max(b.w, b.d);
      expect(span).toBeLessThan(58);          // narrower than the block pitch
    }
  });
});
