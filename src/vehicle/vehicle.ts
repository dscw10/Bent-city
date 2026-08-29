import { P } from '../core/config';
import { terrainAt, slopeAt } from '../core/terrain';
import { wrap, onOffroad, nodePos } from '../core/city-layout';
import { clamp, lerp, shortAngle } from '../core/math';

/**
 * ============================ vehicle ============================
 *
 * Raycast suspension. Four springs, each finding the ground independently,
 * carrying a share of the truck's weight. The body rides on them, so PITCH AND
 * ROLL ARE RESULTS, NOT ANIMATIONS — and because each tyre's grip limit is
 * proportional to the load its own spring is carrying, weight transfer feeds
 * straight back into handling. Brake hard and the front bites; get on the power
 * and the unloaded rear lets go.
 *
 * This is the same model GTA V uses. It is not simulation; it is one ray per
 * wheel into a spring, with very carefully tuned parameters.
 *
 * FOUR BUGS WORTH REMEMBERING, each found by running this headlessly in Node
 * and printing state over time rather than by driving it and guessing:
 *
 * 1. Off-road drag was ~3× too high, capping the truck at walking pace on any
 *    pavement. Resistance is a constant part plus a small speed-dependent part,
 *    with aerodynamic drag on the body separately.
 * 2. No weight transfer at all. Tyre forces act at the contact patch, which is
 *    comH BELOW the centre of mass, so each one twists the body. Without that
 *    term the loads never changed and the suspension was decorative.
 * 3. The anti-roll bar CREATED force instead of transferring it. When the inside
 *    wheel lifted, its partner got a huge one-sided shove and the truck launched
 *    itself off the road.
 * 4. Grip exceeded the rollover threshold, so the truck two-wheeled in EVERY
 *    corner. Correct physics, terrible vehicle.
 *
 * RULE THAT CAME OUT OF #4: `mu` must stay comfortably below track/(2·comH).
 * For this kei truck that threshold is 1.40/(2×0.42) = 1.67g, and mu is 1.42.
 * A deliberately slim margin: it leans about 7° in hard cornering and lifts an
 * inside wheel at full lock, which is correct for the vehicle and reads well.
 */
