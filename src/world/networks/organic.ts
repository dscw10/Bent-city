import { RoadNetwork } from '../network';
import type { Point, RoadNode } from '../network';
import { TILE, ROADW } from '../../core/city-layout';
import { makeRandom } from '../../core/math';

/**
 * ==================== AN ORGANIC CITY, ON A TORUS ====================
 *
 * Chris: *"I don't want it to be a grid."*
 *
 * The lattice was never a design decision, it was the cheapest thing that could
 * possibly work — and it costs the game the one thing the projection was built
 * for. On a grid every junction offers the same four choices, every route is
 * the same length as every other route with the same number of turns, and there
 * is nothing for a map to tell you. Look at the plan region of a grid city and
 * the only information in it is where the drops are. The streets themselves say
 * nothing.
 *
 * An irregular city puts the information back. Blocks differ in size and shape,
 * so distance and turn count stop agreeing; a long diagonal run is genuinely
 * quicker than the same displacement in steps; a junction is a place with a
 * shape you can recognise. That is a map worth looking at, which is the whole
 * argument for the fold.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS BUILT, and why each step is the one it is
 *
 * 1. POINTS. Poisson-disc-ish sampling on the TORUS, then a few rounds of
 *    repulsion. Not a jittered grid — a jittered grid is still a grid, it just
 *    has worse right angles.
 *
 * 2. DELAUNAY, by Bowyer–Watson over a 3×3 replication of the points. The
 *    replication is what makes it periodic: triangulate nine copies, keep the
 *    triangles touching the middle one, and map every vertex back to its
 *    original with the offset it came from. Triangulating the tile alone would
 *    give a boundary, and a boundary is a seam you can see from the map.
 *
 * 3. TAKE THE VORONOI, NOT THE DELAUNAY. The roads are the Voronoi edges and
 *    the blocks are the cells — the classic construction, and the right one.
 *    Delaunay itself is six roads at every junction and triangular blocks,
 *    which reads as a web.
 *
 *    The first attempt pruned Delaunay down with the Gabriel rule and it does
 *    not work, for a reason worth writing down: Gabriel keeps an edge unless
 *    some other point sits inside the circle on that edge, and for an
 *    EQUILATERAL triangle the third vertex sits at 0.87 of the side length from
 *    the midpoint against a radius of 0.50 — comfortably outside. Relaxing the
 *    points to be evenly spaced makes every triangle near-equilateral, so the
 *    prune kept 84% of the edges and produced a hexagonal web. The measured
 *    degree histogram was 4–7. The same holds for any β-skeleton up to β = 2,
 *    which is the whole family. Evenly spaced points cannot make an irregular
 *    graph; the irregularity has to come from somewhere else.
 *
 * 4. CONTRACT THE STUBS. Voronoi junctions are all three-way, and where two of
 *    them fall within a few metres of each other you get a staggered crossroads
 *    with a three-metre road between the halves — a thing you cannot drive and
 *    cannot read on a map. Contracting those into one junction gives the
 *    four-way crossroads a city ought to have, without touching the cells.
 *
 * The one invariant that matters throughout: EVERYTHING IS PERIODIC OVER TILE.
 * The city is one tile drawn 5×5 with the player's position folded into it, and
 * a generator that produces a seam produces it in every copy at once.
 */

/** One point per city block. */
const BLOCKS = 68;
/** Base spacing between block centres, before the density field varies it. */
const MIN_SEP = 46;
/**
 * Two junctions closer than this are one junction. See step 4 above.
 * Comfortably longer than the truck, so no contracted stub survives.
 */
const CONTRACT = 16;
const SEED = 20260830;

/** Half the carriageway. Anything further from a centreline is off the road. */
export const ROAD_HALF = ROADW / 2;

export interface Face {
  /** The block's outline, wound anticlockwise, in coordinates near the tile. */
  poly: Point[];
  centroid: Point;
  area: number;
}

export interface CityPlan {
  network: RoadNetwork;
  faces: Face[];
  /** Straight-line distance to the nearest road centreline, through the wrap. */
  distanceToRoad(x: number, z: number): number;
  /** True where the truck is off the carriageway. */
  offroad(x: number, z: number): boolean;
}

/* ------------------------------------------------------------------ points */

const wrapT = (v: number): number => ((v % TILE) + TILE) % TILE;

/** Shortest signed difference on the torus. Local: this runs before PLACE is set. */
function dT(a: number, b: number): number {
  let d = (a - b) % TILE;
  if (d > TILE / 2) d -= TILE;
  if (d < -TILE / 2) d += TILE;
  return d;
}

