import { PITCH, ROADW, BLOCK } from '../core/city-layout';
import { wrap, wrapDelta, wrapDist } from '../core/place';
import type { Builder } from '../render/builder';
import type { RGB } from '../core/palette';
import { shade } from '../core/palette';
import { approachAngle } from '../core/math';
import { P } from '../core/config';

/**
 * Pedestrians. They walk the pavement ring around a block, and they scatter
 * when the truck gets close.
 *
 * Two reasons they earn their place:
 *
 * - The pavement is a legitimate shortcut in this game — block interiors are
 *   drivable, at the cost of drag and grip. Putting people on it gives that
 *   shortcut a second cost that is nothing to do with physics, so cutting the
 *   corner becomes a judgement rather than a reflex.
 * - They give the near field something that moves at human scale, which is what
 *   makes the life-size half of the frame feel life-size.
 *
 * They are blocks of colour and they run away. Clipping one costs you your
 * combo — enough to make you lift, not enough to end a run.
 */
const NEAR = 16;          // when they notice you
const HIT = 1.9;          // when you have clipped one
const SPAWN_MIN = 25;
const SPAWN_MAX = 110;
const DESPAWN = 170;
const HEAD: RGB = [0.30, 0.32, 0.35];

export interface Pedestrian {
  x: number;
  z: number;
  heading: number;
  speed: number;
  /** Seconds of panic left. While it lasts they sprint away from the truck. */
  panic: number;
  bob: number;
  col: RGB;
  h: number;
}

export class Pedestrians {
  readonly list: Pedestrian[] = [];

  start(count: number, carX: number, carZ: number): void {
    this.list.length = 0;
    for (let i = 0; i < count; i++) this.list.push(this.spawn(carX, carZ));
  }

  /** Returns how many were clipped this frame. */
  update(dt: number, carX: number, carZ: number, carSpeed: number): number {
    let hits = 0;

    for (const p of this.list) {
      const dx = wrapDelta(p.x, carX), dz = wrapDelta(p.z, carZ);
      const d = Math.hypot(dx, dz);

      if (d < NEAR && Math.abs(carSpeed) > 3) {
        p.panic = 1.4;
        // Straight away from the truck, which reads as alarm rather than as
        // pathfinding — and, usefully, gets them off your line.
        p.heading = approachAngle(p.heading, Math.atan2(dx, dz), dt, 0.12);
      } else if (p.panic > 0) {
        p.panic -= dt;
      } else {
        // Idle wander, with a gentle bias back toward the pavement ring.
        p.heading += (Math.random() - 0.5) * dt * 1.6;
        const kerb = this.kerbBias(p.x, p.z);
        if (kerb !== null) p.heading = approachAngle(p.heading, kerb, dt, 0.9);
      }

      const v = p.panic > 0 ? p.speed * 3.1 : p.speed;
      p.x = wrap(p.x + Math.sin(p.heading) * v * dt);
      p.z = wrap(p.z + Math.cos(p.heading) * v * dt);
      p.bob += v * dt * 3.4;

      if (d < HIT && Math.abs(carSpeed) > 4) {
        hits++;
        Object.assign(p, this.spawn(carX, carZ));
        continue;
      }
      if (d > DESPAWN) Object.assign(p, this.spawn(carX, carZ));
    }

    return hits;
  }

  /** Y values are pre-divided by uBuildH — see the note in traffic.ts. */
  draw(b: Builder, carX: number, carZ: number): void {
    const inv = 1 / P.buildH;
    for (const p of this.list) {
      if (wrapDist(p.x, p.z, carX, carZ) > 220) continue;
      // A walk cycle for the price of one sine: the body bobs, and at this
      // scale that is enough to read as walking rather than sliding.
      const bob = Math.abs(Math.sin(p.bob)) * 0.10;
      const base = (0.10 + bob) * inv;
      b.box(p.x, p.z, 0.52, p.h * 0.62 * inv, 0.36, p.col, shade(p.col), 2, base);
      b.box(p.x, p.z, 0.40, p.h * 0.30 * inv, 0.34, HEAD, HEAD, 2, base + p.h * 0.62 * inv);
    }
  }

  private spawn(carX: number, carZ: number): Pedestrian {
    const ang = Math.random() * Math.PI * 2;
    const r = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    // Land them on the pavement ring of whichever block they fell into, so
    // nobody spawns standing in the middle of a carriageway.
    const [x, z] = this.snapToPavement(carX + Math.sin(ang) * r, carZ + Math.cos(ang) * r);
    const t = 0.30 + Math.random() * 0.42;
    return {
      x, z,
      heading: Math.random() * Math.PI * 2,
      speed: 1.1 + Math.random() * 0.7,
      panic: 0,
      bob: Math.random() * 6,
      col: [t, t * 1.03, t * 1.08],
      h: 1.6 + Math.random() * 0.24
    };
  }

  /** Nudge a point onto the pavement band just inside a block's edge. */
  private snapToPavement(x: number, z: number): [number, number] {
    const lx = wrap(x) % PITCH, lz = wrap(z) % PITCH;
    const inner = ROADW / 2 + 2.2;
    const outer = PITCH - ROADW / 2 - 2.2;
    const clampBand = (v: number) => {
      if (v < inner) return inner;
      if (v > outer) return outer;
      // Inside the block: push to whichever edge of the pavement ring is nearer.
      const mid = PITCH / 2;
      return v < mid ? inner : outer;
    };
    // Only one axis is pushed, so they end up on an edge rather than a corner.
    if (Math.random() < 0.5) return [wrap(x) - lx + clampBand(lx), wrap(z)];
    return [wrap(x), wrap(z) - lz + clampBand(lz)];
  }

  /**
   * If a pedestrian has wandered into the middle of a block or out onto the
   * road, return a heading that takes them back toward the pavement.
   */
  private kerbBias(x: number, z: number): number | null {
    const lx = wrap(x) % PITCH, lz = wrap(z) % PITCH;
    const onRoad = lx < ROADW / 2 || lx > PITCH - ROADW / 2 ||
                   lz < ROADW / 2 || lz > PITCH - ROADW / 2;
    const deepInside = lx > ROADW / 2 + BLOCK * 0.28 && lx < PITCH - ROADW / 2 - BLOCK * 0.28 &&
                       lz > ROADW / 2 + BLOCK * 0.28 && lz < PITCH - ROADW / 2 - BLOCK * 0.28;
    if (!onRoad && !deepInside) return null;

    const cx = wrap(x) - lx + PITCH / 2;
    const cz = wrap(z) - lz + PITCH / 2;
    const toCentre = Math.atan2(cx - wrap(x), cz - wrap(z));
    return onRoad ? toCentre : toCentre + Math.PI;
  }
}