export const V = {
  mass: 900, halfTrack: 0.70, axleF: 1.10, axleR: -1.10,
  comH: 0.42, attachDrop: 0.05,
  wheelR: 0.28, susRest: 0.34,
  springK: 17000, damper: 1950, arb: 2000, arbMax: 2500,
  Ipitch: 470, Iroll: 210,
  drive: 16500, brake: 15000,

  /* ---- steering feel ----
   *
   * This is where the game stops pretending to be a simulation, deliberately.
   *
   * The road wheels used to snap to the commanded angle in a single step, so a
   * flick of a stick or a tap of a key WAS full lock, instantly. No steering
   * rack in the world does that, and nothing that does can feel anything but
   * nervous. The wheels now turn at a finite rate — and come back to centre
   * faster than they go out, which is what makes the truck settle after a
   * corner instead of hunting.
   *
   * `maxSteer` came down from 0.66 rad (38°, more lock than a road car has) and
   * the speed falloff went up, so a twitch at 50 m/s is no longer the same
   * input as a twitch in a car park.
   */
  maxSteer: 0.55,
  /** How much of the lock is taken away at vMax. */
  steerFalloff: 0.60,
  /** Returning to centre is always quicker than turning in. */
  steerReturnBoost: 1.7,
  /**
   * Reverse. Deliberately weak and speed-limited: a kei truck reverses like a
   * kei truck, and a fast reverse turns every mistake into a rewind rather than
   * a consequence.
   */
  reverse: 0.30, reverseMax: 11,
  /** Below this wheel speed the truck counts as stopped, and can change gear. */
  stopped: 0.6,
  /**
   * Front cornering stiffness deliberately HIGHER than rear. Understeer means
   * the front saturates before the rear, so the fix is at the front — not more
   * grip everywhere.
   */
  cornerF: 10.0, cornerR: 9.0, mu: 1.42,
  /**
   * Arcade grip assist, as a VELOCITY REDIRECTION rate per second. The first
   * attempt added free yaw torque into corners and the truck simply spun,
   * ending corners travelling backwards. Rotating the velocity vector a little
   * way toward where the nose already points instead makes the truck follow its
   * nose and recover from slides, while the tyres keep behaving consistently.
   * Nothing about the forces is faked.
   *
   * LOWER assist = more sliding and more skill required. This is the difficulty dial.
   */
  assist: 2.4,

  /* ---- drift and boost ----
   *
   * Drift is not a special case bolted onto the physics: it is three of the
   * existing numbers, moved. Holding it takes grip and cornering stiffness off
   * the REAR axle only, and turns most of the assist off — so the back steps
   * out and stops being caught for you. Everything downstream (weight transfer,
   * the friction circle, the tyre audio) then behaves as it always did.
   *
   * Boost is the one honest exception. It is a body force along the truck's
   * axis rather than a force at the contact patches, because a boost that went
   * through the friction circle would do almost nothing in exactly the corner
   * you just earned it in. Same category of arcade device as `assist`, and
   * marked as such rather than dressed up. */
  driftGrip: 0.74,        // rear mu once locked into a drift
  driftCorner: 0.58,      // rear cornering stiffness once locked
  driftAssist: 0.22,      // how much of the assist survives a drift

  /* ---- entering a drift: the hop ----
   *
   * Pressing drift makes the truck hop. That is not decoration: the wheels
   * genuinely leave the ground, so the suspension unloads, the tyres lose their
   * grip for a moment and the truck comes down already rotating. The suspension
   * model gives all of that for free from one vertical impulse — nothing about
   * the hop is special-cased.
   *
   * The direction you are steering AS IT LANDS is the direction the drift locks
   * into, which is what makes entry a deliberate flick rather than a button you
   * hold hopefully. */
  hopSpeed: 1.7,
  /** Below this you cannot start a drift; a hop from walking pace is not a drift. */
  driftMinSpeed: 7,

  /* ---- holding a drift: counter-steer ----
   *
   * Once locked, the truck keeps rotating on its own. Steering INTO the slide
   * deepens it, steering AGAINST it — counter-steering — is what holds the
   * angle. Do nothing and the slip keeps growing until you spin out and lose
   * the charge, so a drift is something you fly rather than something you hold.
   */
  counterAuthority: 6.5,
  /** Assist multiplier while steering further into the slide. */
  driftInto: 0.35,
  /** Slip angle at which the drift is lost and the charge with it. */
  driftSpin: 1.20,
  /** Charge builds fastest at this slip angle, and falls off either side. */
  driftSweet: 0.55,
  driftSweetWidth: 0.45,
  /**
   * Yaw torque pushing the slide FURTHER out, all the time the drift is locked.
   *
   * This is what makes counter-steer necessary rather than optional. Without
   * it, cutting the rear grip is not enough to sustain a slide on its own — the
   * truck simply tracked straight and a drift was something you had to keep
   * provoking. With it, doing nothing walks you into a spin, and holding the
   * angle is an active job.
   */
  driftYaw: 2600,
  /**
   * Body slip angle, in radians, above which a drift counts as a drift.
   *
   * Set above the wander that full throttle alone produces. Holding the button
   * flat out down a straight does eventually get squirrely — that is honest
   * power oversteer with the rear grip cut — but it takes seconds, scrubs speed
   * and charges far slower than simply taking the corner you were going to take
   * anyway. So it is never worth farming.
   */
  driftSlip: 0.20,
  /** Full charge takes this many seconds of genuinely sideways drifting. */
  driftChargeTime: 1.9,
  /** A drift shorter than this earns nothing, so a stab of the button is not a boost. */
  driftMinCharge: 0.22,
  boostForce: 11000,
  /** Seconds of boost from a full charge. */
  boostTime: 1.7,
  /** Boost fades out as speed approaches this multiple of vMax. */
  boostCeiling: 1.25,

  rollC: 45, rollV: 5, aero: 0.62,
  /** Yaw is hard-limited so the truck can never spin like a top. */
  maxYawRate: 2.6
} as const;

