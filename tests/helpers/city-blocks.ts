import { Builder } from '../../src/render/builder';
import { BUILDERS } from '../../src/render/blocks';
import type { BlockKind } from '../../src/render/blocks';
import { makeRandom } from '../../src/core/math';
import { GRID, PITCH, nodePos } from '../../src/core/city-layout';
import type { Block } from '../../src/render/city';

/**
 * Run every block archetype and collect the collision footprints, without
 * needing a scene or a GPU. Lets the tests reason about the city's geometry —
 * chiefly whether any two buildings leave a gap the truck cannot fit through.
 */
export function buildCityBlocks(seed = 20260826): Block[] {
  const b = new Builder();
  const rnd = makeRandom(seed);
  const blocks: Block[] = [];
  const kinds = Object.keys(BUILDERS) as BlockKind[];

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = nodePos(i) + PITCH / 2;
      const cz = nodePos(j) + PITCH / 2;
      // Every archetype, several times each, rather than the shipped mix — the
      // question is whether any layout CAN produce a trap, not whether today's
      // random seed happens to.
      const kind = kinds[(i * GRID + j) % kinds.length];
      BUILDERS[kind]({ b, cx, cz, rnd, push: block => blocks.push(block) });
    }
  }
  return blocks;
}
