import { Dispatch, CAPACITY } from './dispatch';
import type { DispatchEvent, Order } from './dispatch';
import { Rivals } from '../world/rivals';
import type { Rival } from '../world/rivals';
import { Traffic } from '../world/traffic';
import { Pedestrians } from '../world/pedestrians';
import type { Point } from '../world/network';
import { wrapDist, wrapDelta, nearCopy } from '../core/place';
import { C } from '../core/palette';
import { clamp } from '../core/math';
import {
  drawRibbon, drawObjective, drawRival, drawClosure, drawTurnArrow
} from '../render/markers';
import type { Builder } from '../render/builder';
import type { Block } from '../render/scenery';
import type { Mode } from './modes';
import type { Car } from '../vehicle/vehicle';
import { save, recordScore, persist } from './storage';
import type {
  FrameEvents, HudView, Rules, RulesContext, RunOutcome, Slot
} from './rules';
import { noEvents } from './rules';

/**
 * THE CITY'S GAME: melonpan, on a clock, against rivals.
 *
 * This is the whole of what used to be `Game`, moved out intact when the pass
 * arrived and the shell had to stop assuming there were orders. Nothing about
 * it changed in the move — see game/rules.ts for why the seam is where it is.
 *
 * The three decisions that make the plan region load-bearing all live under
 * here: simultaneous orders with countdowns, a three-crate capacity, and
 * closures. See the long note at the top of game/dispatch.ts.
 */

/**
 * How far from a junction the painted turn arrow appears. It used to be 1.3
 * block pitches; the city has no single pitch any more, and 75 metres is what
 * that came to — far enough to be the decision you are about to make, near
 * enough that the one after it is still the map's job.
 */
const TURN_ARROW_RANGE = 75;

const TRAFFIC_COUNT = 26;
const PEDESTRIAN_COUNT = 44;
/** Combo tops out here — beyond it the number stops meaning anything. */
const MAX_MULTIPLIER = 5;

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

export class DeliveryRules implements Rules {
  readonly dispatch = new Dispatch();
  readonly couriers = new Rivals();
  readonly traffic = new Traffic();
  readonly pedestrians = new Pedestrians();

  readonly stats: RunStats = {
    yen: 0, deliveries: 0, expired: 0, sniped: 0, scattered: 0,
    streak: 0, bestStreak: 0, elapsed: 0
  };

  clock = 0;
  private mode!: Mode;
  private route: Point[] = [];
  private routeTimer = 0;
  private focusKey = '';
  private lowWarned = false;
  private readonly blocks: Block[] = [];
  /**
   * The best before this run started. Snapshotted at the line, because the
   * results screen wants to show the number it beat and `commit()` has already
   * overwritten it by the time the screen is drawn.
   */
  private previous = 0;

  constructor(private readonly ctx: RulesContext) {}

  get intensity(): number { return clamp(this.stats.streak / 9, 0, 1); }

  /** What the spatial audio needs: the rivals as plain data. */
  get rivals(): Rival[] { return this.couriers.list; }

  get multiplier(): number {
    return Math.min(MAX_MULTIPLIER, 1 + Math.floor(this.stats.streak / 3));
  }

  get crates(): number { return this.dispatch.crates; }

  start(mode: Mode, car: Car): void {
    this.mode = mode;
    this.clock = mode.duration;
    this.lowWarned = false;
    this.previous = save.best[mode.id] ?? 0;
    Object.assign(this.stats, {
      yen: 0, deliveries: 0, expired: 0, sniped: 0, scattered: 0,
      streak: 0, bestStreak: 0, elapsed: 0
    });

    const net = this.ctx.network;
    this.dispatch.start(mode, net, car.x, car.z);
    this.couriers.start(this.dispatch, net, mode.rivals);
    this.traffic.setClosures(this.dispatch.closedEdges);
    this.traffic.start(net, save.settings.traffic ? TRAFFIC_COUNT : 0, car.x, car.z);
    this.pedestrians.start(save.settings.pedestrians ? PEDESTRIAN_COUNT : 0, car.x, car.z);

    this.route = [];
    this.routeTimer = 0;
    this.focusKey = '';
  }

