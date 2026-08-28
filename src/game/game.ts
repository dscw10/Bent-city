import { Dispatch, CAPACITY } from './dispatch';
import type { DispatchEvent, Order } from './dispatch';
import { Rivals } from '../world/rivals';
import { Traffic } from '../world/traffic';
import { Pedestrians } from '../world/pedestrians';
import { bfs, nearestNode, unwrapPath } from '../world/graph';
import type { Point } from '../world/graph';
import { nodePos, wrapDist, wrapDelta, nearCopy, PITCH } from '../core/city-layout';
import { C } from '../core/palette';
import { clamp } from '../core/math';
import {
  drawRibbon, drawObjective, drawRival, drawClosure, drawTurnArrow
} from '../render/markers';
import type { Builder } from '../render/builder';
import type { Mode } from './modes';
import type { Car } from '../vehicle/vehicle';
import type { Block } from '../render/city';
import { save, recordScore, persist } from './storage';

export type Phase = 'title' | 'playing' | 'paused' | 'over';

export interface RunStats {
  yen: number;
  deliveries: number;
  expired: number;
  sniped: number;
  scattered: number;
  streak: number;
  bestStreak: number;
  elapsed: number;
}

/** What the game wants the rest of the app to react to this frame. */
export interface FrameEvents {
  delivered: number;      // yen credited, 0 if none
  restocked: boolean;
  lost: boolean;          // an order expired or was sniped
  expired: boolean;
  snipedNow: boolean;
  scattered: number;      // pedestrians clipped
  ending: boolean;        // clock crossed into the last ten seconds this frame
}

const TRAFFIC_COUNT = 26;
const PEDESTRIAN_COUNT = 44;
/** Combo tops out here — beyond it the number stops meaning anything. */
const MAX_MULTIPLIER = 5;

export class Game {
  phase: Phase = 'title';
  mode!: Mode;
  clock = 0;

  readonly dispatch = new Dispatch();
  readonly rivals = new Rivals();
  readonly traffic = new Traffic();
  readonly pedestrians = new Pedestrians();

  readonly stats: RunStats = {
    yen: 0, deliveries: 0, expired: 0, sniped: 0, scattered: 0,
    streak: 0, bestStreak: 0, elapsed: 0
  };

  /** Toast lines the UI should show, drained each frame. */
  readonly messages: Array<{ text: string; bad: boolean }> = [];

  /** Building footprints plus whatever is currently in the way. */
  private collision: Block[] = [];
  private staticBlocks: Block[] = [];

  private route: Point[] = [];
  private routeTimer = 0;
  private focusKey = '';
  private lowWarned = false;

  bind(staticBlocks: Block[]): void {
    this.staticBlocks = staticBlocks;
    this.collision = staticBlocks.slice();
  }

  get multiplier(): number {
    return Math.min(MAX_MULTIPLIER, 1 + Math.floor(this.stats.streak / 3));
  }

  get crates(): number { return this.dispatch.crates; }

  start(mode: Mode, car: Car): void {
    this.mode = mode;
    this.phase = 'playing';
    this.clock = mode.duration;
    this.lowWarned = false;
    Object.assign(this.stats, {
      yen: 0, deliveries: 0, expired: 0, sniped: 0, scattered: 0,
      streak: 0, bestStreak: 0, elapsed: 0
    });

    this.dispatch.start(mode);
    this.rivals.start(this.dispatch, mode.rivals);
    this.traffic.setClosures(this.dispatch.closedEdges);
    this.traffic.start(save.settings.cityLife ? TRAFFIC_COUNT : 0, car.x, car.z);
    this.pedestrians.start(save.settings.cityLife ? PEDESTRIAN_COUNT : 0, car.x, car.z);

    this.route = [];
    this.routeTimer = 0;
    this.focusKey = '';
    this.messages.length = 0;
  }

  /** Rebuild the crowd when the City life setting is toggled mid-run. */
  refreshCityLife(car: Car): void {
    const on = save.settings.cityLife;
    this.traffic.start(on ? TRAFFIC_COUNT : 0, car.x, car.z);
    this.pedestrians.start(on ? PEDESTRIAN_COUNT : 0, car.x, car.z);
  }

