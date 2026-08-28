import { P } from '../core/config';
import { uniforms, computeBendEnd } from './uniforms';
import { approach, clamp, shortAngle, smoothstep } from '../core/math';
import type { Car } from '../vehicle/vehicle';

/**
 * ---- speed-reactive projection ----
 *
 * THE CAMERA IS THE PROJECTION, so speed can drive it. Nobody else building a
 * driving game can do this, because everyone else's camera is just a camera.
 *
 * - Standing still: near horizon, large map. You are manoeuvring, so you want
 *   situational awareness.
 * - At speed: the bend start travels out, the life-size street grows, and your
 *   look-ahead extends with your stopping distance. The map scale zooms out to
 *   compensate for the map region sitting further away and shrinking.
 *
 * Three implementation notes that matter:
 * - The response curve is a SMOOTHSTEP on |v|/vMax, not linear. The change
 *   should happen across the mid speed range, not creep in from a standstill.
 * - Smoothed with a ~0.55s lag. Without it the view snaps and is unusable.
 * - 15% of the push comes from ACCELERATION rather than speed, which gives the
 *   surge some punch on the throttle. Small on purpose — more than this and it
 *   pumps on every throttle blip.
 *
 * OPEN QUESTION: does this help, or does it induce motion sickness? It is the
 * same family of trick as FOV-widening in racing games but far more aggressive,
 * and it needs testing on someone who isn't the person who built it. Hence the
 * "Bend intensity" setting, which scales the whole effect down to zero.
 */
export class Projection {
  /** Smoothed bend start and map scale — what the shader actually gets. */
  private zDyn = P.z0;
  private kDyn = P.kMin;
  private prevV = 0;

  /** Heading the far field is aligned to. */
  aLag = 0;

  /** Smoothed speed response in 0..1. The camera shares it. */
  resp = 0;

  /** 0 disables the speed reaction entirely; 1 is full strength. */
  intensity = 1;

  reset(heading: number): void {
    this.zDyn = P.z0;
    this.kDyn = P.kMin;
    this.prevV = 0;
    this.resp = 0;
    this.aLag = heading;
  }

  update(dt: number, car: Car): void {
    const spd = Math.min(1, Math.abs(car.v) / P.vMax);
    this.resp = smoothstep(spd);

    const accel = clamp((car.v - this.prevV) / (dt * 34), 0, 1);
    this.prevV = car.v;

    const push = P.push * this.intensity;
    const targetZ0 = P.z0 + push * (this.resp * 0.85 + accel * 0.15);
    const targetK = P.kMin * (push > 0 ? (1 - 0.30 * this.resp) : 1);

    this.zDyn = approach(this.zDyn, targetZ0, dt, 0.55);
    this.kDyn = approach(this.kDyn, targetK, dt, 0.55);

    uniforms.uZ0.value = this.zDyn;
    uniforms.uKmin.value = this.kDyn;
    // Runs every frame because the map scale is animating. 240 steps, negligible.
    computeBendEnd(this.kDyn);

    /* ---- map orientation lag ----
       aLag is the heading the far field is aligned to.
         lock 0.00 — tracks the truck exactly. The map turns with you.
         lock 1.00 — never moves. World-locked, north stays north.
         in between — the map swings lazily behind your turns.

       Known consequence at lock 1.00: the fold direction is world-aligned too,
       so the map shows what is north of you regardless of travel direction.
       Drive south and your destination can fall off the bottom. That is the
       standard north-up versus heading-up tradeoff in navigation, not obviously
       wrong — but it needs playtesting rather than a decision from first
       principles, which is why it is a setting. */
    if (P.lock <= 0.001) {
      this.aLag = car.a;
    } else if (P.lock < 0.999) {
      this.aLag += shortAngle(car.a - this.aLag) * (1 - Math.exp(-dt * (1 - P.lock) * 9));
    }
    uniforms.uDelta.value = shortAngle(car.a - this.aLag);

    // The twist band sits over the fold, wherever the fold currently is.
    const sB = P.R * Math.PI / 2;
    uniforms.uRampA.value = this.zDyn * 0.45;
    uniforms.uRampB.value = this.zDyn + sB;

    // Strong compression can see much further, so the fog has to open up too.
    uniforms.uFallA.value = 40 + 8000 * Math.pow(1 - P.fall, 3);
    uniforms.uFogEnd.value = 490 + 520 * P.fall;
    uniforms.uFogStart.value = 240 + 300 * P.fall;
  }

  /** Apply a bend parameter that needs the fold end recomputing. */
  static refreshBendEnd(k: number): void { computeBendEnd(k); }
}
