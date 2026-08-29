import * as THREE from 'three';
import { P } from '../core/config';
import { clamp, approach } from '../core/math';
import { terrainAt } from '../core/terrain';
import type { Car } from '../vehicle/vehicle';

/**
 * The camera NEVER MOVES in world terms. It sits at a fixed spot in
 * player-local space, which is the only space it knows about — the world is
 * transformed into that space each frame by uW2P.
 *
 * Four behaviours, and about a third of the feel of the game lives here rather
 * than in the physics:
 *
 * - DISTANCE GROWS WITH SPEED (up to +42%). The truck shrinks, the road opens up.
 * - HEIGHT RIDES THE TRUCK. Player-local space keeps world Y, so a camera at a
 *   fixed local y stays at a fixed ALTITUDE and the truck simply climbs away
 *   from it over hills. It tracks car.y, lightly smoothed so suspension
 *   movement doesn't shake the whole frame.
 * - IT AIMS AT THE HILLSIDE AHEAD, so the view pitches over crests and down
 *   into dips instead of staring at a fixed altitude.
 * - IT TRAILS BEHIND TURNS. Deliberately small: the first version at 0.30 gain
 *   read as a swinging camera rather than as weight, so the gain came down to
 *   0.11 and the clamp from 0.42 to 0.16 rad.
 *
 * Watch the interaction with map lock: camera turn lag and map lock are two
 * different lags applied to the same event. Too much of both and a corner
 * becomes mush.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private dist: number;
  private yaw = 0;
  private prevHeading = 0;
  private height = 0;
  private lookY = 0;
  private first = true;
  /** Extra pull-back applied by events (a near miss, a delivery). Decays away. */
  private kick = 0;

  constructor() {
    // Far plane is only 1400: once bent, the whole visible world sits within a
    // few hundred units of the camera. That, plus polygonOffset on the road,
    // is what stops pavements, dashes and the ribbon z-fighting after the
    // flatten squashes them into nearly the same plane.
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.6, 1400);
    this.dist = P.camDist;
    this.reset();
  }

  reset(): void {
    this.dist = P.camDist;
    this.yaw = 0;
    this.kick = 0;
    this.first = true;
    this.camera.position.set(0, this.dist * 0.4, -this.dist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, this.dist * 0.2, 16);
  }

  /** A one-off shove backwards, for impacts and deliveries. */
  addKick(amount: number): void {
    this.kick = Math.min(3.5, this.kick + amount);
  }

  /** `resp` is the smoothstepped speed response, shared with the projection. */
  update(dt: number, car: Car, resp: number): void {
    this.kick = approach(this.kick, 0, dt, 0.45);

    const targetDist = P.camDist * (1 + 0.42 * resp) + this.kick;
    this.dist = approach(this.dist, targetDist, dt, 0.50);

    let dA = car.a - this.prevHeading;
    this.prevHeading = car.a;
    dA = Math.atan2(Math.sin(dA), Math.cos(dA));       // shortest way round
    const rate = dt > 0 ? dA / dt : 0;

    // Negative sign: turning left leaves the camera out to the right, trailing.
    const yawTarget = clamp(-rate * 0.11, -0.16, 0.16);
    this.yaw = approach(this.yaw, yawTarget, dt, 0.20);

    // Height rides the truck, lightly smoothed. Snap on the first frame, or the
    // camera glides in from the origin every time the game restarts.
    const targetH = car.y;
    this.height = this.first ? targetH : approach(this.height, targetH, dt, 0.16);

    // Aim at the hillside ahead rather than at a fixed altitude.
    const ax = car.x + Math.sin(car.a) * 24;
    const az = car.z + Math.cos(car.a) * 24;
    const targetLook = terrainAt(ax, az);
    this.lookY = this.first ? targetLook : approach(this.lookY, targetLook, dt, 0.30);
    this.first = false;

    const h = this.dist * 0.40;
    this.camera.position.set(
      -this.dist * Math.sin(this.yaw),
      this.height + h,
      -this.dist * Math.cos(this.yaw)
    );

    const roll = this.yaw * 0.18;                       // a little bank
    this.camera.up.set(Math.sin(roll), Math.cos(roll), 0);

    /* Where the camera aims decides how much of the frame the map gets, because
       the map is a plane standing at the end of the fold and you see however
       much of it falls inside the vertical field of view. Raising the aim
       trades life-size street at the bottom of the frame for map at the top. */
    const la = this.yaw * 0.50;                         // look partly into the turn
    this.camera.lookAt(
      16 * Math.sin(la),
      this.lookY + this.dist * 0.20 + P.camAim,
      16 * Math.cos(la)
    );
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