/**
 * The parts of the handling a player is allowed to move at runtime.
 *
 * Steering feel is personal and depends on the input device — a thumb on glass,
 * an analogue stick and a keyboard all want different numbers — so it is a
 * setting rather than a constant, in the same spirit as the bend sliders.
 * 0 is calm and deliberate; 1 is roughly the old instant-response steering.
 */
export const TUNE = { steerSpeed: 0.28 };

/**
 * The two ends of that one dial. Everything about how eager the truck feels
 * moves together, because three sliders for "steering feel" is three ways to
 * make it worse and one player who never touches any of them.
 *
 * Rate limiting the road wheels turned out to be the SMALLER half of the
 * problem, which was worth finding out by measuring rather than assuming: it
 * moved turn-in from 0.050s to 0.083s and left peak yaw untouched at 1.14 rad/s
 * — 65°/s, almost immediately, which is what actually reads as nervous. What
 * governs that is how eagerly the BODY rotates, so yaw inertia and yaw damping
 * are on the same dial and doing most of the work.
 */
const FEEL = {
  /** Steering rate limit, rad/s. */
  rate: [2.2, 7.0],
  /** Yaw inertia. Higher = longer to start AND to stop rotating. */
  inertia: [1050, 560],
  /** Yaw damping per second. Higher = less overshoot, less hunting. */
  damp: [2.1, 0.6]
} as const;

const feel = (pair: readonly [number, number]) =>
  lerp(pair[0], pair[1], TUNE.steerSpeed);

/** [sideways offset (+ is left), forward offset, front?, rear?] */
export const WHEELS = [
  { s:  V.halfTrack, f: V.axleF, front: true,  rear: false },
  { s: -V.halfTrack, f: V.axleF, front: true,  rear: false },
  { s:  V.halfTrack, f: V.axleR, front: false, rear: true  },
  { s: -V.halfTrack, f: V.axleR, front: false, rear: true  }
] as const;

export interface Car {
  x: number; z: number; y: number; a: number;
  vx: number; vy: number; vz: number;
  /** Signed forward speed, m/s. */
  v: number;
  yaw: number; pitch: number; roll: number;
  pitchRate: number; rollRate: number;
  load: number[]; wheelY: number[];
  /** Fraction of available grip currently used, per wheel. Drives tyre audio. */
  slipRatio: number[];
  /** True while any wheel is on pavement/park rather than carriageway. */
  offroad: boolean;
  /** Current front road-wheel angle. Rate limited, so it lags the input. */
  steer: number;
  /**
   * 'hop' from the moment drift is pressed until the wheels are back down;
   * 'locked' once a direction has been committed to.
   */
  driftPhase: 'none' | 'hop' | 'locked';
  /** Which way the locked drift goes: −1 or +1. */
  driftDir: number;
  /** True while locked into a drift. */
  drifting: boolean;
  /** Previous frame's drift input, for edge detection inside the substeps. */
  driftWasHeld: boolean;
  /**
   * Set when a drift is spun out and lost. Like `boostFired`, the CALLER clears
   * it — clearing it here meant a spin in the first of the three substeps was
   * wiped by the second before the game ever saw it.
   */
  spunOut: boolean;
  /** 0..1 how much boost the current drift has earned. */
  driftCharge: number;
  /** Seconds of boost left to spend. */
  boost: number;
  /**
   * Set when a drift is cashed in; the magnitude is the charge spent. The
   * CALLER clears it, not stepVehicle — there are three substeps a frame, and
   * clearing it here meant a release in the first substep was wiped by the
   * second before anything ever saw it.
   */
  boostFired: number;
  /** Set for one step when the truck hits something. Magnitude is the impact speed. */
  impact: number;
}

export function makeCar(): Car {
  return {
    x: nodePos(1), z: nodePos(1), y: V.comH, a: 0,
    vx: 0, vy: 0, vz: 0, v: 0,
    yaw: 0, pitch: 0, roll: 0, pitchRate: 0, rollRate: 0,
    load: [0, 0, 0, 0], wheelY: [0, 0, 0, 0],
    slipRatio: [0, 0, 0, 0],
    steer: 0,
    offroad: false,
    driftPhase: 'none',
    driftDir: 0,
    drifting: false,
    driftWasHeld: false,
    spunOut: false,
    driftCharge: 0,
    boost: 0,
    boostFired: 0,
    impact: 0
  };
}

