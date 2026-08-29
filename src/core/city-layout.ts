/**
 * The city's dimensions. Everything about THE CITY — its geometry, its routing,
 * its collision, its traffic — reads these, so the grid can be resized in one
 * place.
 *
 * The city is one TILE, drawn 5×5 around the player. The player's position is
 * wrapped into the home tile every frame, so the surrounding copies never move:
 * no streaming, no pop-in, one shared geometry.
 *
 * Note what is NOT here any more: the wrap arithmetic itself. That moved to
 * `core/place.ts` when a second location arrived, because a mountain pass has
 * two ends and folding its coordinates would teleport you off the summit back
 * onto the start line at full speed.
 */
export const GRID = 9;                 // intersections per tile
export const PITCH = 58;               // distance between intersections
export const ROADW = 14;               // road width
export const BLOCK = PITCH - ROADW;    // the buildable square between roads
export const TILE = GRID * PITCH;      // 522 — the repeat distance
export const TILES_ACROSS = 5;         // how many copies are drawn per axis

/** World coordinate of intersection index i. */
export const nodePos = (i: number): number => i * PITCH;

/** Fold into the home tile. Local to the city, which always wraps. */
const cityWrap = (v: number): number => ((v % TILE) + TILE) % TILE;

/**
 * True if (x,z) is inside a block footprint rather than on the carriageway —
 * pavement, plaza or car park. All of it is drivable, but draggy and slippery,
 * so cutting a corner is a shortcut with a price.
 *
 * Worked out from grid arithmetic rather than a lookup, so it costs nothing and
 * survives the tile wrap automatically.
 */
export function onOffroad(x: number, z: number): boolean {
  const lx = cityWrap(x) % PITCH;
  const lz = cityWrap(z) % PITCH;
  return lx > ROADW / 2 && lx < PITCH - ROADW / 2 &&
         lz > ROADW / 2 && lz < PITCH - ROADW / 2;
}
