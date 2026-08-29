/**
 * Gamepad support, aimed squarely at an iPad with a controller paired over
 * Bluetooth — an Xbox pad, a DualSense, a Backbone or anything MFi.
 *
 * Three things about the Gamepad API that catch people out, and all three are
 * handled here:
 *
 * 1. THE PAD DOES NOT EXIST UNTIL YOU PRESS SOMETHING. Safari (and Chrome) will
 *    not report a connected pad, and will not fire `gamepadconnected`, until the
 *    player presses a button on it. So this polls `navigator.getGamepads()`
 *    every frame rather than trusting the connect event, and the UI has to be
 *    able to say "press a button on your controller" rather than "no controller
 *    found".
 * 2. THE SNAPSHOT IS STALE. `getGamepads()` returns a fresh snapshot each call
 *    in most engines, but the objects are not live — you must re-read every
 *    frame, never cache the Gamepad object.
 * 3. TRIGGERS ARE BUTTONS, NOT AXES, under the standard mapping — buttons 6 and
 *    7, with an analogue `.value`. Reading them as axes gets you nothing on
 *    exactly the controllers people actually own.
 *
 * Polling runs on its own timer rather than in the render loop. There is no
 * input event to subscribe to — the API is poll-only — so tying it to frames
 * means a quick tap can fall entirely between two of them the moment the frame
 * rate dips, and a menu button that works at 60fps and not at 15 is a horrible
 * thing to debug. Presses are latched here and consumed once per frame.
 *
 * Controls:
 *   left stick X   steer
 *   RT / R2        throttle (analogue)
 *   LT / L2        brake (analogue)
 *   A / ✕          throttle, for pads whose triggers are digital
 *   B / ○          brake
 *   Start / Options pause
 *   X / □          mute
 *   Y / △          bend tuner
 *   D-pad + A      menu navigation, so you never have to reach for the screen
 */

export const BTN = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  SELECT: 8, START: 9,
  L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15
} as const;

export type Button = typeof BTN[keyof typeof BTN];

/** Sticks rest noisily. Below this, treat it as centred. */
const STICK_DEADZONE = 0.16;
/**
 * The left stick doubles as a throttle only as a last resort, for a pad whose
 * triggers report as axes. The deadzone is deliberately large so it cannot fire
 * by accident while steering.
 */
const STICK_THROTTLE_DEADZONE = 0.5;
const TRIGGER_DEADZONE = 0.06;

/** Rescale past the deadzone so the first usable degree of travel is gentle. */
function curve(v: number, dead: number): number {
  const m = Math.abs(v);
  if (m < dead) return 0;
  const t = (m - dead) / (1 - dead);
  return Math.sign(v) * t * t;          // squared: fine control near centre
}

export interface GamepadStatus {
  connected: boolean;
  id: string;
  /** True when the pad reports the standard button/axis layout. */
  standard: boolean;
}

export class Gamepads {
  private index: number | null = null;
  private held: boolean[] = [];
  /** Buttons pressed since the last `endFrame()`. Latched, never dropped. */
  private pending: boolean[] = [];
  private lastId = '';
  private standard = true;
  /** True once the player has actually moved something on the pad. */
  private used = false;
  private timer = 0;

