import { Builder } from './builder';
import { C } from '../core/palette';
import type { RGB } from '../core/palette';
import type { Point } from '../world/network';

/**
 * Block archetypes.
 *
 * Two jobs, and the second one is the interesting one:
 *
 * 1. Stop a straight line for a minute revealing the tile repeat.
 * 2. Give the PLAN REGION something to navigate by. Once buildings lie flat on
 *    the map, roof tone and footprint shape are the only channels left — so the
 *    landmarks here are designed as shapes read from above first and as things
 *    you drive past second. A shrine is a cross; a market is a fine 3×3 grain;
 *    a dock is a dark hole. You can say "past the dark square, second left"
 *    without ever having been there.
 *
 * Every archetype pushes its own collision footprints, because collision is per
 * BUILDING rather than per block — that is what keeps pavements and plazas open
 * as shortcuts with a price.
 *
 * ---------------------------------------------------------------------------
 * THEY FILL A POLYGON NOW, not a square.
 *
 * When the city was a lattice every block was 44 metres on a side and square to
 * the compass, so an archetype could be written in absolute coordinates. An
 * organic city hands you a convex cell with four to eight sides, no two blocks
 * alike, and streets meeting at whatever angle they meet at. So each archetype
 * gets a `Plot`: the outline, its centroid, and a LOCAL FRAME taken from the
 * longest side — which is the block's own idea of "along the street", and the
 * thing everything inside it should line up with.
 *
 * That frame is why the buildings look like a city rather than like furniture
 * dropped into a shape. Real blocks are built out from the street edge, so the
 * default archetype marches a wall of buildings along each side and leaves the
 * middle as back yards.
 */
export interface BlockOut {
  x: number;
  z: number;
  w: number;
  d: number;
  /** Rotation about the centre. Buildings sit on their street, not on north. */
  a?: number;
}

export type BlockKind =
  | 'park' | 'lot' | 'superblock' | 'buildings'
  | 'market' | 'podium' | 'shrine' | 'works' | 'dock';

/** One city block, ready to be built on. */
export interface Plot {
  /** The block's outline, anticlockwise. Already inset off the carriageway. */
  poly: Point[];
  cx: number;
  cz: number;
  /** Bearing of the longest side: the block's own "along the street". */
  along: number;
  /** Half-extents measured in that frame — roughly how much room there is. */
  hu: number;
  hv: number;
  area: number;
}

export interface BlockContext {
  b: Builder;
  plot: Plot;
  rnd: () => number;
  push: (block: BlockOut) => void;
}

/** Buildings are buried this deep, so a rigid base never floats on a slope. */
const SKIRT = 20;

/**
 * ROOF TONE ENCODES HEIGHT. Tall blocks read as dark masses from above, which
 * is the first piece of information the strategic region ever carried that the
 * tactical region could not.
 */
export function roofTone(h: number): RGB {
  const t = 0.88 - Math.min(1, h / 58) * 0.32;
  return [t, t * 1.01, t * 1.04];
}

/* ---------------------------------------------------------------- helpers */

/**
 * Offset a convex polygon inward by `d` metres — every EDGE moved in by exactly
 * d, and the new corners taken where the moved edges cross.
 *
 * The first version scaled the outline toward its centroid instead, which is
 * four lines shorter and quietly wrong: scaling moves a VERTEX by d along the
 * radius, and what a corner actually needs is d / sin(half-angle) along the
 * bisector. On a 120° corner — which is most of them, this being a Voronoi
 * diagram — that under-insets by half, and half of 9.5 metres puts the corner
 * building 4.7 metres from the road centreline. Inside the carriageway. The
 * buildings on every block corner in the city were standing in the road.
 */