/**
 * How closely packed the blocks are here. A smooth periodic field, so the city
 * has a dense quarter and a loose one — which is where the irregularity comes
 * from, now that evenly spaced points have been ruled out. Periodic by
 * construction, like the terrain.
 */
function density(x: number, z: number): number {
  const k = (2 * Math.PI) / TILE;
  return 1
    + 0.30 * Math.sin(k * x + 0.9) * Math.cos(k * z)
    + 0.18 * Math.cos(2 * k * z + 2.1) * Math.sin(k * x + 1.7);
}

function scatter(rnd: () => number): Point[] {
  const pts: Point[] = [];
  for (let tries = 0; tries < BLOCKS * 600 && pts.length < BLOCKS; tries++) {
    const p: Point = [rnd() * TILE, rnd() * TILE];
    const want = MIN_SEP / density(p[0], p[1]);
    let ok = true;
    for (const q of pts) {
      const need = Math.min(want, MIN_SEP / density(q[0], q[1]));
      if (Math.hypot(dT(p[0], q[0]), dT(p[1], q[1])) < need) { ok = false; break; }
    }
    if (ok) pts.push(p);
  }

  /* One gentle round of repulsion, and only one. Relaxing these to evenness is
     exactly what broke the first version — a Voronoi of evenly spaced points is
     a honeycomb. This is only here to break up the slivers dart throwing leaves
     when two points land almost on top of each other, which show up as blocks
     with a two-metre side. */
  for (let i = 0; i < pts.length; i++) {
    let mx = 0, mz = 0;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const dx = dT(pts[i][0], pts[j][0]), dz = dT(pts[i][1], pts[j][1]);
      const d = Math.hypot(dx, dz);
      const near = MIN_SEP * 0.8;
      if (d > near || d < 1e-6) continue;
      mx += (dx / d) * (near - d) * 0.4;
      mz += (dz / d) * (near - d) * 0.4;
    }
    pts[i] = [wrapT(pts[i][0] + mx), wrapT(pts[i][1] + mz)];
  }
  return pts;
}

/* -------------------------------------------------------------- delaunay */

type Tri = [number, number, number];

/**
 * Bowyer–Watson. Insert points one at a time; delete every triangle whose
 * circumcircle contains the new point; re-triangulate the hole from its
 * boundary. Textbook, and at eight hundred points its O(n²) worst case is a
 * few milliseconds once, at startup.
 */
function delaunay(pts: Point[]): Tri[] {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const dx = maxX - minX, dz = maxZ - minZ;
  const m = Math.max(dx, dz) * 12 + 100;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

  // Super-triangle vertices live past the end of the real list.
  const all: Point[] = pts.concat([
    [cx - m, cz - m], [cx + m, cz - m], [cx, cz + m]
  ]);
  const n = pts.length;
  let tris: Tri[] = [[n, n + 1, n + 2]];

  const inCircle = (t: Tri, p: Point): boolean => {
    const [a, b, c] = [all[t[0]], all[t[1]], all[t[2]]];
    const ax = a[0] - p[0], az = a[1] - p[1];
    const bx = b[0] - p[0], bz = b[1] - p[1];
    const ex = c[0] - p[0], ez = c[1] - p[1];
    /* The standard determinant. It answers "inside the circumcircle" only when
       the triangle is wound anticlockwise, which Bowyer–Watson does not
       guarantee — so the orientation is folded in rather than assumed. */
    const det =
      (ax * ax + az * az) * (bx * ez - bz * ex) -
      (bx * bx + bz * bz) * (ax * ez - az * ex) +
      (ex * ex + ez * ez) * (ax * bz - az * bx);
    const orient = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return orient > 0 ? det > 0 : det < 0;
  };

  for (let i = 0; i < n; i++) {
    const p = all[i];
    const keep: Tri[] = [];
    const edges: Array<[number, number]> = [];
    for (const t of tris) {
      if (inCircle(t, p)) {
        edges.push([t[0], t[1]], [t[1], t[2]], [t[2], t[0]]);
      } else {
        keep.push(t);
      }
    }
    // Only the edges used once bound the hole; the shared ones are interior.
    for (let a = 0; a < edges.length; a++) {
      let unique = true;
      for (let b = 0; b < edges.length; b++) {
        if (a === b) continue;
        if ((edges[a][0] === edges[b][1] && edges[a][1] === edges[b][0]) ||
            (edges[a][0] === edges[b][0] && edges[a][1] === edges[b][1])) {
          unique = false; break;
        }
      }
      if (unique) keep.push([edges[a][0], edges[a][1], i]);
    }
    tris = keep;
  }

  return tris.filter(t => t[0] < n && t[1] < n && t[2] < n);
}

