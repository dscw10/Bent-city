/**
 * The whole game is three greys, one green and one warm crust colour.
 * Values are linear-ish rgb 0..1, fed straight into vertex colours.
 *
 * Flat untextured surfaces are not just an aesthetic choice: they bend cleanly.
 * The photogrammetry meshes in the original reference look melty under the same
 * warp because their detail distorts. Simple shapes don't.
 */
export type RGB = [number, number, number];

export const C = {
  face:   [0.98, 0.98, 0.99] as RGB,   // building front faces
  face2:  [0.90, 0.91, 0.93] as RGB,   // a second tone so blocks aren't uniform
  roof:   [0.80, 0.82, 0.85] as RGB,
  road:   [0.76, 0.78, 0.81] as RGB,
  kerb:   [0.88, 0.89, 0.91] as RGB,
  park:   [0.72, 0.79, 0.75] as RGB,
  dash:   [1.00, 1.00, 1.00] as RGB,
  matcha: [0.50, 0.65, 0.31] as RGB,   // the one accent
  melon:  [0.91, 0.78, 0.48] as RGB,   // melonpan crust
  deck:   [0.83, 0.85, 0.86] as RGB,
  lot:    [0.80, 0.81, 0.83] as RGB,
  deckS:  [0.68, 0.70, 0.73] as RGB,
  ink:    [0.07, 0.09, 0.10] as RGB,
  rival:  [0.78, 0.34, 0.30] as RGB,   // rival couriers — the only warm red
  hazard: [0.86, 0.55, 0.22] as RGB,   // road closures
  traffic:[0.62, 0.65, 0.70] as RGB    // other vehicles: deliberately mute
} as const;

/** Side faces are shaded a touch darker so box edges read without an outline. */
export const shade = (c: RGB): RGB => [c[0] * 0.86, c[1] * 0.88, c[2] * 0.90];

/** CSS hex for the same colours, for the HUD. */
export const CSS = {
  paper: '#EDEFF1',
  ink: '#12161A',
  shadow: '#9AA3AB',
  matcha: '#7FA650',
  melon: '#E8C87A',
  rival: '#C7574C',
  hazard: '#DB8C38'
} as const;
