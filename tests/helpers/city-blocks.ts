import { Builder } from '../../src/render/builder';
import { BUILDERS, inset, makePlot } from '../../src/render/blocks';
import type { BlockKind } from '../../src/render/blocks';
import { makeRandom } from '../../src/core/math';
import { cityPlan, ROAD_HALF } from '../../src/world/networks/organic';
import type { Block } from '../../src/render/scenery';

/**
 * Run every block archetype on every real block of the city and collect the
 * collision footprints, without needing a scene or a GPU.
 *
 * Grouped by block, because that is where the hazard lives: two buildings on
 * the same block can leave a gap the truck cannot fit through, whereas two on
 * opposite sides of a street are nineteen metres apart by construction.
 *
 * Every archetype on every block, rather than the shipped mix — the question is
 * whether any layout CAN produce a trap, not whether today's seed happens to.
 */
export function buildCityBlocks(seed = 20260826): Array<{ kind: BlockKind; blocks: Block[] }> {
  const rnd = makeRandom(seed);
  const plan = cityPlan();
  const kinds = Object.keys(BUILDERS) as BlockKind[];
  const out: Array<{ kind: BlockKind; blocks: Block[] }> = [];

  for (const face of plan.faces) {
    const plot = makePlot(inset(face.poly, ROAD_HALF + 2.5));
    if (!plot || plot.area < 200) continue;
    for (const kind of kinds) {
      const b = new Builder();
      const blocks: Block[] = [];
      BUILDERS[kind]({ b, plot, rnd, push: block => blocks.push(block) });
      out.push({ kind, blocks });
    }
  }
  return out;
}

/** The four corners of a footprint, in world coordinates. */
export function corners(b: Block): Array<[number, number]> {
  const ca = Math.cos(b.a ?? 0), sa = Math.sin(b.a ?? 0);
  const hw = b.w / 2, hd = b.d / 2;
  // Same transform as Builder.boxRot and collideBlocks: `a` is a bearing, `w`
  // is across it and `d` along it.
  return ([[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as Array<[number, number]>)
    .map(([u, v]) => [b.x + u * ca + v * sa, b.z - u * sa + v * ca]);
}

/**
 * Exact gap between two footprints, or 0 if they touch or overlap.
 *
 * Both are convex, so the distance is realised between a vertex of one and an
 * edge of the other — check both ways round and take the smallest. A separating
 * axis test would have been shorter and would have UNDERESTIMATED corner-to-
 * corner gaps, which is the case this is looking for.
 */
export function gapBetween(a: Block, b: Block): number {
  const A = corners(a), B = corners(b);
  if (overlaps(A, B)) return 0;
  let best = Infinity;
  for (const [P, Q] of [[A, B], [B, A]] as Array<[typeof A, typeof B]>) {
    for (const p of P) {
      for (let i = 0; i < Q.length; i++) {
        best = Math.min(best, pointSeg(p, Q[i], Q[(i + 1) % Q.length]));
      }
    }
  }
  return best;
}

function pointSeg(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

/** Separating-axis overlap test for two convex quads. */
function overlaps(A: Array<[number, number]>, B: Array<[number, number]>): boolean {
  for (const P of [A, B]) {
    for (let i = 0; i < P.length; i++) {
      const dx = P[(i + 1) % P.length][0] - P[i][0];
      const dz = P[(i + 1) % P.length][1] - P[i][1];
      const nx = -dz, nz = dx;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, z] of A) { const d = x * nx + z * nz; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const [x, z] of B) { const d = x * nx + z * nz; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (a1 < b0 || b1 < a0) return false;
    }
  }
  return true;
}
