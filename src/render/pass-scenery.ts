import * as THREE from 'three';
import { Builder } from './builder';
import { C } from '../core/palette';
import type { RGB } from '../core/palette';
import { makeRandom } from '../core/math';
import { bentMat, addBent } from './materials';
import type { Block, Chunk, Scenery } from './scenery';
import { P } from '../core/config';
import {
  PASS_LENGTH, PASS_ROAD_HALF, TRACK,
  trackPoint, trackHeading, trackCurvature, trackNearest, passTerrainAt
} from '../core/pass-shape';

/**
 * ===================== BUILDING THE PASS =====================
 *
 * The city is drawn on top of a featureless grey ground field authored in
 * player-local space. That works because the city IS featureless underneath —
 * every block sits on the same grey. A valley cannot be: the whole point of it
 * is that the ground changes colour and shape as you leave the road, and a mesh
 * authored in player-local space cannot know where it is in the world at the
 * time its vertex colours are baked. So the pass builds its ground in world
 * space and gets culling from the same chunk mechanism the city's tile copies
 * use.
 *
 * IT IS BUILT IN TWO LAYERS, and the reason is hairpins.
 *
 * A ribbon of ground laid out at fixed perpendicular offsets from the road is
 * the obvious construction, and it works right up until the road turns tighter
 * than the ribbon is wide. On the INSIDE of a corner of radius r, the offset
 * surface collapses to a point at r and turns inside out beyond it — so on a
 * 24-metre hairpin, a ribbon reaching 120 metres each side folds through itself
 * five times. There is no ordering of the vertices that fixes that; the surface
 * genuinely self-intersects.
 *
 * So:
 *   - a COARSE WORLD GRID covers everything, at 26 metres. It is a plain XZ
 *     lattice sampling the terrain function, so it cannot fold whatever the
 *     road does, and it is only 60k vertices for four square kilometres.
 *   - a FINE RIBBON follows the road for detail and paint, clamped on the
 *     inside to a fraction of the local radius so it never reaches the fold.
 *
 * They OVERLAP rather than abut. Two independently tessellated surfaces meeting
 * edge to edge is exactly what produced the white slivers along the city's
 * horizon; here the ribbon simply sits on top, both sample the same terrain
 * function so they agree to within their tessellation error, and a short skirt
 * hangs off the ribbon's outer edge to cover the difference.
 */

const CHUNK = 320;              // metres of road per drawn ribbon piece
const ROW = 6;                  // metres along the road between ribbon rows
const SEED = 20260830;

/** How wide the fine ribbon reaches, and how much of a corner's radius it dare
 *  use on the inside before the offset surface starts folding. */
const RIBBON_REACH = 120;
const INNER_SAFETY = 0.82;
/** The near columns are always safe: 14 < 0.82 × the tightest radius (24). */
const NEAR_REACH = 14;

/** Coarse grid: cell size, and how far outside the road's bounds it extends. */
const GRID = 20;
const GRID_MARGIN = 420;
/**
 * How far the coarse grid sits BELOW the true surface, and how far the ribbon's
 * skirt hangs down to cover the difference. Both in real metres.
 *
 * The two layers sample the same terrain, but the coarse one only every 26
 * metres, so its flat chords stand up to a metre and a half proud of the curve
 * on a valley wall — and where it stands proud it wins the depth test and hides
 * the ribbon. The first build had the road completely invisible for this
 * reason: the truck sat on a featureless grey plain with the graded ribbon
 * floating at the horizon, which reads as a missing mesh rather than as two
 * meshes in the wrong order.
 */
const GRID_DROP = 1.5;
const SKIRT_DROP = 5;

/**
 * Perpendicular offsets of the ribbon's near columns, in metres. Packed tight
 * across the carriageway and its verge — that is where the eye is, and where a
 * straight chord between columns would visibly cut through the kerb.
 */
const NEAR = [-14, -11, -9.2, -7.5, -5.6, -3.7, -1.8, 0, 1.8, 3.7, 5.6, 7.5, 9.2, 11, 14];
/** …and the outer ones, as fractions of whatever reach that row is allowed. */
const OUTER = [0.08, 0.2, 0.36, 0.56, 0.78, 1];

/** What the ground is made of at a given perpendicular distance from the road. */
function groundColour(d: number): RGB {
  if (d <= PASS_ROAD_HALF) return C.road;
  if (d <= 11) return C.verge;
  if (d <= 48) return C.slope;
  if (d <= 145) return C.rock;
  return C.scree;
}

