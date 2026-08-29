import { RoadNetwork } from '../network';
import type { RoadNode } from '../network';
import { PASS_LENGTH, spineX, spineSlope } from '../../core/pass-shape';

/**
 * The pass as a road network: one chain of nodes sampled off the analytic
 * centreline, start line to summit to finish.
 *
 * Note what this is NOT. On the city grid a node is a junction — a place where
 * a decision happens. Here there are no decisions, so the nodes are simply
 * where the road is, and the network is being used as a polyline. That is the
 * refactor paying off: routing, `nearest`, closures and the ribbon all work
 * unchanged on a graph with a degree of two, and none of them had to learn
 * about a second kind of place.
 *
 * SPACING is the one real choice. At 16 metres the chord across the tightest
 * corner (about a 60m radius) cuts roughly 0.4m inside the true curve, which is
 * within the width of the painted line. At the 40m that felt like plenty, it
 * was 2.4m and the route ribbon visibly cut the apex.
 */
export const PASS_SPACING = 16;

export function buildPassNetwork(): RoadNetwork {
  const nodes: RoadNode[] = [];
  const count = Math.round(PASS_LENGTH / PASS_SPACING) + 1;

  for (let i = 0; i < count; i++) {
    const z = (i / (count - 1)) * PASS_LENGTH;
    nodes.push({ x: spineX(z), z, links: [] });
  }
  for (let i = 0; i < count - 1; i++) {
    nodes[i].links.push(i + 1);
    nodes[i + 1].links.push(i);
  }

  // wrapSize 0: the pass has two ends. Fold it and driving off the summit puts
  // you back on the start line at ninety kilometres an hour.
  return new RoadNetwork(nodes, 0);
}

/** Where a run begins: on the line, pointing up the valley. */
export function passSpawn(): { x: number; z: number; heading: number } {
  const z = 30;
  return { x: spineX(z), z, heading: Math.atan2(spineSlope(z), 1) };
}
