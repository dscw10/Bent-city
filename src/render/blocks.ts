import { Builder } from './builder';
import { C } from '../core/palette';
import type { RGB } from '../core/palette';
import { BLOCK } from '../core/city-layout';

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
 */
export interface BlockOut {
  x: number;
  z: number;
  w: number;
  d: number;
}

export type BlockKind =
  | 'park' | 'lot' | 'superblock' | 'buildings'
  | 'market' | 'podium' | 'shrine' | 'works' | 'dock';

export interface BlockContext {
  b: Builder;
  cx: number;
  cz: number;
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

/** A tower or shed. Height is what the roof tone will encode. */
function tower(ctx: BlockContext, x: number, z: number, w: number, d: number, h: number,
                face: RGB, roof?: RGB): void {
  ctx.push({ x, z, w, d });
  ctx.b.box(x, z, w, h + SKIRT, d, face, roof ?? roofTone(h), undefined, -SKIRT);
}

// ---------------------------------------------------------------- park

export function park(ctx: BlockContext): void {
  const { b, cx, cz, rnd } = ctx;
  b.slab(cx, cz, BLOCK, BLOCK, 0.08, C.park, 6);

  // Crossing paths, which give the plan view a legible mark and the street view
  // something other than a green rectangle.
  b.slab(cx, cz, BLOCK * 0.94, 3.2, 0.11, C.kerb, 6);
  b.slab(cx, cz, 3.2, BLOCK * 0.94, 0.11, C.kerb, 6);

  // A pavilion in the middle, and trees around it.
  tower(ctx, cx, cz, BLOCK * 0.26, BLOCK * 0.26, 8 + rnd() * 4, C.face2, C.park);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rnd() * 0.4;
    const r = BLOCK * (0.28 + rnd() * 0.12);
    const tx = cx + Math.sin(a) * r, tz = cz + Math.cos(a) * r;
    b.box(tx, tz, 3.4, 7 + rnd() * 3 + SKIRT, 3.4, [0.55, 0.66, 0.52], [0.48, 0.61, 0.45], 2, -SKIRT);
  }
}

// ---------------------------------------------------------------- car park

export function lot(ctx: BlockContext): void {
  const { b, cx, cz } = ctx;
  b.slab(cx, cz, BLOCK, BLOCK, 0.07, C.lot, 6);
  for (let r = 0; r < 5; r++) {
    const zz = cz - BLOCK / 2 + BLOCK * (r + 0.5) / 5;
    for (let c = 0; c < 7; c++) {
      b.slab(cx - BLOCK / 2 + BLOCK * (c + 0.5) / 7, zz, 0.5, 4.0, 0.10, C.dash, 1);
    }
  }
}

// ---------------------------------------------------------------- superblock

export function superblock(ctx: BlockContext): void {
  const { b, cx, cz, rnd } = ctx;
  b.slab(cx, cz, BLOCK, BLOCK, 0.09, C.kerb, 6);
  const h = 34 + rnd() * 46;
  const w = BLOCK * 0.80;
  ctx.push({ x: cx, z: cz, w, d: w });
  b.box(cx, cz, w, h + SKIRT, w, C.face,
    rnd() < 0.25 ? C.matcha : roofTone(h), undefined, -SKIRT);
}

// ---------------------------------------------------------------- ordinary

export function buildings(ctx: BlockContext): void {
  const { b, cx, cz, rnd } = ctx;
  b.slab(cx, cz, BLOCK, BLOCK, 0.09, C.kerb, 6);

  const n = 1 + ((rnd() * 4) | 0);
  const cells: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (let q = 0; q < n; q++) {
    const [ox, oz] = n === 1 ? [0, 0] : cells[q];
    const w = (n === 1 ? BLOCK * 0.78 : BLOCK * 0.40) * (0.8 + rnd() * 0.2);
    const d = (n === 1 ? BLOCK * 0.78 : BLOCK * 0.40) * (0.8 + rnd() * 0.2);
    const h = 6 + Math.pow(rnd(), 2.4) * 54;
    const roof = rnd() < 0.10 ? C.matcha : roofTone(h);
    ctx.push({ x: cx + ox * BLOCK * 0.24, z: cz + oz * BLOCK * 0.24, w, d });
    b.box(cx + ox * BLOCK * 0.24, cz + oz * BLOCK * 0.24, w, h + SKIRT, d,
      rnd() < 0.35 ? C.face2 : C.face, roof, undefined, -SKIRT);
  }
}

// ---------------------------------------------------------------- market

/**
 * A 3×3 of low stalls with lanes between them. From above it is a fine grain
 * that nothing else in the city has, which makes it a reference point; from the
 * street it is a slalom you can just about take at speed.
 */
