import type * as THREE from 'three';

/**
 * What a level hands back after it has built itself.
 *
 * This used to be `CityData`, and it used to describe a tiled city specifically
 * — twenty-five copies of one mesh at known multiples of TILE. A mountain pass
 * is one long strip cut into segments, which is a different arrangement of the
 * same idea: some meshes, each covering a known rectangle of the world, that
 * can be switched off when that rectangle cannot be on screen.
 *
 * So the shared type is a CHUNK with a bounding rectangle, and the culler stops
 * needing to know how the level laid itself out.
 */

/** A collision footprint, axis-aligned, in world coordinates. */
export interface Block { x: number; z: number; w: number; d: number }

/** One drawn piece of static scenery and the ground it covers. */
export interface Chunk {
  mesh: THREE.Mesh;
  /** World-space bounds of everything in it, generous enough to cover skirts. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /**
   * Never cull this one. For meshes authored in PLAYER-LOCAL space — the city's
   * ground field — which have no fixed world bounds because they travel with
   * the truck.
   */
  everywhere?: boolean;
}

export interface Scenery {
  /** Everything the truck can hit. */
  blocks: Block[];
  /** Everything drawn, in cullable pieces. */
  chunks: Chunk[];
  /** Free-form extras a level's own code may want back. The city keeps its
   *  block archetypes here for the dev overlay; the pass has nothing to add. */
  meta?: Record<string, unknown>;
}
