/**
 * Modes exist mostly to keep one promise from context.md: the sandbox must
 * survive. The projection is still the thing under test, and a timer gets in
 * the way of testing it — so Free roam has no clock, no rivals and no expiry,
 * and it is the mode to open when the question is "does the view work".
 *
 * The other two are the actual game.
 */
export interface Mode {
  id: string;
  name: string;
  desc: string;
  /** Seconds on the clock. 0 = no clock at all. */
  duration: number;
  /** How many orders are live at once. */
  maxOrders: number;
  /** Seconds an order survives before it expires. */
  orderLife: [min: number, max: number];
  /** Rival couriers competing for the same orders. */
  rivals: number;
  /** Road closures forcing you to route around them. */
  closures: number;
  /** Seconds added to the clock per delivery, before the distance bonus. */
  timeBonus: number;
  /** Seconds lost when an order expires or is sniped. */
  timePenalty: number;
  /** How much harder it gets per minute survived, 0 = not at all. */
  ramp: number;
}

export const MODES: Mode[] = [
  {
    id: 'shift',
    name: 'Evening shift',
    desc: 'A clock that only deliveries can refill. Two rivals working the same streets, and roadworks that move.',
    duration: 180,
    maxOrders: 4,
    orderLife: [52, 82],
    rivals: 2,
    closures: 3,
    timeBonus: 9,
    timePenalty: 4,
    ramp: 0.34
  },
  {
    id: 'rush',
    name: 'Rush hour',
    desc: 'Shorter clock, tighter orders, four rivals and the city half shut. For when the shift stops being frightening.',
    duration: 130,
    maxOrders: 5,
    orderLife: [38, 60],
    rivals: 4,
    closures: 6,
    timeBonus: 8,
    timePenalty: 6,
    ramp: 0.62
  },
  {
    id: 'roam',
    name: 'Free roam',
    desc: 'No clock, no rivals, nothing expires. The sandbox the projection was built in — open this one to test the view.',
    duration: 0,
    maxOrders: 3,
    orderLife: [0, 0],
    rivals: 0,
    closures: 0,
    timeBonus: 0,
    timePenalty: 0,
    ramp: 0
  }
];

export const findMode = (id: string): Mode => MODES.find(m => m.id === id) ?? MODES[0];
