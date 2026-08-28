import { bfs, nearestNode, pathLength } from './graph';
import type { Point } from './graph';
import { nodePos, wrapDelta, wrapDist, GRID, TILE } from '../core/city-layout';
import { approachAngle } from '../core/math';
import type { Dispatch, Order } from '../game/dispatch';

/**
 * Rival couriers.
 *
 * They are the clearest case of information that can only live in the plan
 * region. From the street, a rival is a red chevron you glimpse crossing a
 * junction and can do nothing with. From the map you can see WHERE they are,
 * WHICH drop they are heading for and roughly HOW FAST, which turns every
 * order into a judgement: can I beat them there, and if not, which of the
 * others should I take instead?
 *
 * That judgement is impossible without the map. It is the thing the projection
 * is for.
 *
 * They are deliberately not simulated vehicles. They follow the road graph at a
 * steady pace, honour closures, and never collide with anything. A rival that
 * crashed would be a rival you could not plan around.
 */
export interface Rival {
  index: number;
  x: number;
  z: number;
  heading: number;
  speed: number;
  /** Order id being raced for, or −1 while idle. */
  targetId: number;
  path: Point[];
  leg: number;
  /** 0..1, purely for the length of the trail behind the chevron. */
  speed01: number;
  /** Seconds until this rival re-evaluates which order to chase. */
  think: number;
}

/** Slower than a well-driven truck. You should win the races you commit to. */
const BASE_SPEED = 15.5;

export class Rivals {
  readonly list: Rival[] = [];
  private dispatch!: Dispatch;

  start(dispatch: Dispatch, count: number): void {
    this.dispatch = dispatch;
    this.list.length = 0;
    for (let i = 0; i < count; i++) {
      // Spread them around the tile so they don't all arrive from one direction.
      const n = [(i * 3 + 2) % GRID, (i * 5 + 4) % GRID];
      this.list.push({
        index: i,
        x: nodePos(n[0]),
        z: nodePos(n[1]),
        heading: 0,
        speed: BASE_SPEED,
        targetId: -1,
        path: [],
        leg: 0,
        speed01: 0,
        think: i * 0.4
      });
    }
  }

  /** Difficulty ramp: they get quicker as the shift wears on. */
  setPressure(pressure: number): void {
    for (const r of this.list) r.speed = BASE_SPEED * Math.min(1.75, pressure);
  }

  /**
   * Returns the ids of orders a rival reached this frame. The caller decides
   * what that costs the player — this module does not know about scoring.
   */
  update(dt: number): number[] {
    const sniped: number[] = [];
    if (!this.dispatch) return sniped;

    for (const r of this.list) {
      r.think -= dt;

      const target = r.targetId >= 0 ? this.dispatch.byId(r.targetId) : undefined;
      if (!target) { r.targetId = -1; r.path = []; }

      if (r.targetId < 0 || r.think <= 0) {
        this.retarget(r);
        r.think = 2.5 + Math.random();
      }

      this.advance(r, dt);

      const t = r.targetId >= 0 ? this.dispatch.byId(r.targetId) : undefined;
      if (t && wrapDist(r.x, r.z, t.x, t.z) < 8) {
        sniped.push(t.id);
        r.targetId = -1;
        r.path = [];
      }
    }

    // A claim is advisory — it only stops two rivals stacking on one drop.
    for (const o of this.dispatch.orders) o.claimedBy = -1;
    for (const r of this.list) {
      const o = r.targetId >= 0 ? this.dispatch.byId(r.targetId) : undefined;
      if (o) o.claimedBy = r.index;
    }

    return sniped;
  }

  /** Pick the order this rival can reach soonest that nobody else is on. */
  private retarget(r: Rival): void {
    const taken = new Set(this.list.filter(o => o !== r && o.targetId >= 0).map(o => o.targetId));
    let best: Order | null = null;
    let bestCost = Infinity;
    let bestPath: Point[] = [];

    for (const o of this.dispatch.orders) {
      if (taken.has(o.id)) continue;
      const path = bfs(nearestNode(r.x, r.z), o.node, this.dispatch.closedEdges);
      if (path.length === 0) continue;
      const cost = pathLength(path);
      // Don't bother with an order that will expire before they arrive.
      if (o.life > 0 && cost / r.speed > o.remaining) continue;
      if (cost < bestCost) { bestCost = cost; best = o; bestPath = path; }
    }

    if (best) {
      r.targetId = best.id;
      r.path = bestPath;
      r.leg = 0;
    } else {
      // Nothing worth chasing — wander, so they still read as part of the city
      // rather than freezing in place.
      const n: [number, number] = [(Math.random() * GRID) | 0, (Math.random() * GRID) | 0];
      r.targetId = -1;
      r.path = bfs(nearestNode(r.x, r.z), n, this.dispatch.closedEdges);
      r.leg = 0;
    }
  }

  /** Walk along the current path, turning smoothly rather than snapping. */
  private advance(r: Rival, dt: number): void {
    let budget = r.speed * dt;
    let moved = 0;

    while (budget > 0 && r.leg < r.path.length - 1) {
      const to = r.path[r.leg + 1];
      // The path lives in home-tile coordinates and the rival's position is
      // wrapped, so the step has to be measured through the seam.
      const dx = wrapDelta(to[0], r.x), dz = wrapDelta(to[1], r.z);
      const d = Math.hypot(dx, dz);
      if (d < 0.6) { r.leg++; continue; }
      const step = Math.min(budget, d);
      r.x += (dx / d) * step;
      r.z += (dz / d) * step;
      budget -= step;
      moved += step;
      r.heading = approachAngle(r.heading, Math.atan2(dx, dz), dt, 0.18);
    }

    r.x = ((r.x % TILE) + TILE) % TILE;
    r.z = ((r.z % TILE) + TILE) % TILE;
    r.speed01 = dt > 0 ? Math.min(1, (moved / dt) / BASE_SPEED) : 0;
  }
}