export function inset(poly: Point[], d: number): Point[] {
  const n = poly.length;
  if (n < 3) return [];
  // Inward normal of each edge. The outline is anticlockwise, so inside is left.
  const norm: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) return [];
    norm.push([-dz / len, dx / len]);
  }

  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;                      // the edge before this vertex
    const [nx1, nz1] = norm[j], [nx2, nz2] = norm[i];
    // Both offset lines pass through their edge's start, moved along its normal.
    const p1x = poly[j][0] + nx1 * d, p1z = poly[j][1] + nz1 * d;
    const p2x = poly[i][0] + nx2 * d, p2z = poly[i][1] + nz2 * d;
    const d1x = -nz1, d1z = nx1;                    // direction along the first line
    /* Where line 1 crosses line 2: solve (P1 + t·D1 − P2)·N2 = 0. The
       denominator is a DOT product with the second normal — written as a cross
       product first time round, which put the intersections kilometres away and
       produced "blocks" five kilometres across. */
    const den = d1x * nx2 + d1z * nz2;
    if (Math.abs(den) < 1e-6) return [];            // the two edges are parallel
    const t = ((p2x - p1x) * nx2 + (p2z - p1z) * nz2) / den;
    out.push([p1x + d1x * t, p1z + d1z * t]);
  }

  /* An over-offset polygon turns itself inside out, and the obvious test for
     that — a sign flip in the signed area — does not catch it: inverting a
     square through its centre is a 180° rotation, which PRESERVES orientation.
     So check what was actually asked for instead: every new vertex must be at
     least `d` inside every original edge. */
  for (const [x, z] of out) {
    for (let i = 0; i < n; i++) {
      const inward = (x - poly[i][0]) * norm[i][0] + (z - poly[i][1]) * norm[i][1];
      if (inward < d - 1e-6) return [];
    }
  }
  return out;
}

/**
 * Merge away any side too short to build on.
 *
 * A Voronoi cell routinely has a four-metre facet between two long sides, and a
 * four-metre side is not a street frontage — it is skipped, and skipping it
 * leaves the walls of the two long sides three metres apart with nothing
 * between them. That is the notch the alley test kept finding, and it is not
 * fixable from the building side: the outline itself has to stop having corners
 * that small.
 *
 * Collapsing a short side to its MIDPOINT keeps the new vertex inside the old
 * outline — a convex polygon contains the midpoint of any two of its vertices —
 * so nothing ever moves toward the road.
 */
export function simplify(poly: Point[], minLen: number): Point[] {
  const p = poly.slice();
  for (let guard = 0; guard < poly.length && p.length > 3; guard++) {
    let worst = -1, worstLen = minLen;
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      const len = Math.hypot(p[j][0] - p[i][0], p[j][1] - p[i][1]);
      if (len < worstLen) { worstLen = len; worst = i; }
    }
    if (worst < 0) break;
    const j = (worst + 1) % p.length;
    p[worst] = [(p[worst][0] + p[j][0]) / 2, (p[worst][1] + p[j][1]) / 2];
    p.splice(j, 1);
  }
  return p;
}

/** The pavement ring a block is walked round, just inside its kerb. */
export function pavementRing(poly: Point[], d: number): Point[] {
  return simplify(inset(poly, d), 8);
}

/** Build a Plot from an already-inset outline. */
export function makePlot(raw: Point[]): Plot | null {
  const poly = simplify(raw, 11);
  if (poly.length < 3) return null;
  let cx = 0, cz = 0;
  for (const [x, z] of poly) { cx += x; cz += z; }
  cx /= poly.length; cz /= poly.length;

  let along = 0, best = -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > best) { best = len; along = Math.atan2(b[0] - a[0], b[1] - a[1]); }
  }

  const ca = Math.cos(along), sa = Math.sin(along);
  let hu = 0, hv = 0;
  for (const [x, z] of poly) {
    const dx = x - cx, dz = z - cz;
    hu = Math.max(hu, Math.abs(dx * sa + dz * ca));   // along the street
    hv = Math.max(hv, Math.abs(dx * ca - dz * sa));   // across it
  }

  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    area += x0 * z1 - x1 * z0;
  }
  return { poly, cx, cz, along, hu, hv, area: Math.abs(area) / 2 };
}