  end(): void {
    if (this.phase === 'over') return;
    this.phase = 'over';
    save.totalDeliveries += this.stats.deliveries;
    persist();
  }

  /** True if this run set a new best for its mode. */
  commitScore(): boolean {
    if (this.mode.duration === 0) return false;   // free roam is not a score
    return recordScore(this.mode.id, this.stats.yen);
  }

  /**
   * The thing the player is currently being routed to: the nearest live order
   * if the truck has crates, or the nearest bakery if it does not.
   */
  focus(car: Car): { x: number; z: number; order: Order | null } {
    if (this.dispatch.crates <= 0) {
      const b = this.dispatch.nearestBakery(car.x, car.z);
      return { x: nodePos(b[0]), z: nodePos(b[1]), order: null };
    }
    const o = this.dispatch.nearestOrder(car.x, car.z);
    if (o) return { x: o.x, z: o.z, order: o };
    const b = this.dispatch.nearestBakery(car.x, car.z);
    return { x: nodePos(b[0]), z: nodePos(b[1]), order: null };
  }

  /** Everything the truck can hit this frame. */
  collisionSet(): Block[] {
    this.collision.length = 0;
    for (const b of this.staticBlocks) this.collision.push(b);
    for (const b of this.dispatch.barriers) this.collision.push(b);
    for (const b of this.traffic.footprints) this.collision.push(b);
    return this.collision;
  }

  update(dt: number, car: Car): FrameEvents {
    const out: FrameEvents = {
      delivered: 0, restocked: false, lost: false,
      expired: false, snipedNow: false, scattered: 0, ending: false
    };
    if (this.phase !== 'playing') return out;

    this.stats.elapsed += dt;

    const pressure = 1 + this.mode.ramp * (this.stats.elapsed / 60);
    this.dispatch.setPressure(this.stats.elapsed / 60);
    this.rivals.setPressure(pressure);

    // --- world ---
    this.traffic.setClosures(this.dispatch.closedEdges);
    if (save.settings.cityLife) {
      this.traffic.update(dt, car.x, car.z);
      const hits = this.pedestrians.update(dt, car.x, car.z, car.v);
      if (hits > 0) {
        out.scattered = hits;
        this.stats.scattered += hits;
        this.breakStreak('Scattered a pedestrian');
      }
    }

    // --- rivals get first refusal on the orders they reach ---
    for (const id of this.rivals.update(dt)) {
      const ev = this.dispatch.snipe(id, 0);
      if (ev) this.applyEvent(ev, out);
    }

    // --- dispatch ---
    for (const ev of this.dispatch.update(dt, car.x, car.z)) this.applyEvent(ev, out);

    // --- clock ---
    if (this.mode.duration > 0) {
      this.clock -= dt;
      if (this.clock <= 10 && !this.lowWarned) {
        this.lowWarned = true;
        out.ending = true;
      }
      if (this.clock > 10) this.lowWarned = false;
      if (this.clock <= 0) { this.clock = 0; this.end(); }
    }

    this.updateRoute(dt, car);
    return out;
  }

  private applyEvent(ev: DispatchEvent, out: FrameEvents): void {
    switch (ev.kind) {
      case 'delivered': {
        const mult = this.multiplier;
        const yen = ev.value * mult;
        this.stats.yen += yen;
        this.stats.deliveries++;
        this.stats.streak++;
        this.stats.bestStreak = Math.max(this.stats.bestStreak, this.stats.streak);
        out.delivered = yen;

        if (this.mode.duration > 0) {
          // Longer hauls pay back more clock, so committing to the far side of
          // the map is a decision rather than a mistake.
          const haul = clamp(ev.order.value / 40, 0, 5);
          this.clock += this.mode.timeBonus + haul;
        }
        this.messages.push({
          text: `${ev.order.hot ? '★ ' : ''}Delivered · ¥${yen}${mult > 1 ? ` ×${mult}` : ''}`,
          bad: false
        });
        this.focusKey = '';
        break;
      }
      case 'expired':
        this.stats.expired++;
        this.penalise();
        this.breakStreak('Order expired');
        out.lost = true;
        out.expired = true;
        this.focusKey = '';
        break;
      case 'sniped':
        this.stats.sniped++;
        this.penalise();
        this.breakStreak('Beaten to it');
        out.lost = true;
        out.snipedNow = true;
        this.focusKey = '';
        break;
      case 'restock':
        out.restocked = true;
        this.messages.push({ text: `Loaded ${ev.crates} melonpan`, bad: false });
        this.focusKey = '';
        break;
      case 'spawn':
        this.focusKey = '';
        break;
    }
  }

