import * as THREE from 'three';
import { Builder } from './builder';
import { C } from '../core/palette';
import { makeRandom } from '../core/math';
import { BUILDERS, inset, makePlot } from './blocks';
import type { BlockKind } from './blocks';
import { TILE, TILES_ACROSS } from '../core/city-layout';
import { cityPlan, ROAD_HALF } from '../world/networks/organic';
import { bentMat, roadMat, addBent } from './materials';
import type { Block, Chunk, Scenery } from './scenery';

export type { BlockKind } from './blocks';
export type { Block } from './scenery';

/** What occupies each block. Kept for the dev overlay. */
export interface CityMeta { kinds: BlockKind[] }

const CITY_SEED = 20260826;

/**
 * How often each archetype comes up. The landmarks are deliberately rare: a
 * shrine on every corner is not a landmark, it is wallpaper. Roughly one in
 * eight blocks is something you would give directions by.
 */
const MIX: Array<[BlockKind, number]> = [
  ['buildings', 0.40],
  ['superblock', 0.11],
  ['park', 0.09],
  ['lot', 0.07],
  ['market', 0.09],
  ['podium', 0.09],
  ['works', 0.06],
  ['dock', 0.05],
  ['shrine', 0.04]
];

function pickKind(r: number): BlockKind {
  let acc = 0;
  for (const [kind, weight] of MIX) {
    acc += weight;
    if (r < acc) return kind;
  }
  return 'buildings';
}

/**
 * Build one tile of city and place it 5×5 around the origin.
 *
 * 5×5 rather than 3×3 because map compression can see much further than the old
 * fog distance allowed. This is the build's main performance risk — 25 draws —
 * but they all share one buffer, so it is 25 draw calls rather than 25 uploads.
 *
 * The city is no longer a lattice; it comes off the organic plan in
 * world/networks/organic.ts. Two consequences worth knowing here:
 *
 * - A BLOCK IS A POLYGON. Each one is inset off the carriageway to leave the
 *   pavement, then handed to an archetype as a `Plot` with its own frame.
 * - GEOMETRY MAY POKE OUT OF THE TILE, because a block that straddles the seam
 *   is centred on whichever side its centroid falls. That is not a problem: the
 *   tile is drawn 5×5, so what pokes out of one copy is what pokes into the
 *   next, and it lands in the right place on its own. The culler's margin has
 *   to cover the overhang, which is at most half a block.
 */
export function buildCity(scene: THREE.Scene): Scenery {
  const b = new Builder();
  const rnd = makeRandom(CITY_SEED);
  const plan = cityPlan();
  const blocks: Block[] = [];
  const kinds: BlockKind[] = [];

  lanes(b, plan);

  for (const face of plan.faces) {
    /* Inset by the carriageway plus a pavement. The pavement is what makes
       cutting a corner a shortcut with a price rather than a wall. */
    const outline = inset(face.poly, ROAD_HALF + 2.5);
    const plot = makePlot(outline);
    if (!plot || plot.area < 200) { kinds.push('lot'); continue; }

    const kind = pickKind(rnd());
    kinds.push(kind);
    BUILDERS[kind]({ b, plot, rnd, push: block => blocks.push(block) });
  }

  const geo = b.toGeometry();
  const half = (TILES_ACROSS - 1) / 2;
  const chunks: Chunk[] = [];
  // Margin on the bounds: buildings are buried deep, their skirts reach outside
  // the block, and a block that straddles the seam overhangs the tile.
  const M = 90;
  for (let ox = -half; ox <= half; ox++) {
    for (let oz = -half; oz <= half; oz++) {
      const mesh = new THREE.Mesh(geo, bentMat);
      mesh.position.set(ox * TILE, 0, oz * TILE);
      addBent(scene, mesh);
      chunks.push({
        mesh,
        x0: ox * TILE - M, x1: ox * TILE + TILE + M,
        z0: oz * TILE - M, z1: oz * TILE + TILE + M
      });
    }
  }

  return { blocks, chunks, meta: { kinds } };
}

