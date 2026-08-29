import { describe, it, expect, beforeEach } from 'vitest';
import { Dispatch, CAPACITY } from '../src/game/dispatch';
import { Rivals } from '../src/world/rivals';
import { findMode, MODES } from '../src/game/modes';
import { RoadNetwork, edgeKey } from '../src/world/network';
import { buildGridNetwork } from '../src/world/networks/grid';
import { GRID, TILE, nodePos, wrapDelta, wrapDist, nearCopy, onOffroad, PITCH, ROADW } from '../src/core/city-layout';
import { terrainAt } from '../src/core/terrain';

/**
 * The game rules run headlessly, which is how the physics bugs in this project
 * were found in the first place — printing state over time beats driving it and
 * guessing. Everything here is pure logic; nothing touches three.js or the DOM.
 */

describe('tile wrapping', () => {
  it('measures distance through the seam, not around it', () => {
    // Two points 20 apart across the wrap, not TILE-20 apart.
    expect(wrapDist(TILE - 10, 0, 10, 0)).toBeCloseTo(20, 6);
    expect(wrapDelta(10, TILE - 10)).toBeCloseTo(20, 6);
  });

  it('places a marker on the copy nearest the player', () => {
    // Standing just inside the tile, an object just inside the far edge should
    // be drawn just BEHIND you, at a negative coordinate — not a tile away.
    expect(nearCopy(TILE - 10, 10)).toBeCloseTo(-10, 6);
  });

  it('never disagrees with itself about height across the seam', () => {
    // Terrain is exactly periodic over one tile, which is what lets a marker
    // move by a whole tile without sinking into the ground.
    for (const [x, z] of [[0, 0], [123, 456], [7, 500], [261, 261]]) {
      expect(terrainAt(x + TILE, z)).toBeCloseTo(terrainAt(x, z), 6);
      expect(terrainAt(x, z + TILE)).toBeCloseTo(terrainAt(x, z), 6);
    }
  });
});

describe('surfaces', () => {
  it('calls the carriageway on-road and block interiors off-road', () => {
    expect(onOffroad(nodePos(2), nodePos(3))).toBe(false);          // an intersection
    expect(onOffroad(nodePos(2), nodePos(3) + PITCH / 2)).toBe(false); // mid-road
    expect(onOffroad(nodePos(2) + PITCH / 2, nodePos(3) + PITCH / 2)).toBe(true); // block centre
  });

  it('treats the kerb edge consistently either side of the wrap', () => {
    const inside = ROADW / 2 + 1;
    expect(onOffroad(inside, inside)).toBe(true);
    expect(onOffroad(inside + TILE, inside)).toBe(true);
  });
});