/* ------------------------------------------------------------ the plan */

/* ------------------------------------------------------------ the plan */

/** Circumcentre of a triangle. The Voronoi vertex it contributes. */
function circum(a: Point, b: Point, c: Point): Point | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;             // three points on a line
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  return [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
  ];
}

/** Union–find, for contracting the stub junctions. */
function finder(n: number) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; };
  return { find, union: (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) p[x] = y; } };
}

function build(): CityPlan {
  const rnd = makeRandom(SEED);
  const base = scatter(rnd);
  const n = base.length;

  // The 3×3 replication. Index r = copy * n + i; copy 4 is the middle.
  const rep: Point[] = [];
  const repBase: number[] = [];
  const repOff: Array<[number, number]> = [];
  for (let ox = -1; ox <= 1; ox++) {
    for (let oz = -1; oz <= 1; oz++) {
      for (let i = 0; i < n; i++) {
        rep.push([base[i][0] + ox * TILE, base[i][1] + oz * TILE]);
        repBase.push(i);
        repOff.push([ox, oz]);
      }
    }
  }
  const midStart = 4 * n;
  const inMid = (r: number) => r >= midStart && r < midStart + n;

  const tris = delaunay(rep).filter(t => inMid(t[0]) || inMid(t[1]) || inMid(t[2]));

  /* Every triangle touching the middle copy contributes a Voronoi vertex, and
     those are exactly the junctions bounding the middle cells. Triangles out at
     the edge of the 3×3 block are wrong — they would be different under a 5×5
     replication — but no middle cell touches one. */
  const centre: Array<Point | null> = tris.map(t => circum(rep[t[0]], rep[t[1]], rep[t[2]]));

  /* Junctions, deduplicated by their position folded into the home tile. Two
     triangles in different copies that describe the same corner of the city
     land on the same key. */
  const idOf = new Map<string, number>();
  const junction: Point[] = [];
  const triJunction: number[] = new Array(tris.length).fill(-1);
  const key = (x: number, z: number) => `${Math.round(wrapT(x) * 8)}:${Math.round(wrapT(z) * 8)}`;
  for (let t = 0; t < tris.length; t++) {
    const c = centre[t];
    if (!c) continue;
    const k = key(c[0], c[1]);
    let id = idOf.get(k);
    if (id === undefined) {
      id = junction.length;
      idOf.set(k, id);
      junction.push([wrapT(c[0]), wrapT(c[1])]);
    }
    triJunction[t] = id;
  }

  /* Voronoi edges: two triangles sharing a Delaunay edge are neighbouring
     junctions. The wrap the road goes through comes from comparing the
     unwrapped circumcentres against the folded junction positions. */
  const shared = new Map<string, number[]>();
  for (let t = 0; t < tris.length; t++) {
    const [a, b, c] = tris[t];
    for (const [p, q] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const kk = p < q ? `${p}:${q}` : `${q}:${p}`;
      const list = shared.get(kk);
      if (list) list.push(t); else shared.set(kk, [t]);
    }
  }

  interface Edge { a: number; b: number; ox: number; oz: number }
  const edgeSet = new Map<string, Edge>();
  for (const list of shared.values()) {
    if (list.length !== 2) continue;
    const [t0, t1] = list;
    const c0 = centre[t0], c1 = centre[t1];
    if (!c0 || !c1) continue;
    const a = triJunction[t0], b = triJunction[t1];
    if (a < 0 || b < 0 || a === b) continue;
    // Which copy of `b` this road actually reaches.
    const ox = Math.round(((c0[0] + (c1[0] - c0[0])) - junction[b][0]) / TILE);
    const oz = Math.round(((c0[1] + (c1[1] - c0[1])) - junction[b][1]) / TILE);
    const oxA = Math.round((c0[0] - junction[a][0]) / TILE);
    const ozA = Math.round((c0[1] - junction[a][1]) / TILE);
    const e: Edge = { a, b, ox: ox - oxA, oz: oz - ozA };
    const ek = e.a < e.b || (e.a === e.b && (e.ox > 0 || (e.ox === 0 && e.oz > 0)))
      ? `${e.a}|${e.b}|${e.ox}|${e.oz}`
      : `${e.b}|${e.a}|${-e.ox}|${-e.oz}`;
    if (!edgeSet.has(ek)) {
      edgeSet.set(ek, e.a < e.b || (e.a === e.b && (e.ox > 0 || (e.ox === 0 && e.oz > 0)))
        ? e : { a: e.b, b: e.a, ox: -e.ox, oz: -e.oz });
    }
  }

  /* CONTRACT the stubs. A Voronoi vertex pair a few metres apart is a staggered
     crossroads you cannot drive through and cannot read from above; merged,
     they are the four-way junction the city wanted. */
  const uf = finder(junction.length);
  for (const e of edgeSet.values()) {
    const dx = junction[e.b][0] + e.ox * TILE - junction[e.a][0];
    const dz = junction[e.b][1] + e.oz * TILE - junction[e.a][1];
    if (Math.hypot(dx, dz) < CONTRACT) uf.union(e.a, e.b);
  }
  const remap = new Map<number, number>();
  const nodes: RoadNode[] = [];
  const nodeOf = (v: number): number => {
    const root = uf.find(v);
    let id = remap.get(root);
    if (id === undefined) {
      id = nodes.length;
      remap.set(root, id);
      nodes.push({ x: junction[root][0], z: junction[root][1], links: [] });
    }
    return id;
  };

  const roads: Edge[] = [];
  const done = new Set<string>();
  for (const e of edgeSet.values()) {
    const a = nodeOf(e.a), b = nodeOf(e.b);
    if (a === b) continue;                          // swallowed by a contraction
    /* The contraction moves an endpoint to the root's position, which can shift
       it across the seam — so recover the wrap from the geometry rather than
       carrying the old offset through. */
    const ax = junction[e.a][0], az = junction[e.a][1];
    const bx = junction[e.b][0] + e.ox * TILE, bz = junction[e.b][1] + e.oz * TILE;
    const ox = Math.round(((ax + (bx - ax)) - nodes[b].x) / TILE)
      - Math.round((ax - nodes[a].x) / TILE);
    const oz = Math.round(((az + (bz - az)) - nodes[b].z) / TILE)
      - Math.round((az - nodes[a].z) / TILE);
    const k2 = a < b ? `${a}|${b}|${ox}|${oz}` : `${b}|${a}|${-ox}|${-oz}`;
    if (done.has(k2)) continue;
    done.add(k2);
    nodes[a].links.push(b);
    nodes[b].links.push(a);
    roads.push({ a, b, ox, oz });
  }

  /* CELLS. A block is the ring of junctions around one of the original points,
     in angular order — which is exactly the triangles incident to that point.
     Convex by construction, which is what makes the perimeter buildings easy. */
  const incident: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < tris.length; t++) {
    if (!centre[t]) continue;
    for (const v of tris[t]) if (inMid(v)) incident[v - midStart].push(t);
  }

  const faces: Face[] = [];
  for (let i = 0; i < n; i++) {
    const ring = incident[i];
    if (ring.length < 3) continue;
    const p = base[i];
    /* THE CORNERS OF A BLOCK ARE THE JUNCTIONS, AFTER CONTRACTION.
       Built from the raw circumcentres instead, a block's outline disagrees
       with the road graph by up to the contraction distance — and then insetting
       it by the pavement width leaves the corner buildings six metres from a
       centreline they were meant to be nine and a half from. The blocks and the
       roads have to come from the same set of points. */
    const pts = ring
      .map(t => {
        const raw = centre[t]!;
        const node = nodes[nodeOf(triJunction[t])];
        return [
          node.x + Math.round((raw[0] - node.x) / TILE) * TILE,
          node.z + Math.round((raw[1] - node.z) / TILE) * TILE
        ] as Point;
      })
      .map(c => ({ c, a: Math.atan2(c[0] - p[0], c[1] - p[1]) }))
      .sort((u, v) => u.a - v.a)
      .map(u => u.c);

    // Drop consecutive duplicates left by the contraction.
    const poly: Point[] = [];
    for (const c of pts) {
      const last = poly[poly.length - 1];
      if (last && Math.hypot(last[0] - c[0], last[1] - c[1]) < CONTRACT * 0.5) continue;
      poly.push([c[0], c[1]]);
    }
    if (poly.length < 3) continue;
    const area = signedArea(poly);
    faces.push(centreFace(area > 0 ? poly : poly.slice().reverse(), Math.abs(area)));
  }

  const network = new RoadNetwork(nodes, TILE);
  const { distanceToRoad, offroad } = roadDistance(nodes, roads);
  return { network, faces, distanceToRoad, offroad };
}

