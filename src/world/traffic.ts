import { wrap, wrapDelta, wrapDist } from '../core/place';
import { edgeKey } from './network';
import type { RoadNetwork } from './network';
import type { Block } from '../render/scenery';
import type { Builder } from '../render/builder';
import { shade } from '../core/palette';
import { P } from '../core/config';
import type { RGB } from '../core/palette';

/**
 * Traffic — tokens on the road graph.
 *
 * They keep left (this is a Japanese city and a Japanese truck), pick a road at
 * each junction, honour road closures, and slow for the car in front. They
 * never crash and they never chase you.
 *
 * What they are FOR, beyond looking alive: they turn the plan region's
 * information into a cost. Reading the map means not reading the street, and
 * traffic is what makes not reading the street expensive. That tension is the
 * reason to have both regions in one frame at all.
 *
 * They also only exist near you. The city is infinite and wrapped, so traffic
 * is spawned on a ring around the truck and recycled once it falls behind —
 * there is no such thing as the far side of town to simulate.
 *
 * ---------------------------------------------------------------------------
 * IT RUNS ON THE ROAD NETWORK NOW, and it got shorter doing it.
 *
 * The lattice version carried a direction from a set of four, snapped its
 * cross-axis coordinate to a lane by grid arithmetic every frame, and detected
 * junctions by testing a modulo against a window. None of that means anything
 * on a street at 37 degrees. A token now simply holds the road it is on and how
 * far along it is, which is both shorter and the only version that works on a
 * city whose streets meet at whatever angle they meet at.
 */

/** Offset from the centreline, on the left. */
const LANE = 3.4;
const GLASS: RGB = [0.34, 0.38, 0.43];

const SPAWN_MIN = 55;
const SPAWN_MAX = 190;
const DESPAWN = 280;

export interface TrafficCar {
  /** The road it is on, as the two junctions it runs between. */
  from: number;
  to: number;
  /** How far along, 0 to 1. */
  t: number;
  x: number;
  z: number;
  heading: number;
  speed: number;
  target: number;
  /** Body colour, so the traffic isn't visibly one repeated object. */
  col: RGB;
  len: number;
  wid: number;
  hgt: number;
}

export class Traffic {
  readonly cars: TrafficCar[] = [];
  /** Rebuilt each frame, appended to the player's collision set. */
  readonly footprints: Block[] = [];
  private closed: ReadonlySet<string> = new Set();
  private net: RoadNetwork | null = null;

  start(net: RoadNetwork, count: number, carX: number, carZ: number): void {
    this.net = net;
    this.cars.length = 0;
    for (let i = 0; i < count; i++) {
      const c = this.spawn(carX, carZ);
      if (c) this.cars.push(c);
    }
  }

  setClosures(closed: ReadonlySet<string>): void { this.closed = closed; }

  update(dt: number, carX: number, carZ: number): void {
    const net = this.net;
    if (!net) return;

    for (const t of this.cars) {
      // Keep a gap to whatever is directly ahead on the same road.
      const gap = this.gapAhead(t);
      const wanted = gap < 9 ? 0 : gap < 20 ? t.target * 0.45 : t.target;
      t.speed += (wanted - t.speed) * Math.min(1, dt * 2.4);

      const len = net.distance(t.from, t.to);
      t.t += len > 0 ? (t.speed * dt) / len : 1;
      if (t.t >= 1) {
        const next = this.pickNext(t);
        if (next < 0) { Object.assign(t, this.spawn(carX, carZ) ?? t); continue; }
        t.from = t.to;
        t.to = next;
        t.t = 0;
      }
      this.place(t);

      if (wrapDist(t.x, t.z, carX, carZ) > DESPAWN) {
        const fresh = this.spawn(carX, carZ);
        if (fresh) Object.assign(t, fresh);
      }
    }

    this.footprints.length = 0;
    for (const t of this.cars) {
      // Only what is close enough to hit — the collision loop is O(n) per substep.
      if (wrapDist(t.x, t.z, carX, carZ) > 60) continue;
      // Oriented, because the road it is on need not be square to the compass.
      this.footprints.push({ x: t.x, z: t.z, w: t.wid, d: t.len, a: t.heading });
    }
  }

