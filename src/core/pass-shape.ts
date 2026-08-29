/**
 * ======================= THE KAIDŌ PASS =======================
 *
 * One road up a valley and back down the other side. Where the city is a
 * lattice you can cut across, this is a single line you cannot leave — which
 * is the whole reason it is worth building as a second place. It asks the
 * projection a different question. See game/pass-run.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TRACK AND NOT A CURVE (30 Aug)
 *
 * The first version was `x = S(z)`, a sum of three sines. It gave a road that
 * wound convincingly, it was exact in closed form, and it could not make a
 * hairpin. That is not a tuning failure, it is arithmetic:
 *
 *   curvature of x = f(z) is  |S″| / (1 + S′²)^1.5
 *
 * At the apex of a turn S′ = 0, so the apex radius is just 1/S″. To swing the
 * road through ±71° (S′ = ±3) at a 30m apex radius you need S″ ≈ 0.033 held
 * over Δz = 6/0.033 = 180 metres — and at the ENDS of that swing, where
 * |S′| = 3, the same S″ gives a radius of 717m. So the tight bit is an instant
 * and the approach and exit are nearly straight. A hairpin is the opposite: a
 * SUSTAINED tight radius through 160°. The function form cannot express one at
 * any amplitude, so no amount of choosing sines was going to help.
 *
 * So the road is now what a road actually is: a sequence of straights and
 * constant-radius arcs. Distance from a point to it is the min over the pieces,
 * which is a handful of dot products each and exact — no small-angle
 * approximation, no bound on how far the road may turn, and hairpins for free.
 *
 * THE SHAPE IS STILL THE SINGLE SOURCE OF TRUTH. The terrain, the road network,
 * the pace notes and the off-road test are all derived from these pieces, so
 * they cannot disagree about where the road is. The pace notes get simpler
 * rather than harder: every arc IS a corner, with its radius already known,
 * instead of something to be found by differentiating a curve.
 */

/** 0 = straight, +1 = arc turning right, −1 = arc turning left. */
export type PieceKind = 0 | 1 | -1;

/** One piece of road, placed in the world. */
export interface Prim {
  kind: PieceKind;
  /** Straight: the start point. Arc: the centre. */
  ax: number;
  az: number;
  /** Straight: the end point. Arc: unused. */
  bx: number;
  bz: number;
  /** Arc radius. */
  r: number;
  /** Arc: the CCW-covered angular interval, for the containment test. */
  lo: number;
  span: number;
  /** Angle at the piece's start, and the signed sweep from it. */
  aStart: number;
  sweep: number;
  /** Distance along the whole road at this piece's start, and its own length. */
  s0: number;
  len: number;
  /** Bounding circle, so the min search can skip a piece it cannot win. */
  mx: number;
  mz: number;
  rad: number;
}

/**
 * The recipe: alternating runs and turns, in order. `a` is the turn in DEGREES,
 * positive right. Radii are in metres.
 *
 * Read it as a drive. It opens fast, tightens through the middle third where
 * the switchbacks are, and lets go again over the top. Four hairpins, at 24 to
 * 30 metres of radius — tight enough that the truck cannot take one without
 * either braking hard or drifting it, which is the point of having them.
 *
 * The one constraint worth knowing: consecutive hairpins alternate hand, so the
 * road works its way ACROSS the mountain rather than tying itself in a knot.
 */
type Step = { s: number } | { r: number; a: number };

const RECIPE: Step[] = [
  { s: 260 },
  { r: 130, a: 52 }, { s: 160 },
  { r: 95, a: -74 }, { s: 100 },
  { r: 46, a: 88 }, { s: 210 },
  { r: 160, a: -38 }, { s: 120 },

  /* SWITCHBACK ONE. Hairpins come in pairs, and both halves turn through very
     nearly 180° with a short run between them — which is not decoration.
     The first attempt used 158° and 135m, and the two legs converged at 22° for
     135 metres, which closed exactly the 51m the hairpin had opened: the road
     crossed itself, and where it did, the terrain has two roads at two heights
     fighting over the same ground. There is a test for it now. */
  { r: 26, a: 172 }, { s: 80 },
  { r: 27, a: -168 }, { s: 250 },

  { r: 72, a: 62 }, { s: 110 },
  { r: 39, a: -96 }, { s: 170 },
  { r: 185, a: 34 },
  { s: 330 },                        // the long one, over the shoulder

  { r: 30, a: -170 }, { s: 85 },     // switchback two
  { r: 28, a: 166 }, { s: 240 },

  { r: 56, a: 82 }, { s: 150 },
  { r: 88, a: -66 }, { s: 185 },

  { r: 24, a: 174 }, { s: 90 },      // switchback three — the tightest pair
  { r: 26, a: -170 }, { s: 230 },

  { r: 50, a: 92 }, { s: 160 },
  { r: 115, a: -46 }, { s: 140 },
  { r: 35, a: 104 }, { s: 265 },
  { r: 145, a: -48 }, { s: 200 }
];


