import type * as THREE from 'three';
import { RoadNetwork } from '../world/network';
import { buildGridNetwork } from '../world/networks/grid';
import { buildCity, buildRoadSurface } from '../render/city';
import type { CityData } from '../render/city';
import { onOffroad, nodePos, TILE } from '../core/city-layout';

/**
 * A place to drive, and the rules that place plays by.
 *
 * The city and a mountain pass have almost nothing in common as scenery, and
 * not much more as games — a pass has one road, so there is no route to choose
 * and the plan region's job changes completely. What they DO share is the road
 * network abstraction underneath, which is why that came first.
 *
 * Only the city exists so far. This interface is the shape the next one slots
 * into rather than a promise that it is written.
 */
export interface Level {
  id: string;
  name: string;
  /** Junctions and the roads between them. All routing goes through this. */
  network: RoadNetwork;
  /** Repeat distance, or 0 for a level that does not wrap. */
  wrapSize: number;
  /** True where the truck is off the carriageway: draggy, and slippery. */
  offroad(x: number, z: number): boolean;
  /** Where a run begins. */
  spawn: { x: number; z: number; heading: number };
  /** Build the scenery and return the collision footprints. */
  build(scene: THREE.Scene): CityData;
}

export function cityLevel(): Level {
  return {
    id: 'city',
    name: 'The city',
    network: buildGridNetwork(),
    wrapSize: TILE,
    offroad: onOffroad,
    spawn: { x: nodePos(4), z: nodePos(4), heading: 0 },
    build(scene) {
      const data = buildCity(scene);
      buildRoadSurface(scene);
      return data;
    }
  };
}

export const LEVELS: Array<() => Level> = [cityLevel];
