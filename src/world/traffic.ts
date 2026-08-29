import { GRID, PITCH, nodePos } from '../core/city-layout';
import { wrap, wrapDelta, wrapDist } from '../core/place';
import { edgeKey } from './network';
import type { Block } from '../render/city';
import type { Builder } from '../render/builder';
import { shade } from '../core/palette';
import { P } from '../core/config';
import type { RGB } from '../core/palette';

/**
 * Traffic.
 *
 * STILL LATTICE-BOUND, unlike the routing above it. Traffic keeps left in four
 * cardinal directions and snaps itself to lanes by grid arithmetic, none of
 * which means anything on a winding road. It is off by default and a mountain
 * pass will want a different mover entirely, so porting it onto the road
 * network is left until there is a second network to port it to.
 *
 *
 * Not vehicles — tokens on the road graph. They keep left (this is a Japanese
 * city and a Japanese truck), pick a direction at each junction, honour road
 * closures, and slow for the car in front. They never crash and they never
 * chase you.
 *
 * What they are FOR, beyond looking alive: they turn the plan region's
 * information into a cost. Reading the map means not reading the street, and
 * traffic is what makes not reading the street expensive. That tension is the
 * reason to have both regions in one frame at all.
 *
 * They also only exist near you. The city is infinite and wrapped, so traffic
 * is spawned on a ring around the truck and recycled once it falls behind —
 * there is no such thing as the far side of town to simulate.
 */

/** Which way a token is going: +z, +x, −z, −x. */
const DIRS: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const DIR_ANGLE = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const LANE = 3.4;               // offset from the centreline, on the left
const GLASS: RGB = [0.34, 0.38, 0.43];

const SPAWN_MIN = 55;
const SPAWN_MAX = 190;
const DESPAWN = 280;

export interface TrafficCar {
  x: number;
  z: number;
  dir: number;
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

  start(count: number, carX: number, carZ: number): void {
    this.cars.length = 0;
    for (let i = 0; i < count; i++) this.cars.push(this.spawn(carX, carZ));
  }

  setClosures(closed: ReadonlySet<string>): void { this.closed = closed; }

  update(dt: number, carX: number, carZ: number): void {
    for (const t of this.cars) {
      // Keep a gap to whatever is directly ahead in the same lane.
      const gap = this.gapAhead(t);
      const wanted = gap < 9 ? 0 : gap < 20 ? t.target * 0.45 : t.target;
      t.speed += (wanted - t.speed) * Math.min(1, dt * 2.4);

      const [dx, dz] = DIRS[t.dir];
      t.x = wrap(t.x + dx * t.speed * dt);
      t.z = wrap(t.z + dz * t.speed * dt);

      // Snap the cross-axis coordinate, so a token never drifts off its lane.
      this.snapLane(t);

      if (this.atJunction(t)) this.turn(t);

      if (wrapDist(t.x, t.z, carX, carZ) > DESPAWN) Object.assign(t, this.spawn(carX, carZ));
    }

    this.footprints.length = 0;
    for (const t of this.cars) {
      // Only what is close enough to hit — the collision loop is O(n) per substep.
      if (wrapDist(t.x, t.z, carX, carZ) > 60) continue;
      const along = t.dir % 2 === 0;
      this.footprints.push({
        x: t.x, z: t.z,
        w: along ? t.wid : t.len,
        d: along ? t.len : t.wid
      });
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
      const along = t.dir % 2 === 0;
      const w = along ? t.wid : t.len;
      const d = along ? t.len : t.wid;
      b.box(t.x, t.z, w, t.hgt * inv, d, t.col, shade(t.col), 3, 0.28 * inv);
      // A dark band at glass height, so it reads as a vehicle at a glance.
      b.box(t.x, t.z, w * 0.86, t.hgt * 0.34 * inv, d * 0.86,
        GLASS, GLASS, 2, (0.28 + t.hgt * 0.62) * inv);
    }
  }

  headingOf(t: TrafficCar): number { return DIR_ANGLE[t.dir]; }

