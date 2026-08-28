import { TILE } from './city-layout';

/**
 * The world's height is a FUNCTION, not a heightmap. Geometry, the suspension
 * rays and the camera all read the same one, so they can never disagree.
 *
 * Three sine/cosine terms at integer multiples of 2π/TILE, so it is EXACTLY
 * periodic over one tile and the infinite wrap still works.
 *
 * CRITICAL: `terrainAt` here and `terrainAt` in the vertex shader must stay
 * identical. If they drift, the truck drives on a ghost surface — it is the
 * kind of bug that looks like a physics problem and isn't.
 */
export const TA = 5.5;   // hill amplitudes — must match TERRAIN_GLSL
export const TB = 3.0;
export const TC = 1.8;
export const TK = (2 * Math.PI) / TILE;   // periodic over one tile

export function terrainAt(x: number, z: number): number {
  return TA * Math.sin(TK * x) * Math.cos(TK * z)
       + TB * Math.sin(2 * TK * x + 1.7) * Math.sin(TK * z + 0.4)
       + TC * Math.cos(3 * TK * x) * Math.cos(2 * TK * z + 2.1);
}

/**
 * Gradient of the ground. Feeds the component of gravity that acts along the
 * hillside, which is what makes climbs cost speed and descents give it back.
 * Central differences over ±1m — cheap, and the terrain is smooth enough that
 * an analytic derivative buys nothing.
 */
export function slopeAt(x: number, z: number): [number, number] {
  return [
    (terrainAt(x + 1, z) - terrainAt(x - 1, z)) * 0.5,
    (terrainAt(x, z + 1) - terrainAt(x, z - 1)) * 0.5
  ];
}
