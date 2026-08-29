/**
 * ============================ THE PLACE ============================
 *
 * The handful of facts about "wherever we currently are" that the LOW-LEVEL
 * systems need — physics, audio, the camera, the HUD's idea of distance.
 *
 * The road network already made the RULES place-agnostic. This does the same
 * for everything underneath them, and it exists because of two questions that
 * turn out to have different answers in a city and on a mountain pass:
 *
 *   - DOES THE WORLD WRAP? The city is one tile repeated forever, so distance
 *     is measured through the seam and the truck's position is folded back into
 *     the home tile every step. A pass has two ends. Fold a pass and driving
 *     off the summit puts you back at the start line travelling at 90km/h.
 *
 *   - WHAT COUNTS AS OFF THE ROAD? In the city it is grid arithmetic. On a pass
 *     it is distance from a winding centreline.
 *
 * A mutable singleton rather than a parameter threaded through every call
 * because `stepVehicle` runs three times a frame per vehicle and the answer is
 * the same for all of them. Levels set it once, in `use()`.
 */
import { TILE, onOffroad } from './city-layout';

export interface Place {
  /** Repeat distance of the world, or 0 for a place with edges. */
  wrapSize: number;
  /** True where the truck is off the carriageway: draggy, and slippery. */
  offroad(x: number, z: number): boolean;
}

/** The city is the default, so anything that never calls setPlace still works. */
export const PLACE: Place = { wrapSize: TILE, offroad: onOffroad };

export function setPlace(p: Place): void {
  PLACE.wrapSize = p.wrapSize;
  PLACE.offroad = p.offroad;
}

/** Fold a world coordinate into the home tile. A no-op where nothing wraps. */
export function wrap(v: number): number {
  const W = PLACE.wrapSize;
  if (W <= 0) return v;
  return ((v % W) + W) % W;
}

/**
 * Shortest signed difference between two world coordinates.
 *
 * In a wrapping world this has to go through the seam, or anything comparing
 * positions across it — a rival's distance to a drop, the HUD's range to the
 * next objective — reads as half a city away when it is in fact right there.
 * In a place with edges it is plain subtraction, and folding it would be the
 * bug rather than the fix.
 */
export function wrapDelta(a: number, b: number): number {
  const W = PLACE.wrapSize;
  if (W <= 0) return a - b;
  let d = (a - b) % W;
  if (d > W / 2) d -= W;
  if (d < -W / 2) d += W;
  return d;
}

/** Straight-line distance between two points, respecting whatever wrap exists. */
export function wrapDist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(wrapDelta(ax, bx), wrapDelta(az, bz));
}

/**
 * The copy of `v` nearest to `ref`, which may lie outside the home tile.
 *
 * Gameplay measures distance through the seam — an order 60m away across the
 * wrap really is 60m away. Markers therefore have to be DRAWN through the seam
 * too, on whichever copy of the world is nearest, or the HUD says 60m while the
 * beacon sits half a city away in the home tile.
 *
 * This does not contradict the rule that the route never wraps: the route is
 * still computed once, inside the home tile, and drawn once. It is only
 * positioned on the copy you are actually standing in. Terrain is periodic over
 * exactly one tile, so a marker moved by a whole tile lands at the same height.
 */
export const nearCopy = (v: number, ref: number): number => ref + wrapDelta(v, ref);
