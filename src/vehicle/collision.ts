import type { Block } from '../render/city';
import type { Car } from './vehicle';
import { wrapDelta, wrap } from '../core/city-layout';

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
  let impact = 0;
  for (const b of blocks) {
    const hw = b.w / 2 + 1.4, hd = b.d / 2 + 1.4;
    const dx = wrapDelta(car.x, b.x), dz = wrapDelta(car.z, b.z);
    if (Math.abs(dx) >= hw || Math.abs(dz) >= hd) continue;

    const px = hw - Math.abs(dx), pz = hd - Math.abs(dz);
    if (px < pz) {
      impact = Math.max(impact, Math.abs(car.vx));
      car.x = wrap(b.x + Math.sign(dx || 1) * hw);
      car.vx *= -0.15;
      car.vz *= 0.55;
    } else {
      impact = Math.max(impact, Math.abs(car.vz));
      car.z = wrap(b.z + Math.sign(dz || 1) * hd);
      car.vz *= -0.15;
      car.vx *= 0.55;
    }
  }
  return impact;
}
