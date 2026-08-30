import { wrapDist } from '../core/place';
import { RoadNetwork, edgeKey } from '../world/network';
import type { Block } from '../render/city';
import type { Mode } from './modes';

/**
 * ============================ DISPATCH ============================
 *
 * This module exists to answer the open design question the whole project has
 * been circling: WHAT LIVES IN THE PLAN REGION THAT CANNOT LIVE IN THE
 * PERSPECTIVE REGION?
 *
 * Roof tone encoding building height was a start, but it is scenery. The answer
 * has to be a DECISION only the map can support, so there are three here, and
 * they compound:
 *
 * 1. SIMULTANEOUS ORDERS. Several drops are live at once, each with its own
 *    countdown. At street level you see the one you are pointed at; from the map
 *    you see all of them and choose an order to serve them in.
 *
 * 2. A CAPACITY LIMIT. Three crates, refilled at a bakery, so you cannot simply
 *    chase whatever is nearest — you have to pick a CLUSTER one loop can serve
 *    and then get back. That is a routing problem with a shape, and the shape is
 *    only visible from above.
 *
 * 3. CLOSURES. Roadworks block segments of the network. A closure two blocks
 *    ahead is invisible from the street and obvious from the map, and it changes
 *    which way you should already be turning. Because block interiors are
 *    drivable, it diverts you onto the slow pavement rather than stopping you.
 *
 * Rivals are the fourth, and they live in world/rivals.ts.
 *
 * NOTHING HERE KNOWS THE CITY IS A GRID. Everything addresses junctions by
 * index into the level's RoadNetwork, which is what lets a differently-shaped
 * place reuse all of it.
 */

export interface Order {
  id: number;
  /** Index into the level's road network. */
  node: number;
  x: number;
  z: number;
  /** Total lifetime in seconds. 0 means it never expires (free roam). */
  life: number;
  remaining: number;
  /** Base yen, before the combo multiplier. */
  value: number;
  /** Double value. Only distinguishable from above, by its doubled ring. */
  hot: boolean;
  /** Index of the rival currently racing you for it, or −1. */
  claimedBy: number;
}

export interface Closure {
  a: number;
  b: number;
  x: number;
  z: number;
  /**
   * Bearing of the road it blocks. The barrier lies across it.
   *
   * This was a boolean — "does it run along x" — which is all a lattice can
   * tell you and is a coin flip on a street at 37 degrees. The organic city
   * made the angle real information, so it is stored as one.
   */
  angle: number;
}

export type DispatchEvent =
  | { kind: 'delivered'; order: Order; value: number }
  | { kind: 'expired'; order: Order }
  | { kind: 'sniped'; order: Order; rival: number }
  | { kind: 'restock'; crates: number }
  | { kind: 'spawn'; order: Order };

export const CAPACITY = 3;

/** How many bakeries a level gets. Spread out, so one is never far away. */
const BAKERY_COUNT = 3;
/** A drop must be at least this far from the truck, in metres. */
const MIN_DROP_RANGE = 200;

export class Dispatch {
  readonly orders: Order[] = [];
  /** Network node indices. */
  readonly bakeries: number[] = [];
  readonly closures: Closure[] = [];
  /** Edge keys the router must avoid. Rivals honour these too. */
  readonly closedEdges = new Set<string>();
  /** Barrier footprints, appended to the collision set. */
  readonly barriers: Block[] = [];

  crates = CAPACITY;
  private nextId = 1;
  private spawnTimer = 0;
  private closureTimer = 0;
  private mode!: Mode;
  private net!: RoadNetwork;
  /** 1 at the start of a run, growing with `mode.ramp`. Shortens order life. */
  private pressure = 1;

  start(mode: Mode, net: RoadNetwork, spawnX: number, spawnZ: number): void {
    this.mode = mode;
    this.net = net;
    this.orders.length = 0;
    this.crates = CAPACITY;
    this.nextId = 1;
    this.spawnTimer = 0;
    this.closureTimer = 0;
    this.pressure = 1;

    this.placeBakeries();
    this.rollClosures(mode.closures);

    /* Seed the board. Starting empty means the first few seconds of a shift
       have nothing to read and nowhere to go, which is the worst possible
       introduction to a game whose whole pitch is choosing between drops. */
    for (let i = 0; i < Math.min(2, mode.maxOrders); i++) {
      this.spawnOrder(spawnX, spawnZ);
    }
  }

  /**
   * Spread the bakeries out by repeatedly taking the junction furthest from
   * every bakery placed so far. Works on any network shape — on a lattice it
   * lands them near the corners, on a pass it strings them along its length.
   */
  private placeBakeries(): void {
    this.bakeries.length = 0;
    const n = this.net.nodes.length;
    if (n === 0) return;
    this.bakeries.push(0);
    while (this.bakeries.length < Math.min(BAKERY_COUNT, n)) {
      let best = -1, bestD = -1;
      for (let i = 0; i < n; i++) {
        if (this.bakeries.includes(i)) continue;
        let nearest = Infinity;
        for (const b of this.bakeries) nearest = Math.min(nearest, this.net.distance(i, b));
        if (nearest > bestD) { bestD = nearest; best = i; }
      }
      if (best < 0) break;
      this.bakeries.push(best);
    }
  }

  /** Difficulty ramp, driven by the game's elapsed time. */
  setPressure(elapsedMinutes: number): void {
    this.pressure = 1 + this.mode.ramp * elapsedMinutes;
  }

