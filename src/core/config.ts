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
  /**
   * Reference top speed, m/s. Not decoration: the steering falloff, the
   * speed-reactive bend and the engine audio are all measured against it, so it
   * has to track what the truck can actually do.
   */
  vMax: number;
  /** Camera pulls back and up along one diagonal. */
  camDist: number;
  /**
   * How far ABOVE the road the camera aims, in metres. This is the control the
   * projection was missing, and it is the one that decides how much of the
   * frame the map gets.
   *
   * The map region is a plane standing at the end of the fold. How much of it
   * you can see is simply how much of it falls inside the camera's vertical
   * field of view — so a fold that is far away (the Fold preset's z0 of 70,
   * pushing to 190) puts the map's bottom edge at about 1° above the lens and
   * it fills the upper half of the screen, while a fold brought in close puts
   * that same edge 18° up, where it is squeezed into a sliver at the very top.
   *
   * Bringing the fold closer therefore does NOT give you more map, which is the
   * opposite of what everyone assumes. Aiming the camera up does.
   */
  camAim: number;
  /**
   * How far round the world folds, in DEGREES.
   *
   * 90 is the original behaviour: the ground rotates until it is vertical and
   * then continues as a flat plane, which reads as a map panel above a street.
   * Past 90 the surface keeps curving over toward you, so there is no vertical
   * plane and no horizon line — just one continuous curve from under the wheels
   * to overhead. That is the difference between a FOLD and a CYLINDER.
   */
  foldAngle: number;
}

/** Radians, for the shader and the CPU integration. */
export const foldRadians = (p: BendParams): number => p.foldAngle * Math.PI / 180;

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
  vMax: 32,
  camDist: 11,
  camAim: 0,
  foldAngle: 90
};

/**
 * Named starting points, because ten sliders is a lot to move on a touchscreen
 * and the two projections are genuinely different things rather than two ends
 * of one scale.
 */
export interface Preset {
  id: string;
  name: string;
  blurb: string;
  values: BendParams;
}

export const PRESETS: Preset[] = [
  {
    id: 'fold',
    name: 'Fold',
    blurb: 'A long life-size street, then a hard horizon and a flat map above it. Playtested defaults.',
    values: { ...DEFAULT_BEND }
  },
  {
    id: 'cylinder',
    name: 'Cylinder',
    blurb: 'One constant-radius curve starting almost under the wheels, with the camera looking up into it. No hard horizon, and the map is most of the frame rather than a strip you can ignore.',
    values: {
      /* These numbers are not guesses. The frame is 58° tall, the truck sits
         about 23° below the optical axis, and the map is a plane whose bottom
         edge has to land a few degrees ABOVE it for the map to fill the upper
         part of the screen without pushing the truck out of shot. This set puts
         the map's bottom edge at 3.5° and gives it 44% of the frame, against
         the Fold preset's 40%. */
      z0: 60,
      R: 30,           // one wide constant-radius arc rather than a tight fold
      kMin: 0.30,
      flat: 0.05,
      ease: 0,         // constant curvature: the "one big curve", no easing
      fall: 0.55,
      buildH: 0.26,
      lock: 0.10,
      /* The important one. At the Fold preset's push of 120 the life-size
         street grows to 190 units at speed — three blocks of perspective — and
         with a turn arrow painted at the next junction there is simply nothing
         left for the map to tell you. Zero keeps the street the same length
         however fast you go, so the map stays the only source of anything
         beyond the next corner. */
      push: 0,
      vMax: 32,
      camDist: 12,
      camAim: 4,
      foldAngle: 90
    }
  }
];

/** Live, mutable copy the sliders and the speed response write into. */
export const P: BendParams = { ...DEFAULT_BEND };

export function resetBend(): void {
  Object.assign(P, DEFAULT_BEND);
}
