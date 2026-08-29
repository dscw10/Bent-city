import type { Block } from '../render/city';
import type { Car } from './vehicle';
import { wrapDelta, wrap } from '../core/city-layout';

/**
 * How far a footprint is inflated before the truck touches it — effectively the
 * truck's own radius. Anything narrower than 2 x PAD is impassable, so block
 * layouts have to leave more room than this between neighbouring buildings.
 */
export const PAD = 1.4;

/**
 * Axis-aligned push-out against building footprints. Collision is per BUILDING,
 * not per block, so pavement pads and plazas stay open and cutting a corner is
 * a real option.
 *
 * Deliberately crude: it pushes along whichever axis has the least overlap and
 * kills most of the velocity into the wall while keeping some along it, so
 * glancing a building scrubs speed rather than stopping you dead.
 *
 * Returns the impact speed, so audio and the camera can react to it.
 */
export function collideBlocks(car: Car, blocks: Block[]): number {
  /* Resolve only the DEEPEST overlap per call, not every overlap.
   *
   * Resolving them all in one pass meant two facing walls pushed the truck in
   * opposite directions in the same step, and each one also scrubbed velocity —
   * so a truck that had nosed into a narrow gap was pinned there with its speed
   * zeroed from both sides, and no amount of throttle or reverse got it out.
   *
   * Deepest-first cannot cancel itself. Three substeps a frame is plenty for a
   * corner to resolve over the following few steps instead. */
  let worst: Block | null = null;
  let worstDepth = 0;
  let worstAxisX = false;
  let dx = 0, dz = 0;

  for (const b of blocks) {
    const hw = b.w / 2 + PAD, hd = b.d / 2 + PAD;
    const bdx = wrapDelta(car.x, b.x), bdz = wrapDelta(car.z, b.z);
    if (Math.abs(bdx) >= hw || Math.abs(bdz) >= hd) continue;

    const px = hw - Math.abs(bdx);
    const pz = hd - Math.abs(bdz);
    // Push out along whichever axis needs the least movement.
    const alongX = px < pz;
    const depth = alongX ? px : pz;
    if (depth > worstDepth) {
      worstDepth = depth;
      worst = b;
      worstAxisX = alongX;
      dx = bdx; dz = bdz;
    }
  }

  if (!worst) return 0;

  if (worstAxisX) {
    const impact = Math.abs(car.vx);
    car.x = wrap(worst.x + Math.sign(dx || 1) * (worst.w / 2 + PAD));
    car.vx *= -0.15;
    car.vz *= 0.55;
    return impact;
  }

  const impact = Math.abs(car.vz);
  car.z = wrap(worst.z + Math.sign(dz || 1) * (worst.d / 2 + PAD));
  car.vz *= -0.15;
  car.vx *= 0.55;
  return impact;
}
