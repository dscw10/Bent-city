import { RoadNetwork } from '../../src/world/network';
import type { RoadNode } from '../../src/world/network';
import { TILE } from '../../src/core/city-layout';

/**
 * A 9×9 lattice, as a TEST FIXTURE.
 *
 * This used to be the city. It is kept because it is an excellent thing to test
 * a road network against — every distance is exactly a multiple of the pitch,
 * so a routing assertion can be an equality rather than an approximation — and
 * because a graph whose shape you know by hand is worth having when the shipped
 * one is generated.
 *
 * It is not in `src/` any more, because nothing in the game builds on it. The
 * city is an organic Voronoi plan; see world/networks/organic.ts.
 */
export const GRID = 9;
export const PITCH = TILE / GRID;               // 58
export const ROADW = 14;
export const BLOCK = PITCH - ROADW;
export const nodePos = (i: number): number => i * PITCH;

const wrapT = (v: number): number => ((v % TILE) + TILE) % TILE;

/** The lattice's off-road test: inside a block footprint rather than on tarmac. */
export function onOffroad(x: number, z: number): boolean {
  const lx = wrapT(x) % PITCH;
  const lz = wrapT(z) % PITCH;
  return lx > ROADW / 2 && lx < PITCH - ROADW / 2 &&
         lz > ROADW / 2 && lz < PITCH - ROADW / 2;
}

export function buildGridNetwork(): RoadNetwork {
  const nodes: RoadNode[] = [];
  const index = (i: number, j: number) => i * GRID + j;

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) nodes.push({ x: nodePos(i), z: nodePos(j), links: [] });
  }
  /* Links stop at the edge rather than wrapping round. The world wraps — the
     network is told so — but the LATTICE does not join up, which is what makes
     it a good fixture: node 0 has two roads out of it, so closing both really
     does wall it off, and the long way round really is the long way round. */
  const link = (a: number, b: number) => { nodes[a].links.push(b); nodes[b].links.push(a); };
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      if (i + 1 < GRID) link(index(i, j), index(i + 1, j));
      if (j + 1 < GRID) link(index(i, j), index(i, j + 1));
    }
  }
  return new RoadNetwork(nodes, TILE);
}

export const gridCoords = (node: number): [number, number] =>
  [Math.floor(node / GRID), node % GRID];