describe('the road network', () => {
  const net = buildGridNetwork();
  const at = (i: number, j: number) => net.nearest(nodePos(i), nodePos(j));

  it('links every junction to its neighbours, symmetrically', () => {
    expect(net.nodes.length).toBe(GRID * GRID);
    for (let i = 0; i < net.nodes.length; i++) {
      for (const j of net.nodes[i].links) {
        expect(net.nodes[j].links).toContain(i);   // never a one-way street
      }
    }
  });

  it('finds a route and reports its length in metres', () => {
    const route = net.path(at(0, 0), at(3, 4));
    expect(route.length).toBe(8);                  // 3 + 4 steps, plus the start
    expect(net.length(route)).toBeCloseTo(7 * PITCH, 6);
  });

  it('routes by real distance, not by hop count', () => {
    /* The whole reason this is Dijkstra rather than BFS. On a lattice the two
       agree; on a pass, where one link can be ten times another, hop-counting
       sends you the scenic way round. */
    const nodes = [
      { x: 0, z: 0, links: [1, 2] },        // 0 -> 1 is one enormous hop
      { x: 900, z: 0, links: [0, 3] },
      { x: 0, z: 10, links: [0, 3] },       // 0 -> 2 -> 3 is two short ones
      { x: 10, z: 10, links: [2, 1] }
    ];
    const pass = new RoadNetwork(nodes, 0);
    expect(pass.path(0, 3)).toEqual([0, 2, 3]);
  });

  it('routes around a closed segment instead of through it', () => {
    const closed = new Set([edgeKey(at(0, 0), at(1, 0))]);
    const route = net.path(at(0, 0), at(1, 0), closed);
    expect(route.length).toBeGreaterThan(2);       // forced the long way round
    expect(net.length(route)).toBeCloseTo(3 * PITCH, 6);
  });

  it('returns nothing rather than a wrong route when the target is walled off', () => {
    const closed = new Set([
      edgeKey(at(0, 0), at(1, 0)),
      edgeKey(at(0, 0), at(0, 1))
    ]);
    expect(net.path(at(0, 0), at(4, 4), closed)).toEqual([]);
    expect(net.connected(closed)).toBe(false);
  });

  it('unwraps a route sequentially so a long one cannot fold back on itself', () => {
    // Longer than half a tile: unwrapping every point against a single origin
    // would fold the far end back.
    const points = net.points(net.path(at(0, 0), at(8, 0)));
    const out = net.unwrap(points, 0, 0);
    for (let i = 1; i < out.length; i++) {
      expect(Math.abs(out[i][0] - out[i - 1][0])).toBeLessThanOrEqual(PITCH + 1e-6);
    }
    expect(out[out.length - 1][0]).toBeCloseTo(8 * PITCH, 6);
  });

  it('leaves a non-wrapping network alone when unwrapping', () => {
    const pass = new RoadNetwork([{ x: 0, z: 0, links: [] }], 0);
    const pts: Array<[number, number]> = [[0, 0], [500, 0]];
    expect(pass.unwrap(pts, 0, 0)).toEqual(pts);
  });

  it('snaps a position to the junction nearest it', () => {
    expect(net.nearest(nodePos(3) + 4, nodePos(5) - 4)).toBe(at(3, 5));
  });

  it('finds a nearest junction from anywhere, even far off the network', () => {
    for (const [x, z] of [[-4000, -4000], [1e5, 0], [261, 261], [0, 0]]) {
      const i = net.nearest(x, z);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(net.nodes.length);
    }
  });
});

describe('dispatch', () => {
  const net = buildGridNetwork();
  const home = { x: nodePos(4), z: nodePos(4) };
  let d: Dispatch;
  beforeEach(() => {
    d = new Dispatch();
    d.start(findMode('shift'), net, home.x, home.z);
  });

  it('starts loaded and empties one crate per delivery', () => {
    expect(d.crates).toBe(CAPACITY);
    // Force an order into existence, then drive onto it.
    while (d.orders.length === 0) d.update(1, 0, 0);
    const o = d.orders[0];
    const events = d.update(0.016, o.x, o.z);
    expect(events.some(e => e.kind === 'delivered')).toBe(true);
    expect(d.crates).toBe(CAPACITY - 1);
  });

  it('refills at a bakery, and only when it needs to', () => {
    while (d.orders.length === 0) d.update(1, 0, 0);
    const o = d.orders[0];
    d.update(0.016, o.x, o.z);
    expect(d.crates).toBe(CAPACITY - 1);

    const [bx, bz] = d.bakeryPosition(d.bakeries[0]);
    const ev = d.update(0.016, bx, bz);
    expect(ev.some(e => e.kind === 'restock')).toBe(true);
    expect(d.crates).toBe(CAPACITY);

    // Sitting on the bakery already full must not fire again.
    const again = d.update(0.016, bx, bz);
    expect(again.some(e => e.kind === 'restock')).toBe(false);
  });

  it('expires orders once their clock runs out', () => {
    while (d.orders.length === 0) d.update(1, 500, 500);
    const o = d.orders[0];
    let expired = false;
    for (let i = 0; i < 400 && !expired; i++) {
      // Park far away from everything so nothing is delivered by accident.
      expired = d.update(0.5, nodePos(0), nodePos(0)).some(
        e => e.kind === 'expired' && e.order.id === o.id);
    }
    expect(expired).toBe(true);
  });

  it('never spawns an order on top of the truck', () => {
    // Drops must be far enough away that the plan region has to earn its place.
    for (let i = 0; i < 200; i++) d.update(1, nodePos(4), nodePos(4));
    for (const o of d.orders) {
      expect(wrapDist(o.x, o.z, nodePos(4), nodePos(4))).toBeGreaterThan(PITCH * 2);
    }
  });

  it('respects the order limit for its mode', () => {
    const mode = findMode('shift');
    for (let i = 0; i < 400; i++) d.update(0.5, nodePos(0), nodePos(0));
    expect(d.orders.length).toBeLessThanOrEqual(mode.maxOrders);
  });

  it('leaves the network fully connected after closing roads', () => {
    // An unreachable drop is not difficulty, it is unfairness.
    for (let attempt = 0; attempt < 25; attempt++) {
      const fresh = new Dispatch();
      fresh.start(findMode('rush'), net, home.x, home.z);
      expect(net.connected(fresh.closedEdges)).toBe(true);
    }
  });

  it('gives every closure a barrier to drive into', () => {
    d.start(findMode('rush'), net, home.x, home.z);
    expect(d.barriers.length).toBe(d.closures.length);
    for (const b of d.barriers) expect(b.w * b.d).toBeGreaterThan(0);
  });

  it('has no clock, no rivals and no expiry in free roam', () => {
    const roam = new Dispatch();
    roam.start(findMode('roam'), net, home.x, home.z);
    for (let i = 0; i < 200; i++) roam.update(1, nodePos(0), nodePos(0));
    expect(roam.closures.length).toBe(0);
    expect(roam.orders.length).toBeGreaterThan(0);
    for (const o of roam.orders) expect(o.life).toBe(0);
  });
});