export function resetCar(car: Car, x: number, z: number, a: number): void {
  car.x = wrap(x); car.z = wrap(z); car.a = a;
  car.y = terrainAt(car.x, car.z) + V.comH;
  car.vx = car.vy = car.vz = car.v = 0;
  car.yaw = car.pitch = car.roll = 0;
  car.pitchRate = car.rollRate = 0;
  car.load.fill(0);
  car.slipRatio.fill(0);
  car.steer = 0;
  car.driftPhase = 'none';
  car.driftDir = 0;
  car.drifting = false;
  car.driftWasHeld = false;
  car.spunOut = false;
  car.driftCharge = 0;
  car.boost = 0;
  car.boostFired = 0;
  car.impact = 0;
}

/**
 * One physics substep. Called three times per frame — the springs are stiff and
 * one big step goes unstable.
 *
 * `thr` is −1..1 (throttle above zero, brake below), `str` is −1..1.
 */
export function stepVehicle(car: Car, h: number, thr: number, str: number, drift = false): void {
  const sa = Math.sin(car.a), ca = Math.cos(car.a);
  const fx = sa, fz = ca;      // forward
  const lx = ca, lz = -sa;     // left

  const off = onOffroad(car.x, car.z);
  car.offroad = off;
  const mu = V.mu * (off ? 0.66 : 1);

  /* ---- drift: hop in, counter-steer to hold ----
     See the notes on V.hopSpeed and V.counterAuthority. The state machine is
     here rather than in the caller because it has to see the suspension loads,
     which are what tell it the wheels have landed. */
  const planar = Math.hypot(car.vx, car.vz);
  const slipSigned = planar > 1
    ? shortAngle(car.a - Math.atan2(car.vx, car.vz))
    : 0;
  const bodySlip = Math.abs(slipSigned);
  const pressed = drift && !car.driftWasHeld;
  car.driftWasHeld = drift;

  if (!drift && car.driftPhase !== 'none') {
    car.driftPhase = 'none';
    car.driftDir = 0;
  } else if (pressed && car.driftPhase === 'none' && planar > V.driftMinSpeed) {
    // The hop is a plain vertical impulse. Everything that makes it useful —
    // unloaded springs, no tyre grip, landing already rotating — falls out of
    // the suspension model on its own.
    car.vy += V.hopSpeed;
    car.driftPhase = 'hop';
  }

  const driftHeld = car.driftPhase === 'locked';
  car.drifting = driftHeld;

  /* Counter-steer: positive when steering AGAINST the slide. This is what
     holds the angle; without it the slip keeps growing to a spin. */
  const counter = driftHeld ? clamp(-car.driftDir * str, 0, 1) : 0;
  const into = driftHeld ? clamp(car.driftDir * str, 0, 1) : 0;

  const speed = car.vx * fx + car.vz * fz;

  /* Steering is RATE LIMITED rather than instantaneous — see the note on
     V.maxSteer. Coming back to centre is quicker than going out, so the truck
     settles after a corner rather than hunting about. */
  const target = -str * V.maxSteer *
    (1 - V.steerFalloff * Math.min(1, Math.abs(speed) / P.vMax));
  const turning = Math.abs(target) >= Math.abs(car.steer) &&
    Math.sign(target) === Math.sign(car.steer || target);
  const rate = feel(FEEL.rate) * (turning ? 1 : V.steerReturnBoost);
  car.steer += clamp(target - car.steer, -rate * h, rate * h);
  const steer = car.steer;

  let Fx = 0, Fz = 0, Fy = 0, tYaw = 0, tPitch = 0, tRoll = 0;

  /* Pass one: find every spring's compression BEFORE deciding any loads. The
     anti-roll bar couples the two wheels on an axle, so a wheel's load depends
     on its partner's compression — which means this cannot be done in one pass. */
  const comp = [0, 0, 0, 0], cvy = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const W = WHEELS[i];
    const attachY = car.y - V.attachDrop + W.f * car.pitch + W.s * car.roll;
    const wpx = car.x + fx * W.f + lx * W.s;
    const wpz = car.z + fz * W.f + lz * W.s;
    const gy = terrainAt(wpx, wpz);
    comp[i] = Math.max(0, (V.wheelR + V.susRest) - (attachY - gy));
    cvy[i] = car.vy + W.f * car.pitchRate + W.s * car.rollRate;
    car.wheelY[i] = comp[i] > 0 ? gy + V.wheelR : attachY - V.susRest;
  }

  /* Loads. The anti-roll bar TRANSFERS load between the two wheels on an axle —
     it must never add any. So it is computed once per axle, applied equal and
     opposite, clamped, and switched off entirely the moment either wheel leaves
     the ground. */
  const load = car.load;
  for (const [a, bw] of [[0, 1], [2, 3]]) {
    const both = comp[a] > 0 && comp[bw] > 0;
    const arbF = both ? clamp(V.arb * (comp[a] - comp[bw]), -V.arbMax, V.arbMax) : 0;
    const spring = (i: number, extra: number) => comp[i] <= 0 ? 0 :
      clamp(V.springK * comp[i] - V.damper * cvy[i] + extra, 0, 20000);
    load[a] = spring(a, arbF);
    load[bw] = spring(bw, -arbF);
  }

  for (let i = 0; i < 4; i++) {
    const W = WHEELS[i];
    const Fn = load[i];
    if (Fn <= 0) { car.slipRatio[i] = 0; continue; }

    Fy += Fn;
    tPitch += Fn * W.f;
    tRoll += Fn * W.s;

    // --- tyre forces, each scaled by THIS wheel's load ---
    const d = W.front ? steer : 0;
    const cd = Math.cos(d), sd = Math.sin(d);
    const wfx = fx * cd + lx * sd, wfz = fz * cd + lz * sd;   // wheel forward
    const wsx = lx * cd - fx * sd, wsz = lz * cd - fz * sd;   // wheel left

    // velocity at the contact patch, including yaw
    const vpx = car.vx + car.yaw * (-fx * W.s + lx * W.f);
    const vpz = car.vz + car.yaw * (-fz * W.s + lz * W.f);
    const vf = vpx * wfx + vpz * wfz;
    const vs = vpx * wsx + vpz * wsz;

    // Drifting takes grip and cornering stiffness off the REAR axle only. Doing
    // it to both would just make the truck plough; doing it to the rear is what
    // makes the back end come round.
    const rearDrift = driftHeld && W.rear;
    const grip = mu * Fn * (rearDrift ? V.driftGrip : 1);

    // Slip ANGLE rather than slip velocity, so behaviour is sane at all speeds.
    const slip = Math.atan2(vs, Math.abs(vf) + 1.0);
    const corner = W.front ? V.cornerF : V.cornerR * (rearDrift ? V.driftCorner : 1);
    let fLat = -slip * corner * Fn;

    /* Longitudinal force. There are FOUR cases here, not two, and getting that
       wrong is what left the truck unable to reverse out of a building.
 
       The old version treated any negative input as a brake opposing the wheel's
       current direction. From a standstill that does nudge you backwards — but
       the instant the wheel starts turning backwards the sign flips and the very
       same input pushes you forwards again. You buzz against the wall and never
       get anywhere, with nothing on screen to explain why.
 
       So each pedal means "go this way", and becomes a brake only when the truck
       is already going the other way. That is also what a player expects: hold
       brake to stop, keep holding to reverse; blip throttle to stop reversing. */
    const braking = (bias: number) => V.brake * bias * (W.front ? 0.31 : 0.19);
    let fLong = 0;
    if (thr > 0) {
      if (vf < -V.stopped) {
        fLong = braking(thr);                     // rolling back: throttle brakes
      } else if (W.rear) {
        // Rear-wheel drive, which gives power oversteer for free.
        fLong = V.drive * thr * 0.5 * (1 - 0.80 * Math.min(1, Math.abs(speed) / P.vMax));
      }
    } else if (thr < 0) {
      const pedal = -thr;
      if (vf > V.stopped) {
        fLong = -braking(pedal);                  // rolling forward: brake
      } else if (W.rear) {
        // Stopped or already reversing: reverse gear, capped at its own top speed.
        const backwards = Math.max(0, -speed);
        fLong = -V.drive * pedal * V.reverse * (1 - Math.min(1, backwards / V.reverseMax));
      }
    }
    // Rolling resistance: a constant part plus a small speed-dependent part.
    const rr = off ? 5 : 1;
    fLong -= (Math.sign(vf) * V.rollC + vf * V.rollV) * rr;

    // Friction circle — a tyre cannot give full braking and full cornering at once.
    const mag = Math.hypot(fLong, fLat);
    car.slipRatio[i] = grip > 0 ? Math.min(1.6, mag / grip) : 0;
    if (mag > grip) { const k = grip / mag; fLong *= k; fLat *= k; }

    const wx = wfx * fLong + wsx * fLat;
    const wz = wfz * fLong + wsz * fLat;
    Fx += wx; Fz += wz;
    tYaw += W.f * (wx * lx + wz * lz) - W.s * (wx * fx + wz * fz);
  }

  /* Weight transfer. Tyre forces act at the contact patch, comH BELOW the
     centre of mass, so every one of them twists the body. This is the line that
     makes the nose dive under braking and the inside wheels go light in a
     corner — and because each spring's load feeds back into that tyre's grip
     limit, the handling CHANGES with the attitude rather than just looking like
     it does. */
  const Ffwd = Fx * fx + Fz * fz;
  const Flft = Fx * lx + Fz * lz;
  tPitch += Ffwd * V.comH;
  tRoll += Flft * V.comH;

  // The destabilising torque that makes a locked drift something you have to
  // fly. See the note on V.driftYaw.
  if (driftHeld) {
    tYaw -= car.driftDir * V.driftYaw * clamp(planar / 18, 0, 1);
  }

  // Gravity's component along the hillside — climbs cost speed, descents pay it back.
  const [gx, gz] = slopeAt(car.x, car.z);
  Fx -= V.mass * 9.81 * gx;
  Fz -= V.mass * 9.81 * gz;

  /* ---- boost ----
     A body force along the truck's axis, fading out as speed approaches the
     ceiling so it cannot be stacked into orbit. See the note on V.boostForce
     for why this is not applied at the contact patches. */
  if (car.boost > 0) {
    car.boost = Math.max(0, car.boost - h);
    const headroom = 1 - Math.min(1, Math.abs(speed) / (P.vMax * V.boostCeiling));
    Fx += fx * V.boostForce * headroom;
    Fz += fz * V.boostForce * headroom;
  }

  // Aerodynamic drag, on the body rather than the tyres.
  const sp = Math.hypot(car.vx, car.vz);
  Fx -= car.vx * V.aero * sp;
  Fz -= car.vz * V.aero * sp;

  // --- integrate ---
  car.vx += (Fx / V.mass) * h;
  car.vz += (Fz / V.mass) * h;
  car.vy += (Fy / V.mass - 9.81) * h;

  car.yaw += (tYaw / feel(FEEL.inertia)) * h;
  car.pitchRate += (tPitch / V.Ipitch) * h;
  car.rollRate += (tRoll / V.Iroll) * h;
  car.yaw *= (1 - feel(FEEL.damp) * h);
  car.pitchRate *= (1 - 1.1 * h);
  car.rollRate *= (1 - 1.1 * h);
  car.yaw = clamp(car.yaw, -V.maxYawRate, V.maxYawRate);

  /* Velocity redirection — see the note on V.assist.
 
     It aligns the velocity with the truck's LONGITUDINAL AXIS, not with its
     nose. That distinction only matters in reverse, and it matters completely:
     aligning to the nose means that when you are travelling backwards the
     assist spends every frame rotating your velocity back around to forwards.
     It fought the reverse gear to a standstill at 1.5 m/s and looked for all
     the world like the brakes were stuck on. */
  const grounded = load[0] + load[1] + load[2] + load[3] > 0;
  const spd2 = Math.hypot(car.vx, car.vz);
  if (grounded && spd2 > 1.0) {
    const vdir = Math.atan2(car.vx, car.vz);
    const toNose = Math.atan2(Math.sin(car.a - vdir), Math.cos(car.a - vdir));
    // Whichever end of the axis we are actually travelling along.
    const axis = Math.abs(toNose) > Math.PI / 2 ? car.a + Math.PI : car.a;
    const offA = Math.atan2(Math.sin(axis - vdir), Math.cos(axis - vdir));
    /* Most of the assist switches off in a drift, so the back stays out. What
       brings it back is COUNTER-STEER, not a timer: steer against the slide and
       the truck gathers itself, steer further into it and it goes further. */
    let rate = V.assist;
    if (driftHeld) {
      rate = V.assist * (V.driftAssist * (1 - into * (1 - V.driftInto)))
        + counter * V.counterAuthority;
    }
    const na = vdir + offA * Math.min(1, rate * h);
    car.vx = Math.sin(na) * spd2;
    car.vz = Math.cos(na) * spd2;
  }

  /* ---- land the hop, then hold or lose the drift ---- */
  const grounded2 = load[0] + load[1] + load[2] + load[3] > 0;

  if (car.driftPhase === 'hop' && grounded2 && car.vy <= 0) {
    /* Committed on landing. The direction you are steering as the wheels touch
       down is the drift you get — which makes entry a deliberate flick rather
       than a button you hold and hope. Steering nothing falls back to whichever
       way the truck is already rotating, so a hop mid-corner still works. */
    /* NOTE THE SIGN. driftDir is the sign of the STEERING that entered it, so
       that `into` and `counter` below read directly off the player's input.
       Deriving it from the resulting slip instead inverts both of them, and the
       symptom is subtle: the drift still works, but it is being held by the
       "steering further in" branch while the code believes it is counter-steer. */
    const want = Math.abs(str) > 0.15 ? Math.sign(str) : -Math.sign(car.yaw);
    if (want !== 0 && planar > V.driftMinSpeed) {
      car.driftPhase = 'locked';
      car.driftDir = want;
    } else {
      car.driftPhase = 'none';
    }
  }

  if (car.driftPhase === 'locked') {
    if (bodySlip > V.driftSpin) {
      // Gone too far. The drift is lost and the charge with it — that is the
      // cost of not catching it.
      car.driftPhase = 'none';
      car.driftDir = 0;
      car.driftCharge = 0;
      car.spunOut = true;
    } else {
      /* Charge builds fastest in a sweet band of slip angle. Not sideways
         enough earns nothing; on the edge of a spin earns nearly nothing
         either, so the reward is for holding the angle rather than for
         surviving the biggest slide you can provoke. */
      const q = bodySlip < V.driftSlip ? 0
        : clamp(1 - Math.abs(bodySlip - V.driftSweet) / V.driftSweetWidth, 0, 1);
      car.driftCharge = Math.min(1, car.driftCharge + (h * q) / V.driftChargeTime);
    }
  } else if (car.driftCharge > 0) {
    if (car.driftCharge >= V.driftMinCharge) {
      car.boostFired = car.driftCharge;
      car.boost = car.driftCharge * V.boostTime;
    }
    car.driftCharge = 0;
  }

  car.y += car.vy * h;
  car.a += car.yaw * h;
  car.pitch += car.pitchRate * h;
  car.roll += car.rollRate * h;

  // Hard stops — zero the RATE too, or the body keeps winding up against the
  // limit and then snaps back the instant the load comes off.
  if (car.pitch > 0.16) { car.pitch = 0.16; car.pitchRate = Math.min(0, car.pitchRate); }
  if (car.pitch < -0.16) { car.pitch = -0.16; car.pitchRate = Math.max(0, car.pitchRate); }
  if (car.roll > 0.16) { car.roll = 0.16; car.rollRate = Math.min(0, car.rollRate); }
  if (car.roll < -0.16) { car.roll = -0.16; car.rollRate = Math.max(0, car.rollRate); }

  const gy0 = terrainAt(car.x, car.z);
  if (car.y < gy0 + 0.20) { car.y = gy0 + 0.20; car.vy = Math.max(0, car.vy); }

  car.x = wrap(car.x + car.vx * h);
  car.z = wrap(car.z + car.vz * h);

  car.v = car.vx * fx + car.vz * fz;
}
