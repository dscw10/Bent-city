import type * as THREE from 'three';
import type { RoadNetwork } from '../world/network';
import { buildGridNetwork } from '../world/networks/grid';
import { buildPassNetwork, passSpawn } from '../world/networks/pass';
import { buildCity, buildRoadSurface } from '../render/city';
import { buildPass } from '../render/pass-scenery';
import type { Scenery } from '../render/scenery';
import { onOffroad, nodePos, TILE } from '../core/city-layout';
import { passOffroad } from '../core/pass-shape';
import { setPlace } from '../core/place';
import { setTerrain } from '../core/terrain';
import type { TerrainKind } from '../core/terrain';
import { uniforms } from '../render/uniforms';
import { DeliveryRules } from './delivery';
import { PassRules } from './pass-run';
import type { Rules, RulesContext } from './rules';

/**
 * A place to drive, and the rules that place plays by.
 *
 * The city and the mountain pass have almost nothing in common as scenery, and
 * not much more as games — a pass has one road, so there is no route to choose
 * and the plan region's job changes completely. What they DO share is the road
 * network abstraction underneath, which is why that came first.
 *
 * `use()` is the one method that is easy to get wrong. It sets FOUR things that
 * must always move together: the CPU terrain function, the shader's copy of it,
 * the wrap, and the off-road test. Miss the shader half and the truck drives on
 * a ghost surface; miss the wrap and driving off the summit puts you back on
 * the start line at ninety kilometres an hour. Both have happened.
 */
export interface Level {
  id: string;
  name: string;
  /** One line for the place picker. */
  blurb: string;
  /** Junctions and the roads between them. All routing goes through this. */
  network: RoadNetwork;
  /** Repeat distance, or 0 for a level that does not wrap. */
  wrapSize: number;
  /** True where the truck is off the carriageway: draggy, and slippery. */
  offroad(x: number, z: number): boolean;
  /** Where a run begins. */
  spawn: { x: number; z: number; heading: number };
  /** Make the world be this place. Call before building or spawning. */
  use(): void;
  /** Build the scenery and return the collision footprints. */
  build(scene: THREE.Scene): Scenery;
  /** The game this place plays. */
  makeRules(ctx: RulesContext): Rules;
}

function applyTerrain(kind: TerrainKind): void {
  setTerrain(kind);
  uniforms.uTerrMode.value = kind === 'pass' ? 1 : 0;
}

export function cityLevel(): Level {
  const network = buildGridNetwork();
  return {
    id: 'city',
    name: 'The city',
    blurb: 'A lattice you can cut across, four drops live at once and two rivals working the same streets.',
    network,
    wrapSize: TILE,
    offroad: onOffroad,
    spawn: { x: nodePos(4), z: nodePos(4), heading: 0 },
    use() {
      applyTerrain('city');
      setPlace({ wrapSize: TILE, offroad: onOffroad });
    },
    build(scene) {
      const data = buildCity(scene);
      data.chunks.push(buildRoadSurface(scene));
      return data;
    },
    makeRules: ctx => new DeliveryRules(ctx)
  };
}

export function passLevel(): Level {
  const network = buildPassNetwork();
  return {
    id: 'pass',
    name: 'Kaidō pass',
    blurb: 'Five kilometres of one road, up and over. No route to choose — the map becomes a co-driver instead.',
    network,
    wrapSize: 0,
    offroad: passOffroad,
    spawn: passSpawn(),
    use() {
      applyTerrain('pass');
      setPlace({ wrapSize: 0, offroad: passOffroad });
    },
    build: buildPass,
    makeRules: ctx => new PassRules(ctx)
  };
}

export const LEVELS: Record<string, () => Level> = {
  city: cityLevel,
  pass: passLevel
};

export const LEVEL_ORDER = ['city', 'pass'] as const;