  /**
   * Start polling independently of the frame rate. Safe to call more than once.
   * 60Hz costs an array copy and a few floats.
   */
  startPolling(hz = 60): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.poll(), Math.round(1000 / hz));
  }

  stopPolling(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  steer = 0;
  /** −1 full brake, +1 full throttle. Same convention as the touch stick. */
  throttle = 0;

  get status(): GamepadStatus {
    return { connected: this.index !== null, id: this.lastId, standard: this.standard };
  }

  /** True once a pad has been touched — used to hide the on-screen joystick. */
  get inUse(): boolean { return this.used; }

  /** Read every frame. Cheap; it is an array copy and a few floats. */
  poll(): void {
    const pads = navigator.getGamepads?.() ?? [];
    let pad: Gamepad | null = null;

    // Prefer the pad already in use; otherwise adopt the first connected one.
    if (this.index !== null) pad = pads[this.index] ?? null;
    if (!pad) {
      this.index = null;
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p?.connected) { pad = p; this.index = i; break; }
      }
    }

    if (!pad) {
      this.steer = 0;
      this.throttle = 0;
      this.held.length = 0;
      return;
    }

    this.lastId = pad.id;
    this.standard = pad.mapping === 'standard';

    const axis = (i: number) => pad.axes[i] ?? 0;
    const button = (i: number) => {
      const b = pad.buttons[i];
      return typeof b === 'object' ? b.value : (b ?? 0);
    };
    const isDown = (i: number) => {
      const b = pad.buttons[i];
      return typeof b === 'object' ? b.pressed : (b ?? 0) > 0.5;
    };

    this.steer = curve(axis(0), STICK_DEADZONE);

    // Triggers first, then face buttons, then the stick as a last resort.
    let throttle = curve(button(BTN.RT), TRIGGER_DEADZONE);
    let brake = curve(button(BTN.LT), TRIGGER_DEADZONE);
    if (isDown(BTN.A)) throttle = 1;
    if (isDown(BTN.B)) brake = 1;
    if (isDown(BTN.UP)) throttle = 1;
    if (isDown(BTN.DOWN)) brake = 1;
    if (throttle === 0 && brake === 0) {
      // Note the sign: on a gamepad, pushing the stick UP gives a NEGATIVE Y.
      const y = -axis(1);
      const v = curve(y, STICK_THROTTLE_DEADZONE);
      if (v > 0) throttle = v; else brake = -v;
    }
    this.throttle = throttle - brake;

    // Edge detection. A new press is LATCHED rather than reported for one poll
    // only, so the frame that eventually reads it cannot miss it however late
    // it arrives.
    for (let i = 0; i < pad.buttons.length; i++) {
      const down = isDown(i);
      if (down && !this.held[i]) this.pending[i] = true;
      this.held[i] = down;
      if (down) this.used = true;
    }
    if (Math.abs(this.steer) > 0.4 || Math.abs(this.throttle) > 0.4) this.used = true;
  }

  /** True if the button has gone down since the last `endFrame()`. */
  pressed(button: Button): boolean { return this.pending[button] === true; }

  down(button: Button): boolean { return this.held[button] === true; }

  /** Clear the latched presses. Call once per frame, after acting on them. */
  endFrame(): void { this.pending.length = 0; }

  /**
   * −1, 0 or +1 once per press, from the D-pad or the left stick. Menu
   * navigation wants discrete steps, and a stick held forward must not scroll
   * a list at sixty items a second.
   */
  private repeatAt = 0;
  menuStep(now: number): number {
    // Both directions are summed rather than one winning, because two presses
    // can latch into the same frame when the frame rate dips — and silently
    // dropping one of them is exactly the bug this latching exists to avoid.
    let dir = (this.pressed(BTN.DOWN) ? 1 : 0) + (this.pressed(BTN.UP) ? -1 : 0);
    if (dir === 0 && !this.pressed(BTN.DOWN) && !this.pressed(BTN.UP)) {
      const y = -(navigator.getGamepads?.()[this.index ?? -1]?.axes[1] ?? 0);
      if (Math.abs(y) > 0.6) {
        if (now - this.repeatAt > 280) { this.repeatAt = now; dir = y > 0 ? -1 : 1; }
      } else {
        this.repeatAt = 0;
      }
    }
    return dir;
  }

  /**
   * A short rumble. Support is patchy and inconsistent across browsers and
   * pads, so every part of this is optional and failure is silent — a missing
   * rumble is not worth an exception in the frame loop.
   */
  rumble(duration: number, strong: number, weak = strong * 0.6): void {
    if (this.index === null) return;
    const pad = navigator.getGamepads?.()[this.index];
    const actuator = (pad as unknown as {
      vibrationActuator?: { playEffect(type: string, opts: object): Promise<string> };
    })?.vibrationActuator;
    if (!actuator?.playEffect) return;
    try {
      void actuator.playEffect('dual-rumble', {
        duration, strongMagnitude: strong, weakMagnitude: weak
      }).catch(() => { /* unsupported effect type */ });
    } catch { /* no rumble here */ }
  }
}
