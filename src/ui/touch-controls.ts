/**
 * Touch controls: steering on the left, pedals on the right.
 *
 * The previous scheme was one stick doing both axes, which is compact and quite
 * bad — steering and throttle are constantly fighting for the same thumb, and
 * any hard corner costs you the throttle.
 *
 * Three things matter here:
 *
 * 1. THE STEERING PAD FLOATS. There is no fixed circle to find. Wherever your
 *    thumb first lands becomes the centre, and steering is measured from there.
 *    On a tablet you cannot see your thumb and you are not looking at it anyway,
 *    so a control with a fixed position is a control you keep missing.
 *
 * 2. IT IS ALL MULTI-TOUCH. Every control captures its own pointerId, so
 *    steering with one thumb while holding throttle and stabbing drift with the
 *    other works. Pointer capture also means dragging off a control keeps it,
 *    rather than dropping the input the moment your thumb wanders — which on a
 *    phone is constantly.
 *
 * 3. HORIZONTAL ONLY. The steering pad ignores vertical movement entirely.
 *    Thumbs travel in arcs, so a two-axis reading picks up throttle you never
 *    asked for every time you turn.
 *
 * 4. THE PEDALS ARE ONE SURFACE, NOT THREE BUTTONS. A thumb holding GO can
 *    slide up onto DRIFT and hold both, because keeping your foot on the gas
 *    through a drift is the whole point of drifting and lifting off to reach a
 *    second button loses you the corner.
 */

export interface TouchState {
  /** −1..1 */
  steer: number;
  throttle: boolean;
  brake: boolean;
  drift: boolean;
  /** True while any touch control is being used, so the game can hide chrome. */
  active: boolean;
}

/** How far the thumb travels for full lock, in CSS pixels. */
const STEER_RADIUS = 62;
/** Ignore the first few pixels, or resting a thumb counts as steering. */
const STEER_DEADZONE = 0.06;

export interface TouchControls {
  readonly state: TouchState;
  /** 0..1 drift charge, drawn as a ring on the drift button. */
  setCharge(v: number): void;
  setBoosting(on: boolean): void;
  show(on: boolean): void;
}

export function createTouchControls(root: HTMLElement): TouchControls {
  const zone = root.querySelector<HTMLElement>('.steer-zone');
  const stick = root.querySelector<HTMLElement>('.steer-stick');
  const knob = root.querySelector<HTMLElement>('.steer-knob');
  if (!zone || !stick || !knob) throw new Error('touch controls markup is incomplete');

  const state: TouchState = {
    steer: 0, throttle: false, brake: false, drift: false, active: false
  };

  // ---------- floating steering pad ----------
  let steerPointer: number | null = null;
  let originX = 0;

  const showStick = (x: number, y: number) => {
    stick.style.transform = `translate(${x}px, ${y}px)`;
    stick.classList.add('on');
  };

  zone.addEventListener('pointerdown', e => {
    if (steerPointer !== null) return;              // one thumb steers, not two
    e.preventDefault();
    steerPointer = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    originX = e.clientX;
    state.active = true;
    showStick(e.clientX, e.clientY);
    knob.style.transform = 'translate(-50%, -50%)';
  });

  zone.addEventListener('pointermove', e => {
    if (e.pointerId !== steerPointer) return;
    const dx = e.clientX - originX;
    const clamped = Math.max(-STEER_RADIUS, Math.min(STEER_RADIUS, dx));
    const raw = clamped / STEER_RADIUS;
    // Rescale past the deadzone, then square it: fine control near centre,
    // full lock still reachable.
    const m = Math.abs(raw);
    state.steer = m < STEER_DEADZONE ? 0
      : Math.sign(raw) * Math.pow((m - STEER_DEADZONE) / (1 - STEER_DEADZONE), 1.5);
    knob.style.transform = `translate(calc(-50% + ${clamped}px), -50%)`;
  });

  const endSteer = (e: PointerEvent) => {
    if (e.pointerId !== steerPointer) return;
    steerPointer = null;
    state.steer = 0;
    stick.classList.remove('on');
    knob.style.transform = 'translate(-50%, -50%)';
  };
  zone.addEventListener('pointerup', endSteer);
  zone.addEventListener('pointercancel', endSteer);

  /* ---------- pedals ----------
   *
   * Handled as ONE pointer-tracking surface rather than three independent
   * buttons, so that a thumb already holding GO can slide up onto DRIFT and
   * hold both. Keeping your foot on the gas through a drift is the whole point
   * of drifting, and lifting off to reach a second button loses you the corner.
   *
   * The rule: a pointer holds the button it STARTED on, plus whatever button it
   * is currently over. Slide back down and you are on the throttle alone again.
   */
  const buttons = new Map<string, HTMLElement>();
  for (const key of ['accel', 'brake', 'drift'] as const) {
    const el = root.querySelector<HTMLElement>(`.btn-${key}`);
    if (!el) throw new Error(`missing touch control .btn-${key}`);
    buttons.set(key, el);
  }

  /** Which buttons each live pointer is holding. */
  const holds = new Map<number, Set<string>>();

  const hitTest = (x: number, y: number): string | null => {
    for (const [key, el] of buttons) {
      const r = el.getBoundingClientRect();
      // A circle, generously — thumbs are wide and the edges are the bit you miss.
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (Math.hypot(x - cx, y - cy) <= r.width / 2 + 10) return key;
    }
    return null;
  };

  const applyHolds = () => {
    const held = new Set<string>();
    for (const set of holds.values()) for (const key of set) held.add(key);
    state.throttle = held.has('accel');
    state.brake = held.has('brake');
    state.drift = held.has('drift');
    for (const [key, el] of buttons) el.classList.toggle('down', held.has(key));
  };

  const pedals = root.querySelector<HTMLElement>('.pedals');
  if (!pedals) throw new Error('missing .pedals');

  pedals.addEventListener('pointerdown', e => {
    const key = hitTest(e.clientX, e.clientY);
    if (!key) return;
    e.preventDefault();
    pedals.setPointerCapture(e.pointerId);
    holds.set(e.pointerId, new Set([key]));
    state.active = true;
    applyHolds();
  });

  pedals.addEventListener('pointermove', e => {
    const set = holds.get(e.pointerId);
    if (!set) return;
    const origin = set.values().next().value as string;
    const over = hitTest(e.clientX, e.clientY);
    // Origin is sticky; whatever is under the thumb right now joins it.
    const next = new Set([origin]);
    if (over) next.add(over);
    holds.set(e.pointerId, next);
    applyHolds();
  });

  const releasePointer = (e: PointerEvent) => {
    if (!holds.delete(e.pointerId)) return;
    applyHolds();
  };
  pedals.addEventListener('pointerup', releasePointer);
  pedals.addEventListener('pointercancel', releasePointer);

  const driftBtn = buttons.get('drift')!;

  // A losing-focus safety net: a backgrounded tab never sends pointerup.
  addEventListener('blur', () => {
    holds.clear();
    applyHolds();
    state.steer = 0;
    steerPointer = null;
    stick.classList.remove('on');
  });

  let lastCharge = -1;
  return {
    state,
    setCharge(v: number) {
      const rounded = Math.round(v * 20) / 20;      // 5% steps; it is a ring, not a readout
      if (rounded === lastCharge) return;
      lastCharge = rounded;
      driftBtn.style.setProperty('--charge', `${rounded * 360}deg`);
      driftBtn.classList.toggle('charged', v >= 1);
    },
    setBoosting(on: boolean) { driftBtn.classList.toggle('boosting', on); },
    show(on: boolean) { root.classList.toggle('on', on); }
  };
}