export function market(ctx: BlockContext): void {
  const { b, cx, cz, rnd } = ctx;
  b.slab(cx, cz, BLOCK, BLOCK, 0.09, C.kerb, 6);
  const cell = BLOCK * 0.28;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const x = cx + i * BLOCK * 0.30;
      const z = cz + j * BLOCK * 0.30;
      const h = 5 + rnd() * 4;
      tower(ctx, x, z, cell * 0.8, cell * 0.8, h, C.face,
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
  const { b, cx, cz, rnd } = ctx;
  b.slab(cx, cz, BLOCK, BLOCK, 0.09, C.kerb, 6);
  const pw = BLOCK * 0.86;
  const th = 46 + rnd() * 40;
  ctx.push({ x: cx, z: cz, w: pw, d: pw });
  b.box(cx, cz, pw, 14 + SKIRT, pw, C.face2, roofTone(14), undefined, -SKIRT);
  b.box(cx, cz, BLOCK * 0.44, th + SKIRT, BLOCK * 0.44, C.face, roofTone(th), undefined, -SKIRT);
}

// ---------------------------------------------------------------- shrine

/**
 * A shrine: an open compound, a matcha-roofed hall, and a gate on the approach.
 * From above it reads as a cross inside a square, which is the single most
 * findable shape in the tile.
 */
export function shrine(ctx: BlockContext): void {
  const { b, cx, cz } = ctx;
  b.slab(cx, cz, BLOCK, BLOCK, 0.09, [0.84, 0.83, 0.80], 6);
  // Gravel approach, laid as a cross.
  b.slab(cx, cz, BLOCK * 0.9, 6.5, 0.12, [0.90, 0.89, 0.86], 6);
  b.slab(cx, cz, 6.5, BLOCK * 0.9, 0.12, [0.90, 0.89, 0.86], 6);

  tower(ctx, cx, cz, BLOCK * 0.34, BLOCK * 0.30, 11, C.face, C.matcha);

  // The gate: two posts and a lintel, on the approach side.
  const g = BLOCK * 0.36;
  for (const s of [-1, 1]) {
    ctx.push({ x: cx + s * 5.2, z: cz + g, w: 1.6, d: 1.6 });
    b.box(cx + s * 5.2, cz + g, 1.6, 9 + SKIRT, 1.6, C.matcha, C.matcha, 2, -SKIRT);
  }
  b.box(cx, cz + g, 13, 1.4 + SKIRT, 1.8, C.matcha, C.matcha, 2, 9 - SKIRT);
}

// ---------------------------------------------------------------- works

/**
 * A construction site: hoarding round the edge, open inside, a crane. The
 * hoarding is what you collide with, so the interior is a trap rather than a
 * shortcut — which makes it the one block you learn NOT to cut through.
 */
export function works(ctx: BlockContext): void {
  const { b, cx, cz, rnd } = ctx;
  b.slab(cx, cz, BLOCK, BLOCK, 0.08, [0.78, 0.76, 0.72], 6);

  const h = BLOCK * 0.42;
  for (const [dx, dz, w, d] of [
    [0, h, BLOCK * 0.84, 1.8], [0, -h, BLOCK * 0.84, 1.8],
    [h, 0, 1.8, BLOCK * 0.84], [-h, 0, 1.8, BLOCK * 0.84]
  ]) {
    ctx.push({ x: cx + dx, z: cz + dz, w, d });
    b.box(cx + dx, cz + dz, w, 3.2 + SKIRT, d, C.hazard, C.hazard, 3, -SKIRT);
  }

  // The crane: a mast and a jib. Tall, so it is a beacon down a long street,
  // and it lies flat on the map as a distinctive L.
  const mh = 40 + rnd() * 22;
  ctx.push({ x: cx, z: cz, w: 3.2, d: 3.2 });
  b.box(cx, cz, 3.2, mh + SKIRT, 3.2, C.melon, C.melon, 4, -SKIRT);
  b.box(cx + BLOCK * 0.18, cz, BLOCK * 0.42, 2.0 + SKIRT, 2.0, C.melon, C.melon, 4, mh - 4 - SKIRT);
}

// ---------------------------------------------------------------- dock

/**
 * Water. Not drivable, and the darkest thing in the city, so on the map it is a
 * hole — the easiest landmark of all to navigate by, and the only one that
 * punishes you for driving at it.
 */
export function dock(ctx: BlockContext): void {
  const { b, cx, cz } = ctx;
  b.slab(cx, cz, BLOCK, BLOCK, 0.09, C.kerb, 6);
  const w = BLOCK * 0.78;
  b.slab(cx, cz, w, w, 0.05, [0.50, 0.56, 0.62], 8);
  // One collision box over the water. The pavement ring around it stays open,
  // so you can still skirt the edge — at the usual off-road price.
  ctx.push({ x: cx, z: cz, w, d: w });
  // A low quay wall, so the edge reads before you are in it.
  for (const [dx, dz, bw, bd] of [
    [0, w / 2, w, 1.4], [0, -w / 2, w, 1.4],
    [w / 2, 0, 1.4, w], [-w / 2, 0, 1.4, w]
  ]) {
    b.box(cx + dx, cz + dz, bw, 1.2 + SKIRT, bd, C.deckS, C.deckS, 3, -SKIRT);
  }
}

export const BUILDERS: Record<BlockKind, (ctx: BlockContext) => void> = {
  park, lot, superblock, buildings, market, podium, shrine, works, dock
};
