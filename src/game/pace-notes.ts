import { PASS_LENGTH, spineSlope, spineCurve, spineX } from '../core/pass-shape';

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
 * Everything here is derived by DIFFERENTIATING the centreline rather than by
 * measuring the built geometry. The road, the terrain and the notes are then
 * three views of one function and cannot disagree about where a corner is.
 */

export interface Corner {
  /** Distance along the pass axis where the corner begins and ends. */
  startZ: number;
  endZ: number;
  /** Where it is tightest. */
  apexZ: number;
  /** Tightest radius through it, in metres. */
  radius: number;
  /** −1 left, +1 right. */
  dir: -1 | 1;
  /** Rally grade: 1 tightest … 6 fastest. */
  grade: number;
  /** Arc distance from the start line to the corner's entry. */
  entry: number;
}

/** Beyond this radius the road is not doing anything worth calling out. */
const CORNER_RADIUS = 260;
/** Two bends closer than this with the same sign are one corner. */
const MERGE_GAP = 45;
/** A wobble shorter than this is noise in the sway, not a corner. */
const MIN_LENGTH = 14;

/** Radius of the centreline at z. Standard curvature of x = f(z). */
export function radiusAt(z: number): number {
  const s = spineSlope(z);
  const c = spineCurve(z);
  return Math.pow(1 + s * s, 1.5) / Math.max(1e-9, Math.abs(c));
}

/**
 * Grade from radius, 1 tightest to 6 barely a bend.
 *
 * The boundaries were picked against this road's ACTUAL distribution rather
 * than from a table. Its forty corners run from a 59m radius to about 250m, so
 * generic thresholds would have graded nearly half of them a 2 — and a warning
 * that fires on half the corners is not a warning, it is a background colour.
 * These put three corners in grade 1 and four in grade 2, which keeps a red
 * note something you sit up for.
 *
 * Measured quantiles, for whoever changes the sway terms next:
 *   min 59 · p20 81 · p40 101 · p60 133 · p80 187 · max 249
 */
export function gradeFor(radius: number): number {
  if (radius < 66) return 1;
  if (radius < 85) return 2;
  if (radius < 110) return 3;
  if (radius < 150) return 4;
  if (radius < 200) return 5;
  return 6;
}

/**
 * Arc length along the centreline, tabulated every 4m.
 *
 * Worth the table: the road runs up to 55° away from the pass axis, so at its
 * worst a metre of z is 1.45 metres of driving. Calling a corner "in 200m" when
 * it is 280m of road away is the difference between a note you trust and one
 * you learn to ignore.
 */
const ARC_STEP = 4;
const ARC: Float64Array = (() => {
  const n = Math.ceil(PASS_LENGTH / ARC_STEP) + 1;
  const a = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const z = (i - 0.5) * ARC_STEP;
    const s = spineSlope(z);
    a[i] = a[i - 1] + Math.sqrt(1 + s * s) * ARC_STEP;
  }
  return a;
})();

/** Distance driven from the start line to a point z along the axis. */
export function arcAt(z: number): number {
  const t = Math.min(Math.max(z, 0), PASS_LENGTH) / ARC_STEP;
  const i = Math.min(ARC.length - 2, Math.floor(t));
  return ARC[i] + (ARC[i + 1] - ARC[i]) * (t - i);
}

/** Total length of road, as opposed to the length of the valley. */
export const PASS_DISTANCE = arcAt(PASS_LENGTH);

/**
 * Every corner on the pass, in order. Computed once — the road never changes,
 * and forty corners is not a thing worth recomputing per frame.
 */
export function findCorners(): Corner[] {
  const out: Corner[] = [];
  let cur: { startZ: number; endZ: number; dir: -1 | 1; radius: number; apexZ: number } | null = null;

  for (let z = 0; z <= PASS_LENGTH; z += 2) {
    const r = radiusAt(z);
    if (r >= CORNER_RADIUS) continue;
    const dir: -1 | 1 = spineCurve(z) > 0 ? 1 : -1;

    if (cur && cur.dir === dir && z - cur.endZ <= MERGE_GAP) {
      cur.endZ = z;
      if (r < cur.radius) { cur.radius = r; cur.apexZ = z; }
    } else {
      if (cur) push(cur, out);
      cur = { startZ: z, endZ: z, dir, radius: r, apexZ: z };
    }
  }
  if (cur) push(cur, out);
  return out;
}

function push(
  c: { startZ: number; endZ: number; dir: -1 | 1; radius: number; apexZ: number },
  out: Corner[]
): void {
  if (c.endZ - c.startZ < MIN_LENGTH) return;
  out.push({
    startZ: c.startZ, endZ: c.endZ, apexZ: c.apexZ,
    radius: c.radius, dir: c.dir,
    grade: gradeFor(c.radius),
    entry: arcAt(c.startZ)
  });
}

/** "L2", "R5" — the co-driver's shorthand, and the HUD's whole vocabulary. */
export const noteText = (c: Corner): string => `${c.dir < 0 ? 'L' : 'R'}${c.grade}`;

/** Where a corner's entry is in the world, for hanging a marker off. */
export function cornerPoint(c: Corner, z = c.startZ): [number, number] {
  return [spineX(z), z];
}
