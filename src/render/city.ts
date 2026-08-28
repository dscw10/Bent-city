import * as THREE from 'three';
import { Builder } from './builder';
import { C } from '../core/palette';
import { makeRandom } from '../core/math';
import { BUILDERS } from './blocks';
import type { BlockKind } from './blocks';
import { GRID, PITCH, TILE, TILES_ACROSS, nodePos } from '../core/city-layout';
import { bentMat, roadMat, addBent } from './materials';

export type { BlockKind } from './blocks';

/** A building footprint, in home-tile coordinates. Collision reads these. */
export interface Block { x: number; z: number; w: number; d: number }

/** One drawn copy of the tile, and where it sits. */
export interface Tile {
  mesh: THREE.Mesh;
  ox: number;
  oz: number;
}

export interface CityData {
  blocks: Block[];
  /** What occupies each block, indexed [i][j]. */
  kinds: BlockKind[][];
  tiles: Tile[];
}

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
 */
export function buildCity(scene: THREE.Scene): CityData {
  const b = new Builder();
  const rnd = makeRandom(CITY_SEED);
  const blocks: Block[] = [];
  const kinds: BlockKind[][] = Array.from({ length: GRID }, () => new Array<BlockKind>(GRID));

  // Lane dashes. These are what make the plan-view region read as a map rather
  // than as a grey grid — without them the roads have no direction.
  //
  // Loops run to GRID (not GRID-1) so the pattern is continuous across the tile
  // join. An off-by-one here shows up as a visible seam you cannot un-see.
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      for (let k = 0; k < 4; k++) {
        const t = nodePos(j) + PITCH * (k + 0.5) / 4;
        b.slab(nodePos(i), t, 0.7, 3.4, 0.02, C.dash, 1);
        b.slab(t, nodePos(i), 3.4, 0.7, 0.02, C.dash, 1);
      }
    }
  }

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = nodePos(i) + PITCH / 2;
      const cz = nodePos(j) + PITCH / 2;
      const kind = pickKind(rnd());
      kinds[i][j] = kind;
      BUILDERS[kind]({ b, cx, cz, rnd, push: block => blocks.push(block) });
    }
  }

  const geo = b.toGeometry();
  const half = (TILES_ACROSS - 1) / 2;
  const tiles: Tile[] = [];
  for (let ox = -half; ox <= half; ox++) {
    for (let oz = -half; oz <= half; oz++) {
      const mesh = new THREE.Mesh(geo, bentMat);
      mesh.position.set(ox * TILE, 0, oz * TILE);
      addBent(scene, mesh);
      tiles.push({ mesh, ox, oz });
    }
  }

  return { blocks, kinds, tiles };
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
export function buildRoadSurface(scene: THREE.Scene): void {
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
}