  /**
   * IMPORTANT: every Y value here is pre-divided by uBuildH.
   *
   * That uniform scales BUILDING height for map legibility, and the shader
   * applies it to everything before terrain is added. Buildings want that;
   * a car does not — left alone it renders at a third of its height and reads
   * as a flat grey shard lying in the road. This is the same trap that broke
   * the first attempt at elevated roads, in a different costume.
   *
   * The terrain lift is handled by the anchor, which is why there is no
   * terrainAt() call here: the box is authored at ground level and the shader
   * puts it on the hillside, upright, exactly as it does with buildings.
   */
  draw(b: Builder, carX: number, carZ: number): void {
    const inv = 1 / P.buildH;
    for (const t of this.cars) {
      if (wrapDist(t.x, t.z, carX, carZ) > 400) continue;
      b.boxRot(t.x, t.z, t.wid, t.hgt * inv, t.len, t.heading,
        t.col, shade(t.col), 3, 0.28 * inv);
      // A dark band at glass height, so it reads as a vehicle at a glance.
      b.boxRot(t.x, t.z, t.wid * 0.86, t.hgt * 0.34 * inv, t.len * 0.86, t.heading,
        GLASS, GLASS, 2, (0.28 + t.hgt * 0.62) * inv);
    }
  }

  headingOf(t: TrafficCar): number { return t.heading; }

  /** Put a token in the world from the road it is on and how far along it is. */
  private place(t: TrafficCar): void {
    const net = this.net!;
    const a = net.nodes[t.from], b = net.nodes[t.to];
    const dx = net.delta(b.x, a.x), dz = net.delta(b.z, a.z);
    const len = Math.hypot(dx, dz) || 1;
    t.heading = Math.atan2(dx, dz);
    // Left of the direction of travel is (−cos, sin) — they keep left.
    t.x = wrap(a.x + dx * t.t - (dz / len) * 0 - (Math.cos(t.heading)) * LANE);
    t.z = wrap(a.z + dz * t.t + (Math.sin(t.heading)) * LANE);
  }

  /** Which road to take out of the junction ahead. */
  private pickNext(t: TrafficCar): number {
    const net = this.net!;
    const here = net.nodes[t.to];
    const inA = t.heading;
    const options: Array<{ n: number; turn: number }> = [];
    for (const n of here.links) {
      if (n === t.from && here.links.length > 1) continue;   // no U-turns unless dead end
      if (this.closed.has(edgeKey(t.to, n))) continue;
      const outA = Math.atan2(net.delta(net.nodes[n].x, here.x),
                              net.delta(net.nodes[n].z, here.z));
      let d = outA - inA;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      options.push({ n, turn: Math.abs(d) });
    }
    if (options.length === 0) return t.from;                 // boxed in: turn round
    /* Weighted toward carrying straight on, which is what makes traffic read as
       going somewhere rather than milling about. On a lattice this fell out of
       the four fixed directions; on an irregular graph it has to be asked for. */
    options.sort((p, q) => p.turn - q.turn);
    const r = Math.random();
    if (r < 0.55 || options.length === 1) return options[0].n;
    return options[1 + ((Math.random() * (options.length - 1)) | 0)].n;
  }

  private spawn(carX: number, carZ: number): TrafficCar | null {
    const net = this.net;
    if (!net || net.nodes.length === 0) return null;
    const ang = Math.random() * Math.PI * 2;
    const r = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    const from = net.nearest(carX + Math.sin(ang) * r, carZ + Math.cos(ang) * r);
    const links = net.nodes[from].links;
    if (links.length === 0) return null;
    const to = links[(Math.random() * links.length) | 0];

    const big = Math.random() < 0.22;
    const t: TrafficCar = {
      from, to, t: Math.random(),
      x: 0, z: 0, heading: 0,
      target: 9 + Math.random() * 7,
      speed: 9,
      col: pickColour(),
      len: big ? 6.4 : 4.3,
      wid: big ? 2.2 : 1.8,
      hgt: big ? 2.6 : 1.5
    };
    this.place(t);
    return t;
  }

  /** Distance to the next token ahead on the same road, or a big number. */
  private gapAhead(t: TrafficCar): number {
    let best = 1e9;
    for (const o of this.cars) {
      if (o === t || o.from !== t.from || o.to !== t.to || o.t <= t.t) continue;
      const d = Math.hypot(wrapDelta(o.x, t.x), wrapDelta(o.z, t.z));
      if (d < best) best = d;
    }
    return best;
  }
}

function pickColour(): RGB {
  const t = 0.55 + Math.random() * 0.30;
  return [t, t * 1.02, t * 1.06];
}