/**
 * Lane markings, drawn down the middle of every road.
 *
 * These are what make the plan-view region read as a map rather than as a grey
 * shape — without them the roads have no direction and an organic city is just
 * a scatter of blocks. They matter more here than they did on the lattice,
 * because a grid at least had its own right angles to read.
 *
 * Drawn per EDGE, and every edge exactly once, so nothing doubles up at a
 * junction and nothing is missed across the seam.
 */
function lanes(b: Builder, plan: ReturnType<typeof cityPlan>): void {
  const net = plan.network;
  for (let i = 0; i < net.nodes.length; i++) {
    const a = net.nodes[i];
    for (const j of a.links) {
      if (j <= i) continue;
      const dx = net.delta(net.nodes[j].x, a.x);
      const dz = net.delta(net.nodes[j].z, a.z);
      const len = Math.hypot(dx, dz);
      if (len < 1) continue;
      const ang = Math.atan2(dx, dz);
      // Dashes stop short of each junction, so the box is left clear.
      const clear = 9;
      for (let s = clear; s < len - clear; s += 9) {
        const t = (s + 2) / len;
        b.slabRot(a.x + dx * t, a.z + dz * t, 0.7, 3.6, 0.02, ang, C.dash, 1);
      }
    }
  }
}

/**
 * ---------- road surface ----------
 *
 * NOT tiled. It is a featureless grey field, so instead of repeating it there is
 * ONE mesh authored permanently in player-local space — it never moves and never
 * rotates.
 *
 * Its subdivision is packed toward the camera with a power curve, which means
 * the fold always lands in the dense part of the mesh wherever you put z0.
 * Lateral subdivision used to be almost nothing, because the bend only scales x
 * linearly — but terrain varies in x too, so it needs real columns now.
 *
 * Total cost: about 33k vertices instead of the 150k a uniformly-subdivided
 * ground plane needed.
 */
export function buildRoadSurface(scene: THREE.Scene): Chunk {
  const XS = 72, ZS = 260, X = 1200, ZA = -90, ZB = 1400, POW = 2.2, POWX = 2.4;
  const p: number[] = [], n: number[] = [], c: number[] = [];

  const zAt = (u: number) => ZA + (ZB - ZA) * Math.pow(u, POW);

  /* Lateral subdivision is packed toward the centre with the same trick.
     It used to be uniform, which put 37 units between columns — and over that
     span the mesh's straight-line approximation of the hillside rises about
     0.14 units, while a pavement pad only floats 0.03 above the ground. The
     road was poking up THROUGH the pavements, and it showed as a sawtooth
     along every kerb. Packing the columns toward the truck drops the error
     where it is visible to almost nothing, and leaves it coarse only far out
     to the sides where the map compression has squashed it anyway. */
  const xAt = (u: number) => {
    const s = u * 2 - 1;
    return Math.sign(s) * X * Math.pow(Math.abs(s), POWX);
  };

  const tri = (a: number[], b_: number[], c_: number[]) => {
    p.push(...a, ...b_, ...c_);
    for (let k = 0; k < 3; k++) { n.push(0, 1, 0); c.push(...C.road); }
  };

  for (let i = 0; i < XS; i++) {
    const x0 = xAt(i / XS), x1 = xAt((i + 1) / XS);
    for (let j = 0; j < ZS; j++) {
      const z0 = zAt(j / ZS), z1 = zAt((j + 1) / ZS);
      tri([x0, 0, z0], [x1, 0, z1], [x1, 0, z0]);
      tri([x0, 0, z0], [x0, 0, z1], [x1, 0, z1]);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  // uLocal = 1 on this material, so the anchor attribute is ignored — but the
  // shader still declares it, so it has to exist.
  g.setAttribute('aAnchor', new THREE.Float32BufferAttribute(new Float32Array(p.length / 3 * 2), 2));

  const m = new THREE.Mesh(g, roadMat);
  m.renderOrder = -1;
  addBent(scene, m);
  return { mesh: m, x0: 0, z0: 0, x1: 0, z1: 0, everywhere: true };
}