const D2R = Math.PI / 180;
const TAU = Math.PI * 2;

/** Fold an angle into [0, 2π). */
const norm = (a: number): number => ((a % TAU) + TAU) % TAU;

function buildTrack(): Prim[] {
  const out: Prim[] = [];
  let x = 0, z = 0, head = 0, s = 0;

  for (const step of RECIPE) {
    if ('s' in step) {
      const bx = x + Math.sin(head) * step.s;
      const bz = z + Math.cos(head) * step.s;
      out.push(prim({
        kind: 0, ax: x, az: z, bx, bz, r: 0,
        aStart: 0, sweep: 0, s0: s, len: step.s
      }));
      x = bx; z = bz; s += step.s;
    } else {
      const turn = step.a * D2R;
      const sign = Math.sign(turn) as 1 | -1;
      /* The centre is one radius to the side the road is turning toward.
         Heading is measured from +Z toward +X, so "right" is heading + 90°. */
      const toC = head + sign * Math.PI / 2;
      const cx = x + Math.sin(toC) * step.r;
      const cz = z + Math.cos(toC) * step.r;
      // Angle of the START point as seen from the centre — the opposite way.
      const aStart = toC + Math.PI;
      /* Work the tangent out rather than guessing the sign. Position round the
         circle is C + R(sin a, cos a), so velocity is proportional to
         (cos a, −sin a) for increasing a — and at a = aStart = head − π/2 that
         is exactly (sin head, cos head), the direction of travel. So the swept
         angle runs the SAME way as the heading change.

         It was written as −turn first, and the failure is worth knowing because
         it is nearly invisible: every piece is individually correct, the road
         is still one connected curve, and the only symptom is that each arc
         leaves its entry point travelling backwards. The self-consistency
         checks all passed. What caught it was plotting the road and noticing
         it doubling back over a 185m-radius, 34° bend. */
      const sweep = turn;
      const len = step.r * Math.abs(turn);
      out.push(prim({
        kind: sign, ax: cx, az: cz, bx: 0, bz: 0, r: step.r,
        aStart, sweep, s0: s, len
      }));
      const aEnd = aStart + sweep;
      x = cx + Math.sin(aEnd) * step.r;
      z = cz + Math.cos(aEnd) * step.r;
      head += turn;
      s += len;
    }
  }
  return out;
}

/** Fill in the derived fields: the containment interval and the bounding circle. */
function prim(p: Omit<Prim, 'lo' | 'span' | 'mx' | 'mz' | 'rad'>): Prim {
  if (p.kind === 0) {
    return {
      ...p, lo: 0, span: 0,
      mx: (p.ax + p.bx) / 2, mz: (p.az + p.bz) / 2,
      rad: Math.hypot(p.bx - p.ax, p.bz - p.az) / 2
    };
  }
  const lo = norm(p.sweep > 0 ? p.aStart : p.aStart + p.sweep);
  const span = Math.abs(p.sweep);
  /* Bounding circle of an arc: the centre plus the radius is generous but
     always correct, and correctness is what the min search's early-out needs —
     a bound that is ever too small silently loses the nearest piece. */
  return { ...p, lo, span, mx: p.ax, mz: p.az, rad: p.r };
}

export const TRACK: Prim[] = buildTrack();

/** Total length of road, start line to finish, in metres. */
export const PASS_LENGTH: number = TRACK.reduce((a, p) => a + p.len, 0);

/** Half-width of the flat carriageway plus its verge. */
export const PASS_ROAD_HALF = 7.5;

/** How far out the valley wall takes to reach its full height. */
export const PASS_WALL_RAMP = 80;
/** How high the wall is at the top of that ramp. */
export const PASS_WALL_H = 60;
/** Slope of the mountainside beyond the wall, on up into the peaks. */
export const PASS_WALL_TAIL = 0.55;

/** Summit height above the start, in metres. Reached halfway. */
export const PASS_CLIMB = 105;
/** Small undulation along the road, so the climb is not a ramp. */
export const PASS_RIPPLE_A = 2.4;
export const PASS_RIPPLE_K = 0.021;

/**
 * Nearest point on the road: how far away it is, and how far along the road
 * that point is.
 *
 * A plain min over the pieces, with a cheap lower bound skipping any piece that
 * cannot beat the best so far. Exact, unbounded in how far the road may turn,
 * and — unlike the closed-form version this replaced — it does not care that
 * two legs of a hairpin pass within fifty metres of each other.
 */
