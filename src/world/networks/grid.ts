import { RoadNetwork } from '../network';
import type { RoadNode } from '../network';
import { GRID, TILE, nodePos } from '../../core/city-layout';

/**
 * The 9×9 city lattice, expressed as an ordinary road network.
 *
 * This is the whole point of the refactor: what used to be arithmetic scattered
 * through dispatch, rivals and routing is now just one generator among several.
 * Nothing downstream knows this network is a grid.
 */
export function buildGridNetwork(): RoadNetwork {
  const nodes: RoadNode[] = [];
  const index = (i: number, j: number) => i * GRID + j;

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      nodes.push({ x: nodePos(i), z: nodePos(j), links: [] });
    }
  }

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const here = index(i, j);
      // Links are added in one direction and mirrored, so the graph is always
      // symmetric — an asymmetric link is a one-way street nobody asked for.
      if (i + 1 < GRID) {
        const east = index(i + 1, j);
        nodes[here].links.push(east);
        nodes[east].links.push(here);
      }
      if (j + 1 < GRID) {
        const north = index(i, j + 1);
        nodes[here].links.push(north);
        nodes[north].links.push(here);
      }
    }
  }

  return new RoadNetwork(nodes, TILE);
}

/** Grid coordinates of a node index, for the scenery generator that still needs them. */
export const gridCoords = (node: number): [number, number] =>
  [Math.floor(node / GRID), node % GRID];
