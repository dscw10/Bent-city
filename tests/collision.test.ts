import { describe, it, expect } from 'vitest';
import { makeCar, resetCar, stepVehicle } from '../src/vehicle/vehicle';
import { collideBlocks } from '../src/vehicle/collision';
import { Dispatch } from '../src/game/dispatch';
import { findMode } from '../src/game/modes';
import { nodePos, TILE, wrapDist } from '../src/core/city-layout';
import type { Block } from '../src/render/city';

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
