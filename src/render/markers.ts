import type { Builder } from './builder';
import type { RGB } from '../core/palette';
import { C } from '../core/palette';
import type { Point } from '../world/graph';

/**
 * Marks drawn onto the world: the route, objectives, rivals, closures.
 *
 * THE GENERAL PRINCIPLE, learned when the destination marker stopped working:
 * anything that must be legible in BOTH regions needs a component built for
 * each. A tall pillar is the beacon you see down the street, and it flattens
 * into nothing on the map. A flat ground ring is invisible at street level and
 * is the only thing that survives onto the map. So markers have both.
 */

/** Ribbon width and the height it floats at, above the road but below the kerb. */
const RIBBON_W = 4.6;
const RIBBON_Y = 0.16;

/**
 * The route ribbon. Subdivided every ~2m along its length: the bend happens per
 * vertex, so a straight run drawn as one long quad bends as a chord and reads as
 * a broken road.
 */
export function drawRibbon(b: Builder, path: Point[], col: RGB = C.matcha): void {
  if (path.length < 2) return;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], c = path[i + 1];
    const dx = c[0] - a[0], dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const ux = dx / len, uz = dz / len;
    const px = -uz * RIBBON_W / 2, pz = ux * RIBBON_W / 2;
    const steps = Math.max(2, Math.round(len / 2));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps, t1 = (s + 1) / steps;
      const A = [a[0] + dx * t0, a[1] + dz * t0];
      const B = [a[0] + dx * t1, a[1] + dz * t1];
      b.quad(
        [A[0] - px, RIBBON_Y, A[1] - pz], [A[0] + px, RIBBON_Y, A[1] + pz],
        [B[0] + px, RIBBON_Y, B[1] + pz], [B[0] - px, RIBBON_Y, B[1] - pz],
        1, 1, col
      );
    }
    // Corner patch, or turns leave a notch.
    b.slab(c[0], c[1], RIBBON_W, RIBBON_W, RIBBON_Y, col, 1);
  }
}

/**
 * An objective marker. Two components, for the two regions:
 *   - a tall pillar: the beacon you see down the street
 *   - a flat ground ring: the footprint that survives onto the map
 *
 * `urgency` 0..1 shrinks the ring's countdown arc. That arc is the point of the
 * whole exercise — it is information you can only act on from above, because at
 * street level you can see one objective at a time and from the map you can see
 * all of them and choose.
 */
export function drawObjective(
  b: Builder, x: number, z: number, col: RGB,
  opts: { pillar?: boolean; ringSize?: number; remaining?: number } = {}
): void {
  const { pillar = true, ringSize = 22, remaining } = opts;

  if (pillar) b.box(x, z, 2.2, 66, 2.2, col, col, 8, -20);
  b.ring(x, z, ringSize, 3.2, 0.22, col);

  if (remaining !== undefined) drawCountdown(b, x, z, ringSize * 1.55, remaining, col);
}

/**
 * A countdown drawn as a ring of ticks that empties clockwise from twelve.
 * Ticks rather than a smooth arc because ticks stay countable when the map
 * scale shrinks them to a few pixels — a smooth wedge just becomes a smudge.
 */
export function drawCountdown(
  b: Builder, x: number, z: number, radius: number,
  remaining: number, col: RGB, ticks = 12
): void {
  const lit = Math.ceil(Math.max(0, Math.min(1, remaining)) * ticks);
  for (let i = 0; i < lit; i++) {
    const ang = -(i / ticks) * Math.PI * 2;             // clockwise from +Z
    const cx = x + Math.sin(ang) * radius;
    const cz = z + Math.cos(ang) * radius;
    b.slabRot(cx, cz, 2.0, 4.4, 0.20, ang, col, 1);
  }
}

/**
 * A rival courier. A chevron pointing where they are going, plus a short trail
 * behind it, so from the map you can read their heading and roughly their speed
 * without any text. A stubby beacon keeps them visible in the near field.
 */
export function drawRival(
  b: Builder, x: number, z: number, heading: number, speed01: number
): void {
  const col = C.rival;
  const s = Math.sin(heading), c = Math.cos(heading);

  // Chevron: two bars meeting at a point ahead.
  const tipX = x + s * 5.0, tipZ = z + c * 5.0;
  b.slabRot(tipX - s * 2.4 + c * 1.9, tipZ - c * 2.4 - s * 1.9, 1.9, 6.4, 0.24, heading + 0.42, col, 1);
  b.slabRot(tipX - s * 2.4 - c * 1.9, tipZ - c * 2.4 + s * 1.9, 1.9, 6.4, 0.24, heading - 0.42, col, 1);

  // Trail — longer the faster they are moving.
  const trail = 6 + 18 * speed01;
  for (let i = 0; i < 4; i++) {
    const t = (i + 1) / 4;
    const d = 5 + trail * t;
    b.slabRot(x - s * d, z - c * d, 1.5 * (1 - t * 0.6), 3.0, 0.20, heading, col, 1);
  }

  b.box(x, z, 1.6, 12, 1.6, col, col, 3, -20);
}

/**
 * A road closure. Bars across the carriageway in the near field, plus a flat X
 * that stays readable once everything is lying down on the map.
 */
export function drawClosure(b: Builder, x: number, z: number, alongX: boolean): void {
  const col = C.hazard;
  const w = 15;
  for (let i = -1; i <= 1; i++) {
    const off = i * 2.6;
    if (alongX) b.slab(x + off, z, 1.6, w, 0.26, col, 2);
    else b.slab(x, z + off, w, 1.6, 0.26, col, 2);
  }
  // The X reads at any map scale and at any orientation.
  b.slabRot(x, z, 2.2, 20, 0.24, Math.PI / 4, col, 1);
  b.slabRot(x, z, 2.2, 20, 0.24, -Math.PI / 4, col, 1);
}

/**
 * A turn arrow painted on the road at a junction: near-field guidance so you do
 * not have to read the map for the next decision, only for the one after it.
 * `turn` is −1 left, 0 straight, +1 right.
 */
export function drawTurnArrow(
  b: Builder, x: number, z: number, heading: number, turn: number
): void {
  const col = C.matcha;
  const s = Math.sin(heading), c = Math.cos(heading);
  // Shaft along the direction of travel.
  b.slabRot(x, z, 2.4, 11, 0.14, heading, col, 2);

  const head = heading + turn * Math.PI / 2;
  const hx = x + s * 5.5, hz = z + c * 5.5;
  if (turn === 0) {
    b.slabRot(hx + s * 2.0, hz + c * 2.0, 5.2, 5.2, 0.14, heading + Math.PI / 4, col, 1);
  } else {
    // Bend the shaft round, then a head on the new direction.
    b.slabRot(hx + Math.sin(head) * 3.0, hz + Math.cos(head) * 3.0, 2.4, 7.0, 0.14, head, col, 2);
    const ax = hx + Math.sin(head) * 7.0, az = hz + Math.cos(head) * 7.0;
    b.slabRot(ax, az, 4.4, 4.4, 0.14, head + Math.PI / 4, col, 1);
  }
}
