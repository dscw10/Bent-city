/**
 * Modes exist mostly to keep one promise from context.md: the sandbox must
 * survive. The projection is still the thing under test, and a timer gets in
 * the way of testing it — so each place keeps one mode with no clock and
 * nothing chasing you, and that is the one to open when the question is "does
 * the view work".
 *
 * Every mode belongs to a PLACE. The city's shifts and the pass's runs are not
 * difficulty settings on one game; they are two games, and the mode list is
 * filtered by whichever place is selected.
 */
export interface Mode {
  id: string;
  /** Which level this is played on. */
  level: string;
  name: string;
  desc: string;
  /** Seconds on the clock. 0 = no clock at all. */
  duration: number;
  /** How many orders are live at once. City only. */
  maxOrders: number;
  /** Seconds an order survives before it expires. City only. */
  orderLife: [min: number, max: number];
  /** Rival couriers competing for the same orders. City only. */
  rivals: number;
  /** Road closures forcing you to route around them. City only. */
  closures: number;
  /** Seconds added to the clock per delivery, or per checkpoint on the pass. */
  timeBonus: number;
  /** Seconds lost when an order expires or is sniped. City only. */
  timePenalty: number;
  /** How much harder it gets per minute survived, 0 = not at all. */
  ramp: number;
}

/** The parts every mode shares, so a pass mode does not have to name city fields. */
const BASE = {
  maxOrders: 0,
  orderLife: [0, 0] as [number, number],
  rivals: 0,
  closures: 0,
  timePenalty: 0,
  ramp: 0
};

export const MODES: Mode[] = [
  {
    ...BASE,
    id: 'shift',
    level: 'city',
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
    ...BASE,
    id: 'rush',
    level: 'city',
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
    ...BASE,
    id: 'roam',
    level: 'city',
    name: 'Free roam',
    desc: 'No clock, no rivals, nothing expires. The sandbox the projection was built in — open this one to test the view.',
    duration: 0,
    maxOrders: 3,
    timeBonus: 0
  },
  {
    ...BASE,
    id: 'climb',
    level: 'pass',
    name: 'The climb',
    desc: 'Start line to summit against a clock only the checkpoints refill. Read the notes three corners ahead or run out of road.',
    /* 70 seconds is enough to reach the first gate at a pace that is quick but
       not desperate. Every gate then pays 22 back, so the run is survivable
       from the start and only becomes a race against the clock once you start
       losing time in the corners — which is the pacing the notes exist for. */
    duration: 70,
    timeBonus: 22
  },
  {
    ...BASE,
    id: 'recce',
    level: 'pass',
    name: 'Recce',
    desc: 'The same road with no clock. Learn where the tight ones are — that is what a recce is for, and it is the sandbox up here.',
    duration: 0,
    timeBonus: 0
  }
];

export const findMode = (id: string): Mode => MODES.find(m => m.id === id) ?? MODES[0];

export const modesFor = (level: string): Mode[] => MODES.filter(m => m.level === level);
