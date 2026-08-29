import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Gamepads, BTN } from '../src/ui/gamepad';

/**
 * A fake pad, because the real thing needs hardware and a person holding it.
 * The shapes here are the ones the spec actually produces: buttons are objects
 * with an analogue `value`, and a stick pushed FORWARD reports a NEGATIVE y.
 */
function fakePad(overrides: Partial<Gamepad> = {}): Gamepad {
  return {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    hapticActuators: [],
    vibrationActuator: null,
    ...overrides
  } as unknown as Gamepad;
}

let pad: Gamepad | null = null;

const press = (i: number, value = 1) => {
  (pad!.buttons as unknown as Array<{ pressed: boolean; touched: boolean; value: number }>)[i] =
    { pressed: value > 0.5, touched: value > 0, value };
};
const axis = (i: number, v: number) => {
  (pad!.axes as unknown as number[])[i] = v;
};

beforeEach(() => {
  pad = fakePad();
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => [pad] },
    configurable: true,
    writable: true
  });
});

afterEach(() => { pad = null; });

describe('gamepad', () => {
  it('reports nothing when no pad is connected', () => {
    pad = null;
    const g = new Gamepads();
    g.poll();
    expect(g.status.connected).toBe(false);
    expect(g.steer).toBe(0);
    expect(g.throttle).toBe(0);
  });

  it('detects a standard pad and reports a readable name', () => {
    const g = new Gamepads();
    g.poll();
    expect(g.status.connected).toBe(true);
    expect(g.status.standard).toBe(true);
    expect(g.status.id).toContain('Xbox');
  });

  it('reads the right trigger as an analogue throttle', () => {
    const g = new Gamepads();
    press(BTN.RT, 1);
    g.poll();
    expect(g.throttle).toBeCloseTo(1, 3);

    press(BTN.RT, 0);
    press(BTN.LT, 1);
    g.poll();
    expect(g.throttle).toBeCloseTo(-1, 3);
  });

  it('ignores trigger noise below the deadzone', () => {
    const g = new Gamepads();
    press(BTN.RT, 0.03);
    g.poll();
    expect(g.throttle).toBe(0);
  });

  it('accepts A and B for pads whose triggers are digital', () => {
    const g = new Gamepads();
    press(BTN.A);
    g.poll();
    expect(g.throttle).toBe(1);

    press(BTN.A, 0);
    press(BTN.B);
    g.poll();
    expect(g.throttle).toBe(-1);
  });

  it('steers from the left stick, with a deadzone and a soft centre', () => {
    const g = new Gamepads();
    axis(0, 0.1);
    g.poll();
    expect(g.steer).toBe(0);                    // inside the deadzone

    axis(0, 1);
    g.poll();
    expect(g.steer).toBeCloseTo(1, 3);

    axis(0, 0.5);
    g.poll();
    // Squared response: half travel gives well under half steering.
    expect(g.steer).toBeGreaterThan(0);
    expect(g.steer).toBeLessThan(0.35);
  });

  it('falls back to the left stick for throttle, with the sign the spec uses', () => {
    const g = new Gamepads();
    // Pushed forward is NEGATIVE y. Getting this backwards makes the truck
    // reverse when you ask it to go, which is a very confusing five minutes.
    axis(1, -1);
    g.poll();
    expect(g.throttle).toBeGreaterThan(0.9);

    axis(1, 1);
    g.poll();
    expect(g.throttle).toBeLessThan(-0.9);
  });

  it('does not let steering trip the stick throttle fallback', () => {
    const g = new Gamepads();
    axis(0, 1);      // full lock
    axis(1, -0.3);   // a little forward slop, as a thumb actually holds it
    g.poll();
    expect(g.throttle).toBe(0);
  });

  it('fires a button press once per frame, not once per poll', () => {
    const g = new Gamepads();
    press(BTN.START);
    g.poll();
    expect(g.pressed(BTN.START)).toBe(true);
    g.endFrame();
    g.poll();
    expect(g.pressed(BTN.START)).toBe(false);
    expect(g.down(BTN.START)).toBe(true);

    press(BTN.START, 0);
    g.poll();
    press(BTN.START);
    g.poll();
    expect(g.pressed(BTN.START)).toBe(true);
  });

  it('latches a press that happens entirely between two frames', () => {
    // The whole reason polling is decoupled from rendering: a tap can start and
    // finish inside one slow frame, and it must still be seen.
    const g = new Gamepads();
    g.poll();
    g.endFrame();
    press(BTN.A);
    g.poll();                 // pressed...
    press(BTN.A, 0);
    g.poll();                 // ...and released, both before the frame reads it
    expect(g.pressed(BTN.A)).toBe(true);
    expect(g.down(BTN.A)).toBe(false);
    g.endFrame();
    expect(g.pressed(BTN.A)).toBe(false);
  });

  it('stays quiet until the pad is actually touched', () => {
    // A paired-but-idle pad must not hide the on-screen joystick.
    const g = new Gamepads();
    g.poll();
    expect(g.inUse).toBe(false);
    press(BTN.A);
    g.poll();
    expect(g.inUse).toBe(true);
  });

  it('nets two menu presses that land in the same frame', () => {
    const g = new Gamepads();
    press(BTN.DOWN); g.poll(); press(BTN.DOWN, 0); g.poll();
    press(BTN.UP);   g.poll(); press(BTN.UP, 0);   g.poll();
    expect(g.menuStep(1000)).toBe(0);        // one each way cancels out
    g.endFrame();

    press(BTN.DOWN); g.poll(); press(BTN.DOWN, 0); g.poll();
    expect(g.menuStep(1000)).toBe(1);
  });

  it('steps a menu once per D-pad press, and repeats a held stick slowly', () => {
    const g = new Gamepads();
    press(BTN.DOWN);
    g.poll();
    expect(g.menuStep(1000)).toBe(1);
    g.endFrame();
    g.poll();
    expect(g.menuStep(1000)).toBe(0);            // held, not repeating

    press(BTN.DOWN, 0);
    g.endFrame();
    axis(1, 1);                                   // stick held back
    g.poll();
    expect(g.menuStep(2000)).toBe(1);
    expect(g.menuStep(2050)).toBe(0);             // too soon to repeat
    expect(g.menuStep(2400)).toBe(1);             // repeat after the delay
  });

  it('survives a pad that disappears mid-session', () => {
    const g = new Gamepads();
    press(BTN.RT, 1);
    g.poll();
    expect(g.throttle).toBeGreaterThan(0);
    pad = null;
    g.poll();
    expect(g.throttle).toBe(0);
    expect(g.status.connected).toBe(false);
  });

  it('handles a non-standard mapping without throwing', () => {
    pad = fakePad({ mapping: '' as GamepadMappingType, buttons: [] });
    const g = new Gamepads();
    axis(0, 1);
    g.poll();
    expect(g.status.standard).toBe(false);
    expect(g.steer).toBeCloseTo(1, 3);
  });

  it('never throws when asked to rumble a pad that cannot', () => {
    const g = new Gamepads();
    g.poll();
    expect(() => g.rumble(100, 1)).not.toThrow();
  });
});