  private penalise(): void {
    if (this.mode.duration > 0) this.clock = Math.max(0, this.clock - this.mode.timePenalty);
  }

  private breakStreak(reason: string): void {
    if (this.stats.streak >= 3) this.messages.push({ text: `${reason} · combo lost`, bad: true });
    else if (this.stats.streak === 0) this.messages.push({ text: reason, bad: true });
    this.stats.streak = 0;
  }

  /**
   * The route is recomputed a few times a second, not every frame — BFS over 81
   * nodes is cheap but it is not free, and the ribbon does not visibly lag.
   */
  private updateRoute(dt: number, car: Car): void {
    this.routeTimer -= dt;
    const f = this.focus(car);
    const key = `${Math.round(f.x)},${Math.round(f.z)}`;
    if (this.routeTimer > 0 && key === this.focusKey) return;
    this.routeTimer = 0.3;
    this.focusKey = key;
    this.route = bfs(nearestNode(car.x, car.z), nearestNode(f.x, f.z), this.dispatch.closedEdges);
  }

  /**
   * Draw everything the game wants on top of the world, into the unlit batch.
   *
   * Note how much of this exists in TWO forms. Every objective has a pillar for
   * the street and a flat ring for the map; every closure has bars for the
   * street and an X for the map; rivals have a beacon and a chevron. That is
   * the general rule this projection imposes: anything that must be legible in
   * both regions needs a component built for each.
   */
  drawMarks(b: Builder, car: Car): void {
    const focus = this.focus(car);

    // Everything below is positioned on the copy of the city nearest the truck,
    // not in the home tile. Gameplay measures distance through the tile seam,
    // so the marks have to be drawn through it as well.
    const nx = (x: number) => nearCopy(x, car.x);
    const nz = (z: number) => nearCopy(z, car.z);

    const path = unwrapPath(this.displayRoute(car), car.x, car.z);
    drawRibbon(b, path);
    this.drawNextTurn(b, car, path);

    // Bakeries. Ring only, unless the truck is empty — in which case one of
    // them is where you are actually going, and it earns the beacon.
    for (const bk of this.dispatch.bakeries) {
      const bx = nodePos(bk[0]), bz = nodePos(bk[1]);
      const isFocus = this.dispatch.crates <= 0 && bx === focus.x && bz === focus.z;
      drawObjective(b, nx(bx), nz(bz), C.melon, { pillar: isFocus, ringSize: 18 });
    }

    // Orders. The countdown ring is the whole point: at street level you can
    // see one of these, and from the map you can see all of them and choose.
    for (const o of this.dispatch.orders) {
      const col = o.claimedBy >= 0 ? C.rival : C.matcha;
      const isFocus = o.x === focus.x && o.z === focus.z;
      const ox = nx(o.x), oz = nz(o.z);
      drawObjective(b, ox, oz, col, {
        pillar: isFocus,
        ringSize: o.hot ? 28 : 22,
        remaining: o.life > 0 ? o.remaining / o.life : undefined
      });
      // A hot order gets a second, larger ring. At map scale colour alone is a
      // couple of pixels; a doubled outline survives.
      if (o.hot) b.ring(ox, oz, 40, 2.6, 0.20, col);
    }

    for (const r of this.rivals.list) {
      drawRival(b, nx(r.x), nz(r.z), r.heading, r.speed01);
    }
    for (const c of this.dispatch.closures) {
      drawClosure(b, nx(c.x), nz(c.z), c.alongX);
    }
  }

