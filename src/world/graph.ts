import { GRID, PITCH, nodePos, wrap } from '../core/city-layout';

/**
 * ============================ routing ============================
 *
 * BFS on the intersection graph. Deliberately does NOT wrap: the route is only
 * ever computed and drawn inside the home tile, so it never crosses a seam and
 * never appears twice.
 *
 * That is a design decision, not a limitation. The repeated city is scenery; the
 * route is the one thing that tells you where you actually are. A route that
 * crossed seams would make the repetition ambiguous instead of ignorable.
 */
export type Node = [number, number];
export type Point = [number, number];

export const nodeKey = (i: number, j: number): number => i * GRID + j;

/** Key for the edge between two adjacent nodes, order-independent. */
export function edgeKey(a: Node, b: Node): string {
  const ka = nodeKey(a[0], a[1]), kb = nodeKey(b[0], b[1]);
  return ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`;
}

export function nearestNode(x: number, z: number): Node {
  return [
    Math.max(0, Math.min(GRID - 1, Math.round(wrap(x) / PITCH))),
    Math.max(0, Math.min(GRID - 1, Math.round(wrap(z) / PITCH)))
  ];
}

const STEPS: Node[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Shortest path from `from` to `to`, avoiding any edge in `closed`.
 *
 * Road closures are what give the plan region something to be USEFUL about: a
 * closure two blocks ahead is invisible from the street and obvious from above,
 * and it changes which way you should already be turning.
 *
 * Returns world-space points. Empty if no route exists (which the closure
 * generator is careful never to allow, but a caller should still handle).
 */
export function bfs(from: Node, to: Node, closed?: ReadonlySet<string>): Point[] {
  const prev = new Map<number, Node | null>();
  const queue: Node[] = [from];
  prev.set(nodeKey(from[0], from[1]), null);
  let found = from[0] === to[0] && from[1] === to[1];

  for (let head = 0; head < queue.length && !found; head++) {
    const [i, j] = queue[head];
    for (const [di, dj] of STEPS) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= GRID || nj >= GRID) continue;
      const k = nodeKey(ni, nj);
      if (prev.has(k)) continue;
      if (closed?.has(edgeKey([i, j], [ni, nj]))) continue;
      prev.set(k, [i, j]);
      if (ni === to[0] && nj === to[1]) { found = true; break; }
      queue.push([ni, nj]);
    }
  }

  if (!found) return [];

  const path: Point[] = [];
  let cur: Node | null | undefined = to;
  while (cur) {
    path.unshift([nodePos(cur[0]), nodePos(cur[1])]);
    cur = prev.get(nodeKey(cur[0], cur[1]));
  }
  return path;
}

/**
 * Path length in world units. Used to decide whether a rival will beat you to a
 * drop, which is the whole point of showing them on the map.
 */
export function pathLength(path: Point[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  }
  return total;
}

/** Manhattan distance in grid steps — cheap ordering heuristic. */
export const gridDistance = (a: Node, b: Node): number =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