/** World position at (distance along the road, perpendicular offset right). */
function at(s: number, w: number): [number, number] {
  const [x, z] = trackPoint(s);
  const h = trackHeading(s);
  // Heading h is the direction (sin h, cos h); right of it is (cos h, −sin h).
  return [x + Math.cos(h) * w, z - Math.sin(h) * w];
}

/**
 * How far the fine ribbon may reach on each side at `s`. Two things bound it,
 * and both were found by looking at the wrong thing on screen first.
 *
 * 1. CURVATURE. A surface offset from a curve collapses to a point at the
 *    radius of curvature and turns inside out beyond it, so on a 24-metre
 *    hairpin a ribbon reaching 120 metres folds through itself five times.
 *    There is no ordering of the vertices that fixes that.
 *
 * 2. THE REST OF THE ROAD. This one only exists because the road became a real
 *    track: a switchback puts two legs 45 metres apart and other places put
 *    them 120, and a 120-metre ribbon from each of them covers the same ground
 *    twice. The two copies z-fight, and worse, they DISAGREE about the colour —
 *    one calls that ground "120 metres out, so bare rock" while the other calls
 *    it "seven metres out, so tarmac". What that looks like is a pale plateau
 *    with the road disappearing under it.
 *
 *    So the ribbon stops at the medial axis: walk outward and quit where the
 *    nearest bit of road stops being this one. Beyond that the coarse grid
 *    takes over, and it gets the colour right because it asks the same
 *    question of the whole track.
 *
 * Taken as a running minimum over a window, so the limit does not step at the
 * joint between a hairpin and the straight leading into it.
 */
const reachCache = new Map<number, [number, number]>();

function reachAt(s: number): [number, number] {
  let left = RIBBON_REACH, right = RIBBON_REACH;

  const k = trackCurvature(s);
  if (k !== 0) {
    const lim = INNER_SAFETY / Math.abs(k);
    if (k > 0) right = Math.min(right, lim);
    else left = Math.min(left, lim);
  }

  for (const side of [-1, 1] as const) {
    let lim = side < 0 ? left : right;
    for (let w = NEAR_REACH + 6; w <= lim; w += 8) {
      const [x, z] = at(s, side * w);
      // If something nearer than `w` is found, that is a different leg of the
      // road and this ribbon has no business covering the ground in between.
      if (trackNearest(x, z).d < w - 1) { lim = w - 8; break; }
    }
    if (side < 0) left = lim; else right = lim;
  }
  return [Math.max(NEAR_REACH, left), Math.max(NEAR_REACH, right)];
}

function reach(s: number): [number, number] {
  const key = Math.round(s / 4);
  const hit = reachCache.get(key);
  if (hit) return hit;
  let left = RIBBON_REACH, right = RIBBON_REACH;
  for (let d = -32; d <= 32; d += 8) {
    const [l, r] = reachAt(Math.min(PASS_LENGTH, Math.max(0, s + d)));
    left = Math.min(left, l);
    right = Math.min(right, r);
  }
  const out: [number, number] = [left, right];
  reachCache.set(key, out);
  return out;
}

export function buildPass(scene: THREE.Scene): Scenery {
  const rnd = makeRandom(SEED);
  const blocks: Block[] = [];
  const chunks: Chunk[] = [];

  coarseGround(scene, chunks);

  const pieces = Math.ceil(PASS_LENGTH / CHUNK);
  for (let p = 0; p < pieces; p++) {
    const s0 = p * CHUNK;
    const s1 = Math.min(PASS_LENGTH, s0 + CHUNK);
    const b = new Builder();

    ribbon(b, s0, s1);
    paint(b, s0, s1);
    furniture(b, s0, s1, rnd, blocks);
    if (p === 0) gate(b, 0, C.matcha);
    if (s1 >= PASS_LENGTH) gate(b, PASS_LENGTH, C.melon);

    const mesh = new THREE.Mesh(b.toGeometry(), bentMat);
    mesh.renderOrder = 1;                    // over the coarse grid, never under
    addBent(scene, mesh);

    // Bounds from the road itself plus the ribbon's reach and a margin for the
    // scenery standing beside it.
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let s = s0; s <= s1; s += 8) {
      const [x, z] = trackPoint(s);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const M = RIBBON_REACH + 40;
    chunks.push({ mesh, x0: x0 - M, x1: x1 + M, z0: z0 - M, z1: z1 + M });
  }

  return { blocks, chunks };
}

