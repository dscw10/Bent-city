import type { Audio } from './audio';
import { clamp } from '../core/math';

/**
 * Adaptive music, synthesised in stems.
 *
 * Four layers of the same length and tempo — pulse, bass, pad, lead — faded in
 * and out on game state rather than sequenced as a fixed arrangement. It is
 * simple to build and reads as sophisticated, because the music appears to
 * respond to the player.
 *
 * Scheduling uses the standard Web Audio lookahead pattern: a timer wakes every
 * 25ms and schedules everything due in the next 120ms, against the audio clock
 * rather than the frame clock. Scheduling from requestAnimationFrame would put
 * the groove at the mercy of the frame rate, which on a phone in a corner is
 * exactly where it must not be.
 *
 * Key: A minor pentatonic, because every note in it works against every other
 * one and the layers can be mixed in any combination without ever clashing.
 */
const BPM = 104;
const STEP = 60 / BPM / 4;          // a sixteenth
const BAR = STEP * 16;
const LOOKAHEAD = 0.12;
const TICK_MS = 25;

/** A minor pentatonic, two octaves, as frequencies. */
const A = 110;
const SCALE = [1, 6 / 5, 4 / 3, 3 / 2, 9 / 5].flatMap(r => [A * r, A * 2 * r, A * 4 * r]);
const note = (i: number): number => SCALE[((i % SCALE.length) + SCALE.length) % SCALE.length];

const BASS_LINE = [0, 0, 3, 0, 6, 0, 3, 9];
const LEAD_LINE = [12, 15, 18, 15, 21, 18, 15, 12, 15, 18, 21, 18, 15, 12, 9, 12];

export interface MusicState {
  /** 0..1 how fast the truck is going. */
  speed: number;
  /** 0..1 how close the clock is to running out. */
  urgency: number;
  /** 0..1 combo depth. */
  intensity: number;
  /** Playing, as opposed to paused or on a menu. */
  active: boolean;
}

export class Music {
  private audio!: Audio;
  private ctx!: AudioContext;
  private bus!: GainNode;
  private layers!: Record<'pulse' | 'bass' | 'pad' | 'lead', GainNode>;
  private timer = 0;
  private nextStep = 0;
  private step = 0;
  private live = false;

  attach(audio: Audio): void {
    const ctx = audio.ctx;
    const bus = audio.bus('music');
    if (!ctx || !bus || this.live) return;
    this.audio = audio;
    this.ctx = ctx;
    this.bus = bus;
    this.live = true;

    const layer = (gain: number) => {
      const g = ctx.createGain();
      g.gain.value = gain;
      g.connect(bus);
      return g;
    };
    this.layers = { pulse: layer(0), bass: layer(0), pad: layer(0), lead: layer(0) };

    this.nextStep = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  /**
   * Mix the stems from game state. Everything is a target for setTargetAtTime,
   * so layers slide in over a bar or two rather than snapping — a layer that
   * appears instantly sounds like a bug, not like a cue.
   */
  setState(s: MusicState): void {
    if (!this.live) return;
    const t = this.ctx.currentTime;
    const on = s.active ? 1 : 0;

    // Pad is always there while playing: it is the floor the rest sits on.
    this.layers.pad.gain.setTargetAtTime(on * 0.16, t, 1.2);
    // Pulse comes in as you get moving.
    this.layers.pulse.gain.setTargetAtTime(on * clamp(s.speed * 1.6, 0, 1) * 0.22, t, 0.9);
    // Bass follows commitment: speed plus combo.
    this.layers.bass.gain.setTargetAtTime(
      on * clamp(s.speed * 0.7 + s.intensity * 0.6, 0, 1) * 0.20, t, 1.1);
    // The lead is the reward, and the panic: a deep combo or a dying clock.
    this.layers.lead.gain.setTargetAtTime(
      on * clamp(Math.max(s.intensity, s.urgency * 0.9), 0, 1) * 0.13, t, 1.4);

    // Urgency also pulls the whole thing up a touch in tempo-feel by opening the
    // pad, which is cheaper and less disorienting than actually changing tempo.
    this.bus.gain.setTargetAtTime(0.55 * (0.85 + s.urgency * 0.25), t, 1.5);
  }

  private schedule(): void {
    if (!this.live) return;
    const until = this.ctx.currentTime + LOOKAHEAD;
    while (this.nextStep < until) {
      this.playStep(this.step, this.nextStep);
      this.step = (this.step + 1) % 64;      // four bars
      this.nextStep += STEP;
    }
  }

  private playStep(step: number, when: number): void {
    const s16 = step % 16;

    // --- pulse: kick, snare, hats ---
    if (s16 === 0 || s16 === 6 || s16 === 10) this.kick(when);
    if (s16 === 4 || s16 === 12) this.snare(when);
    if (s16 % 2 === 0) this.hat(when, s16 % 4 === 0 ? 0.5 : 0.28);

    // --- bass: one note per eighth ---
    if (s16 % 2 === 0) {
      const idx = BASS_LINE[(s16 / 2) | 0] + (step >= 32 ? 3 : 0);
      this.pluck(note(idx) / 2, when, STEP * 1.8, this.layers.bass);
    }

    // --- pad: one chord per bar ---
    if (s16 === 0) {
      const root = step >= 32 ? 3 : 0;
      for (const off of [0, 2, 4]) this.pad(note(root + off), when, BAR);
    }

    // --- lead: a sixteenth arpeggio ---
    this.pluck(note(LEAD_LINE[s16]), when, STEP * 1.4, this.layers.lead, 'triangle');
  }

  // ---------- voices ----------

  private kick(when: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, when);
    osc.frequency.exponentialRampToValueAtTime(44, when + 0.11);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.9, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.20);
    osc.connect(g).connect(this.layers.pulse);
    osc.start(when);
    osc.stop(when + 0.25);
  }

  private snare(when: number): void {
    const src = this.audio.noiseSource();
    if (!src) return;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1700;
    bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.35, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
    src.connect(bp).connect(g).connect(this.layers.pulse);
    src.start(when);
    src.stop(when + 0.18);
  }

  private hat(when: number, level: number): void {
    const src = this.audio.noiseSource();
    if (!src) return;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.10 * level, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    src.connect(hp).connect(g).connect(this.layers.pulse);
    src.start(when);
    src.stop(when + 0.08);
  }

  private pluck(freq: number, when: number, dur: number, into: GainNode,
                type: OscillatorType = 'sawtooth'): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(6000, freq * 9), when);
    lp.frequency.exponentialRampToValueAtTime(Math.max(200, freq * 2), when + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.5, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(lp).connect(g).connect(into);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  private pad(freq: number, when: number, dur: number): void {
    // Two detuned triangles: the cheapest way to a pad that does not sound like
    // a single oscillator holding a note.
    for (const detune of [-7, 7]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.30, when + dur * 0.35);
      g.gain.linearRampToValueAtTime(0.0001, when + dur);
      osc.connect(g).connect(this.layers.pad);
      osc.start(when);
      osc.stop(when + dur + 0.05);
    }
  }
}
