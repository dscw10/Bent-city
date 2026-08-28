/**
 * ============================ THE AUDIO SPINE ============================
 *
 * The Web Audio API is a full DSP graph, not a play-a-sound function. It is the
 * same class of tool as an engine's audio layer, which is why staying in the
 * browser costs nothing here.
 *
 *     engine bus  ─┐
 *     world bus   ─┼─→ master → compressor → limiter → out
 *     music bus   ─┤
 *     UI bus      ─┘
 *
 * Separate buses because that is what lets music duck under a delivery chime,
 * or the engine drop away for a moment, without touching anything else.
 *
 * ONE THING SPECIFIC TO THIS PROJECT: positional audio must use the UNBENT
 * world coordinates. Same principle as the physics — the bend is a rendering
 * transform and nothing else may see it. If a sound ever appears to come from
 * where a bent building LOOKS like it is, that is the bug.
 *
 * Nothing here loads a file. Every sound in the game is synthesised, which
 * keeps the whole thing one small download and means it works offline.
 */
export type BusName = 'engine' | 'world' | 'music' | 'ui';

export class Audio {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private buses = new Map<BusName, GainNode>();
  private duckAmount = 0;
  private noise!: AudioBuffer;
  private started = false;
  private volume = 0.75;
  private muted = false;

  /**
   * Must be called from a user gesture. Browsers will not start an AudioContext
   * without one, and a context created too early sits suspended forever with no
   * error to see.
   */
  start(): void {
    if (this.started) return;
    const Ctor = window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;              // no Web Audio: the game plays fine silent

    this.started = true;
    const ctx = new Ctor();
    this.ctx = ctx;

    // Limiter first in construction order, last in signal order.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.08;
    limiter.connect(ctx.destination);

    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -18;
    glue.knee.value = 12;
    glue.ratio.value = 3;
    glue.attack.value = 0.01;
    glue.release.value = 0.22;
    glue.connect(limiter);

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(glue);

    for (const name of ['engine', 'world', 'music', 'ui'] as BusName[]) {
      const g = ctx.createGain();
      g.gain.value = name === 'music' ? 0.55 : 1;
      g.connect(this.master);
      this.buses.set(name, g);
    }

    this.noise = makeNoiseBuffer(ctx);

    // The listener is the truck, in unbent world space.
    if (ctx.listener.upX) {
      ctx.listener.upX.value = 0;
      ctx.listener.upY.value = 1;
      ctx.listener.upZ.value = 0;
    }
  }

  /** Browsers suspend the context when a tab is hidden or on the first tap. */
  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend();
  }

  get ready(): boolean { return this.ctx !== null; }
  get now(): number { return this.ctx?.currentTime ?? 0; }

  bus(name: BusName): GainNode | null { return this.buses.get(name) ?? null; }

  setVolume(v: number): void {
    this.volume = v;
    this.applyMaster();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyMaster();
  }

  private applyMaster(): void {
    if (!this.ctx) return;
    const target = this.muted ? 0 : this.volume * (1 - this.duckAmount * 0.65);
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
  }

  /**
   * Pull the music (and only the music) down for a moment, so a chime lands in
   * a hole rather than fighting a pad.
   */
  duckMusic(seconds = 0.7, depth = 0.72): void {
    const music = this.buses.get('music');
    if (!this.ctx || !music) return;
    const t = this.ctx.currentTime;
    music.gain.cancelScheduledValues(t);
    music.gain.setValueAtTime(music.gain.value, t);
    music.gain.linearRampToValueAtTime(0.55 * (1 - depth), t + 0.04);
    music.gain.linearRampToValueAtTime(0.55, t + seconds);
  }

  /** A looping white-noise source. The one primitive everything gritty is built from. */
  noiseSource(): AudioBufferSourceNode | null {
    if (!this.ctx) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    return src;
  }

  /**
   * Position the listener at the truck. Web Audio's forward vector points along
   * −Z by convention while the game's heading points along +Z, hence the sign.
   */
  setListener(x: number, y: number, z: number, heading: number): void {
    const l = this.ctx?.listener;
    if (!l) return;
    const fx = -Math.sin(heading), fz = -Math.cos(heading);
    if (l.positionX) {
      const t = this.now;
      l.positionX.setTargetAtTime(x, t, 0.02);
      l.positionY.setTargetAtTime(y, t, 0.02);
      l.positionZ.setTargetAtTime(z, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02);
      l.forwardY.setTargetAtTime(0, t, 0.02);
      l.forwardZ.setTargetAtTime(fz, t, 0.02);
    } else {
      // Safari still wants the deprecated calls.
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(x, y, z);
      legacy.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  /** A panner set up for city distances. */
  createPanner(): PannerNode | null {
    if (!this.ctx) return null;
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 12;
    p.maxDistance = 220;
    p.rolloffFactor = 1.1;
    return p;
  }
}

/** Two seconds of white noise, generated once and shared. */
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}
