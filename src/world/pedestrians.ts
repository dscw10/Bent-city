import { wrap, wrapDelta, wrapDist } from '../core/place';
import type { Builder } from '../render/builder';
import type { RGB } from '../core/palette';
import { shade } from '../core/palette';
import { approachAngle } from '../core/math';
import { P } from '../core/config';
import { cityPlan, ROAD_HALF } from './networks/organic';
import { pavementRing } from '../render/blocks';
import type { Point } from './network';

/**
 * Pedestrians. They walk the pavement round a block, and they scatter when the
 * truck gets close.
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
 *
 * WALKING A RING, NOT A GRID. The lattice version worked out which block you
 * were in with two modulos and pushed you to the nearer edge of a square
 * pavement band. A block is a polygon now, so a pedestrian holds the block it
 * belongs to and how far round it has walked — which is both simpler and the
 * only version that can follow a kerb that bends.
 */
const NEAR = 16;          // when they notice you
const HIT = 1.9;          // when you have clipped one
const SPAWN_MIN = 25;
const SPAWN_MAX = 110;
const DESPAWN = 170;
const HEAD: RGB = [0.30, 0.32, 0.35];
/** How far inside the kerb they walk. */
const PAVEMENT = ROAD_HALF + 1.6;

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
  /** Which block's pavement they belong to, and which way round they walk. */
  ring: number;
  along: number;
  way: 1 | -1;
}

/** The pavement outline of every block, walked once and kept. */
let rings: Array<{ poly: Point[]; seg: number[]; total: number }> | null = null;

function ringsOf() {
  if (rings) return rings;
  rings = [];
  for (const f of cityPlan().faces) {
    const poly = pavementRing(f.poly, PAVEMENT);
    if (poly.length < 3) continue;
    const seg: number[] = [];
    let total = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      seg.push(len);
      total += len;
    }
    if (total > 20) rings.push({ poly, seg, total });
  }
  return rings;
}

/** Where you are after walking `s` metres round block `r`, and which way. */
function onRing(r: number, s: number): { x: number; z: number; heading: number } {
  const ring = ringsOf()[r];
  let t = ((s % ring.total) + ring.total) % ring.total;
  for (let i = 0; i < ring.poly.length; i++) {
    if (t <= ring.seg[i]) {
      const a = ring.poly[i], b = ring.poly[(i + 1) % ring.poly.length];
      const u = ring.seg[i] > 0 ? t / ring.seg[i] : 0;
      return {
        x: a[0] + (b[0] - a[0]) * u,
        z: a[1] + (b[1] - a[1]) * u,
        heading: Math.atan2(b[0] - a[0], b[1] - a[1])
      };
    }
    t -= ring.seg[i];
  }
  return { x: ring.poly[0][0], z: ring.poly[0][1], heading: 0 };
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
        p.x = wrap(p.x + Math.sin(p.heading) * p.speed * 3.1 * dt);
        p.z = wrap(p.z + Math.cos(p.heading) * p.speed * 3.1 * dt);
      } else {
        if (p.panic > 0) {
          p.panic -= dt;
          /* Walking back to the kerb after a fright, rather than snapping to
             it. Panic pushes them off the ring and this is what puts them
             back, so the two never fight over the same frame. */
          const home = onRing(p.ring, p.along);
          p.heading = approachAngle(p.heading, Math.atan2(home.x - p.x, home.z - p.z), dt, 0.5);
          p.x = wrap(p.x + Math.sin(p.heading) * p.speed * dt);
          p.z = wrap(p.z + Math.cos(p.heading) * p.speed * dt);
        } else {
          p.along += p.way * p.speed * dt;
          const at = onRing(p.ring, p.along);
          p.x = wrap(at.x);
          p.z = wrap(at.z);
          p.heading = p.way > 0 ? at.heading : at.heading + Math.PI;
        }
      }
      p.bob += p.speed * dt * 3.4;

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
    const all = ringsOf();
    const ang = Math.random() * Math.PI * 2;
    const r = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    const tx = carX + Math.sin(ang) * r, tz = carZ + Math.cos(ang) * r;

    // Whichever block's pavement is nearest where they were asked for.
    let ring = 0, best = Infinity;
    for (let i = 0; i < all.length; i++) {
      const p = all[i].poly[0];
      const d = Math.hypot(wrapDelta(p[0], tx), wrapDelta(p[1], tz));
      if (d < best) { best = d; ring = i; }
    }

    const along = Math.random() * all[ring].total;
    const at = onRing(ring, along);
    const t = 0.30 + Math.random() * 0.42;
    return {
      x: wrap(at.x), z: wrap(at.z),
      heading: at.heading,
      speed: 1.1 + Math.random() * 0.7,
      panic: 0,
      bob: Math.random() * 6,
      col: [t, t * 1.03, t * 1.08],
      h: 1.6 + Math.random() * 0.24,
      ring,
      along,
      way: Math.random() < 0.5 ? 1 : -1
    };
  }
}
