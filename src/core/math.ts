/** Small numeric helpers shared across the game. */

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** t³(6t²−15t+10) — curvature ramps in and out from zero, unlike smoothstep. */
export const smootherstep = (t: number): number =>
  t * t * t * (t * (t * 6 - 15) + 10);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Wrap an angle difference into (−π, π] so lags always take the short way round. */
export const shortAngle = (d: number): number => Math.atan2(Math.sin(d), Math.cos(d));

/**
 * Frame-rate independent exponential approach. `lag` is the time constant in
 * seconds — the time taken to close ~63% of the gap. Every smoothed value in
 * the game uses this rather than a raw per-frame fraction, so behaviour is
 * identical at 30fps and 144fps.
 */
export const approach = (current: number, target: number, dt: number, lag: number): number =>
  current + (target - current) * (1 - Math.exp(-dt / lag));

/** As `approach`, but takes the short way round a circle. */
export const approachAngle = (current: number, target: number, dt: number, lag: number): number =>
  current + shortAngle(target - current) * (1 - Math.exp(-dt / lag));

/** Deterministic LCG. Seeded so the city is the same city every time. */
export function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
