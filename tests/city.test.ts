import { describe, it, expect } from 'vitest';
import { cityPlan, ROAD_HALF } from '../src/world/networks/organic';
import { TILE } from '../src/core/city-layout';
import { inset, makePlot, simplify } from '../src/render/blocks';
import { PAD } from '../src/vehicle/collision';

/**
 * The city is generated now, not laid out, so the things that used to be true
 * by construction have to be checked. Two of these caught real defects: the
 * Euler count found a face walk that returned nothing, and the periodicity
 * check is the one that would notice a seam — which on a tile drawn 5×5 would
 * appear twenty-five times at once.
 */
const plan = cityPlan();
const net = plan.network;

describe('the city plan', () => {
  it('is one connected network with junctions a city would have', () => {
    expect(net.wrapSize).toBe(TILE);
    expect(net.connected()).toBe(true);
    expect(net.nodes.length).toBeGreaterThan(60);
    for (const n of net.nodes) {
      expect(n.links.length).toBeGreaterThanOrEqual(3);
      expect(n.links.length).toBeLessThanOrEqual(6);
    }
  });

  it('is planar and closes up on the torus', () => {
    /* V − E + F = 0 is the Euler characteristic of a torus, and it is the
       single most useful thing to assert about a generated street plan: it
       fails if the face walk misses a block, double-counts one, or wanders off
       through the seam. The first version of the walk returned zero faces and
       this is what said so. */
    let edges = 0;
    for (const n of net.nodes) edges += n.links.length;
    edges /= 2;
    expect(net.nodes.length - edges + plan.faces.length).toBe(0);
  });

  it('is not a grid', () => {
    // The whole point. On a lattice every road is one of two lengths and every
    // junction is a right angle; here neither is true.
    const lens: number[] = [];
    for (let i = 0; i < net.nodes.length; i++) {
      for (const j of net.nodes[i].links) if (j > i) lens.push(net.distance(i, j));
    }
    lens.sort((a, b) => a - b);
    expect(lens[lens.length - 1] / lens[0]).toBeGreaterThan(3);

    const areas = plan.faces.map(f => f.area).sort((a, b) => a - b);
    expect(areas[areas.length - 1] / areas[0]).toBeGreaterThan(2.5);

    // And the angles at a junction are spread rather than all square.
    let square = 0, total = 0;
    for (let i = 0; i < net.nodes.length; i++) {
      const a = net.nodes[i];
      const bearings = a.links.map(j => Math.atan2(
        net.delta(net.nodes[j].x, a.x), net.delta(net.nodes[j].z, a.z)));
      for (const b of bearings) {
        total++;
        const q = Math.abs(((b / (Math.PI / 2)) % 1 + 1) % 1 - 0.5);
        if (q > 0.47) square++;                 // within 3° of a right angle
      }
    }
    expect(square / total).toBeLessThan(0.12);
  });

  it('covers the whole tile with blocks, and only once', () => {
    const total = plan.faces.reduce((a, f) => a + f.area, 0);
    // Voronoi cells tile the plane exactly; the roads are drawn on top of them.
    expect(total).toBeGreaterThan(TILE * TILE * 0.95);
    expect(total).toBeLessThan(TILE * TILE * 1.05);
  });

  it('is exactly periodic, because a seam would appear twenty-five times', () => {
    for (let i = 0; i < 3000; i++) {
      const x = Math.random() * TILE, z = Math.random() * TILE;
      expect(plan.offroad(x, z)).toBe(plan.offroad(x + TILE, z - 2 * TILE));
      expect(plan.distanceToRoad(x, z)).toBeCloseTo(
        plan.distanceToRoad(x - 3 * TILE, z + TILE), 9);
    }
  });

  it('calls a junction the road and a block interior off it', () => {
    for (const n of net.nodes) {
      expect(plan.offroad(n.x, n.z)).toBe(false);
      expect(plan.distanceToRoad(n.x, n.z)).toBeLessThan(1e-6);
    }
    for (const f of plan.faces) {
      // The centre of a block is off the road by more than the pavement.
      expect(plan.distanceToRoad(f.centroid[0], f.centroid[1])).toBeGreaterThan(ROAD_HALF);
    }
  });

  it('gives every block room to build on, clear of the carriageway', () => {
    let built = 0;
    for (const f of plan.faces) {
      const plot = makePlot(inset(f.poly, ROAD_HALF + 2.5));
      if (!plot) continue;
      built++;
      /* Every corner of the building line has to be off the tarmac — with the
         truck's own radius to spare, or a building on a corner is something you
         hit while driving down the middle of the road. The first inset scaled
         toward the centroid instead of offsetting the edges, and put the corner
         buildings 4.7 metres from the centreline. */
      for (const [x, z] of plot.poly) {
        expect(plan.distanceToRoad(x, z)).toBeGreaterThan(ROAD_HALF + PAD * 0.5);
      }
    }
    expect(built).toBeGreaterThan(plan.faces.length * 0.9);
  });
});

describe('block outlines', () => {
  it('offsets every edge by the distance asked for', () => {
    // A square, inset by 5, is a smaller square 10 shorter on each side.
    const sq: Array<[number, number]> = [[0, 0], [20, 0], [20, 20], [0, 20]];
    const got = inset(sq, 5);
    expect(got.length).toBe(4);
    const xs = got.map(p => p[0]).sort((a, b) => a - b);
    const zs = got.map(p => p[1]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(5, 6);
    expect(xs[3]).toBeCloseTo(15, 6);
    expect(zs[0]).toBeCloseTo(5, 6);
    expect(zs[3]).toBeCloseTo(15, 6);
  });

  it('refuses to offset a polygon inside out', () => {
    expect(inset([[0, 0], [20, 0], [20, 20], [0, 20]], 40)).toEqual([]);
  });

  it('merges away a side too short to build on', () => {
    // A square with one corner chamfered by a two-metre facet.
    const poly: Array<[number, number]> = [[0, 0], [18, 0], [20, 2], [20, 20], [0, 20]];
    expect(simplify(poly, 11).length).toBe(4);
    expect(simplify(poly, 1).length).toBe(5);
  });

  it('takes its frame from the longest side, which is the street', () => {
    const plot = makePlot([[0, 0], [40, 0], [40, 12], [0, 12]])!;
    // The long side runs along +x, which is a bearing of 90 degrees.
    expect(Math.abs(Math.sin(plot.along))).toBeCloseTo(1, 6);
    expect(plot.hu).toBeCloseTo(20, 6);       // along the street
    expect(plot.hv).toBeCloseTo(6, 6);        // across it
  });
});
