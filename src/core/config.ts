/**
 * Projection tuning. These are Chris's playtested defaults (26 Aug) — they came
 * from driving the thing, not from theory, so treat them as the reference point
 * for any future change.
 *
 * Worth noting what the combination says: a tight fold (13) with a long
 * life-size street (70) and low buildings (0.31). The horizon is hard and close,
 * the street is generous, and almost nothing blocks the map.
 */
export interface BendParams {
  /** Distance ahead where the curl begins, at a standstill. Bigger = more street. */
  z0: number;
  /** Radius of the curl. Small = a tighter fold = more map, less street. */
  R: number;
  /** Map scale. 1.0 = life size; lower shrinks the world as it lifts. */
  kMin: number;
  /** Residual building height on the map. 0 = perfectly flat footprints. */
  flat: number;
  /** 0 = constant-radius arc (reads as a chamfer), 1 = fully progressive fold. */
  ease: number;
  /** 0 = linear map, 1 = strong vertical compression toward the top. */
  fall: number;
  /** Global building height scale. Lower reveals more map. */
  buildH: number;
  /** 0 = map turns with the car, 1 = world-locked so north stays north. */
  lock: number;
  /** How far speed pushes the bend start outward. 0 = static view. */
  push: number;
  /** Reference top speed the speed response is measured against. */
  vMax: number;
  /** Camera pulls back and up along one diagonal. */
  camDist: number;
}

export const DEFAULT_BEND: BendParams = {
  z0: 70,
  R: 13,
  kMin: 0.34,
  flat: 0.06,
  ease: 1.0,
  fall: 0.51,
  buildH: 0.31,
  lock: 0.1,
  push: 120,
  vMax: 55,
  camDist: 11
};

/** Live, mutable copy the sliders and the speed response write into. */
export const P: BendParams = { ...DEFAULT_BEND };

export function resetBend(): void {
  Object.assign(P, DEFAULT_BEND);
}