/** Distance from the block's centre to its nearest side. */
function innerRadius(p: Plot): number {
  let best = Infinity;
  for (let i = 0; i < p.poly.length; i++) {
    const a = p.poly[i], b = p.poly[(i + 1) % p.poly.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    best = Math.min(best, Math.abs((p.cx - a[0]) * (-dz / len) + (p.cz - a[1]) * (dx / len)));
  }
  return best;
}

/** A point in the plot's own frame: `u` along the street, `v` across it. */
function at(p: Plot, u: number, v: number): [number, number] {
  const ca = Math.cos(p.along), sa = Math.sin(p.along);
  return [p.cx + u * sa + v * ca, p.cz + u * ca - v * sa];
}

/**
 * A tower or shed, aligned to the plot. Height is what the roof tone encodes.
 *
 * `w` is the frontage — the width ALONG whatever street the building faces —
 * and `d` is how far back it goes. The swap into `across, along` happens here,
 * once, so no archetype has to think about it.
 */
function tower(ctx: BlockContext, x: number, z: number, w: number, d: number, h: number,
               face: RGB, roof?: RGB, ang = ctx.plot.along): void {
  ctx.push({ x, z, w: d, d: w, a: ang });
  ctx.b.boxRot(x, z, d, h + SKIRT, w, ang, face, roof ?? roofTone(h), undefined, -SKIRT);
}

/** The block's ground: its pavement or yard, filling the whole outline. */
function pad(ctx: BlockContext, col: RGB, y = 0.09): void {
  ctx.b.polyFlat(ctx.plot.poly, y, col, 5);
}

/**
 * Walk the outline placing buildings along it, each square to the side it sits
 * on. `depth` is how far back from the street the wall reaches.
 *
 * This is the one that makes an organic city read as one. A block built as a
 * perimeter wall shows the street its face and keeps its back yards private,
 * which is what a city block IS — and from above, the outline of the block and
 * the outline of its buildings become the same shape, so the map gains a
 * silhouette per block instead of a grey square.
 */
function perimeter(
  ctx: BlockContext, wallDepth: number,
  height: () => number, face: () => RGB = () => C.face
): void {
  const { plot, rnd } = ctx;

  /* ---- a wall that CANNOT have a gap in it ----
   *
   * Three versions of this had gaps, each in a different place, and each fix
   * moved the problem rather than removing it: spacing the buildings along a
   * side left a notch at every corner; overshooting the ends did not close a
   * corner where two streets meet at 112°, because each wall is set back from
   * its own street by its own depth; adding a building on the corner left
   * gaps between IT and the two walls. Whack-a-mole, because the construction
   * allowed gaps and the numbers were being asked to prevent them.
   *
   * So the wall is built along a PATH instead. Offset the block's outline
   * inward by half the depth, walk it by arc length, and cut it into buildings
   * end to end — each one drawn a little longer than its own share so it
   * overlaps its neighbours on both sides. Consecutive buildings then overlap
   * BY CONSTRUCTION, including round every corner, whatever the angle.
   *
   * What it costs is the alleys: a block is one continuous terrace now. That is
   * what a city block mostly is, and the shortcuts through the middle were
   * never real — the interior was always solid.
   */
  /* A THIN BLOCK HAS NO MIDDLE. If the wall's depth does not reach the centre
     from both sides, the block has back yards and everything is fine — but if
     it very nearly does, the two sides leave a slot two or three metres wide
     down the middle, which is the same trap in a new place. So on a block too
     thin to have an interior, the wall is thickened until the two sides
     overlap through the centre and the block becomes one solid mass. */
  let depth = wallDepth;
  const inradius = innerRadius(plot);
  if (inradius - depth < 5) depth = inradius * 1.05 + 2;

  const path = inset(plot.poly, depth / 2);
  if (path.length < 3) return;

  // Arc length round the closed path.
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[(i + 1) % path.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(len);
    total += len;
  }
  if (total < 24) return;

  /** Where you are after walking `s` metres round the path. */
  const walk = (s: number): Point => {
    let t = ((s % total) + total) % total;
    for (let i = 0; i < path.length; i++) {
      if (t <= seg[i]) {
        const a = path[i], b = path[(i + 1) % path.length];
        const u = seg[i] > 0 ? t / seg[i] : 0;
        return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
      }
      t -= seg[i];
    }
    return path[0];
  };

  /** How far each building reaches past its own share, at each end. */
  const OVERLAP = 2.4;
  const n = Math.max(3, Math.round(total / 16));
  const share = total / n;

  for (let k = 0; k < n; k++) {
    const a = walk(k * share);
    const b = walk((k + 1) * share);
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const chord = Math.hypot(dx, dz);
    if (chord < 1) continue;
    const h = height();
    tower(ctx,
      (a[0] + b[0]) / 2, (a[1] + b[1]) / 2,
      chord + OVERLAP * 2, depth * (0.8 + rnd() * 0.3), h,
      face(), rnd() < 0.08 ? C.matcha : roofTone(h),
      Math.atan2(dx, dz));
  }
}

// ---------------------------------------------------------------- park

export function park(ctx: BlockContext): void {
  const { b, plot, rnd } = ctx;
  pad(ctx, C.park, 0.08);

  // Crossing paths, which give the plan view a legible mark and the street view
  // something other than a green shape.
  b.slabRot(plot.cx, plot.cz, plot.hu * 1.9, 3.2, 0.11, plot.along, C.kerb, 6);
  b.slabRot(plot.cx, plot.cz, 3.2, plot.hv * 1.9, 0.11, plot.along, C.kerb, 6);

  // A pavilion in the middle, and trees around it.
  tower(ctx, plot.cx, plot.cz, plot.hu * 0.34, plot.hv * 0.34, 8 + rnd() * 4, C.face2, C.park);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rnd() * 0.4;
    const [tx, tz] = at(plot, Math.sin(a) * plot.hu * 0.66, Math.cos(a) * plot.hv * 0.66);
    b.box(tx, tz, 3.4, 7 + rnd() * 3 + SKIRT, 3.4, [0.55, 0.66, 0.52], [0.48, 0.61, 0.45], 2, -SKIRT);
  }
}