function signedArea(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    s += x0 * z1 - x1 * z0;
  }
  return s / 2;
}

/**
 * Slide a block so its centroid lands inside the home tile.
 *
 * A block that straddles the seam is fine — the tile is drawn 5×5, so geometry
 * poking out of one copy is exactly the geometry poking INTO the next one, and
 * it lands in the right place on its own. What is not fine is a block whose
 * centroid is a whole tile away, because the culler works on the tile's bounds
 * plus a margin.
 */
function centreFace(poly: Point[], area: number): Face {
  let cx = 0, cz = 0;
  for (const [x, z] of poly) { cx += x; cz += z; }
  cx /= poly.length; cz /= poly.length;
  const ox = wrapT(cx) - cx, oz = wrapT(cz) - cz;
  return {
    poly: poly.map(([x, z]) => [x + ox, z + oz] as Point),
    centroid: [cx + ox, cz + oz],
    area
  };
}

/* --------------------------------------------------- the off-road test */

/**
 * Distance to the nearest road centreline, exact and fast.
 *
 * The grid version was two modulos and four comparisons, and this has to stand
 * in for it in the suspension's inner loop — four rays, three substeps, sixty
 * times a second. So the segments go into a uniform hash covering the tile plus
 * a margin, and a query touches the nine cells around it. A sampled distance
 * field would have been easier and would have put a resolution error on the
 * kerb line, which is exactly where the truck can feel it.
 */