/** World-space bounds of the whole road, plus a margin of mountainside. */
function bounds(): [number, number, number, number] {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of TRACK) {
    x0 = Math.min(x0, p.mx - p.rad); x1 = Math.max(x1, p.mx + p.rad);
    z0 = Math.min(z0, p.mz - p.rad); z1 = Math.max(z1, p.mz + p.rad);
  }
  return [x0 - GRID_MARGIN, x1 + GRID_MARGIN, z0 - GRID_MARGIN, z1 + GRID_MARGIN];
}

/**
 * The mountainside: a plain lattice sampling the terrain function.
 *
 * Nothing here knows where the road is except through `trackNearest`, which is
 * only used to pick a colour — so it cannot fold, cannot self-intersect, and
 * does not care how tight the corners get. Cut into blocks so the culler can
 * throw most of it away.
 */
function coarseGround(scene: THREE.Scene, chunks: Chunk[]): void {
  const [bx0, bx1, bz0, bz1] = bounds();
  const nx = Math.ceil((bx1 - bx0) / GRID);
  const nz = Math.ceil((bz1 - bz0) / GRID);
  const BLOCKS = 6;                                  // BLOCKS × BLOCKS pieces
  const stepX = Math.ceil(nx / BLOCKS), stepZ = Math.ceil(nz / BLOCKS);

  for (let bi = 0; bi < BLOCKS; bi++) {
    for (let bj = 0; bj < BLOCKS; bj++) {
      const b = new Builder();
      const i0 = bi * stepX, i1 = Math.min(nx, i0 + stepX);
      const j0 = bj * stepZ, j1 = Math.min(nz, j0 + stepZ);
      if (i0 >= i1 || j0 >= j1) continue;

      for (let i = i0; i < i1; i++) {
        for (let j = j0; j < j1; j++) {
          const x = bx0 + i * GRID, z = bz0 + j * GRID;
          const col = groundColour(trackNearest(x + GRID / 2, z + GRID / 2).d);
          // Far z first, near z second — the winding `slab` uses. Reverse it and
          // the face normal points at the ground and the whole valley is lit
          // from underneath.
          /* NOTE THE DIVISION. The shader multiplies a vertex's y by uBuildH
             before adding terrain, so anything meant to be a real depth has to
             be pre-divided — otherwise a 3-metre drop renders as 0.9 and the
             grid pops back through. Same trap as the traffic and the viaducts. */
          const y = -GRID_DROP / P.buildH;
          b.quad([x, y, z + GRID], [x + GRID, y, z + GRID],
                 [x + GRID, y, z], [x, y, z], 1, 1, col);
        }
      }

      const mesh = new THREE.Mesh(b.toGeometry(), bentMat);
      addBent(scene, mesh);
      chunks.push({
        mesh,
        x0: bx0 + i0 * GRID, x1: bx0 + i1 * GRID,
        z0: bz0 + j0 * GRID, z1: bz0 + j1 * GRID
      });
    }
  }
}

/**
 * The fine band that follows the road. No anchors anywhere in here: every
 * vertex takes its height from its own position, which is what makes a surface
 * follow the terrain instead of lifting off it rigidly.
 */
