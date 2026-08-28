import { describe, it, expect, beforeEach } from 'vitest';
import { Dispatch, CAPACITY } from '../src/game/dispatch';
import { Rivals } from '../src/world/rivals';
import { findMode, MODES } from '../src/game/modes';
import { bfs, edgeKey, nearestNode, unwrapPath, pathLength } from '../src/world/graph';
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

describe('routing', () => {
  it('finds a path and reports its length', () => {
    const path = bfs([0, 0], [3, 4]);
    expect(path.length).toBe(8);                       // 3 + 4 steps, plus the start
    expect(pathLength(path)).toBeCloseTo(7 * PITCH, 6);
  });

  it('routes around a closed edge instead of through it', () => {
    const closed = new Set([edgeKey([0, 0], [1, 0])]);
    const path = bfs([0, 0], [1, 0], closed);
    expect(path.length).toBeGreaterThan(2);            // forced the long way round
    expect(pathLength(path)).toBeCloseTo(3 * PITCH, 6);
  });

  it('returns nothing rather than a wrong path when the target is walled off', () => {
    const closed = new Set([
      edgeKey([0, 0], [1, 0]),
      edgeKey([0, 0], [0, 1])
    ]);
    expect(bfs([0, 0], [4, 4], closed)).toEqual([]);
  });

  it('unwraps a path sequentially so a long route cannot fold back on itself', () => {
    // A route longer than half a tile: unwrapping every point against a single
    // origin would fold the far end back, so this must be done step by step.
    const path = bfs([0, 0], [8, 0]);
    const out = unwrapPath(path, 0, 0);
    for (let i = 1; i < out.length; i++) {
      expect(Math.abs(out[i][0] - out[i - 1][0])).toBeLessThanOrEqual(PITCH + 1e-6);
    }
    expect(out[out.length - 1][0]).toBeCloseTo(8 * PITCH, 6);
  });

  it('snaps a position to the intersection nearest it', () => {
    expect(nearestNode(nodePos(3) + 4, nodePos(5) - 4)).toEqual([3, 5]);
  });
});

describe('dispatch', () => {
  let d: Dispatch;
  beforeEach(() => {
    d = new Dispatch();
    d.start(findMode('shift'));
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

    const b = d.bakeries[0];
    const ev = d.update(0.016, nodePos(b[0]), nodePos(b[1]));
    expect(ev.some(e => e.kind === 'restock')).toBe(true);
    expect(d.crates).toBe(CAPACITY);

    // Sitting on the bakery already full must not fire again.
    const again = d.update(0.016, nodePos(b[0]), nodePos(b[1]));
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

  it('leaves the graph fully connected after closing roads', () => {
    // An unreachable drop is not difficulty, it is unfairness.
    for (let attempt = 0; attempt < 25; attempt++) {
      const fresh = new Dispatch();
      fresh.start(findMode('rush'));
      for (let i = 0; i < GRID; i++) {
        for (let j = 0; j < GRID; j++) {
          expect(bfs([0, 0], [i, j], fresh.closedEdges).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('gives every closure a barrier to drive into', () => {
    d.start(findMode('rush'));
    expect(d.barriers.length).toBe(d.closures.length);
    for (const b of d.barriers) expect(b.w * b.d).toBeGreaterThan(0);
  });

  it('has no clock, no rivals and no expiry in free roam', () => {
    const roam = new Dispatch();
    roam.start(findMode('roam'));
    for (let i = 0; i < 200; i++) roam.update(1, nodePos(0), nodePos(0));
    expect(roam.closures.length).toBe(0);
    expect(roam.orders.length).toBeGreaterThan(0);
    for (const o of roam.orders) expect(o.life).toBe(0);
  });
});

describe('rivals', () => {
  it('converge on an order and take it', () => {
    const d = new Dispatch();
    d.start(findMode('shift'));
    while (d.orders.length === 0) d.update(1, nodePos(0), nodePos(0));

    const r = new Rivals();
    r.start(d, 2);

    let sniped: number[] = [];
    for (let i = 0; i < 4000 && sniped.length === 0; i++) {
      sniped = r.update(0.05);
      d.update(0.05, nodePos(0), nodePos(0));
    }
    expect(sniped.length).toBeGreaterThan(0);
  });

  it('stay inside the tile', () => {
    const d = new Dispatch();
    d.start(findMode('rush'));
    const r = new Rivals();
    r.start(d, 4);
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
    d.start(findMode('rush'));
    for (let i = 0; i < 40; i++) d.update(1, nodePos(0), nodePos(0));
    const r = new Rivals();
    r.start(d, 4);
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
