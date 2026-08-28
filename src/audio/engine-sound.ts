import type { Audio } from './audio';
import { clamp } from '../core/math';

/**
 * Engine and tyre noise.
 *
 * DON'T LOOP ONE SAMPLE AND PITCH IT — it sounds like a hairdryer. This layers
 * four voices at harmonically related frequencies, crossfades between them on
 * RPM, and puts a separate load-dependent layer on top so throttle-on and
 * throttle-off differ. That difference is most of the perceived quality of a
 * driving game.
 *
 * The engine is a 660cc three-cylinder kei unit: buzzy, revvy, not much torque.
 * Firing frequency for a four-stroke triple is rpm/60 × 1.5, and building the
 * tone from that rather than from an arbitrary pitch is why it sounds like an
 * engine rather than like a synthesiser doing an impression of one.
 *
 * There is no gearbox in the physics, so one is faked here purely for the
 * sound: RPM sweeps up, drops on a shift, and sweeps again. It costs nothing
 * and it is the single biggest thing separating "a drone that rises" from
 * "a vehicle accelerating".
 */

/** Ratios chosen so the shifts land at speeds you actually drive at. */
const GEARS = [3.6, 2.1, 1.45, 1.05, 0.82];
const IDLE_RPM = 850;
const MAX_RPM = 7600;

export class EngineSound {
  private ctx!: AudioContext;
  private out!: GainNode;

  /** Sawtooth layers: sub, fundamental, and two harmonics. */
  private oscs: OscillatorNode[] = [];
  private gains: GainNode[] = [];
  private tone!: BiquadFilterNode;

  /** Induction roar — noise that grows with load. */
  private airGain!: GainNode;
  private airFilter!: BiquadFilterNode;

  /** Tyre and surface noise. */
  private tyreGain!: GainNode;
  private tyreFilter!: BiquadFilterNode;
  private rollGain!: GainNode;
  private rollFilter!: BiquadFilterNode;

  private gear = 0;
  private shiftFor = 0;
  private rpm = IDLE_RPM;
  private live = false;

  attach(audio: Audio): void {
    const ctx = audio.ctx;
    const bus = audio.bus('engine');
    if (!ctx || !bus || this.live) return;
    this.ctx = ctx;
    this.live = true;

    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(bus);

    // Tone stack: one lowpass shared by the harmonic layers, opened by load.
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 900;
    this.tone.Q.value = 0.8;
    this.tone.connect(this.out);

    // Sub, fundamental, and two upper harmonics. Each is detuned slightly —
    // perfectly in-tune layers phase-cancel into a single thin buzz.
    const layers: Array<[type: OscillatorType, mult: number, gain: number, detune: number]> = [
      ['sine', 0.5, 0.55, -6],
      ['sawtooth', 1, 0.40, 0],
      ['sawtooth', 2, 0.18, 9],
      ['square', 3, 0.07, -13]
    ];
    for (const [type, mult, gain, detune] of layers) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(this.tone);
      osc.start();
      this.oscs.push(osc);
      this.gains.push(g);
      (osc as OscillatorNode & { _mult?: number })._mult = mult;
    }

    // Induction: bandpassed noise, gain follows load rather than speed, which
    // is what makes lifting off audible.
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'bandpass';
    this.airFilter.frequency.value = 700;
    this.airFilter.Q.value = 0.7;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;
    audio.noiseSource()?.connect(this.airFilter);
    this.airFilter.connect(this.airGain).connect(this.out);
    this.startNoise(audio, this.airFilter);

    // Tyre scrub: only audible when a tyre is near its grip limit.
    this.tyreFilter = ctx.createBiquadFilter();
    this.tyreFilter.type = 'bandpass';
    this.tyreFilter.frequency.value = 1900;
    this.tyreFilter.Q.value = 1.4;
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;
    this.tyreFilter.connect(this.tyreGain).connect(bus);
    this.startNoise(audio, this.tyreFilter);

