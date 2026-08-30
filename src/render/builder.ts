import * as THREE from 'three';
import type { RGB } from '../core/palette';
import { C, shade } from '../core/palette';

/**
 * ============================ geometry builder ============================
 *
 * Everything that bends is baked into a few big buffers with vertex colours, so
 * the GPU only ever gets a handful of draw calls.
 *
 * TWO THINGS MATTER HERE, and both have bitten:
 *
 * 1. THE BEND HAPPENS PER-VERTEX. A long flat road with only four corners bends
 *    as a straight chord and looks broken. All geometry must be heavily
 *    subdivided — that is what the `su`/`sv` arguments are for.
 *
 * 2. EVERY VERTEX CARRIES AN ANCHOR: the x,z the shader samples terrain height
 *    at. Pass no anchor and each vertex uses its own position, so the surface
 *    DRAPES over the hills — what roads, pavements and lane markings want. Pass
 *    an anchor and every vertex lifts by the SAME amount, so the shape stays
 *    rigid and vertical — what buildings want, because they should stand up in
 *    the direction of gravity rather than lean with the hillside.
 */
export type V3 = [number, number, number];
export type V2 = [number, number];

export class Builder {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  a: number[] = [];

  /** Corners in order, subdivided su × sv so the bend stays smooth. */
  quad(a: V3, b: V3, c: V3, d: V3, su: number, sv: number, col: RGB, anc?: V2): void {
    const nx = (b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]);
    const ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]);
    const nz = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    const l = Math.hypot(nx, ny, nz) || 1;
    const N: V3 = [nx / l, ny / l, nz / l];

    const mix = (u: V3, v: V3, t: number): V3 =>
      [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t, u[2] + (v[2] - u[2]) * t];

    for (let i = 0; i < su; i++) {
      for (let j = 0; j < sv; j++) {
        const u0 = i / su, u1 = (i + 1) / su, v0 = j / sv, v1 = (j + 1) / sv;
        const pt = (u: number, v: number): V3 => mix(mix(a, b, u), mix(d, c, u), v);
        const q = [pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1)];
        this.tri(q[0], q[1], q[2], N, col, anc);
        this.tri(q[0], q[2], q[3], N, col, anc);
      }
    }
  }

  private tri(x: V3, y: V3, z: V3, N: V3, col: RGB, anc?: V2): void {
    this.p.push(...x, ...y, ...z);
    for (const v of [x, y, z]) {
      this.n.push(...N);
      this.c.push(...col);
      this.a.push(anc ? anc[0] : v[0], anc ? anc[1] : v[2]);
    }
  }

  /**
   * An upright box. One anchor for the whole thing, so it stays vertical on a
   * hillside rather than leaning with it.
   *
   * `baseY` is normally strongly negative — buildings are buried, because a
   * rigid flat base floats clear of the ground on the uphill side. The skirt has
   * to be generous, since uBuildH shrinks the skirt but never shrinks the terrain.
   */
  box(cx: number, cz: number, sx: number, sy: number, sz: number,
      col: RGB, roofCol?: RGB, segZ?: number, baseY = 0): void {
    const y0 = baseY, y1 = y0 + sy;
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    const A: V2 = [cx, cz];

    /* Subdivision along z is what the fold actually consumes. The fold spans
       R·π/2 ≈ 20 units at the default curl radius, so segments coarser than a
       few units across leave visible facets and spikes right on the horizon,
       which is the most looked-at line in the game. Dropping the pointless
       vertical subdivision below bought the budget to make this finer. */
    const sz_ = Math.min(12, segZ ?? Math.max(3, Math.round(sz / 5)));
    const sx_ = Math.min(10, Math.max(2, Math.round(sx / 8)));

    /* VERTICAL SUBDIVISION IS ALWAYS 1, and it is worth knowing why.
     *
     * Work through the bend for a fixed player-local z: the fold angle, the
     * local scale, the flatten ramp and the point on the folded curve are all
     * functions of z alone. Height then enters only as
     *     y_out = pos.y + h·cos φ      z_out = z0 + pos.x − h·sin φ
     * which is AFFINE in h. The map-lock twist is a rotation about Y, and its
     * blend ramp is on radial distance in xz — neither touches y either.
     *
     * So subdividing a box vertically produces vertices that land exactly where
     * the straight edge between the corners already goes. It was costing four
     * to nine times the geometry of a tall building for no visible difference
     * at all. Horizontal subdivision still matters: x and z do run through
     * non-linear terms.
     */
    const sy_ = 1;

    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], sx_, sy_, col, A);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], sx_, sy_, col, A);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], sz_, sy_, shade(col), A);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], sz_, sy_, shade(col), A);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], sx_, sz_, roofCol ?? C.roof, A);
  }

  /**
   * A box turned about its own vertical axis.
   *
   * The city stopped being a lattice, and a building on a street that runs at
   * 23 degrees has to sit on that street rather than square to the compass —
   * the alternative is a block of buildings that all miss their own pavement.
   * Same anchor rule as `box`: one anchor for the whole thing, so it stays
   * vertical on a hillside.
   */
  boxRot(cx: number, cz: number, across: number, sy: number, along: number, ang: number,
         col: RGB, roofCol?: RGB, segZ?: number, baseY = 0): void {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const y0 = baseY, y1 = y0 + sy;
    const A: V2 = [cx, cz];
    /* `ang` is a BEARING, the same convention as everything else in the game:
       heading a means travelling along (sin a, cos a). So the `along` extent
       runs that way and `across` runs to its right, and at a = 0 the two are
       exactly the sx and sz of `box`. See the note on slabRot for the version
       of this that was wrong for four months. */
    const p = (u: number, v: number, y: number): V3 =>
      [cx + u * ca + v * sa, y, cz - u * sa + v * ca];

    const sx = across, sz = along;
    const hx = sx / 2, hz = sz / 2;
    // Capped. The fold only ever needs a few segments across a building, and an
    // uncapped divisor turns one mistakenly huge box into a million triangles.
    const sx_ = Math.min(10, Math.max(2, Math.round(sx / 8)));
    const sz_ = Math.min(12, segZ ?? Math.max(3, Math.round(sz / 5)));
    // Vertical subdivision is always 1 — see the long note in `box` for why
    // that is provably free of effect under the bend.
    this.quad(p(-hx, hz, y0), p(hx, hz, y0), p(hx, hz, y1), p(-hx, hz, y1), sx_, 1, col, A);
    this.quad(p(hx, -hz, y0), p(-hx, -hz, y0), p(-hx, -hz, y1), p(hx, -hz, y1), sx_, 1, col, A);
    this.quad(p(hx, hz, y0), p(hx, -hz, y0), p(hx, -hz, y1), p(hx, hz, y1), sz_, 1, shade(col), A);
    this.quad(p(-hx, -hz, y0), p(-hx, hz, y0), p(-hx, hz, y1), p(-hx, -hz, y1), sz_, 1, shade(col), A);
    this.quad(p(-hx, hz, y1), p(hx, hz, y1), p(hx, -hz, y1), p(-hx, -hz, y1), sx_, sz_,
      roofCol ?? C.roof, A);
  }

  /**
   * A flat polygon, fanned from its first vertex and subdivided.
   *
   * The subdivision is not optional. The bend happens per vertex, so a block-
   * sized triangle drawn as three points folds as a chord and tears away from
   * the road beside it. A triangle is passed to `quad` with its last two
   * corners coincident, which subdivides it correctly and costs a strip of
   * degenerate triangles at the tip that nothing ever sees.
   */
  polyFlat(pts: V2[], y: number, col: RGB, seg = 5): void {
    for (let i = 1; i < pts.length - 1; i++) {
      const a: V3 = [pts[0][0], y, pts[0][1]];
      const b: V3 = [pts[i][0], y, pts[i][1]];
      const c: V3 = [pts[i + 1][0], y, pts[i + 1][1]];
      this.quad(a, b, c, c, seg, seg, col);
    }
  }

  /** A flat horizontal patch with NO anchor, so it drapes over the terrain. */
  slab(cx: number, cz: number, sx: number, sz: number, y: number, col: RGB, seg?: number): void {
    const s = seg ?? Math.max(2, Math.round(Math.max(sx, sz) / 5));
    this.quad(
      [cx - sx / 2, y, cz + sz / 2], [cx + sx / 2, y, cz + sz / 2],
      [cx + sx / 2, y, cz - sz / 2], [cx - sx / 2, y, cz - sz / 2],
      s, s, col
    );
  }

  /**
   * A flat patch rotated about Y. Used for turn arrows and angled markings.
   *
   * `ang` is a BEARING: the game's convention throughout is that heading a
   * means travelling along (sin a, cos a), and `sz` runs that way while `sx`
   * runs across it.
   *
   * THIS USED TO ROTATE THE WRONG WAY, and it is worth knowing why nobody
   * noticed. The old version mapped the sz axis to (−sin a, cos a) — the
   * heading REFLECTED in the z axis — which is identical for a = 0 and ±180,
   * and differs by exactly 180° at ±90. Every one of those is a right angle,
   * and while the city was a lattice every angle passed to this function was a
   * right angle. It only became visible when a mountain road started asking for
   * a corner board at 43 degrees, and then when the city's streets stopped
   * meeting at right angles too.
   */
  slabRot(cx: number, cz: number, sx: number, sz: number, y: number,
          ang: number, col: RGB, seg = 2): void {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const pt = (dx: number, dz: number): V3 =>
      [cx + dx * ca + dz * sa, y, cz - dx * sa + dz * ca];
    this.quad(pt(-sx / 2, sz / 2), pt(sx / 2, sz / 2), pt(sx / 2, -sz / 2), pt(-sx / 2, -sz / 2),
      seg, seg, col);
  }

  /** A flat ring on the ground, built from four bars. Survives the flatten. */
  ring(cx: number, cz: number, outer: number, thickness: number, y: number, col: RGB): void {
    const o = outer, t = thickness;
    this.slab(cx, cz + o / 2, o, t, y, col, 4);
    this.slab(cx, cz - o / 2, o, t, y, col, 4);
    this.slab(cx + o / 2, cz, t, o, y, col, 4);
    this.slab(cx - o / 2, cz, t, o, y, col, 4);
  }

  get vertexCount(): number { return this.p.length / 3; }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aAnchor', new THREE.Float32BufferAttribute(this.a, 2));
    return g;
  }
}