export function trackNearest(x: number, z: number): { d: number; s: number } {
  let best = Infinity;
  let bestS = 0;

  for (const p of TRACK) {
    // Lower bound on the distance to anything in this piece.
    const bound = Math.hypot(x - p.mx, z - p.mz) - p.rad;
    if (bound >= best) continue;

    let d: number, t: number;
    if (p.kind === 0) {
      const dx = p.bx - p.ax, dz = p.bz - p.az;
      const u = Math.min(1, Math.max(0,
        ((x - p.ax) * dx + (z - p.az) * dz) / (dx * dx + dz * dz)));
      d = Math.hypot(x - (p.ax + dx * u), z - (p.az + dz * u));
      t = u * p.len;
    } else {
      const vx = x - p.ax, vz = z - p.az;
      const rr = Math.hypot(vx, vz);
      // Is the point inside the arc's angular wedge?
      const da = norm(Math.atan2(vx, vz) - p.lo);
      if (da <= p.span) {
        d = Math.abs(rr - p.r);
        const along = p.sweep > 0 ? da : p.span - da;
        t = along * p.r;
      } else {
        // Outside it: the nearest point is whichever end is closer.
        const e0 = p.aStart, e1 = p.aStart + p.sweep;
        const d0 = Math.hypot(x - (p.ax + Math.sin(e0) * p.r), z - (p.az + Math.cos(e0) * p.r));
        const d1 = Math.hypot(x - (p.ax + Math.sin(e1) * p.r), z - (p.az + Math.cos(e1) * p.r));
        d = Math.min(d0, d1);
        t = d0 <= d1 ? 0 : p.len;
      }
    }
    if (d < best) { best = d; bestS = p.s0 + t; }
  }
  return { d: best, s: bestS };
}

/** Perpendicular distance from the road's centreline. */
export const offCentre = (x: number, z: number): number => trackNearest(x, z).d;

/** Where the road is, and which way it points, at distance `s` along it. */
export function trackPoint(s: number): [number, number] {
  const p = pieceAt(s);
  const t = Math.min(p.len, Math.max(0, s - p.s0));
  if (p.kind === 0) {
    const u = p.len > 0 ? t / p.len : 0;
    return [p.ax + (p.bx - p.ax) * u, p.az + (p.bz - p.az) * u];
  }
  const a = p.aStart + p.sweep * (t / p.len);
  return [p.ax + Math.sin(a) * p.r, p.az + Math.cos(a) * p.r];
}

export function trackHeading(s: number): number {
  const p = pieceAt(s);
  if (p.kind === 0) return Math.atan2(p.bx - p.ax, p.bz - p.az);
  const t = Math.min(p.len, Math.max(0, s - p.s0));
  const a = p.aStart + p.sweep * (t / p.len);
  // Tangent to the circle, pointing the way the road runs.
  return a + (p.sweep > 0 ? Math.PI / 2 : -Math.PI / 2);
}

/** Signed curvature at `s`: 0 on a straight, ±1/r on an arc, + for a right. */
export function trackCurvature(s: number): number {
  const p = pieceAt(s);
  return p.kind === 0 ? 0 : p.kind / p.r;
}

/** Radius of the road at `s`. Infinity on a straight. */
export const trackRadius = (s: number): number => {
  const p = pieceAt(s);
  return p.kind === 0 ? Infinity : p.r;
};

export function pieceAt(s: number): Prim {
  const t = Math.min(PASS_LENGTH, Math.max(0, s));
  // Linear scan of thirty-odd pieces. Called a few thousand times a frame at
  // most, from the scenery builder and the notes; a binary search would be
  // measuring the wrong thing.
  for (let i = TRACK.length - 1; i >= 0; i--) if (t >= TRACK[i].s0) return TRACK[i];
  return TRACK[0];
}

/** The valley floor's height along the road: a climb to the summit and back. */
export function passFloor(s: number): number {
  const t = Math.min(1, Math.max(0, s / PASS_LENGTH));
  return PASS_CLIMB * Math.sin(Math.PI * t) + PASS_RIPPLE_A * Math.sin(PASS_RIPPLE_K * s);
}

/**
 * The valley wall as a function of distance from the road.
 *
 * Quadratic through the ramp, so the verge leaves the carriageway at zero
 * gradient — drive two metres wide and you are on grass, not on a kerb — and
 * steepens to about 1.5 (56°) by the top, which is steep enough that gravity
 * throws you back down it. Beyond the ramp it carries on at a gentler slope,
 * which is what turns a trench into a mountainside.
 */
export function passWall(d: number): number {
  const s = Math.min(1, Math.max(0, (d - PASS_ROAD_HALF) / PASS_WALL_RAMP));
  const over = Math.max(0, d - PASS_ROAD_HALF - PASS_WALL_RAMP);
  return PASS_WALL_H * s * s + over * PASS_WALL_TAIL;
}

