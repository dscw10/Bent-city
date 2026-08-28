/**
 * The city's dimensions. Everything — geometry, routing, collision, traffic and
 * the audio's idea of where things are — reads these, so the grid can be
 * resized in one place.
 *
 * The city is one TILE, drawn 5×5 around the player. The player's position is
 * wrapped into the home tile every frame, so the surrounding copies never move:
 * no streaming, no pop-in, one shared geometry.
 */
export const GRID = 9;                 // intersections per tile
export const PITCH = 58;               // distance between intersections
export const ROADW = 14;               // road width
export const BLOCK = PITCH - ROADW;    // the buildable square between roads
export const TILE = GRID * PITCH;      // 522 — the repeat distance
export const TILES_ACROSS = 5;         // how many copies are drawn per axis

/** World coordinate of intersection index i. */
export const nodePos = (i: number): number => i * PITCH;

/** Wrap a world coordinate into the home tile. */
export const wrap = (v: number): number => ((v % TILE) + TILE) % TILE;

/**
 * Shortest signed difference between two world coordinates, accounting for the
 * wrap. Without this, anything comparing positions across the tile seam — a
 * rival's distance to a drop, a traffic car's gap to the truck — reads as half
 * a city away when it is in fact right there.
 */
export function wrapDelta(a: number, b: number): number {
  let d = (a - b) % TILE;
  if (d > TILE / 2) d -= TILE;
  if (d < -TILE / 2) d += TILE;
  return d;
}

/** Straight-line distance between two points, respecting the wrap. */
export function wrapDist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(wrapDelta(ax, bx), wrapDelta(az, bz));
}

/**
 * True if (x,z) is inside a block footprint rather than on the carriageway —
 * pavement, plaza or car park. All of it is drivable, but draggy and slippery,
 * so cutting a corner is a shortcut with a price.
 *
 * Worked out from grid arithmetic rather than a lookup, so it costs nothing and
 * survives the tile wrap automatically.
 */
export function onOffroad(x: number, z: number): boolean {
  const lx = wrap(x) % PITCH;
  const lz = wrap(z) % PITCH;
  return lx > ROADW / 2 && lx < PITCH - ROADW / 2 &&
         lz > ROADW / 2 && lz < PITCH - ROADW / 2;
}