function ribbon(b: Builder, sStart: number, sEnd: number): void {
  const cols = (s: number): number[] => {
    const [left, right] = reach(s);
    const out = NEAR.slice();
    for (const f of OUTER) {
      out.unshift(-(NEAR_REACH + (left - NEAR_REACH) * f));
      out.push(NEAR_REACH + (right - NEAR_REACH) * f);
    }
    return out.sort((p, q) => p - q);
  };

  for (let s = sStart; s < sEnd; s += ROW) {
    const s1 = Math.min(sEnd, s + ROW);
    const a = cols(s), c = cols(s1);
    for (let i = 0; i < a.length - 1; i++) {
      const col = groundColour(Math.abs(a[i] + a[i + 1]) / 2);
      const [ax, az] = at(s1, c[i]), [bx, bz] = at(s1, c[i + 1]);
      const [cx, cz] = at(s, a[i + 1]), [dx, dz] = at(s, a[i]);
      b.quad([ax, 0, az], [bx, 0, bz], [cx, 0, cz], [dx, 0, dz], 1, 1, col);
    }

    /* A skirt hanging off each outer edge. The coarse grid underneath is 26m
       between samples and can be a metre or so off the true surface there, and
       a crack between the two layers shows the background through the ground. A
       skirt is one quad per row and it cannot crack. */
    for (const side of [0, a.length - 1]) {
      const wa = a[side], wc = c[side];
      const [ax, az] = at(s1, wc), [dx, dz] = at(s, wa);
      const drop = -SKIRT_DROP / P.buildH;
      // Coloured like the ground it hangs off, so where it does show it reads
      // as a low bank rather than as a white cliff running the whole valley.
      const col = groundColour(Math.abs(wa));
      if (side === 0) {
        b.quad([dx, 0, dz], [ax, 0, az], [ax, drop, az], [dx, drop, dz], 1, 1, col);
      } else {
        b.quad([ax, 0, az], [dx, 0, dz], [dx, drop, dz], [ax, drop, az], 1, 1, col);
      }
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
function paint(b: Builder, sStart: number, sEnd: number): void {
  const Y = 0.03;
  for (let s = sStart; s < sEnd; s += 2) {
    const s1 = Math.min(sEnd, s + 2);
    const strip = (w: number, half: number) => {
      const [ax, az] = at(s1, w - half), [bx, bz] = at(s1, w + half);
      const [cx, cz] = at(s, w + half), [dx, dz] = at(s, w - half);
      b.quad([ax, Y, az], [bx, Y, bz], [cx, Y, cz], [dx, Y, dz], 1, 1, C.dash);
    };
    strip(-6.9, 0.28);
    strip(6.9, 0.28);
    // Dashes: 4m on, 6m off, measured ALONG THE ROAD so they stay even through
    // a hairpin rather than bunching up on the inside.
    if (s % 10 < 4) strip(0, 0.3);
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
  b: Builder, sStart: number, sEnd: number,
  rnd: () => number, blocks: Block[]
): void {
  // Anything with real-world height has to be pre-divided by P.buildH, because
  // the shader multiplies box heights by it for map legibility. Forget this and
  // a 1.5m post renders half a metre tall — the same trap that once made the
  // traffic look like grey shards.
  const inv = 1 / P.buildH;

  for (let s = Math.ceil(sStart / 22) * 22; s < sEnd; s += 22) {
    for (const side of [-1, 1]) {
      const [x, z] = at(s, side * 8.7);
      b.box(x, z, 0.34, 1.5 * inv, 0.34, C.dash, C.ink, 2, -3 * inv);
    }
  }

  for (let s = Math.ceil(sStart / 42) * 42; s < sEnd; s += 42) {
    // Outcrops on the OUTSIDE of the corner, where you would run wide.
    const k = trackCurvature(s);
    const side = k > 0 ? -1 : 1;
    const [left, right] = reach(s);
    const room = side > 0 ? right : left;
    if (room < 16) continue;                       // no shoulder here to put one on
    const [x, z] = at(s, side * (13 + rnd() * Math.min(9, room - 14)));
    const size = 2.6 + rnd() * 2.6;
    b.box(x, z, size, (1.4 + rnd() * 2.2) * inv, size, C.rock, C.scree, 2, -4 * inv);
    blocks.push({ x, z, w: size, d: size });
  }

  // Pines on the lower slopes. Purely visual, and they thin out with height so
  // the tree line reads as a tree line.
  for (let s = Math.ceil(sStart / 11) * 11; s < sEnd; s += 11) {
    for (let k = 0; k < 3; k++) {
      const side = rnd() < 0.5 ? -1 : 1;
      const [left, right] = reach(s);
      const room = side > 0 ? right : left;
      const w = side * (16 + rnd() * rnd() * 90);
      if (Math.abs(w) > Math.min(96, room)) continue;   // above the tree line, or no room
      const [x, z] = at(Math.min(sEnd, s + rnd() * 9), w);
      const h = (7 + rnd() * 7) * inv;
      b.box(x, z, 2.2, h, 2.2, C.pine, C.pine, 2, -5 * inv);
    }
  }
}

/** Start and finish: two posts and a beam, so the ends of the pass are places. */
function gate(b: Builder, s: number, col: RGB): void {
  const inv = 1 / P.buildH;
  for (const side of [-1, 1]) {
    const [x, z] = at(s, side * 9.4);
    b.box(x, z, 1.1, 9 * inv, 1.1, col, col, 2, -4 * inv);
  }
  // A band across the road at ground level, which is the half that survives
  // onto the map once the fold has laid the posts down flat.
  for (let w = -8; w <= 8; w += 2) {
    const [x, z] = at(s, w);
    b.slab(x, z, 2.2, 1.6, 0.05, col, 1);
  }
}

/** Exposed for the tests: the terrain the scenery was built to sit on. */
export { passTerrainAt };