// ---------------------------------------------------------------- car park

export function lot(ctx: BlockContext): void {
  const { b, plot } = ctx;
  pad(ctx, C.lot, 0.07);
  // Bays run along the block's own street, not along north.
  const rows = Math.max(2, Math.round(plot.hv / 9));
  const cols = Math.max(3, Math.round(plot.hu / 5));
  for (let r = 0; r < rows; r++) {
    const v = -plot.hv * 0.7 + (plot.hv * 1.4) * (r + 0.5) / rows;
    for (let c = 0; c < cols; c++) {
      const u = -plot.hu * 0.7 + (plot.hu * 1.4) * (c + 0.5) / cols;
      const [x, z] = at(plot, u, v);
      b.slabRot(x, z, 0.5, 4.0, 0.10, plot.along, C.dash, 1);
    }
  }
}

// ---------------------------------------------------------------- superblock

export function superblock(ctx: BlockContext): void {
  const { plot, rnd } = ctx;
  pad(ctx, C.kerb);
  const h = 34 + rnd() * 46;
  tower(ctx, plot.cx, plot.cz, plot.hu * 1.2, plot.hv * 1.2, h, C.face,
    rnd() < 0.25 ? C.matcha : roofTone(h));
}

// ---------------------------------------------------------------- ordinary

/**
 * The default: a wall of buildings round the edge and yards behind them.
 *
 * A continuous terrace round the block, with the yards behind it solid. See
 * the long note on `perimeter` for why it is built along a path rather than
 * side by side — three versions of that had a gap somewhere.
 */
export function buildings(ctx: BlockContext): void {
  const { rnd } = ctx;
  pad(ctx, C.kerb);
  perimeter(ctx, 12 + rnd() * 6, () => 6 + Math.pow(rnd(), 2.4) * 54,
    () => (rnd() < 0.35 ? C.face2 : C.face));
}

