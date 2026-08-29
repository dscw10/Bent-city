import * as THREE from 'three';
import { Builder } from './builder';
import { C } from '../core/palette';
import type { RGB } from '../core/palette';
import { makeRandom } from '../core/math';
import { bentMat, addBent } from './materials';
import type { Block, Chunk, Scenery } from './scenery';
import { P } from '../core/config';
import {
  PASS_LENGTH, PASS_ROAD_HALF, spineX, spineSlope, spineCurve
} from '../core/pass-shape';

/**
 * ===================== BUILDING THE PASS =====================
 *
 * The city is drawn on top of a featureless grey ground field authored in
 * player-local space. That works because the city IS featureless underneath —
 * every block sits on the same grey. A valley cannot be: the whole point of it
 * is that the ground changes colour and shape as you leave the road, and a
 * mesh authored in player-local space cannot know where it is in the world at
 * the time its vertex colours are baked. So the pass builds its ground in world
 * space, in strips, and gets culling for free from the same chunk mechanism the
 * city's tile copies use.
 *
 * THE MESH IS BUILT IN (z, w) AND CONVERTED, where w is PERPENDICULAR distance
 * from the centreline. Sampling at constant world-x offsets instead would make
 * the carriageway widen by √(1+S′²) through every corner — 40% wider at the
 * tightest — and the painted edge lines would drift off the tarmac. Everything
 * below therefore picks a w, then multiplies by the local normalisation before
 * offsetting from the spine, which is exactly the inverse of what the terrain
 * function does to get back from x to w.
 */

const CHUNK = 260;              // metres of valley per drawn piece
const ROW = 6;                  // metres between mesh rows along the road
const SEED = 20260829;

/**
 * Perpendicular offsets of the mesh columns, in metres. Packed tight across the
 * carriageway and its verge — that is where the eye is, and where a straight
 * chord between columns would visibly cut through the kerb — and coarse out on
 * the mountainside where the fold has squashed everything anyway.
 */
const COLUMNS = [
  -420, -300, -210, -145, -100, -70, -48, -32, -21, -14.5,
  -11, -9.2, -7.5, -5.6, -3.7, -1.8, 0, 1.8, 3.7, 5.6, 7.5, 9.2, 11,
  14.5, 21, 32, 48, 70, 100, 145, 210, 300, 420
];

/** What the ground is made of at a given perpendicular distance from the road. */
function groundColour(w: number): RGB {
  const d = Math.abs(w);
  if (d <= PASS_ROAD_HALF) return C.road;
  if (d <= 11) return C.verge;
  if (d <= 48) return C.slope;
  if (d <= 145) return C.rock;
  return C.scree;
}

/** World position of a point given as (distance along, perpendicular offset). */
function at(z: number, w: number): [number, number] {
  const s = spineSlope(z);
  const n = Math.sqrt(1 + s * s);
  // Perpendicular to the centreline is (1, -S′)/n in (x, z); scaling the x
  // offset by n and leaving z alone is the same first-order approximation the
  // terrain function makes, and using the same one on both sides is what keeps
  // the painted road on the flat part of the valley.
  return [spineX(z) + w * n, z];
}

export function buildPass(scene: THREE.Scene): Scenery {
  const rnd = makeRandom(SEED);
  const blocks: Block[] = [];
  const chunks: Chunk[] = [];
  const pieces = Math.ceil(PASS_LENGTH / CHUNK);

  for (let p = 0; p < pieces; p++) {
    const zStart = p * CHUNK;
    const zEnd = Math.min(PASS_LENGTH, zStart + CHUNK);
    const b = new Builder();

    ground(b, zStart, zEnd);
    paint(b, zStart, zEnd);
    furniture(b, zStart, zEnd, rnd, blocks);
    if (p === 0) gate(b, 0, C.matcha);
    if (zEnd >= PASS_LENGTH) gate(b, PASS_LENGTH, C.melon);

    const mesh = new THREE.Mesh(b.toGeometry(), bentMat);
    addBent(scene, mesh);

    // Bounds have to cover the sway of the centreline as well as the corridor,
    // and the sway is ±220 at its worst.
    chunks.push({ mesh, x0: -700, x1: 700, z0: zStart - 40, z1: zEnd + 40 });
  }

  return { blocks, chunks };
}

/**
 * The valley floor and its walls, as one draped surface.
 *
 * No anchors anywhere in here: every vertex takes its height from its own
 * position, which is what makes a surface follow the terrain instead of lifting
 * off it rigidly. That is the same reason the city's pavements have no anchor
 * and its buildings do.
 */
function ground(b: Builder, zStart: number, zEnd: number): void {
  for (let z = zStart; z < zEnd; z += ROW) {
    const z1 = Math.min(zEnd, z + ROW);
    for (let i = 0; i < COLUMNS.length - 1; i++) {
      const wa = COLUMNS[i], wb = COLUMNS[i + 1];
      const col = groundColour((wa + wb) / 2);
      /* WINDING MATTERS, and it is invisible until you look at the lighting.
         Builder.quad derives the face normal from the corner order, and the
         first version of this walked (−w,−z) → (+w,−z) → (+w,+z) → (−w,+z),
         which is the reverse of what `slab` does and points the normal at the
         ground. The material is double-sided so everything still DREW; it was
         simply lit from underneath, and the whole valley came out a third as
         bright as the city and read as being permanently in shadow. Far z
         first, near z second, matching slab. */
      const [ax, az] = at(z1, wa), [bx, bz] = at(z1, wb);
      const [cx, cz] = at(z, wb), [dx, dz] = at(z, wa);
      b.quad([ax, 0, az], [bx, 0, bz], [cx, 0, cz], [dx, 0, dz], 1, 1, col);
    }
  }
}

