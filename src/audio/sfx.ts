import type { Audio } from './audio';

/**
 * One-shots, all synthesised.
 *
 * Everything with a place in the world — a rival's engine, the hum of a live
 * order — is fed UNBENT world coordinates through a PannerNode. That is the same
 * rule the physics follows: the bend is a rendering transform and nothing else
 * may see it.
 */
export class Sfx {
  private audio!: Audio;
  private live = false;

  attach(audio: Audio): void {
    if (!audio.ctx) return;
    this.audio = audio;
    this.live = true;
  }

  /**
   * The delivery chime. A perfect fifth with a soft attack — deliberately the
   * only consonant, ringing sound in the game, so it stands out against an
   * engine and a city.
   */
  delivered(multiplier: number): void {
    if (!this.live) return;
    // The combo raises the chime a scale degree at a time, so a run of
    // deliveries climbs. You can hear a streak without looking at the number.
    const step = Math.min(4, multiplier - 1);
    const root = 523.25 * Math.pow(2, step / 12 * 2);
    this.bell(root, 0.9, 0.20);
    this.bell(root * 1.5, 1.1, 0.13, 0.06);
    this.audio.duckMusic(0.6, 0.55);
  }

  restock(): void {
    if (!this.live) return;
    // A wooden thunk: short, low, no pitch to speak of.
    this.thump(140, 0.16, 0.18);
    this.bell(880, 0.28, 0.05, 0.03);
  }

  /** An order timed out. Falling, and it does not resolve. */
  expired(): void {
    if (!this.live) return;
    this.sweep(440, 180, 0.55, 0.13, 'triangle');
  }

  /** A rival got there first. Sharper and more annoying than an expiry. */
  sniped(): void {
    if (!this.live) return;
    this.sweep(700, 240, 0.35, 0.15, 'sawtooth');
    this.thump(90, 0.3, 0.14);
  }

  /** Hitting something. Scaled by how hard. */
  impact(speed: number): void {
    if (!this.live) return;
    const hard = Math.min(1, speed / 22);
    this.noiseBurst(0.10 + hard * 0.14, 250 + hard * 1400, 0.10 + hard * 0.22);
    this.thump(60 + hard * 40, 0.18, 0.10 + hard * 0.18);
  }

  scattered(): void {
    if (!this.live) return;
    this.noiseBurst(0.07, 2600, 0.07);
  }

  /**
   * Cashing in a drift. A rising sweep with a noise whoosh over it, both scaled
   * by how much charge was spent — so a scrappy little drift sounds like one.
   */
  boost(charge: number): void {
    if (!this.live) return;
    const ctx = this.audio.ctx!;
    const bus = this.audio.bus('world')!;
    const t = ctx.currentTime;
    const dur = 0.35 + charge * 0.35;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(120 + 420 * charge, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.exponentialRampToValueAtTime(2600, t + dur * 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * (0.5 + charge * 0.5), t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp).connect(g).connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);

    this.noiseBurst(dur * 0.8, 900 + charge * 1200, 0.10 * charge);
  }

  /** The last ten seconds. One per second, rising at the end. */
  tick(secondsLeft: number): void {
    if (!this.live) return;
    const urgent = secondsLeft <= 3;
    this.bell(urgent ? 1046 : 784, 0.10, urgent ? 0.14 : 0.08);
  }

  /** Shift over. */
  finish(): void {
    if (!this.live) return;
    this.bell(523.25, 1.6, 0.16);
    this.bell(659.25, 1.6, 0.12, 0.10);
    this.bell(784, 1.9, 0.14, 0.20);
  }

  // ---------- primitives ----------

  private bell(freq: number, dur: number, gain: number, delay = 0): void {
    const ctx = this.audio.ctx!;
    const bus = this.audio.bus('ui')!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private thump(freq: number, dur: number, gain: number): void {
    const ctx = this.audio.ctx!;
    const bus = this.audio.bus('world')!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.45, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private sweep(from: number, to: number, dur: number, gain: number, type: OscillatorType): void {
    const ctx = this.audio.ctx!;
    const bus = this.audio.bus('ui')!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp).connect(g).connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private noiseBurst(dur: number, cutoff: number, gain: number): void {
    const ctx = this.audio.ctx!;
    const bus = this.audio.bus('world')!;
    const src = this.audio.noiseSource();
    if (!src) return;
    const t = ctx.currentTime;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = cutoff;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(bus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }
}