// ---------------------------------------------------------------- market

/**
 * Rows of low stalls with lanes between them. From above it is a fine grain
 * that nothing else in the city has, which makes it a reference point; from the
 * street it is a slalom you can just about take at speed.
 */
export function market(ctx: BlockContext): void {
  const { plot, rnd } = ctx;
  pad(ctx, C.kerb);
  /* The lane width is DERIVED, not assumed. The first version fixed the stall
     at 5.4 across on a nominal 9-metre pitch — but the pitch comes from the
     block's own size, and on a small block it came out at 5.5, leaving a
     centimetre between neighbouring stalls. A centimetre is not a lane, it is a
     solid block that also wedges anyone who noses into it. So the stall is
     whatever is left after taking LANE out of the real pitch, and the market
     simply does not appear on a block too small to hold one.

     Six metres, not the 3.8 it started at. The truck is 2.8 wide including its
     collision radius, so 3.8 leaves half a metre either side: enough to drive
     straight down and not enough to correct in, which is the one band that
     traps you. A slalom you can take at speed needs room to be wrong in. */
  const LANE = 6.0;
  const rows = Math.max(2, Math.round(plot.hv * 2 / 9));
  const cols = Math.max(2, Math.round(plot.hu * 2 / 9));
  const size = Math.min(plot.hv * 1.44 / rows, plot.hu * 1.44 / cols) - LANE;
  if (size < 3) { buildings(ctx); return; }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = -plot.hv * 0.72 + (plot.hv * 1.44) * (r + 0.5) / rows;
      const u = -plot.hu * 0.72 + (plot.hu * 1.44) * (c + 0.5) / cols;
      const [x, z] = at(plot, u, v);
      tower(ctx, x, z, size, size, 5 + rnd() * 4, C.face,
        rnd() < 0.3 ? C.melon : [0.86, 0.87, 0.89]);
    }
  }
}

// ---------------------------------------------------------------- podium

/**
 * A tower on a wide podium. The two-tier massing gives a stepped footprint from
 * above and an unmistakable silhouette from the street — the only shape in the
 * city that changes width as it rises.
 */
export function podium(ctx: BlockContext): void {
  const { b, plot, rnd } = ctx;
  pad(ctx, C.kerb);
  const th = 46 + rnd() * 40;
  const pw = plot.hu * 1.45, pd = plot.hv * 1.45;
  ctx.push({ x: plot.cx, z: plot.cz, w: pd, d: pw, a: plot.along });
  b.boxRot(plot.cx, plot.cz, pd, 14 + SKIRT, pw, plot.along, C.face2, roofTone(14), undefined, -SKIRT);
  b.boxRot(plot.cx, plot.cz, pd * 0.5, th + SKIRT, pw * 0.5, plot.along, C.face,
    roofTone(th), undefined, -SKIRT);
}

// ---------------------------------------------------------------- shrine

/**
 * A shrine: an open compound, a matcha-roofed hall, and a gate on the approach.
 * From above it reads as a cross inside a polygon, which is the single most
 * findable shape in the tile.
 */
export function shrine(ctx: BlockContext): void {
  const { b, plot } = ctx;
  pad(ctx, [0.84, 0.83, 0.80]);
  // Gravel approach, laid as a cross on the block's own axes.
  b.slabRot(plot.cx, plot.cz, plot.hu * 1.8, 6.5, 0.12, plot.along, [0.90, 0.89, 0.86], 6);
  b.slabRot(plot.cx, plot.cz, 6.5, plot.hv * 1.8, 0.12, plot.along, [0.90, 0.89, 0.86], 6);

  tower(ctx, plot.cx, plot.cz, plot.hu * 0.5, plot.hv * 0.44, 11, C.face, C.matcha);

  /* The gate: two posts and a lintel, out on the approach. NO COLLISION on the
     posts, deliberately. They are 1.6 metres across and they stand eight apart
     in the middle of an open compound, which turned out to be exactly the shape
     that wedges a truck: drive in at an angle, end up between a post and the
     hall, and reverse gets you nowhere. A shrine gate you can clip is a much
     smaller lie than a shrine you can get stuck in. */
  const g = plot.hv * 0.74;
  for (const s of [-1, 1]) {
    const [x, z] = at(plot, s * 5.2, g);
    b.box(x, z, 1.6, 9 + SKIRT, 1.6, C.matcha, C.matcha, 2, -SKIRT);
  }
  const [lx, lz] = at(plot, 0, g);
  b.boxRot(lx, lz, 13, 1.4 + SKIRT, 1.8, plot.along, C.matcha, C.matcha, 2, 9 - SKIRT);
  // (13 across the approach, 1.8 along it — a lintel, not a beam down the path.)
}