    // Surface roll: broadband rumble, brighter and louder off-road. This is the
    // channel that tells you you have left the carriageway without looking.
    this.rollFilter = ctx.createBiquadFilter();
    this.rollFilter.type = 'lowpass';
    this.rollFilter.frequency.value = 400;
    this.rollFilter.Q.value = 0.5;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    this.rollFilter.connect(this.rollGain).connect(bus);
    this.startNoise(audio, this.rollFilter);
  }

  private startNoise(audio: Audio, into: AudioNode): void {
    const src = audio.noiseSource();
    if (!src) return;
    src.connect(into);
    src.start();
  }

  /**
   * @param speed   forward speed, m/s (signed)
   * @param throttle −1..1
   * @param slip    highest fraction of grip in use across the four tyres
   * @param offroad true on pavement, plaza or car park
   * @param vMax    reference top speed
   */
  update(dt: number, speed: number, throttle: number, slip: number,
         offroad: boolean, vMax: number, active: boolean): void {
    if (!this.live) return;
    const t = this.ctx.currentTime;
    const v = Math.abs(speed);

    // --- fake gearbox, for the sound only ---
    this.shiftFor = Math.max(0, this.shiftFor - dt);
    const ratioRpm = (g: number) => IDLE_RPM + (v / vMax) * GEARS[g] * 2600;
    if (this.shiftFor <= 0) {
      if (this.gear < GEARS.length - 1 && ratioRpm(this.gear) > MAX_RPM * 0.92) {
        this.gear++; this.shiftFor = 0.22;
      } else if (this.gear > 0 && ratioRpm(this.gear) < IDLE_RPM + 900) {
        this.gear--; this.shiftFor = 0.16;
      }
    }
    // During a shift the revs fall away, which is what makes it read as a shift
    // rather than as a glitch.
    const targetRpm = clamp(ratioRpm(this.gear) * (this.shiftFor > 0 ? 0.72 : 1), IDLE_RPM, MAX_RPM);
    this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 9);

    // Four-stroke triple: 1.5 firing events per revolution.
    const fire = clamp((this.rpm / 60) * 1.5, 12, 260);

    const load = clamp(throttle, 0, 1);
    const revs = clamp((this.rpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM), 0, 1);

    for (let i = 0; i < this.oscs.length; i++) {
      const mult = (this.oscs[i] as OscillatorNode & { _mult?: number })._mult ?? 1;
      this.oscs[i].frequency.setTargetAtTime(fire * mult, t, 0.03);
      // The upper harmonics only come in with revs and load, so the engine gets
      // harder rather than just louder.
      const weight = i === 0 ? 1 - revs * 0.45
        : i === 1 ? 0.6 + revs * 0.4
        : 0.15 + revs * 0.75 * (0.4 + load * 0.6);
      const base = [0.55, 0.40, 0.18, 0.07][i];
      this.gains[i].gain.setTargetAtTime(base * weight, t, 0.05);
    }

    // Load opens the tone stack. Off the throttle it closes and the engine goes
    // behind you, which is the other half of what sells a lift.
    this.tone.frequency.setTargetAtTime(500 + revs * 2600 + load * 1500, t, 0.06);
    this.airFilter.frequency.setTargetAtTime(420 + revs * 1500, t, 0.06);
    this.airGain.gain.setTargetAtTime(active ? (0.04 + load * 0.16) * (0.3 + revs * 0.7) : 0, t, 0.08);

    const level = active ? 0.10 + revs * 0.16 + load * 0.05 : 0;
    this.out.gain.setTargetAtTime(level, t, 0.06);

    // --- tyres ---
    const scrub = clamp((slip - 0.72) / 0.5, 0, 1) * clamp(v / 12, 0, 1);
    this.tyreGain.gain.setTargetAtTime(active ? scrub * 0.20 : 0, t, 0.05);
    this.tyreFilter.frequency.setTargetAtTime(1500 + scrub * 1400, t, 0.06);

    const roll = clamp(v / vMax, 0, 1);
    this.rollGain.gain.setTargetAtTime(
      active ? roll * (offroad ? 0.30 : 0.10) : 0, t, 0.09);
    this.rollFilter.frequency.setTargetAtTime(
      (offroad ? 900 : 300) + roll * (offroad ? 1400 : 500), t, 0.09);
  }

  /** Drop everything to silence, for pause and menus. */
  silence(): void {
    if (!this.live) return;
    const t = this.ctx.currentTime;
    for (const g of [this.out, this.airGain, this.tyreGain, this.rollGain]) {
      g.gain.setTargetAtTime(0, t, 0.05);
    }
  }
}
