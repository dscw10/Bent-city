import type { Builder } from './builder';
import type { Car } from '../vehicle/vehicle';
import { WHEELS } from '../vehicle/vehicle';
import { P } from '../core/config';
import { clamp, lerp } from '../core/math';
import { wrapDist, nearCopy, wrap } from '../core/city-layout';

/**
 * Tyre smoke.
 *
 * Drawn as flat ground-hugging quads rather than camera-facing billboards,
 * because BILLBOARDS ARE ONE OF THE THINGS THE BEND BREAKS: a sprite turned to
 * face the camera is turned in unbent space, and once the world folds it is
 * facing the wrong way — or edge-on, or inside out. Flat quads bend like
 * everything else does, which also means the smoke lies down onto the map with
 * the rest of the world and you can see a rival's drift from above.
 *
 * It suits the flat-shaded look anyway: a puff here is a couple of squares that
 * grow, turn and fade to paper.
 */
interface Puff {
  x: number;
  z: number;
  size: number;
  rot: number;
  spin: number;
  age: number;
  life: number;
  /** 0..1 how hard the tyre was working when it was made. */
  strength: number;
}

const MAX_PUFFS = 90;
/** Slip fraction above which a tyre starts to smoke at all. */
const SMOKE_THRESHOLD = 0.85;

export class Smoke {
  private readonly puffs: Puff[] = [];
  private spawnDebt = 0;

  clear(): void {
    this.puffs.length = 0;
    this.spawnDebt = 0;
  }

  update(dt: number, car: Car): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      if (p.age >= p.life) { this.puffs.splice(i, 1); continue; }
      p.size += dt * (1.7 + p.strength * 2.4);
      p.rot += p.spin * dt;
    }

    // Only the driven wheels smoke, and only when they are near their limit.
    const speed = Math.hypot(car.vx, car.vz);
    if (speed < 3) return;

    let worst = 0;
    for (let i = 0; i < 4; i++) {
      if (WHEELS[i].rear) worst = Math.max(worst, car.slipRatio[i]);
    }
    const strength = clamp((worst - SMOKE_THRESHOLD) / 0.5, 0, 1) *
      (car.drifting ? 1 : 0.55);
    if (strength <= 0.02) { this.spawnDebt = 0; return; }

    // Rate scales with how hard the tyres are working and how fast they are
    // travelling, carried as a fractional debt so it is frame-rate independent.
    this.spawnDebt += dt * (10 + strength * 34) * clamp(speed / 14, 0, 1);
    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1;
      this.emit(car, strength);
    }
  }

  private emit(car: Car, strength: number): void {
    const sa = Math.sin(car.a), ca = Math.cos(car.a);
    const W = WHEELS[Math.random() < 0.5 ? 2 : 3];
    const x = car.x + sa * W.f + ca * W.s + (Math.random() - 0.5) * 0.5;
    const z = car.z + ca * W.f - sa * W.s + (Math.random() - 0.5) * 0.5;

    if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
    this.puffs.push({
      x: wrap(x),
      z: wrap(z),
      size: 1.6 + Math.random() * 1.2,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 1.4,
      age: 0,
      life: 0.55 + strength * 0.6 + Math.random() * 0.3,
      strength
    });
  }

  /**
   * Y values are pre-divided by uBuildH, for the same reason traffic is: that
   * uniform scales BUILDING height and smoke is not a building.
   */
  draw(b: Builder, carX: number, carZ: number): void {
    const inv = 1 / P.buildH;
    for (const p of this.puffs) {
      if (wrapDist(p.x, p.z, carX, carZ) > 220) continue;
      const t = p.age / p.life;

      /* WHITE, and it dies by SHRINKING rather than fading.
       *
       * There is no alpha here: the marks batch is opaque, and giving smoke its
       * own transparent pass would put a per-vertex alpha on every vertex of
       * the city to serve ninety quads. Fading a colour instead only works if
       * you know what is behind it, and smoke lands on road, pavement and grass
       * alike. So it is near-white — brighter than any of them, in a palette
       * whose road is 0.76 — and it goes away by getting smaller.
       */
      const g = lerp(0.995, 0.90, t);
      const col: [number, number, number] = [g, g, Math.min(1, g + 0.01)];
      const x = nearCopy(p.x, carX);
      const z = nearCopy(p.z, carZ);
      // Puff out fast, then shrink away to nothing.
      const grow = t < 0.25 ? t / 0.25 : 1;
      const s = p.size * grow * (1 - t * t);
      if (s < 0.05) continue;
      const y = (0.06 + t * 0.5) * inv;
      // Two squares crossed: a rounder silhouette than one, for two quads.
      b.slabRot(x, z, s, s, y, p.rot, col, 1);
      b.slabRot(x, z, s * 0.75, s * 0.75, y, p.rot + Math.PI / 4, col, 1);
    }
  }

  get count(): number { return this.puffs.length; }
}