// ---------------------------------------------------------------- works

/**
 * A construction site: hoarding round the edge, open inside, a crane. The
 * hoarding is what you collide with, so the interior is a trap rather than a
 * shortcut — which makes it the one block you learn NOT to cut through.
 */
export function works(ctx: BlockContext): void {
  const { b, plot, rnd } = ctx;
  pad(ctx, [0.78, 0.76, 0.72], 0.08);

  // Hoarding: one panel per side of the block, laid on the side itself.
  for (let i = 0; i < plot.poly.length; i++) {
    const a = plot.poly[i], c = plot.poly[(i + 1) % plot.poly.length];
    const dx = c[0] - a[0], dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 8) continue;
    const ang = Math.atan2(dx, dz);
    const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
    /* Full length, so adjacent panels overlap at the corners and the compound
       is genuinely sealed. Stopping short left a three-and-a-half metre notch
       at every corner — an entrance, which is exactly what a works site is not
       meant to have. */
    ctx.push({ x: mx, z: mz, w: 1.8, d: len, a: ang });
    b.boxRot(mx, mz, 1.8, 3.2 + SKIRT, len, ang, C.hazard, C.hazard, 3, -SKIRT);
  }

  // The crane: a mast and a jib. Tall, so it is a beacon down a long street,
  // and it lies flat on the map as a distinctive L.
  const mh = 40 + rnd() * 22;
  ctx.push({ x: plot.cx, z: plot.cz, w: 3.2, d: 3.2 });
  b.box(plot.cx, plot.cz, 3.2, mh + SKIRT, 3.2, C.melon, C.melon, 4, -SKIRT);
  const [jx, jz] = at(plot, plot.hu * 0.42, 0);
  b.boxRot(jx, jz, 2.0, 2.0 + SKIRT, plot.hu * 0.84, plot.along, C.melon, C.melon, 4, mh - 4 - SKIRT);
}

// ---------------------------------------------------------------- dock

/**
 * Water. Not drivable, and the darkest thing in the city, so on the map it is a
 * hole — the easiest landmark of all to navigate by, and the only one that
 * punishes you for driving at it.
 */
export function dock(ctx: BlockContext): void {
  const { b, plot } = ctx;
  pad(ctx, C.kerb);
  const water = inset(plot.poly, 4);
  if (water.length < 3) return;
  b.polyFlat(water, 0.05, [0.50, 0.56, 0.62], 5);

  // One collision box over the water. The pavement ring around it stays open,
  // so you can still skirt the edge — at the usual off-road price.
  ctx.push({ x: plot.cx, z: plot.cz, w: plot.hv * 1.3, d: plot.hu * 1.3, a: plot.along });

  // A low quay wall on each side, so the edge reads before you are in it.
  for (let i = 0; i < water.length; i++) {
    const a = water[i], c = water[(i + 1) % water.length];
    const dx = c[0] - a[0], dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 5) continue;
    b.boxRot((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, 1.4, 1.2 + SKIRT, len,
      Math.atan2(dx, dz), C.deckS, C.deckS, 3, -SKIRT);
  }
}

export const BUILDERS: Record<BlockKind, (ctx: BlockContext) => void> = {
  park, lot, superblock, buildings, market, podium, shrine, works, dock
};
