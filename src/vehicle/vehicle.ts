import { P } from '../core/config';
import { terrainAt, slopeAt } from '../core/terrain';
import { nodePos } from '../core/city-layout';
import { wrap, PLACE } from '../core/place';
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
  /* Drive was 16500 and the truck did 46 m/s — 167 km/h, in a 660cc kei truck.
     Worse than implausible, it was too fast for the city it drives in: at 30
     m/s a 58m block goes by in 1.9 seconds, which is not enough time to read
     anything. Slowing it down is as much a fix for the map going unread as it
     is for the handling. */
  drive: 8200, brake: 15000,

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

  /* ---- holding a drift: AN ANGLE YOU CHOOSE ----
   *
   * This is modelled on Mario Kart rather than on a car, and the difference is
   * the whole point. In Mario Kart the stick does not apply a torque during a
   * drift — it SELECTS how far round the drift sits, within a bounded range:
   * held into the turn gives a tight drift, released gives a middle one, held
   * against it gives a wide one. The kart then travels to that angle. You
   * cannot spin out of a drift, and there is no fight to lose.
   *
   * What was here before was a fight: a constant destabilising torque pushing
   * the slide out, and counter-steer authority pulling it back. Measured, from
   * 23 m/s, holding the stick into the drift reached 135 degrees a second of
   * yaw and spun out inside 1.25 seconds, dumping the truck to 8 m/s — and
   * "steer further in" is the first thing anybody tries. That is what "steers
   * too sharply" was.
   *
   * So the target slip angle is a lerp across these three, and the truck is
   * flown to it by a PD controller. Both halves of "progressive" live here: the
   * TARGET itself may only travel at driftAim rad/s, so slamming the stick is
   * not a step input, and the controller then has to close the remaining gap
   * against real inertia.
   */
  driftWide: 0.18,        // rad of slip with the stick held against the drift
  driftMid: 0.38,         // rad with the stick released
  driftTight: 0.58,       // rad with the stick held into the drift
  /** How fast the TARGET may travel, rad/s. This is the progressiveness dial. */
  driftAim: 1.5,
  /**
   * Speed, in m/s, at which the full drift angle is available. Below it the
   * target tapers.
   *
   * Without this a held drift is a death spiral: the controller holds 33
   * degrees of slip whatever the speed, and at 33 degrees the tyres scrub so
   * hard that four seconds of it takes the truck from 20 m/s to 6 and then
   * keeps it there, spinning slowly. A kart cannot hold a big drift angle at
   * walking pace and neither should this.
   */
  driftFullSpeed: 16,
  driftMinAngle: 0.35,    // fraction of the target that survives at a crawl
  /** Yaw torque per radian of error, and per rad/s of closing speed. */
  driftHold: 9000,
  driftDamp: 1500,
  /** Ceiling on the controller's torque, so a big error is still a lean-in. */
  driftHoldMax: 4600,
  /**
   * How much of the normal steering lock survives a drift.
   *
   * The other half of the fix. While drifting the stick is choosing a drift
   * angle, so leaving the front wheels on full lock as well means one input
   * doing two jobs and the truck darting. A third of the lock is enough to
   * place the nose and not enough to fight the controller.
   */
  driftSteer: 0.34,
  /**
   * How far the front wheels still point INTO the corner at full counter-steer.
   *
   * Without this, holding away from the drift steered the truck the other way:
   * the front axle can make about 6800 N·m and the drift controller is clamped
   * to a fifth of that, so the stick simply won. Which is not what counter-steer
   * means in a kart game — there, holding away gives you a WIDE version of the
   * same corner, never the opposite one. So while drifting the stick no longer
   * reaches the wheels directly; it slides them between pointing hard into the
   * corner and pointing very slightly into it.
   */
  driftSteerMin: 0.10,
  /** Slip angle at which the drift is lost. A safety valve, not a mechanic:
   *  the target is bounded well below it, so reaching it means something hit
   *  you or the ground did something unexpected. */
  driftSpin: 1.35,
  /**
   * Body slip angle, in radians, above which a drift counts as a drift.
   *
   * Set above the wander that full throttle alone produces, and just below the
   * wide-drift target — so a drift held on full counter-steer still charges,
   * slowly, which is what Mario Kart does too.
   */
  driftSlip: 0.16,
  /** Below this fraction of driftMinSpeed a drift ends: a slow pirouette is not
   *  a drift, and holding one was free rotation. */
  driftDropSpeed: 0.6,
  /**
   * Charge is TIME-BASED, as it is in Mario Kart: a counter that runs while you
   * are drifting, faster when the stick is held hard over. The documented rates
   * there are 5 per frame past 45 degrees of stick and 2 below it, hence 2.5.
   *
   * It replaced a sweet-spot band that paid out fastest at one exact slip
   * angle. That was precise and unreadable — you could not see your own slip
   * angle to hold it — and it rewarded a skill the player had no instrument
   * for. Committing to the corner is legible; holding 32 degrees is not.
   */
  driftHardRate: 2.5,
  /** Stick deflection past which the charge runs at the faster rate. */
  driftHardStick: 0.5,
  /** Yaw rate, rad/s, that counts as "already turning" for a hands-off hop. */
  driftHopYaw: 0.35,
  driftChargeTime: 2.2,
  /** A drift shorter than this earns nothing, so a stab of the button is not a boost. */
  driftMinCharge: 0.22,
  boostForce: 7000,
  /** Seconds of boost from a full charge. */
  boostTime: 1.7,
  /**
   * Boost fades out as speed approaches this multiple of vMax. Comfortably
   * above 1: the whole point of a boost is to take you past what the engine
   * alone can do, and at 1.25 it had almost no headroom left once the truck was
   * already near its top speed — which is exactly when you cash one in.
   */
  boostCeiling: 1.45,

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
export const TUNE = {
  steerSpeed: 0.28,
  /**
   * Engine power, as a multiplier on `drive`. A setting rather than a constant
   * because "how quick should it be" is exactly the sort of thing that needs
   * driving rather than reasoning about — and because the answer is tangled up
   * with the city's scale: at 30 m/s a 58m block goes past in 1.9 seconds,
   * which is not long enough to read anything on the map.
   */
  power: 1
};

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
  /**
   * The slip angle the stick is currently asking for, in radians. Rate limited,
   * so it lags the stick — see V.driftAim. Lives on the car rather than in a
   * local because it has to survive between substeps.
   */
  driftTarget: number;
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
    driftTarget: V.driftMid,
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
  car.driftTarget = V.driftMid;
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

  const off = PLACE.offroad(car.x, car.z);
  car.offroad = off;
  const mu = V.mu * (off ? 0.66 : 1);

  /* ---- drift: hop in, counter-steer to hold ----
     See the notes on V.hopSpeed and V.driftTight. The state machine is
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

  /* The stick, in the drift's own frame: +1 held INTO the drift, -1 against it.
     In Mario Kart this does not push the kart round — it picks how far round
     the drift sits. See the note on V.driftTight. */
  const aim = driftHeld ? clamp(car.driftDir * str, -1, 1) : 0;

  /* The slip a drift produces is opposite in sign to the steering that entered
     it — measured, not assumed: driftDir +1 gives slip around -0.5 rad. */
  const driftSign = -car.driftDir;

  if (driftHeld) {
    const taper = clamp(
      (planar - V.driftMinSpeed) / (V.driftFullSpeed - V.driftMinSpeed),
      V.driftMinAngle, 1);
    const want = (aim >= 0
      ? V.driftMid + aim * (V.driftTight - V.driftMid)
      : V.driftMid + aim * (V.driftMid - V.driftWide)) * taper;
    // Rate-limited, so slamming the stick is a lean rather than a step input.
    // This is the progressiveness dial: everything downstream is a controller
    // chasing THIS number, and it can only move so fast.
    car.driftTarget += clamp(want - car.driftTarget, -V.driftAim * h, V.driftAim * h);
  } else {
    car.driftTarget = V.driftMid;
  }

  const speed = car.vx * fx + car.vz * fz;

  /* Steering is RATE LIMITED rather than instantaneous — see the note on
     V.maxSteer. Coming back to centre is quicker than going out, so the truck
     settles after a corner rather than hunting about. */
  /* One stick cannot do two jobs at full authority. While drifting it is
     choosing a drift angle, so the front wheels get a third of their lock —
     enough to place the nose, not enough to fight the drift controller — and
     they always point somewhere into the corner. See V.driftSteerMin. */
  const strFront = driftHeld
    ? car.driftDir * (V.driftSteerMin + (1 - V.driftSteerMin) * (aim + 1) / 2)
    : str;
  const target = -strFront * V.maxSteer *
    (1 - V.steerFalloff * Math.min(1, Math.abs(speed) / P.vMax)) *
    (driftHeld ? V.driftSteer : 1);
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
        fLong = V.drive * TUNE.power * thr * 0.5 * (1 - 0.80 * Math.min(1, Math.abs(speed) / P.vMax));
      }
    } else if (thr < 0) {
      const pedal = -thr;
      if (vf > V.stopped) {
        fLong = -braking(pedal);                  // rolling forward: brake
      } else if (W.rear) {
        // Stopped or already reversing: reverse gear, capped at its own top speed.
        const backwards = Math.max(0, -speed);
        fLong = -V.drive * TUNE.power * pedal * V.reverse * (1 - Math.min(1, backwards / V.reverseMax));
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

  /* ---- the drift controller ----
     A PD loop that flies the body to the slip angle the stick asked for. It
     pushes the slide OUT when you are short of the target and gathers it back
     IN when you are past, which is what makes the angle bounded and the drift
     unloseable — the two things the old torque-versus-counter-steer fight got
     wrong.

     The derivative term needs how fast the slip angle is actually changing,
     which is the body's yaw rate minus the velocity vector's. The latter falls
     straight out of the force already accumulated this step:
     d/dt atan2(vx, vz) = (vz*ax - vx*az) / |v|^2. Estimating it by remembering
     last frame's slip instead would be a substep behind, and this runs three
     times a frame. */
  if (driftHeld && planar > 1) {
    const omegaV = (car.vz * Fx - car.vx * Fz) / (V.mass * planar * planar);
    const q = slipSigned * driftSign;                  // slip, in the drift's frame
    const qRate = (car.yaw - omegaV) * driftSign;
    const push = clamp(
      V.driftHold * (car.driftTarget - q) - V.driftDamp * qRate,
      -V.driftHoldMax, V.driftHoldMax
    ) * clamp(planar / 12, 0, 1);
    tYaw += driftSign * push;
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
    /* Most of the assist switches off in a drift, so the back stays out. It is
       a constant now: it used to spike to counterAuthority the instant you
       steered against the slide, which snapped the truck straight and was half
       of what read as darting. Gathering the slide back in is the drift
       controller's job, and it does it at a rate you can watch. */
    const rate = driftHeld ? V.assist * V.driftAssist : V.assist;
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
    /* Landing with no input and no rotation is just a hop. It has to be, now
       that the charge is time-based: without the yaw floor the truck locks into
       a drift with no direction, the rear grip cut at full throttle produces
       enough power oversteer to clear the "actually sideways" gate, and holding
       the button down a straight farms a full boost in two seconds. */
    const want = Math.abs(str) > 0.15 ? Math.sign(str)
      : Math.abs(car.yaw) > V.driftHopYaw ? -Math.sign(car.yaw)
      : 0;
    if (want !== 0 && planar > V.driftMinSpeed) {
      car.driftPhase = 'locked';
      car.driftDir = want;
      /* Seed the target from the slip the truck ALREADY has, so the controller
         starts with no error and grows into the angle at driftAim. Starting it
         at the middle angle instead made the first tenth of a second a step
         input, which is the snap the whole rework is trying to remove. */
      car.driftTarget = Math.min(bodySlip, V.driftMid);
    } else {
      car.driftPhase = 'none';
    }
  }

  if (car.driftPhase === 'locked') {
    if (bodySlip > V.driftSpin) {
      /* A safety valve rather than a mechanic. The controller keeps the angle
         well inside this, so getting here means something hit you or the
         ground did something unexpected — and losing the charge is then a
         consequence of the crash rather than of the drift. */
      car.driftPhase = 'none';
      car.driftDir = 0;
      car.driftCharge = 0;
      car.spunOut = true;
    } else if (planar < V.driftMinSpeed * V.driftDropSpeed) {
      // Too slow to be a drift any more. Keep whatever was earned.
      car.driftPhase = 'none';
      car.driftDir = 0;
    } else {
      /* Time-based, and faster with the stick hard over — Mario Kart's model.
         The gate is just "actually sideways", which a wide drift on full
         counter-steer still clears, so committing harder pays but playing it
         safe still earns. */
      const q = bodySlip < V.driftSlip ? 0
        : (Math.abs(str) > V.driftHardStick ? V.driftHardRate : 1);
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