/**
 * Paint: a broken centre line and two solid edge lines.
 *
 * This is not decoration. In the city the lane dashes are what make the plan
 * region read as a map rather than as a grey grid; here they are what make a
 * five-kilometre grey ribbon read as a ROAD from above, and the edge lines are
 * what tell you where it goes when the fold has squashed the valley walls flat
 * and the only cue left is the shape of the tarmac.
 */
function paint(b: Builder, zStart: number, zEnd: number): void {
  const Y = 0.03;
  for (let z = zStart; z < zEnd; z += 2) {
    const z1 = Math.min(zEnd, z + 2);
    const strip = (w: number, half: number) => {
      const [ax, az] = at(z1, w - half), [bx, bz] = at(z1, w + half);
      const [cx, cz] = at(z, w + half), [dx, dz] = at(z, w - half);
      b.quad([ax, Y, az], [bx, Y, bz], [cx, Y, cz], [dx, Y, dz], 1, 1, C.dash);
    };
    strip(-6.9, 0.28);
    strip(6.9, 0.28);
    // Dashes: 4m on, 6m off, measured along the road so they stay even
    // through corners rather than bunching up on the inside.
    if (z % 10 < 4) strip(0, 0.3);
  }
}

/**
 * What stands beside the road: marker posts, rock outcrops and pines.
 *
 * The posts are the important ones. A pass has no buildings, so without them
 * the near field has nothing passing the camera at a known spacing and the
 * truck reads as slower than it is — the same reason real mountain roads are
 * lined with them, and the same trick as the city's lane dashes.
 *
 * The outcrops are the only things here with a collision footprint. There is
 * deliberately no armco: the valley wall already throws you back — its gradient
 * reaches about 1.5, so gravity along the slope beats what the tyres can put
 * down — and a continuous barrier would need a footprint every three metres for
 * five kilometres, which is more collision geometry than the whole city has.
 * Going off should cost you the corner, not end the run.
 */
function furniture(
  b: Builder, zStart: number, zEnd: number,
  rnd: () => number, blocks: Block[]
): void {
  // Anything with real-world height has to be pre-divided by P.buildH, because
  // the shader multiplies box heights by it for map legibility. Forget this and
  // a 1.6m post renders half a metre tall — the same trap that once made the
  // traffic look like grey shards.
  const inv = 1 / P.buildH;

  for (let z = Math.ceil(zStart / 24) * 24; z < zEnd; z += 24) {
    // Marker posts, both sides, just off the tarmac.
    for (const side of [-1, 1]) {
      const [x, zz] = at(z, side * 8.7);
      b.box(x, zz, 0.34, 1.5 * inv, 0.34, C.dash, C.ink, 2, -3 * inv);
    }
  }

  for (let z = Math.ceil(zStart / 45) * 45; z < zEnd; z += 45) {
    // Outcrops on the OUTSIDE of the corner, where you would run wide.
    const curve = spineCurve(z);
    const side = curve > 0 ? -1 : 1;
    const w = side * (13 + rnd() * 9);
    const [x, zz] = at(z, w);
    const size = 2.6 + rnd() * 2.6;
    b.box(x, zz, size, (1.4 + rnd() * 2.2) * inv, size, C.rock, C.scree, 2, -4 * inv);
    blocks.push({ x, z: zz, w: size, d: size });
  }

  // Pines on the lower slopes. Purely visual, and they thin out with height so
  // the tree line reads as a tree line.
  for (let z = Math.ceil(zStart / 11) * 11; z < zEnd; z += 11) {
    for (let k = 0; k < 3; k++) {
      const side = rnd() < 0.5 ? -1 : 1;
      const w = side * (16 + rnd() * rnd() * 120);
      if (Math.abs(w) > 96) continue;                 // above the tree line
      const [x, zz] = at(z + rnd() * 9, w);
      const h = (7 + rnd() * 7) * inv;
      b.box(x, zz, 2.2, h, 2.2, C.pine, C.pine, 2, -5 * inv);
    }
  }
}

/** Start and finish: two posts and a beam, so the ends of the pass are places. */
function gate(b: Builder, z: number, col: RGB): void {
  const inv = 1 / P.buildH;
  for (const side of [-1, 1]) {
    const [x, zz] = at(z, side * 9.4);
    b.box(x, zz, 1.1, 9 * inv, 1.1, col, col, 2, -4 * inv);
  }
  // A band across the road at ground level, which is the half that survives
  // onto the map once the fold has laid the posts down flat.
  for (let w = -8; w <= 8; w += 2) {
    const [x, zz] = at(z, w);
    b.slab(x, zz, 2.2, 1.6, 0.05, col, 1);
  }
}
