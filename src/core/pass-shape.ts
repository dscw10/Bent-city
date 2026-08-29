/**
 * ======================= THE KAIDŌ PASS =======================
 *
 * One road up a valley and back down the other side. Where the city is a
 * lattice you can cut across, this is a single line you cannot leave — which
 * is the whole reason it is worth building as a second place. It asks the
 * projection a different question.
 *
 * In the city the plan region is a MAP: it shows you a choice of routes and a
 * cluster of drops, and the game is deciding an order to serve them in. On a
 * pass there is no route to choose, so the map would be a stripe of nothing.
 * What lives up there instead is what the road is about to do — the rally
 * co-driver's job. See `game/pace-notes.ts`.
 *
 * THE SHAPE IS ANALYTIC, and that is not an implementation detail. The road
 * centreline is a sum of three sines in z, so:
 *
 *   - the terrain function can be written in closed form and matched EXACTLY by
 *     the vertex shader, which is the one hard requirement in this codebase
 *     (see the note in core/terrain.ts about ghost surfaces);
 *   - the road network is samples of that same curve, so junction positions
 *     and the valley floor can never disagree;
 *   - the pace notes are derived by differentiating it rather than by measuring
 *     geometry that might have drifted.
 *
 * WHY THE SWAY IS BOUNDED. `u` below is horizontal offset from the centreline,
 * corrected to a perpendicular distance by dividing through by √(1+S′²). That
 * is a first-order approximation and it degrades as the road turns away from
 * the z axis, so the amplitudes are chosen to keep |S′| under about 1.5 —
 * corners up to roughly 55° off the axis. Real hairpins would need the corridor
 * measured against the polyline instead, which the shader cannot do cheaply.
 * The tightest corner here still comes out at about a 60m radius, which at
 * cruising speed is a proper committed corner rather than a kink.
 */

/** How long the pass is, start line to finish, in metres along +Z. */
export const PASS_LENGTH = 5200;

/**
 * The three sway terms. Amplitude in metres, wavelength in metres.
 *
 * Deliberately not harmonics of one another: a road built from a fundamental
 * and its octaves has a rhythm you learn in one run, and a pass should still
 * be catching you out on the fifth.
 */
export const SWAY: ReadonlyArray<{ a: number; lambda: number; phase: number }> = [
  { a: 180, lambda: 1500, phase: 0.0 },
  { a: 34,  lambda: 460,  phase: 1.3 },
  { a: 7,   lambda: 180,  phase: 0.6 }
];

/** Summit height above the start, in metres. Reached halfway, back to 0 at the end. */
export const PASS_CLIMB = 90;

/** Half-width of the flat carriageway plus its verge. */
export const PASS_ROAD_HALF = 7.5;

/** How far out the valley wall takes to reach its full height. */
export const PASS_WALL_RAMP = 80;
/** How high the wall is at the top of that ramp. */
export const PASS_WALL_H = 60;
/** Slope of the mountainside beyond the wall, on up into the peaks. */
export const PASS_WALL_TAIL = 0.55;

/** Small undulation along the road itself, so the climb is not a ramp. */
export const PASS_RIPPLE_A = 2.4;
export const PASS_RIPPLE_K = 0.021;

/** Lateral position of the road's centreline at distance z along the pass. */
export function spineX(z: number): number {
  let x = 0;
  for (const t of SWAY) x += t.a * Math.sin((2 * Math.PI / t.lambda) * z + t.phase);
  return x;
}

/** dx/dz of the centreline — the road's angle away from the pass axis. */
export function spineSlope(z: number): number {
  let d = 0;
  for (const t of SWAY) {
    const k = 2 * Math.PI / t.lambda;
    d += t.a * k * Math.cos(k * z + t.phase);
  }
  return d;
}

/** d²x/dz² — curvature, near enough, and the raw material of a pace note. */
export function spineCurve(z: number): number {
  let d = 0;
  for (const t of SWAY) {
    const k = 2 * Math.PI / t.lambda;
    d -= t.a * k * k * Math.sin(k * z + t.phase);
  }
  return d;
}

/**
 * Perpendicular distance from the road's centreline, near enough.
 *
 * The exact answer needs the closest point on the curve, which is a root-find.
 * Dividing the horizontal offset by √(1+S′²) is the first-order version and
 * costs two multiplies — which matters, because the vertex shader calls this
 * for every vertex in the valley.
 */
export function offCentre(x: number, z: number): number {
  const s = spineSlope(z);
  return Math.abs(x - spineX(z)) / Math.sqrt(1 + s * s);
}

/** The valley floor's height along the road: a climb to the summit and back. */
export function passFloor(z: number): number {
  const t = Math.min(1, Math.max(0, z / PASS_LENGTH));
  return PASS_CLIMB * Math.sin(Math.PI * t) + PASS_RIPPLE_A * Math.sin(PASS_RIPPLE_K * z);
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
  return passFloor(z) + passWall(offCentre(x, z));
}

/** Off the carriageway: draggy and slippery, and on this road also uphill. */
export function passOffroad(x: number, z: number): boolean {
  return offCentre(x, z) > PASS_ROAD_HALF;
}

/**
 * GLSL twin of everything above. It MUST agree with the TypeScript to the last
 * term — a divergence here is the ghost-surface bug, where the geometry says
 * one height and the suspension says another, and it presents as a physics
 * problem rather than as a shader one.
 *
 * `uPassA`/`uPassB` carry the sway amplitudes and wavenumbers; `uPassC` carries
 * the phases, the climb and the length; `uPassD` the wall shape. Packed into
 * vectors rather than named individually so adding a term is a constant change
 * rather than three more uniforms.
 */
export const PASS_GLSL = /* glsl */ `
  float passSpine(float z){
    return uPassA.x*sin(uPassB.x*z + uPassC.x)
         + uPassA.y*sin(uPassB.y*z + uPassC.y)
         + uPassA.z*sin(uPassB.z*z + uPassC.z);
  }
  float passSlope(float z){
    return uPassA.x*uPassB.x*cos(uPassB.x*z + uPassC.x)
         + uPassA.y*uPassB.y*cos(uPassB.y*z + uPassC.y)
         + uPassA.z*uPassB.z*cos(uPassB.z*z + uPassC.z);
  }
  float passTerrain(vec2 p){
    float s = passSlope(p.y);
    float d = abs(p.x - passSpine(p.y)) / sqrt(1.0 + s*s);
    float t = clamp(p.y / uPassD.w, 0.0, 1.0);
    float floorY = uPassD.x * sin(3.14159265 * t) + uPassE.z * sin(uPassE.w * p.y);
    float w = clamp((d - uPassD.y) / uPassD.z, 0.0, 1.0);
    float over = max(d - uPassD.y - uPassD.z, 0.0);
    return floorY + uPassE.x * w * w + over * uPassE.y;
  }`;

/** The uniform payload, so the shader and the CPU are fed from one place. */
export function passUniformValues() {
  const k = (i: number) => (2 * Math.PI) / SWAY[i].lambda;
  return {
    A: [SWAY[0].a, SWAY[1].a, SWAY[2].a] as const,
    B: [k(0), k(1), k(2)] as const,
    C: [SWAY[0].phase, SWAY[1].phase, SWAY[2].phase] as const,
    D: [PASS_CLIMB, PASS_ROAD_HALF, PASS_WALL_RAMP, PASS_LENGTH] as const,
    E: [PASS_WALL_H, PASS_WALL_TAIL, PASS_RIPPLE_A, PASS_RIPPLE_K] as const
  };
}