  private spawn(carX: number, carZ: number): TrafficCar {
    const ang = Math.random() * Math.PI * 2;
    const r = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    const px = carX + Math.sin(ang) * r;
    const pz = carZ + Math.cos(ang) * r;

    const dir = (Math.random() * 4) | 0;
    const big = Math.random() < 0.22;
    const t: TrafficCar = {
      x: wrap(px), z: wrap(pz), dir,
      target: 9 + Math.random() * 7,
      speed: 9,
      col: pickColour(),
      len: big ? 6.4 : 4.3,
      wid: big ? 2.2 : 1.8,
      hgt: big ? 2.6 : 1.5
    };
    // Put it on the nearest road running the right way.
    if (dir % 2 === 0) {
      const i = Math.round(wrap(px) / PITCH) % GRID;
      t.x = wrap(nodePos(i) + (dir === 0 ? LANE : -LANE));
    } else {
      const j = Math.round(wrap(pz) / PITCH) % GRID;
      t.z = wrap(nodePos(j) + (dir === 1 ? -LANE : LANE));
    }
    return t;
  }

  private snapLane(t: TrafficCar): void {
    if (t.dir % 2 === 0) {
      const i = Math.round((wrap(t.x) - (t.dir === 0 ? LANE : -LANE)) / PITCH);
      t.x = wrap(nodePos(i) + (t.dir === 0 ? LANE : -LANE));
    } else {
      const j = Math.round((wrap(t.z) - (t.dir === 1 ? -LANE : LANE)) / PITCH);
      t.z = wrap(nodePos(j) + (t.dir === 1 ? -LANE : LANE));
    }
  }

  /** True within a small window of the junction centre, once per crossing. */
  private atJunction(t: TrafficCar): boolean {
    const along = t.dir % 2 === 0 ? wrap(t.z) : wrap(t.x);
    const off = along % PITCH;
    return off < 1.2 || off > PITCH - 1.2;
  }

  private turn(t: TrafficCar): void {
    const node = this.nodeAt(t);
    const options: number[] = [];
    for (let d = 0; d < 4; d++) {
      if (d === (t.dir + 2) % 4) continue;            // never a U-turn
      // The next node in that direction, on the axis that direction moves along.
      const to: [number, number] = d % 2 === 0
        ? [node[0], node[1] + (d === 0 ? 1 : -1)]
        : [node[0] + (d === 1 ? 1 : -1), node[1]];
      if (to[0] < 0 || to[1] < 0 || to[0] >= GRID || to[1] >= GRID) continue;
      if (this.closed.has(edgeKey(node[0] * GRID + node[1], to[0] * GRID + to[1]))) continue;
      // Straight on is three times as likely as either turn. Traffic that turns
      // at random reads as confused rather than as traffic.
      const weight = d === t.dir ? 3 : 1;
      for (let k = 0; k < weight; k++) options.push(d);
    }
    if (options.length === 0) { t.dir = (t.dir + 2) % 4; return; }
    t.dir = options[(Math.random() * options.length) | 0];
    this.snapLane(t);
  }

  private nodeAt(t: TrafficCar): [number, number] {
    return [
      Math.max(0, Math.min(GRID - 1, Math.round(wrap(t.x) / PITCH) % GRID)),
      Math.max(0, Math.min(GRID - 1, Math.round(wrap(t.z) / PITCH) % GRID))
    ];
  }

  /** Distance to the nearest token ahead in the same lane, or Infinity. */
  private gapAhead(t: TrafficCar): number {
    const [dx, dz] = DIRS[t.dir];
    let best = Infinity;
    for (const o of this.cars) {
      if (o === t || o.dir !== t.dir) continue;
      const ox = wrapDelta(o.x, t.x), oz = wrapDelta(o.z, t.z);
      const along = ox * dx + oz * dz;
      const across = Math.abs(ox * dz - oz * dx);
      if (along <= 0 || across > 2.5) continue;
      best = Math.min(best, along - (t.len + o.len) / 2);
    }
    return best;
  }
}

function pickColour(): RGB {
  const t = 0.58 + Math.random() * 0.34;
  // Mostly greys with a rare warm one, so traffic never competes with the
  // matcha accent or the rivals' red for attention.
  if (Math.random() < 0.10) return [0.80, 0.74, 0.60];
  return [t, t * 1.02, t * 1.05];
}
