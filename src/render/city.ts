import * as THREE from 'three';
import { Builder } from './builder';
import { C } from '../core/palette';
import type { RGB } from '../core/palette';
import { makeRandom } from '../core/math';
import { GRID, PITCH, BLOCK, TILE, TILES_ACROSS, nodePos } from '../core/city-layout';
import { bentMat, roadMat, addBent } from './materials';

/** A building footprint, in home-tile coordinates. Collision reads these. */
export interface Block { x: number; z: number; w: number; d: number }

/** What kind of thing occupies a block. Traffic and pedestrians read this. */
export type BlockKind = 'park' | 'lot' | 'superblock' | 'buildings';

export interface CityData {
  blocks: Block[];
  kinds: BlockKind[][];   // [i][j] over the grid
}

const CITY_SEED = 20260826;

/**
 * Build one tile of city and place it 5×5 around the origin.
 *
 * 5×5 rather than 3×3 because map compression can see much further than the old
 * fog distance allowed. This is the build's main performance risk — 25 draw
 * calls of the same geometry — but they share one buffer, so it is 25 draws
 * rather than 25 uploads.
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
      const kind = rnd();

      if (kind < 0.11) {
        // Park / plaza — fully drivable apart from one small pavilion.
        kinds[i][j] = 'park';
        b.slab(cx, cz, BLOCK, BLOCK, 0.08, C.park, 6);
        blocks.push({ x: cx, z: cz, w: BLOCK * 0.3, d: BLOCK * 0.3 });
        b.box(cx, cz, BLOCK * 0.3, 23 + rnd() * 4, BLOCK * 0.3, C.face2, C.park, undefined, -20);
        continue;
      }

      if (kind < 0.19) {
        // Open car park — drivable, dashed, and a genuine cut-through.
        kinds[i][j] = 'lot';
        b.slab(cx, cz, BLOCK, BLOCK, 0.07, C.lot, 6);
        for (let r = 0; r < 5; r++) {
          const zz = cz - BLOCK / 2 + BLOCK * (r + 0.5) / 5;
          for (let c2 = 0; c2 < 7; c2++) {
            b.slab(cx - BLOCK / 2 + BLOCK * (c2 + 0.5) / 7, zz, 0.5, 4.0, 0.10, C.dash, 1);
          }
        }
        continue;
      }

      // Pavement pad — drivable, but draggy. Cutting the corner costs you speed.
      b.slab(cx, cz, BLOCK, BLOCK, 0.09, C.kerb, 6);

      if (kind < 0.30) {
        kinds[i][j] = 'superblock';
        const h = 34 + rnd() * 46;
        const w = BLOCK * 0.80, d = BLOCK * 0.80;
        blocks.push({ x: cx, z: cz, w, d });
        b.box(cx, cz, w, h + 20, d, C.face,
          rnd() < 0.25 ? C.matcha : roofTone(h), undefined, -20);
        continue;
      }

      kinds[i][j] = 'buildings';
      const n = 1 + ((rnd() * 4) | 0);
      const cells: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
      for (let q = 0; q < n; q++) {
        const [ox, oz] = n === 1 ? [0, 0] : cells[q];
        const w = (n === 1 ? BLOCK * 0.78 : BLOCK * 0.40) * (0.8 + rnd() * 0.2);
        const d = (n === 1 ? BLOCK * 0.78 : BLOCK * 0.40) * (0.8 + rnd() * 0.2);
        const h = 6 + Math.pow(rnd(), 2.4) * 54;
        const bx = cx + ox * BLOCK * 0.24;
        const bz = cz + oz * BLOCK * 0.24;

        // Collision is per BUILDING, not per block. That is what makes the
        // pavement a shortcut you can take rather than a wall.
        blocks.push({ x: bx, z: bz, w, d });

        // SKIRT: buildings are rigid and vertical, so on a slope a flat base
        // would float clear of the ground on the uphill side. Bury them 20
        // units — generous, because uBuildH shrinks the skirt but never the terrain.
        const roof = rnd() < 0.10 ? C.matcha : roofTone(h);
        b.box(bx, bz, w, h + 20, d, rnd() < 0.35 ? C.face2 : C.face, roof, undefined, -20);
      }
    }
  }

  const geo = b.toGeometry();
  const half = (TILES_ACROSS - 1) / 2;
  for (let ox = -half; ox <= half; ox++) {
    for (let oz = -half; oz <= half; oz++) {
      const m = new THREE.Mesh(geo, bentMat);
      m.position.set(ox * TILE, 0, oz * TILE);
      addBent(scene, m);
    }
  }

  return { blocks, kinds };
}

/**
 * ROOF TONE ENCODES HEIGHT. Once buildings lie flat on the map, the roof is the
 * only channel left — so tall blocks read as dark masses from above. This is
 * the first thing in the build where the strategic region carries information
 * the tactical region cannot.
 */
function roofTone(h: number): RGB {
  const t = 0.88 - Math.min(1, h / 58) * 0.32;
  return [t, t * 1.01, t * 1.04];
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
  const XS = 64, ZS = 260, X = 1200, ZA = -90, ZB = 1400, POW = 2.2;
  const p: number[] = [], n: number[] = [], c: number[] = [];
  const zAt = (u: number) => ZA + (ZB - ZA) * Math.pow(u, POW);

  const tri = (a: number[], b_: number[], c_: number[]) => {
    p.push(...a, ...b_, ...c_);
    for (let k = 0; k < 3; k++) { n.push(0, 1, 0); c.push(...C.road); }
  };

  for (let i = 0; i < XS; i++) {
    const x0 = -X + 2 * X * i / XS, x1 = -X + 2 * X * (i + 1) / XS;
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
