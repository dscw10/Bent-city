import { GRID, nodePos, wrapDist } from '../core/city-layout';
import { edgeKey, gridDistance, nearestNode, nodeKey } from '../world/graph';
import type { Node } from '../world/graph';
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
 * has to be a DECISION the player can only make from above. There are three
 * here, and they compound:
 *
 * 1. SIMULTANEOUS ORDERS. Several drops are live at once, each with its own
 *    countdown. At street level you can see the one you are pointed at. From
 *    the map you can see all of them, with their timers, and choose an order to
 *    serve them in. Choosing well is the game.
 *
 * 2. A CAPACITY LIMIT. The truck holds three crates and refills at a bakery, so
 *    you cannot simply chase whatever is nearest — you have to pick a CLUSTER
 *    of three that a single loop can serve, and then get back. That is a
 *    routing problem with a shape, and the shape is only visible from above.
 *
 * 3. CLOSURES. Roadworks block edges of the graph. A closure two blocks ahead
 *    is invisible from the street and obvious from the map, and it changes
 *    which way you should already be turning. Because block interiors are
 *    drivable, a closure does not stop you — it pushes you onto the slow
 *    pavement cut-through, which is a cost rather than a wall.
 *
 * Rivals are the fourth, and they live in world/rivals.ts.
 */

export interface Order {
  id: number;
  node: Node;
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
  a: Node;
  b: Node;
  x: number;
  z: number;
  /** True if the barrier runs along the x axis (blocking a north-south road). */
  alongX: boolean;
}

export type DispatchEvent =
  | { kind: 'delivered'; order: Order; value: number }
  | { kind: 'expired'; order: Order }
  | { kind: 'sniped'; order: Order; rival: number }
  | { kind: 'restock'; crates: number }
  | { kind: 'spawn'; order: Order };

export const CAPACITY = 3;

/** Bakeries are fixed for a run and spread out, so one is never far away. */
const BAKERY_NODES: Node[] = [[1, 1], [7, 3], [3, 7]];

export class Dispatch {
  readonly orders: Order[] = [];
  readonly bakeries: Node[] = BAKERY_NODES.map(n => [...n] as Node);
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
  /** 1 at the start of a run, growing with `mode.ramp`. Shortens order life. */
  private pressure = 1;

  start(mode: Mode): void {
    this.mode = mode;
    this.orders.length = 0;
    this.crates = CAPACITY;
    this.nextId = 1;
    this.spawnTimer = 0;
    this.closureTimer = 0;
    this.pressure = 1;
    this.rollClosures(mode.closures);

    // Seed the board. Starting empty means the first few seconds of a shift
    // have nothing to read and nowhere to go, which is the worst possible
    // introduction to a game whose whole pitch is choosing between drops.
    for (let i = 0; i < Math.min(2, mode.maxOrders); i++) {
      this.spawnOrder(nodePos(4), nodePos(4));
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
        if (wrapDist(nodePos(b[0]), nodePos(b[1]), carX, carZ) < 11) {
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

  /**
   * The order the HUD calls "next": the nearest one you can actually serve. If
   * the truck is empty that is a bakery instead, which is why this can return
   * null and the caller has to handle the restock case.
   */
  nearestOrder(x: number, z: number): Order | null {
    let best: Order | null = null;
    let bestD = Infinity;
    for (const o of this.orders) {
      const d = wrapDist(o.x, o.z, x, z);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  nearestBakery(x: number, z: number): Node {
    let best = this.bakeries[0];
    let bestD = Infinity;
    for (const b of this.bakeries) {
      const d = wrapDist(nodePos(b[0]), nodePos(b[1]), x, z);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  private spawnOrder(carX: number, carZ: number): Order | null {
    const here = nearestNode(carX, carZ);
    let node: Node | null = null;

    // Drops must be far enough away that the plan region has to earn its place.
    // At short range you can navigate from the street view alone, which rather
    // defeats the point of the whole projection.
    for (let tries = 0; tries < 80; tries++) {
      const cand: Node = [(Math.random() * GRID) | 0, (Math.random() * GRID) | 0];
      if (gridDistance(cand, here) < 4) continue;
      if (this.orders.some(o => o.node[0] === cand[0] && o.node[1] === cand[1])) continue;
      if (this.bakeries.some(b => b[0] === cand[0] && b[1] === cand[1])) continue;
      node = cand;
      break;
    }
    if (!node) return null;

    const bakery = this.nearestBakery(nodePos(node[0]), nodePos(node[1]));
    const haul = gridDistance(node, bakery);
    const [lo, hi] = this.mode.orderLife;
    const life = lo > 0 ? (lo + Math.random() * (hi - lo)) / this.pressure : 0;

    const order: Order = {
      id: this.nextId++,
      node,
      x: nodePos(node[0]),
      z: nodePos(node[1]),
      life,
      remaining: life,
      value: Math.round(50 + haul * 14),
      hot: Math.random() < 0.16,
      claimedBy: -1
    };
    this.orders.push(order);
    return order;
  }

  /**
   * Pick `n` road segments to close, then verify the graph is still fully
   * connected before accepting them. An unreachable drop is not a difficulty
   * spike, it is a bug the player experiences as unfairness.
   */
  private rollClosures(n: number): void {
    this.closures.length = 0;
    this.closedEdges.clear();
    this.barriers.length = 0;
    if (n <= 0) return;

    for (let attempt = 0; attempt < 40 && this.closures.length < n; attempt++) {
      const i = (Math.random() * GRID) | 0;
      const j = (Math.random() * GRID) | 0;
      const horizontal = Math.random() < 0.5;
      const a: Node = [i, j];
      const b: Node = horizontal ? [i + 1, j] : [i, j + 1];
      if (b[0] >= GRID || b[1] >= GRID) continue;

      const key = edgeKey(a, b);
      if (this.closedEdges.has(key)) continue;

      this.closedEdges.add(key);
      if (!this.fullyConnected()) { this.closedEdges.delete(key); continue; }

      this.closures.push({
        a, b,
        x: (nodePos(a[0]) + nodePos(b[0])) / 2,
        z: (nodePos(a[1]) + nodePos(b[1])) / 2,
        alongX: !horizontal
      });
    }

    for (const c of this.closures) {
      // Sized to span the carriageway. Block interiors stay drivable, so this
      // diverts you onto the slow pavement rather than stopping you dead.
      this.barriers.push(c.alongX
        ? { x: c.x, z: c.z, w: 15, d: 2.2 }
        : { x: c.x, z: c.z, w: 2.2, d: 15 });
    }
  }

  /** Can node (0,0) still reach every other node? One flood fill, not 81 searches. */
  private fullyConnected(): boolean {
    const seen = new Uint8Array(GRID * GRID);
    const stack: Node[] = [[0, 0]];
    seen[0] = 1;
    let reached = 1;
    while (stack.length) {
      const [i, j] = stack.pop()!;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Node[]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= GRID || nj >= GRID) continue;
        const k = nodeKey(ni, nj);
        if (seen[k]) continue;
        if (this.closedEdges.has(edgeKey([i, j], [ni, nj]))) continue;
        seen[k] = 1;
        reached++;
        stack.push([ni, nj]);
      }
    }
    return reached === GRID * GRID;
  }
}
