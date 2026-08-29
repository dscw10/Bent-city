import type { Audio } from './audio';
import type { Rival } from '../world/rivals';
import type { Traffic } from '../world/traffic';
import { nearCopy, wrapDist } from '../core/place';
import { terrainAt } from '../core/terrain';
import { clamp } from '../core/math';

/**
 * Sound that belongs to places rather than to the player.
 *
 * Rivals get a panned engine drone, so you hear one coming across a junction
 * before the map has told you anything. Traffic gets a single hum whose level
 * follows how much of it is near you, rather than twenty-six individual voices —
 * that is a mix decision as much as a performance one: twenty-six panned engines
 * is mud, one hum is a busy street.
 *
 * EVERY POSITION HERE IS UNBENT WORLD SPACE, and expressed on the copy of the
 * city nearest the listener so the wrap does not throw a sound to the far side
 * of town. If a sound ever seems to come from where a bent building LOOKS like
 * it is, that is the bug.
 */
export class WorldSound {
  private audio!: Audio;
  private live = false;

  private rivalVoices: Array<{ panner: PannerNode; gain: GainNode; osc: OscillatorNode }> = [];
  private hum!: GainNode;
  private humFilter!: BiquadFilterNode;

  attach(audio: Audio): void {
    const ctx = audio.ctx;
    const bus = audio.bus('world');
    if (!ctx || !bus || this.live) return;
    this.audio = audio;
    this.live = true;

    this.humFilter = ctx.createBiquadFilter();
    this.humFilter.type = 'lowpass';
    this.humFilter.frequency.value = 520;
    this.hum = ctx.createGain();
    this.hum.gain.value = 0;
    this.humFilter.connect(this.hum).connect(bus);
    const src = audio.noiseSource();
    if (src) { src.connect(this.humFilter); src.start(); }
  }

  private ensureVoices(count: number): void {
    const ctx = this.audio.ctx!;
    const bus = this.audio.bus('world')!;
    while (this.rivalVoices.length < count) {
      const panner = this.audio.createPanner();
      if (!panner) return;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 78;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 340;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(lp).connect(gain).connect(panner).connect(bus);
      osc.start();
      this.rivalVoices.push({ panner, gain, osc });
    }
  }

  update(rivals: Rival[], traffic: Traffic | null, carX: number, carZ: number, active: boolean): void {
    if (!this.live) return;
    const ctx = this.audio.ctx!;
    const t = ctx.currentTime;

    this.ensureVoices(rivals.length);

    for (let i = 0; i < this.rivalVoices.length; i++) {
      const voice = this.rivalVoices[i];
      const r = rivals[i];
      if (!r || !active) {
        voice.gain.gain.setTargetAtTime(0, t, 0.15);
        continue;
      }
      const x = nearCopy(r.x, carX);
      const z = nearCopy(r.z, carZ);
      const y = terrainAt(r.x, r.z) + 0.6;

      if (voice.panner.positionX) {
        voice.panner.positionX.setTargetAtTime(x, t, 0.05);
        voice.panner.positionY.setTargetAtTime(y, t, 0.05);
        voice.panner.positionZ.setTargetAtTime(z, t, 0.05);
      } else {
        (voice.panner as unknown as { setPosition(x: number, y: number, z: number): void })
          .setPosition(x, y, z);
      }

      // A rival flat out is a rival worth hearing; one crawling is not.
      voice.osc.frequency.setTargetAtTime(66 + r.speed01 * 44, t, 0.12);
      voice.gain.gain.setTargetAtTime(0.10 + r.speed01 * 0.10, t, 0.12);
    }

    // City hum: count what is actually near, not what exists. Null on a road
    // with nothing else on it, and a mountain pass in silence is the point of
    // a mountain pass.
    let near = 0;
    for (const c of traffic?.cars ?? []) {
      if (wrapDist(c.x, c.z, carX, carZ) < 90) near++;
    }
    const density = clamp(near / 7, 0, 1);
    this.hum.gain.setTargetAtTime(active ? density * 0.055 : 0, t, 0.4);
    this.humFilter.frequency.setTargetAtTime(380 + density * 260, t, 0.4);
  }

  silence(): void {
    if (!this.live) return;
    const t = this.audio.ctx!.currentTime;
    this.hum.gain.setTargetAtTime(0, t, 0.1);
    for (const v of this.rivalVoices) v.gain.gain.setTargetAtTime(0, t, 0.1);
  }
}
