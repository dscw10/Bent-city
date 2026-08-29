import { RoadNetwork } from '../network';
import type { RoadNode } from '../network';
import { PASS_LENGTH, trackPoint } from '../../core/pass-shape';

/**
 * The pass as a road network: one chain of nodes sampled off the track, start
 * line to summit to finish.
 *
 * Note what this is NOT. On the city grid a node is a junction — a place where
 * a decision happens. Here there are no decisions, so the nodes are simply
 * where the road is, and the network is being used as a polyline. That is the
 * road-network refactor paying off: routing, `nearest`, closures and the ribbon
 * all work unchanged on a graph with a degree of two, and none of them had to
 * learn about a second kind of place.
 *
 * SPACING is the one real choice, and the hairpins set it. The chord across an
 * arc falls inside the true curve by r(1 − cos(θ/2)); at the tightest corner on
 * the pass — 24 metres — twelve-metre steps cut 0.75m inside, which is inside
 * the width of the painted line. At the 40m that felt like plenty it was 8
 * metres, and the ribbon would have cut clean across the apex.
 */
export const PASS_SPACING = 12;

export function buildPassNetwork(): RoadNetwork {
  const nodes: RoadNode[] = [];
  const count = Math.round(PASS_LENGTH / PASS_SPACING) + 1;

  for (let i = 0; i < count; i++) {
    const [x, z] = trackPoint((i / (count - 1)) * PASS_LENGTH);
    nodes.push({ x, z, links: [] });
  }
  for (let i = 0; i < count - 1; i++) {
    nodes[i].links.push(i + 1);
    nodes[i + 1].links.push(i);
  }

  // wrapSize 0: the pass has two ends. Fold it and driving off the summit puts
  // you back on the start line at ninety kilometres an hour.
  return new RoadNetwork(nodes, 0);
}

export { passSpawn } from '../../core/pass-shape';
