import { TILE } from './city-layout';
import { passTerrainAt } from './pass-shape';

/**
 * The world's height is a FUNCTION, not a heightmap. Geometry, the suspension
 * rays and the camera all read the same one, so they can never disagree.
 *
 * The CITY's is three sine/cosine terms at integer multiples of 2π/TILE, so it
 * is EXACTLY periodic over one tile and the infinite wrap still works. The
 * PASS's is a valley carved along an analytic centreline — see core/pass-shape.
 *
 * CRITICAL: `terrainAt` here and `terrainAt` in the vertex shader must stay
 * identical, in BOTH branches. If they drift, the truck drives on a ghost
 * surface — it is the kind of bug that looks like a physics problem and isn't.
 */
export const TA = 5.5;   // city hill amplitudes — must match TERRAIN_GLSL
export const TB = 3.0;
export const TC = 1.8;
export const TK = (2 * Math.PI) / TILE;   // periodic over one tile

export type TerrainKind = 'city' | 'pass';

/**
 * Which shape the world currently has. A mutable module-level switch rather
 * than an argument because `terrainAt` is called from the suspension inner
 * loop — four rays, three substeps, sixty times a second — and threading a
 * parameter through all of that to answer a question that is the same for
 * every caller in a frame buys nothing.
 */
export const TERRAIN: { kind: TerrainKind } = { kind: 'city' };

export function setTerrain(kind: TerrainKind): void {
  TERRAIN.kind = kind;
}

export function cityTerrainAt(x: number, z: number): number {
  return TA * Math.sin(TK * x) * Math.cos(TK * z)
       + TB * Math.sin(2 * TK * x + 1.7) * Math.sin(TK * z + 0.4)
       + TC * Math.cos(3 * TK * x) * Math.cos(2 * TK * z + 2.1);
}

export function terrainAt(x: number, z: number): number {
  return TERRAIN.kind === 'pass' ? passTerrainAt(x, z) : cityTerrainAt(x, z);
}

/**
 * Gradient of the ground. Feeds the component of gravity that acts along the
 * hillside, which is what makes climbs cost speed and descents give it back.
 * Central differences over ±1m — cheap, and both terrains are smooth enough
 * that an analytic derivative buys nothing.
 *
 * On the pass this is also what stops you driving up the valley wall: at the
 * top of the ramp the gradient is about 1.5, so gravity's along-slope
 * component is 15 m/s², comfortably more than the tyres can put down.
 */
export function slopeAt(x: number, z: number): [number, number] {
  return [
    (terrainAt(x + 1, z) - terrainAt(x - 1, z)) * 0.5,
    (terrainAt(x, z + 1) - terrainAt(x, z - 1)) * 0.5
  ];
}