  update(dt: number, carX: number, carZ: number): DispatchEvent[] {
    const events: DispatchEvent[] = [];

    // --- restock ---
    if (this.crates < CAPACITY) {
      for (const b of this.bakeries) {
        const [bx, bz] = this.net.position(b);
        if (wrapDist(bx, bz, carX, carZ) < 11) {
          this.crates = CAPACITY;
          events.push({ kind: 'restock', crates: this.crates });
          break;
        }
      }
    }

    // --- expiry ---
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const o = this.orders[i];
      if (o.life <= 0) continue;
      o.remaining -= dt;
      if (o.remaining <= 0) {
        this.orders.splice(i, 1);
        events.push({ kind: 'expired', order: o });
      }
    }

    // --- delivery ---
    if (this.crates > 0) {
      for (let i = this.orders.length - 1; i >= 0; i--) {
        const o = this.orders[i];
        if (wrapDist(o.x, o.z, carX, carZ) >= 10) continue;
        this.orders.splice(i, 1);
        this.crates--;
        events.push({ kind: 'delivered', order: o, value: o.value * (o.hot ? 2 : 1) });
        break;      // one per frame, so two coincident drops still read as two
      }
    }

    // --- spawning ---
    this.spawnTimer -= dt;
    if (this.orders.length < this.mode.maxOrders && this.spawnTimer <= 0) {
      // Faster when the board is emptier, so you are never left with nothing to
      // aim at, but never so fast that the board is permanently full.
      const deficit = this.mode.maxOrders - this.orders.length;
      this.spawnTimer = Math.max(1.2, 6.5 - deficit * 1.4);
      const o = this.spawnOrder(carX, carZ);
      if (o) events.push({ kind: 'spawn', order: o });
    }

    // --- roadworks move ---
    if (this.mode.closures > 0) {
      this.closureTimer -= dt;
      if (this.closureTimer <= 0) {
        this.closureTimer = 34 + Math.random() * 16;
        this.rollClosures(this.mode.closures);
      }
    }

    return events;
  }

  /** Called by the rival system when one of them beats you to a drop. */
  snipe(orderId: number, rival: number): DispatchEvent | null {
    const i = this.orders.findIndex(o => o.id === orderId);
    if (i < 0) return null;
    const [o] = this.orders.splice(i, 1);
    return { kind: 'sniped', order: o, rival };
  }

  byId(id: number): Order | undefined {
    return this.orders.find(o => o.id === id);
  }

  /** The nearest order you could actually serve. */
  nearestOrder(x: number, z: number): Order | null {
    let best: Order | null = null;
    let bestD = Infinity;
    for (const o of this.orders) {
      const d = wrapDist(o.x, o.z, x, z);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /** Network index of the nearest bakery. */
  nearestBakery(x: number, z: number): number {
    let best = this.bakeries[0] ?? 0;
    let bestD = Infinity;
    for (const b of this.bakeries) {
      const d = this.net.distanceTo(b, x, z);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  bakeryPosition(node: number): [number, number] {
    return this.net.position(node);
  }

  private spawnOrder(carX: number, carZ: number): Order | null {
    let node = -1;

    /* Drops must be far enough away that the plan region has to earn its place.
       At short range you can navigate from the street view alone, which rather
       defeats the point of the whole projection. Measured in METRES rather than
       in grid steps, so it means the same thing on any network. */
    for (let tries = 0; tries < 80; tries++) {
      const cand = (Math.random() * this.net.nodes.length) | 0;
      if (this.net.distanceTo(cand, carX, carZ) < MIN_DROP_RANGE) continue;
      if (this.orders.some(o => o.node === cand)) continue;
      if (this.bakeries.includes(cand)) continue;
      node = cand;
      break;
    }
    if (node < 0) return null;

    const [x, z] = this.net.position(node);
    const bakery = this.nearestBakery(x, z);
    const haul = this.net.length(this.net.path(node, bakery, this.closedEdges));
    const [lo, hi] = this.mode.orderLife;
    const life = lo > 0 ? (lo + Math.random() * (hi - lo)) / this.pressure : 0;

    const order: Order = {
      id: this.nextId++,
      node,
      x,
      z,
      life,
      remaining: life,
      // Paid by the length of the haul, so a long one across the map is worth
      // committing to rather than something to avoid.
      value: Math.round(50 + haul * 0.24),
      hot: Math.random() < 0.16,
      claimedBy: -1
    };
    this.orders.push(order);
    return order;
  }

  /**
   * Pick `n` segments to close, then verify the network is still fully
   * connected before accepting them. An unreachable drop is not a difficulty
   * spike, it is a bug the player experiences as unfairness.
   */
  private rollClosures(n: number): void {
    this.closures.length = 0;
    this.closedEdges.clear();
    this.barriers.length = 0;
    if (n <= 0) return;

    const edges = this.net.edges();
    if (edges.length === 0) return;

    for (let attempt = 0; attempt < 60 && this.closures.length < n; attempt++) {
      const [a, b] = edges[(Math.random() * edges.length) | 0];
      const key = edgeKey(a, b);
      if (this.closedEdges.has(key)) continue;

      this.closedEdges.add(key);
      if (!this.net.connected(this.closedEdges)) { this.closedEdges.delete(key); continue; }

      const [ax, az] = this.net.position(a);
      const [bx, bz] = this.net.position(b);
      // Which way the barrier lies follows the segment it blocks, whatever
      // angle that happens to be.
      const dx = this.net.delta(bx, ax), dz = this.net.delta(bz, az);
      this.closures.push({
        a, b,
        x: ax + dx / 2,
        z: az + dz / 2,
        angle: Math.atan2(dx, dz)
      });
    }

    for (const c of this.closures) {
      // Sized to span the carriageway. Block interiors stay drivable, so this
      // diverts you onto the slow pavement rather than stopping you dead.
      // 15 across the road, 2.2 along it, turned to sit on the carriageway.
      this.barriers.push({ x: c.x, z: c.z, w: 15, d: 2.2, a: c.angle });
    }
  }
}
