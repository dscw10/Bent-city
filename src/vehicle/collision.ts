import type { Block } from '../render/city';
import type { Car } from './vehicle';
import { wrapDelta, wrap } from '../core/place';
import { clamp } from '../core/math';

/**
 * How far a footprint is inflated before the truck touches it — effectively the
 * truck's own radius. Anything narrower than 2 x PAD is impassable, so block
 * layouts have to leave more room than this between neighbouring buildings.
 */
export const PAD = 1.4;

/** How much of the speed into a wall comes back out of it. */
const RESTITUTION = 0.35;
/** How much of the speed ALONG a wall survives the contact. */
const TANGENT = 0.88;

/**
 * Collision against building footprints, with a bounce.
 *
 * Two things about the geometry matter, and the first one was the bug that made
 * corners so unpleasant:
 *
 * 1. THE FOOTPRINT IS INFLATED BY A CIRCLE, NOT A SQUARE. Padding each axis
 *    separately makes the collision surface a right angle at every corner, and
 *    the push-out is then always axis-aligned. Clip a corner diagonally and the
 *    least-penetration axis flips between x and z from one step to the next,
 *    each flip scrubbing more speed, and the truck stops dead on a spot it
 *    should have glanced off. Rounding the corner — taking the closest point on
 *    the box and pushing out along the line to it — gives a normal that turns
 *    smoothly through the corner instead.
 *
 * 2. THE RESPONSE IS A REFLECTION, not a stop. The component into the wall
 *    comes back out scaled by RESTITUTION, and the component along the wall
 *    survives almost intact. So a head-on hit bounces, a glancing hit deflects
 *    and you keep going, and neither one parks you.
 *
 * Returns the impact speed — how fast you were going INTO the wall, which is
 * the number the camera shake, the rumble and the audio all want.
 */
export function collideBlocks(car: Car, blocks: Block[]): number {
  /* Resolve only the DEEPEST overlap per call, not every overlap. Resolving
     them all in one pass meant two facing walls pushed the truck opposite ways
     in the same step and each scrubbed velocity, pinning anything that nosed
     into a narrow gap. Three substeps a frame is plenty for a corner to resolve
     over the following few steps instead. */
  let depth = 0;
  let nx = 0, nz = 0;

  for (const b of blocks) {
    const dx = wrapDelta(car.x, b.x);
    const dz = wrapDelta(car.z, b.z);
    const hw = b.w / 2, hd = b.d / 2;

    // Closest point on the (unpadded) box to the truck's centre.
    const ox = dx - clamp(dx, -hw, hw);
    const oz = dz - clamp(dz, -hd, hd);
    const d2 = ox * ox + oz * oz;

    let cnx: number, cnz: number, cd: number;
    if (d2 > 1e-9) {
      // Outside the box proper: the normal points away from the closest point,
      // which is what rounds the corners.
      const d = Math.sqrt(d2);
      if (d >= PAD) continue;
      cnx = ox / d; cnz = oz / d; cd = PAD - d;
    } else {
      // Centre is genuinely inside the box — shove it out the nearest face.
      const px = hw - Math.abs(dx);
      const pz = hd - Math.abs(dz);
      if (px < pz) { cnx = Math.sign(dx || 1); cnz = 0; cd = px + PAD; }
      else { cnx = 0; cnz = Math.sign(dz || 1); cd = pz + PAD; }
    }

    if (cd > depth) { depth = cd; nx = cnx; nz = cnz; }
  }

  if (depth <= 0) return 0;

  // Separate first, so the bounce starts from a legal position.
  car.x = wrap(car.x + nx * depth);
  car.z = wrap(car.z + nz * depth);

  const vn = car.vx * nx + car.vz * nz;
  if (vn >= 0) return 0;                    // already moving away; just separated

  // Split into "into the wall" and "along the wall", then rebuild.
  const tx = car.vx - nx * vn;
  const tz = car.vz - nz * vn;
  car.vx = tx * TANGENT + nx * -vn * RESTITUTION;
  car.vz = tz * TANGENT + nz * -vn * RESTITUTION;

  const impact = -vn;
  // Take some rotation out of a real thump, or the truck keeps steering itself
  // back into the wall it just bounced off.
  if (impact > 6) car.yaw *= 0.7;
  return impact;
}
