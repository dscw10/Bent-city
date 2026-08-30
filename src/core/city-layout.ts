/**
 * The city's dimensions — the two or three facts that are still constants now
 * that its streets are generated rather than laid out on a lattice.
 *
 * The city is one TILE, drawn 5×5 around the player. The player's position is
 * wrapped into the home tile every frame, so the surrounding copies never move:
 * no streaming, no pop-in, one shared geometry.
 *
 * Note what is NOT here any more. The wrap arithmetic moved to `core/place.ts`
 * when a mountain pass arrived, because a pass has two ends. The grid pitch,
 * the block size, the junction positions and the off-road test moved out when
 * the city stopped being a grid: streets, blocks and pavements all come off the
 * plan in `world/networks/organic.ts`, and the lattice survives only as a test
 * fixture in tests/helpers/lattice.ts.
 */
export const TILE = 522;               // the repeat distance
export const ROADW = 14;               // road width
export const TILES_ACROSS = 5;         // how many copies are drawn per axis