export function passTerrainAt(x: number, z: number): number {
  const n = trackNearest(x, z);
  return passFloor(n.s) + passWall(n.d);
}

/** Off the carriageway: draggy and slippery, and on this road also uphill. */
export const passOffroad = (x: number, z: number): boolean =>
  trackNearest(x, z).d > PASS_ROAD_HALF;

/** Where a run begins: on the line, pointing up the valley. */
export function passSpawn(): { x: number; z: number; heading: number } {
  const [x, z] = trackPoint(24);
  return { x, z, heading: trackHeading(24) };
}

/**
 * GLSL twin of everything above. It MUST agree with the TypeScript to the last
 * term — a divergence here is the ghost-surface bug, where the geometry says
 * one height and the suspension says another, and it presents as a physics
 * problem rather than as a shader one.
 *
 * The track is uploaded as three vec4 per piece:
 *   p0 = (kind, ax, az, r)      kind 0 straight, ±1 arc
 *   p1 = (bx, bz, lo, span)
 *   p2 = (aStart, sweep, s0, len)
 * and the bounding circle is (ax, az, r) for an arc and the midpoint of the
 * segment for a straight, so p3 carries it rather than recomputing.
 *   p3 = (mx, mz, rad, 0)
 *
 * The loop is bounded by a compile-time constant, as GLSL ES 1.0 requires, and
 * pieces past the real count are marked unused by a negative bounding radius.
 */
export const PASS_PRIMS = 40;
export const PASS_STRIDE = 4;

export const PASS_GLSL = /* glsl */ `
  #define PASS_PRIMS ${PASS_PRIMS}
  #define PASS_TAU 6.28318530718

  float passNorm(float a){ return a - PASS_TAU * floor(a / PASS_TAU); }

  // Returns (distance to the road, distance along the road).
  vec2 trackNearest(vec2 p){
    float best = 1e9;
    float bestS = 0.0;
    for(int i = 0; i < PASS_PRIMS; i++){
      vec4 b = uTrack[i * 4 + 3];
      if(b.z < 0.0) continue;                       // unused slot
      float bound = length(p - b.xy) - b.z;
      if(bound >= best) continue;

      vec4 p0 = uTrack[i * 4];
      vec4 p1 = uTrack[i * 4 + 1];
      vec4 p2 = uTrack[i * 4 + 2];
      float d, t;

      if(p0.x == 0.0){
        vec2 a = p0.yz, e = p1.xy - a;
        float u = clamp(dot(p - a, e) / dot(e, e), 0.0, 1.0);
        d = length(p - (a + e * u));
        t = u * p2.w;
      } else {
        vec2 c = p0.yz;
        float r = p0.w;
        vec2 v = p - c;
        float rr = length(v);
        float da = passNorm(atan(v.x, v.y) - p1.z);
        if(da <= p1.w){
          d = abs(rr - r);
          float along = p2.y > 0.0 ? da : p1.w - da;
          t = along * r;
        } else {
          float e0 = p2.x, e1 = p2.x + p2.y;
          float d0 = length(p - (c + vec2(sin(e0), cos(e0)) * r));
          float d1 = length(p - (c + vec2(sin(e1), cos(e1)) * r));
          d = min(d0, d1);
          t = d0 <= d1 ? 0.0 : p2.w;
        }
      }
      if(d < best){ best = d; bestS = p2.z + t; }
    }
    return vec2(best, bestS);
  }

  float passTerrain(vec2 p){
    vec2 n = trackNearest(p);
    float t = clamp(n.y / uPassD.w, 0.0, 1.0);
    float floorY = uPassD.x * sin(3.14159265 * t) + uPassE.z * sin(uPassE.w * n.y);
    float w = clamp((n.x - uPassD.y) / uPassD.z, 0.0, 1.0);
    float over = max(n.x - uPassD.y - uPassD.z, 0.0);
    return floorY + uPassE.x * w * w + over * uPassE.y;
  }`;

/** The uniform payload, so the shader and the CPU are fed from one place. */
export function passUniformValues() {
  const track: number[][] = [];
  for (let i = 0; i < PASS_PRIMS; i++) {
    const p = TRACK[i];
    if (!p) {
      track.push([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, -1, 0]);
      continue;
    }
    track.push(
      [p.kind, p.ax, p.az, p.r],
      [p.bx, p.bz, p.lo, p.span],
      [p.aStart, p.sweep, p.s0, p.len],
      [p.mx, p.mz, p.rad, 0]
    );
  }
  return {
    D: [PASS_CLIMB, PASS_ROAD_HALF, PASS_WALL_RAMP, PASS_LENGTH] as const,
    E: [PASS_WALL_H, PASS_WALL_TAIL, PASS_RIPPLE_A, PASS_RIPPLE_K] as const,
    track
  };
}