describe('rivals', () => {
  const net = buildGridNetwork();
  it('converge on an order and take it', () => {
    const d = new Dispatch();
    d.start(findMode('shift'), net, nodePos(0), nodePos(0));
    while (d.orders.length === 0) d.update(1, nodePos(0), nodePos(0));

    const r = new Rivals();
    r.start(d, net, 2);

    let sniped: number[] = [];
    for (let i = 0; i < 4000 && sniped.length === 0; i++) {
      sniped = r.update(0.05);
      d.update(0.05, nodePos(0), nodePos(0));
    }
    expect(sniped.length).toBeGreaterThan(0);
  });

  it('stay inside the tile', () => {
    const d = new Dispatch();
    d.start(findMode('rush'), net, nodePos(4), nodePos(4));
    const r = new Rivals();
    r.start(d, net, 4);
    for (let i = 0; i < 1500; i++) {
      r.update(0.05);
      d.update(0.05, nodePos(4), nodePos(4));
      for (const rv of r.list) {
        expect(rv.x).toBeGreaterThanOrEqual(0);
        expect(rv.x).toBeLessThan(TILE);
        expect(rv.z).toBeGreaterThanOrEqual(0);
        expect(rv.z).toBeLessThan(TILE);
        expect(Number.isFinite(rv.heading)).toBe(true);
      }
    }
  });

  it('never double-book two rivals onto one order', () => {
    const d = new Dispatch();
    d.start(findMode('rush'), net, nodePos(0), nodePos(0));
    for (let i = 0; i < 40; i++) d.update(1, nodePos(0), nodePos(0));
    const r = new Rivals();
    r.start(d, net, 4);
    for (let i = 0; i < 600; i++) {
      r.update(0.05);
      d.update(0.05, nodePos(0), nodePos(0));
      const claims = r.list.map(x => x.targetId).filter(id => id >= 0);
      expect(new Set(claims).size).toBe(claims.length);
    }
  });
});

describe('modes', () => {
  it('has unique ids and a sandbox with no clock', () => {
    expect(new Set(MODES.map(m => m.id)).size).toBe(MODES.length);
    expect(findMode('roam').duration).toBe(0);
    expect(findMode('roam').rivals).toBe(0);
  });

  it('falls back to the first mode for an unknown id', () => {
    expect(findMode('nonsense')).toBe(MODES[0]);
  });
});
