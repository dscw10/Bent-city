/**
 * One virtual joystick, both axes, spring-centred.
 *   horizontal -> steering
 *   vertical   -> push up to accelerate, down to brake
 *
 * Built on pointer events with POINTER CAPTURE, so dragging off the pad keeps
 * control rather than dropping it — which is what happens constantly on a phone
 * once the stick is anywhere near the screen edge.
 */
export interface Stick { x: number; y: number; active: boolean }

export function createJoystick(base: HTMLElement): Stick {
  const knob = base.querySelector<HTMLElement>('.knob');
  if (!knob) throw new Error('joystick is missing its .knob');

  const RAD = 40;                        // how far the knob travels, in pixels
  const state: Stick = { x: 0, y: 0, active: false };
  let pointer: number | null = null;

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    const r = base.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > RAD) { dx = dx / len * RAD; dy = dy / len * RAD; }
    state.x = dx / RAD;
    state.y = -dy / RAD;                 // y positive = pushed up = throttle
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  const end = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    state.active = false;
    base.classList.remove('live');
    state.x = 0; state.y = 0;
    knob.style.transform = 'translate(0,0)';
  };

  base.addEventListener('pointerdown', e => {
    e.preventDefault();
    pointer = e.pointerId;
    base.setPointerCapture(e.pointerId);
    state.active = true;
    base.classList.add('live');
    move(e);
  });
  base.addEventListener('pointermove', move);
  base.addEventListener('pointerup', end);
  base.addEventListener('pointercancel', end);

  return state;
}

/** Keyboard, which overrides the stick while a key is held. */
export function createKeyboard(): {
  read(stick: Stick): { thr: number; str: number };
  isDown(key: string): boolean;
  onPress(key: string, fn: () => void): void;
} {
  const keys: Record<string, boolean> = {};
  const presses = new Map<string, Array<() => void>>();
  const PREVENT = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ']);

  addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (PREVENT.has(k)) e.preventDefault();
    if (!keys[k]) presses.get(k)?.forEach(fn => fn());
    keys[k] = true;
  });
  addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
  // Held keys stick down forever if the tab loses focus mid-press.
  addEventListener('blur', () => { for (const k of Object.keys(keys)) keys[k] = false; });

  return {
    read(stick: Stick) {
      let thr = stick.y;
      let str = stick.x;
      if (keys['w'] || keys['arrowup']) thr = 1;
      if (keys['s'] || keys['arrowdown'] || keys[' ']) thr = -1;
      if (keys['a'] || keys['arrowleft']) str = -1;
      if (keys['d'] || keys['arrowright']) str = 1;
      return { thr, str };
    },
    isDown: (key: string) => !!keys[key],
    onPress(key: string, fn: () => void) {
      const list = presses.get(key) ?? [];
      list.push(fn);
      presses.set(key, list);
    }
  };
}
