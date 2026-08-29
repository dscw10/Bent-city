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