  /**
   * The route with the truck's own position on the front, so the ribbon starts
   * under your wheels rather than at the junction ahead — which reads as a
   * route you have already missed.
   *
   * BFS starts from the nearest intersection, and when the truck is on a road
   * that intersection is always ON that road, ahead or behind. So joining the
   * truck straight to it never cuts a diagonal across a block.
   *
   * The one node worth dropping is a first node just BEHIND you when the second
   * is ahead: those two can only be the junction you have just crossed and the
   * next one along the same road, so skipping the first saves the ribbon from
   * pointing backwards under the truck for no reason.
   */
  private displayRoute(car: Car): Point[] {
    if (this.route.length === 0) return [];
    const fx = Math.sin(car.a), fz = Math.cos(car.a);
    const ahead = (p: Point) => wrapDelta(p[0], car.x) * fx + wrapDelta(p[1], car.z) * fz;

    const rest = this.route.length >= 2 && ahead(this.route[0]) < -1 && ahead(this.route[1]) > 0
      ? this.route.slice(1)
      : this.route;

    // Start the ribbon a little ahead of the truck. Drawn from the truck
    // itself it is only a couple of metres from the camera, where a 4.6m band
    // smears across the whole bottom of the frame and hides the road.
    const first = rest[0];
    const dx = wrapDelta(first[0], car.x), dz = wrapDelta(first[1], car.z);
    const d = Math.hypot(dx, dz);
    const lead = Math.min(10, d * 0.5);
    const start: Point = d > 0.5
      ? [car.x + (dx / d) * lead, car.z + (dz / d) * lead]
      : [car.x, car.z];

    return [start, ...rest];
  }

  /** Traffic and pedestrians go into the lit batch, so they read as objects. */
  drawMovers(b: Builder, car: Car): void {
    if (!save.settings.cityLife) return;
    this.traffic.draw(b, car.x, car.z);
    this.pedestrians.draw(b, car.x, car.z);
  }

  /**
   * A turn arrow painted on the road at the next junction, so the immediate
   * decision does not need the map at all. The map is then free to be about the
   * decision AFTER this one — which is the level it is actually good at.
   */
  private drawNextTurn(b: Builder, car: Car, path: Point[]): void {
    // path[0] is the truck itself, so the first junction is path[1].
    if (path.length < 3) return;

    const at = path[1];
    const next = path[2];
    const dx = at[0] - car.x, dz = at[1] - car.z;
    const range = Math.hypot(dx, dz);
    // Only paint it once the junction is close enough to be the decision you
    // are about to make, and far enough that the arrow is not sitting on the
    // camera. Beyond this range the turn is the map's job, not the road's.
    if (range > PITCH * 1.3 || range < 27) return;

    const inA = Math.atan2(dx, dz);
    const outA = Math.atan2(next[0] - at[0], next[1] - at[1]);
    let d = outA - inA;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const turn = Math.abs(d) < 0.6 ? 0 : d > 0 ? 1 : -1;

    // Snap the painted arrow to the road axis rather than to the truck's exact
    // heading, or it wanders about as you weave.
    const axis = Math.round(inA / (Math.PI / 2)) * (Math.PI / 2);
    drawTurnArrow(b, at[0] - Math.sin(axis) * 17, at[1] - Math.cos(axis) * 17, axis, turn);
  }

  /** Distance to the current objective, for the HUD. */
  focusDistance(car: Car): number {
    const f = this.focus(car);
    return wrapDist(f.x, f.z, car.x, car.z);
  }

  taskText(): string {
    if (this.dispatch.crates <= 0) return 'Load up at the <span class="accent">bakery</span>';
    const n = this.dispatch.orders.length;
    if (n === 0) return 'Waiting on the next order';
    return `Deliver the <span class="accent">melonpan</span> · ${this.dispatch.crates}/${CAPACITY} aboard`;
  }
}