  refresh(car: Car): void {
    this.traffic.start(this.ctx.network, save.settings.traffic ? TRAFFIC_COUNT : 0, car.x, car.z);
    this.pedestrians.start(save.settings.pedestrians ? PEDESTRIAN_COUNT : 0, car.x, car.z);
  }

  update(dt: number, car: Car): FrameEvents {
    const out = noEvents();
    this.stats.elapsed += dt;

    const pressure = 1 + this.mode.ramp * (this.stats.elapsed / 60);
    this.dispatch.setPressure(this.stats.elapsed / 60);
    this.couriers.setPressure(pressure);

    // --- world ---
    this.traffic.setClosures(this.dispatch.closedEdges);
    if (save.settings.traffic) this.traffic.update(dt, car.x, car.z);
    if (save.settings.pedestrians) {
      const hits = this.pedestrians.update(dt, car.x, car.z, car.v);
      if (hits > 0) {
        out.scattered = hits;
        this.stats.scattered += hits;
        this.breakStreak('Scattered a pedestrian');
      }
    }

    // --- rivals get first refusal on the orders they reach ---
    for (const id of this.couriers.update(dt)) {
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
      if (this.clock <= 0) { this.clock = 0; out.finished = true; }
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
        out.scored = yen;

        if (this.mode.duration > 0) {
          // Longer hauls pay back more clock, so committing to the far side of
          // the map is a decision rather than a mistake.
          const haul = clamp(ev.order.value / 40, 0, 5);
          this.clock += this.mode.timeBonus + haul;
        }
        this.ctx.messages.push({
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
        this.ctx.messages.push({ text: `Loaded ${ev.crates} melonpan`, bad: false });
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
    if (this.stats.streak >= 3) this.ctx.messages.push({ text: `${reason} · combo lost`, bad: true });
    else if (this.stats.streak === 0) this.ctx.messages.push({ text: reason, bad: true });
    this.stats.streak = 0;
  }

  extraBlocks(): Block[] {
    this.blocks.length = 0;
    for (const b of this.dispatch.barriers) this.blocks.push(b);
    for (const b of this.traffic.footprints) this.blocks.push(b);
    return this.blocks;
  }

  /**
   * The thing the player is currently being routed to: the nearest live order
   * if the truck has crates, or the nearest bakery if it does not.
   */
  focus(car: Car): { x: number; z: number; order: Order | null } {
    const bakery = () => {
      const [x, z] = this.dispatch.bakeryPosition(this.dispatch.nearestBakery(car.x, car.z));
      return { x, z, order: null };
    };
    if (this.dispatch.crates <= 0) return bakery();
    const o = this.dispatch.nearestOrder(car.x, car.z);
    return o ? { x: o.x, z: o.z, order: o } : bakery();
  }

  /**
   * The route is recomputed a few times a second, not every frame — Dijkstra
   * over 81 nodes is cheap but it is not free, and the ribbon does not visibly
   * lag.
   */
  private updateRoute(dt: number, car: Car): void {
    this.routeTimer -= dt;
    const f = this.focus(car);
    const key = `${Math.round(f.x)},${Math.round(f.z)}`;
    if (this.routeTimer > 0 && key === this.focusKey) return;
    this.routeTimer = 0.3;
    this.focusKey = key;
    const net = this.ctx.network;
    this.route = net.points(net.path(
      net.nearest(car.x, car.z), net.nearest(f.x, f.z), this.dispatch.closedEdges));
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

    const path = this.ctx.network.unwrap(this.displayRoute(car), car.x, car.z);
    drawRibbon(b, path);
    if (save.settings.turnArrows) this.drawNextTurn(b, car, path);

    // Bakeries. Ring only, unless the truck is empty — in which case one of
    // them is where you are actually going, and it earns the beacon.
    for (const bk of this.dispatch.bakeries) {
      const [bx, bz] = this.dispatch.bakeryPosition(bk);
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

    for (const r of this.couriers.list) {
      drawRival(b, nx(r.x), nz(r.z), r.heading, r.speed01);
    }
    for (const c of this.dispatch.closures) {
      drawClosure(b, nx(c.x), nz(c.z), c.angle);
    }
  }

  /**
   * The route with the truck's own position on the front, so the ribbon starts
   * under your wheels rather than at the junction ahead — which reads as a
   * route you have already missed.
   *
   * Routing starts from the nearest intersection, and when the truck is on a
   * road that intersection is always ON that road, ahead or behind. So joining
   * the truck straight to it never cuts a diagonal across a block.
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
    if (save.settings.traffic) this.traffic.draw(b, car.x, car.z);
    if (save.settings.pedestrians) this.pedestrians.draw(b, car.x, car.z);
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
    if (range > TURN_ARROW_RANGE || range < 27) return;

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

  hud(car: Car): HudView {
    const f = this.focus(car);
    const mult = this.multiplier;
    const slots: Slot[] = this.dispatch.orders.map(o => {
      const d = wrapDist(o.x, o.z, car.x, car.z);
      return {
        key: `o${o.id}`,
        tag: `${o.hot ? '★ ' : ''}${Math.round(d)} m`,
        value: o.life > 0 ? mmss(o.remaining) : '—',
        order: d,
        live: this.dispatch.crates > 0 && o.claimedBy < 0,
        contested: o.claimedBy >= 0,
        urgent: o.life > 0 && o.remaining < 12
      };
    });

    return {
      clock: this.clock,
      clockTotal: this.mode.duration || 1,
      endless: this.mode.duration === 0,
      score: this.stats.yen.toLocaleString('en-GB'),
      sub: mult > 1
        ? `<span class="accent">&times;${mult}</span> &middot; ${this.stats.streak} in a row`
        : '&nbsp;',
      task: this.taskText(),
      distance: wrapDist(f.x, f.z, car.x, car.z),
      cargo: this.dispatch.crates,
      slots
    };
  }

  private taskText(): string {
    if (this.dispatch.crates <= 0) return 'Load up at the <span class="accent">bakery</span>';
    const n = this.dispatch.orders.length;
    if (n === 0) return 'Waiting on the next order';
    return `Deliver the <span class="accent">melonpan</span> · ${this.dispatch.crates}/${CAPACITY} aboard`;
  }

  outcome(): RunOutcome {
    const s = this.stats;
    const previous = this.previous;
    const isBest = this.mode.duration > 0 && s.yen > previous;
    const rows: ResultRowList = [
      { label: 'Delivered', value: String(s.deliveries) },
      { label: 'Longest streak', value: String(s.bestStreak) },
      { label: 'Expired', value: String(s.expired) },
      { label: 'Beaten to it', value: String(s.sniped) },
      { label: 'Time on shift', value: mmss(s.elapsed) }
    ];
    if (isBest && previous > 0) {
      rows.unshift({ label: 'Previous best', value: `¥${previous.toLocaleString('en-GB')}`, highlight: true });
    }
    return {
      title: isBest ? 'New best shift' : 'Shift over',
      score: `¥${s.yen.toLocaleString('en-GB')}`,
      rows
    };
  }

  commit(): boolean {
    save.totalDeliveries += this.stats.deliveries;
    persist();
    if (this.mode.duration === 0) return false;       // roam is not a score
    return recordScore(this.mode.id, this.stats.yen);
  }
}

type ResultRowList = RunOutcome['rows'];

const mmss = (t: number): string => {
  const s = Math.max(0, Math.ceil(t));
  return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`;
};
