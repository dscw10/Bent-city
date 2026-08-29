import { wrapDelta } from '../core/city-layout';

/**
 * ============================ ROAD NETWORK ============================
 *
 * A general graph of junctions with world positions, replacing the hard-coded
 * 9×9 lattice the whole game was written against.
 *
 * Everything the RULES need — where can I go, what is the way to that drop, is
 * this segment closed, which junction am I nearest — now comes from here rather
 * than from grid arithmetic. That is what lets a second location exist at all:
 * a mountain pass is a chain of nodes, a city is a lattice of them, and
 * dispatch, rivals and routing cannot tell the difference.
 *
 * Two things it deliberately does NOT own:
 *
 * - SCENERY. What the road looks like, where the buildings are, what counts as
 *   off-road — that is the level's job, and a pass has nothing in common with a
 *   city there.
 * - THE WRAP. It records whether the world repeats and over what distance, but
 *   a level that does not wrap simply says so. Distances are measured through
 *   the seam only when there is one.
 */
export interface RoadNode {
  x: number;
  z: number;
  /** Indices of the nodes this one connects to. Always symmetric. */
  links: number[];
}

export type Point = [number, number];

/** Order-independent key for the segment between two nodes. */
export const edgeKey = (a: number, b: number): string =>
  a < b ? `${a}:${b}` : `${b}:${a}`;

export class RoadNetwork {
  readonly nodes: readonly RoadNode[];
  /** Repeat distance of the world, or 0 for a level that does not wrap. */
  readonly wrapSize: number;

  /** Buckets of node indices, for a nearest() that does not scan everything. */
  private readonly cell: number;
  private readonly grid = new Map<string, number[]>();

  constructor(nodes: RoadNode[], wrapSize = 0) {
    this.nodes = nodes;
    this.wrapSize = wrapSize;

    // A bucket roughly the size of a typical link keeps nearest() to a handful
    // of candidates whatever shape the network is.
    let total = 0, count = 0;
    for (let i = 0; i < nodes.length; i++) {
      for (const j of nodes[i].links) {
        total += this.distance(i, j);
        count++;
      }
    }
    this.cell = count > 0 ? Math.max(8, total / count) : 40;

    for (let i = 0; i < nodes.length; i++) {
      const key = this.cellKey(nodes[i].x, nodes[i].z);
      const list = this.grid.get(key);
      if (list) list.push(i); else this.grid.set(key, [i]);
    }
  }

  private cellKey(x: number, z: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }

  /** Separation between two points, through the seam if this level wraps. */
  delta(a: number, b: number): number {
    return this.wrapSize > 0 ? wrapDelta(a, b) : a - b;
  }

  distanceTo(i: number, x: number, z: number): number {
    return Math.hypot(this.delta(this.nodes[i].x, x), this.delta(this.nodes[i].z, z));
  }

  distance(i: number, j: number): number {
    return this.distanceTo(i, this.nodes[j].x, this.nodes[j].z);
  }

  position(i: number): Point {
    return [this.nodes[i].x, this.nodes[i].z];
  }

  /** Index of the junction nearest a world point. */
  nearest(x: number, z: number): number {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best = -1, bestD = Infinity;

    // Widen the search until something is found — a sparse network (a pass with
    // long straights) can have empty buckets for a long way in every direction.
    for (let r = 1; r <= 6 && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (r > 1 && Math.abs(dx) < r && Math.abs(dz) < r) continue;  // ring only
          for (const i of this.grid.get(`${cx + dx},${cz + dz}`) ?? []) {
            const d = this.distanceTo(i, x, z);
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
    }
    if (best >= 0) return best;

    // Fallback: a point genuinely miles from anything.
    for (let i = 0; i < this.nodes.length; i++) {
      const d = this.distanceTo(i, x, z);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * Shortest route between two junctions, by REAL DISTANCE rather than by
   * number of hops. On a lattice those are the same; on a pass, where one link
   * can be ten times another, hop-counting sends you the scenic way round.
   *
   * Dijkstra with a linear scan for the frontier. The networks here are a few
   * hundred nodes, and a binary heap for that is a lot of code to save nothing.
   */
  path(from: number, to: number, closed?: ReadonlySet<string>): number[] {
    const n = this.nodes.length;
    if (from < 0 || to < 0 || from >= n || to >= n) return [];
    if (from === to) return [from];

    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[from] = 0;

    for (;;) {
      let at = -1, best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!done[i] && dist[i] < best) { best = dist[i]; at = i; }
      }
      if (at < 0) break;
      if (at === to) break;
      done[at] = 1;

      for (const next of this.nodes[at].links) {
        if (done[next]) continue;
        if (closed?.has(edgeKey(at, next))) continue;
        const d = dist[at] + this.distance(at, next);
        if (d < dist[next]) { dist[next] = d; prev[next] = at; }
      }
    }

    if (dist[to] === Infinity) return [];
    const route: number[] = [];
    for (let at = to; at >= 0; at = prev[at]) route.unshift(at);
    return route;
  }

  /** World positions for a route, in order. */
  points(route: readonly number[]): Point[] {
    return route.map(i => this.position(i));
  }

  /** Total length of a route, in metres. */
  length(route: readonly number[]): number {
    let total = 0;
    for (let i = 0; i < route.length - 1; i++) total += this.distance(route[i], route[i + 1]);
    return total;
  }

  /** Can every junction still be reached from every other? One flood fill. */
  connected(closed?: ReadonlySet<string>): boolean {
    const n = this.nodes.length;
    if (n === 0) return true;
    const seen = new Uint8Array(n);
    const stack = [0];
    seen[0] = 1;
    let reached = 1;
    while (stack.length) {
      const at = stack.pop()!;
      for (const next of this.nodes[at].links) {
        if (seen[next] || closed?.has(edgeKey(at, next))) continue;
        seen[next] = 1;
        reached++;
        stack.push(next);
      }
    }
    return reached === n;
  }

  /** Every segment, each listed once. */
  edges(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < this.nodes.length; i++) {
      for (const j of this.nodes[i].links) if (i < j) out.push([i, j]);
    }
    return out;
  }

  /**
   * Re-express a route so its points are continuous around a reference, rather
   * than jumping a whole tile at the seam. Done SEQUENTIALLY: a route can be
   * longer than half a tile, and unwrapping everything against one origin folds
   * the far end back on itself.
   */
  unwrap(points: Point[], refX: number, refZ: number): Point[] {
    if (this.wrapSize <= 0 || points.length === 0) return points;
    const out: Point[] = [];
    let px = refX, pz = refZ;
    for (const [x, z] of points) {
      const ux = px + wrapDelta(x, px);
      const uz = pz + wrapDelta(z, pz);
      out.push([ux, uz]);
      px = ux; pz = uz;
    }
    return out;
  }
}
