import { TRACK, PASS_LENGTH, trackPoint, trackHeading } from '../core/pass-shape';
import type { Prim } from '../core/pass-shape';

/**
 * ======================= PACE NOTES =======================
 *
 * The answer to "what is the plan region FOR on a road with no junctions".
 *
 * In the city the map answers a routing question: several drops are live, each
 * with a countdown, and the game is choosing an order to serve them in. A pass
 * has one road, so that question does not exist and a map of it would be a
 * stripe of nothing — which is exactly the objection that made a second place
 * worth building rather than a reskin.
 *
 * What a co-driver reads out instead is the SHAPE OF THE ROAD AHEAD: which way
 * the next corner goes, how tight it is, and how far away it is. That is
 * information about a place you cannot see yet, which is the one thing the fold
 * is uniquely good at showing — and unlike a turn arrow at a junction it cannot
 * be reduced to a single near-field decision, because the useful version is
 * three corners deep and the answer to each depends on the ones after it.
 *
 * GRADES follow the rally convention: 1 is the tightest, 6 is barely a bend.
 * Counter-intuitive if you have not seen it before, which is why the HUD prints
 * the direction letter first — "L2" reads as a thing rather than as a number.
 *
 * THIS USED TO BE THE HARD PART. When the road was a sum of sines, a corner had
 * to be FOUND: sample the curvature, threshold it, group runs of the same sign,
 * merge across gaps, then hunt the apex for a radius. Now the road is built
 * from arcs, so every corner is a piece of the track with its radius already
 * written on it, and all of that goes away. That is the second time the track
 * rewrite made something downstream simpler rather than harder.
 */

export interface Corner {
  /** Distance along the road where the corner begins and ends. */
  entry: number;
  exit: number;
  /** The arc's radius, in metres. */
  radius: number;
  /** −1 left, +1 right. */
  dir: -1 | 1;
  /** How far round it goes, in radians. */
  sweep: number;
  /** Rally grade: 1 tightest … 6 fastest. */
  grade: number;
}

/**
 * Grade from radius, 1 tightest to 6 barely a bend.
 *
 * Calibrated against THIS road's actual arcs rather than from a table — the
 * boundaries mean nothing without the distribution they are cutting. The pass
 * has nineteen corners at these radii:
 *
 *   24 26 26 27 28 30 · 35 39 · 46 50 56 · 72 88 · 95 115 130 · 145 160 185
 *
 * which the cuts below split 6 / 2 / 3 / 2 / 3 / 3. The six in grade 1 are the
 * hairpins, and they are the reason the grade exists: at 24 metres of radius
 * the truck cannot take one without either braking hard or drifting it.
 */
export function gradeFor(radius: number): number {
  if (radius < 32) return 1;
  if (radius < 45) return 2;
  if (radius < 60) return 3;
  if (radius < 95) return 4;
  if (radius < 140) return 5;
  return 6;
}

/** Every corner on the pass, in order. Computed once — the road never changes. */
export function findCorners(): Corner[] {
  return TRACK
    .filter((p): p is Prim => p.kind !== 0)
    .map(p => ({
      entry: p.s0,
      exit: p.s0 + p.len,
      radius: p.r,
      dir: (p.kind === 1 ? 1 : -1) as -1 | 1,
      sweep: Math.abs(p.sweep),
      grade: gradeFor(p.r)
    }));
}

/**
 * Distance along the road IS the parameter now, so there is no arc-length table
 * any more. It existed because the old road was parameterised by a straight
 * axis that ran up to 45% short of the real driving distance, and calling a
 * corner "in 200m" when it was 280m of road away is the difference between a
 * note you trust and one you learn to ignore.
 */
export const PASS_DISTANCE = PASS_LENGTH;

/** "L2", "R5" — the co-driver's shorthand, and the HUD's whole vocabulary. */
export const noteText = (c: Corner): string => `${c.dir < 0 ? 'L' : 'R'}${c.grade}`;

/** Where a corner's entry is in the world, and which way the road points there. */
export function cornerPoint(c: Corner): { x: number; z: number; heading: number } {
  const [x, z] = trackPoint(c.entry);
  return { x, z, heading: trackHeading(c.entry) };
}
