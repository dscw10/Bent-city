import { Audio } from './audio';
import { EngineSound } from './engine-sound';
import { Sfx } from './sfx';
import { WorldSound } from './world-sound';
import { Music } from './music';
import type { Car } from '../vehicle/vehicle';
import type { Rival } from '../world/rivals';
import type { Traffic } from '../world/traffic';
import { P } from '../core/config';
import { clamp } from '../core/math';

/**
 * One object for the rest of the game to talk to, so nothing outside this
 * folder has to know about AudioContext lifecycles or bus routing.
 *
 * Everything is lazy: no context exists until the player presses Start, because
 * a browser will not let one run before a gesture and one created early sits
 * suspended forever with no error to see.
 */
export class GameAudio {
  private readonly audio = new Audio();
  private readonly engine = new EngineSound();
  private readonly sfx = new Sfx();
  private readonly world = new WorldSound();
  private readonly music = new Music();
  private tickAt = -1;

  /** Call from a user gesture. Safe to call repeatedly. */
  begin(volume: number, muted: boolean): void {
    this.audio.start();
    if (!this.audio.ready) return;
    this.audio.setVolume(volume);
    this.audio.setMuted(muted);
    this.engine.attach(this.audio);
    this.sfx.attach(this.audio);
    this.world.attach(this.audio);
    this.music.attach(this.audio);
    this.audio.resume();
  }

  setVolume(v: number): void { this.audio.setVolume(v); }
  setMuted(m: boolean): void { this.audio.setMuted(m); }
  resume(): void { this.audio.resume(); }

  /** Per-frame. `active` is false while paused or on a menu. */
  update(
    dt: number, car: Car, throttle: number, active: boolean,
    rivals: Rival[], traffic: Traffic | null,
    music: { speed: number; urgency: number; intensity: number }
  ): void {
    if (!this.audio.ready) return;

    if (!active) {
      // Engine and city stop; the music stays, dropped to its pad. Silence
      // behind a pause menu makes a game feel switched off, and the pad is
      // also what the title and results screens sit on.
      this.engine.silence();
      this.world.silence();
      this.music.setState({ speed: 0, urgency: 0, intensity: 0, active: true });
      return;
    }

    const slip = Math.max(...car.slipRatio);
    this.engine.update(dt, car.v, throttle, slip, car.offroad, P.vMax, true);

    // The listener is the truck, in UNBENT world space — the bend is a
    // rendering transform and the audio must never see it.
    this.audio.setListener(car.x, car.y, car.z, car.a);
    this.world.update(rivals, traffic, car.x, car.z, true);
    this.music.setState({ ...music, active: true });
  }

  delivered(multiplier: number): void { this.sfx.delivered(multiplier); }
  restocked(): void { this.sfx.restock(); }
  expired(): void { this.sfx.expired(); }
  sniped(): void { this.sfx.sniped(); }
  scattered(): void { this.sfx.scattered(); }
  boost(charge: number): void { this.sfx.boost(charge); }
  finish(): void { this.sfx.finish(); }

  impact(speed: number): void {
    if (speed > 4) this.sfx.impact(speed);
  }

  /** One tick per second over the last ten, rising at the very end. */
  clock(remaining: number, endless: boolean): void {
    if (endless || remaining > 10 || remaining <= 0) { this.tickAt = -1; return; }
    const whole = Math.ceil(remaining);
    if (whole !== this.tickAt) {
      this.tickAt = whole;
      this.sfx.tick(whole);
    }
  }

  /**
   * Mix inputs, derived in one place so the music and the HUD agree.
   *
   * `intensity` is whatever the current game says drama is: a delivery combo in
   * the city, how far up the pass you have got on the mountain. The music does
   * not need to know which.
   */
  static musicState(speed: number, clock: number, duration: number, intensity: number) {
    return {
      speed: clamp(Math.abs(speed) / P.vMax, 0, 1),
      urgency: duration > 0 ? clamp(1 - clock / Math.min(45, duration), 0, 1) : 0,
      intensity: clamp(intensity, 0, 1)
    };
  }
}