function roadDistance(
  nodes: RoadNode[], edges: Array<{ a: number; b: number; ox: number; oz: number }>
): Pick<CityPlan, 'distanceToRoad' | 'offroad'> {
  const CELL = 44;
  const MARGIN = 60;
  const lo = -MARGIN, span = TILE + MARGIN * 2;
  const cells = Math.ceil(span / CELL);
  const grid: number[][] = Array.from({ length: cells * cells }, () => []);
  const segs: number[] = [];                       // ax, az, bx, bz, ...

  const put = (ax: number, az: number, bx: number, bz: number) => {
    const id = segs.length / 4;
    segs.push(ax, az, bx, bz);
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - lo) / CELL));
    const i1 = Math.min(cells - 1, Math.floor((Math.max(ax, bx) - lo) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - lo) / CELL));
    const j1 = Math.min(cells - 1, Math.floor((Math.max(az, bz) - lo) / CELL));
    if (i1 < 0 || j1 < 0 || i0 >= cells || j0 >= cells) return;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) grid[i * cells + j].push(id);
  };

  // Every copy of every road that reaches the padded tile.
  for (const e of edges) {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const ax = nodes[e.a].x + ox * TILE, az = nodes[e.a].z + oz * TILE;
        const bx = nodes[e.b].x + (ox + e.ox) * TILE, bz = nodes[e.b].z + (oz + e.oz) * TILE;
        if (Math.max(ax, bx) < lo || Math.min(ax, bx) > lo + span) continue;
        if (Math.max(az, bz) < lo || Math.min(az, bz) > lo + span) continue;
        put(ax, az, bx, bz);
      }
    }
  }

  const distanceToRoad = (x: number, z: number): number => {
    const px = wrapT(x), pz = wrapT(z);
    const ci = Math.floor((px - lo) / CELL), cj = Math.floor((pz - lo) / CELL);
    let best = Infinity;
    for (let i = ci - 1; i <= ci + 1; i++) {
      if (i < 0 || i >= cells) continue;
      for (let j = cj - 1; j <= cj + 1; j++) {
        if (j < 0 || j >= cells) continue;
        for (const id of grid[i * cells + j]) {
          const ax = segs[id * 4], az = segs[id * 4 + 1];
          const dx = segs[id * 4 + 2] - ax, dz = segs[id * 4 + 3] - az;
          const len2 = dx * dx + dz * dz;
          const u = len2 > 0
            ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
          const d = Math.hypot(px - (ax + dx * u), pz - (az + dz * u));
          if (d < best) best = d;
        }
      }
    }
    /* A point further than a cell from every road in its own nine cells is
       inside a very large block; the exact number stops mattering once it is
       past the kerb, and answering CELL is both cheap and always an
       underestimate of the truth. */
    return Number.isFinite(best) ? best : CELL;
  };

  return { distanceToRoad, offroad: (x, z) => distanceToRoad(x, z) > ROAD_HALF };
}

let cached: CityPlan | null = null;

/** The city. Generated once — it is the same city every session, by seed. */
export function cityPlan(): CityPlan {
  if (!cached) cached = build();
  return cached;
}

export function buildOrganicNetwork(): RoadNetwork {
  return cityPlan().network;
}
