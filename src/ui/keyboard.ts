/**
 * Keyboard input. Kept alongside the touch controls and the gamepad — whichever
 * is being pushed hardest wins, so nothing has to be "selected".
 */
export interface KeyboardInput {
  read(): { thr: number; str: number; drift: boolean };
  isDown(key: string): boolean;
  onPress(key: string, fn: () => void): void;
}

export function createKeyboard(): KeyboardInput {
  const keys: Record<string, boolean> = {};
  const presses = new Map<string, Array<() => void>>();
  const PREVENT = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'shift']);

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
    read() {
      let thr = 0;
      let str = 0;
      if (keys['w'] || keys['arrowup']) thr = 1;
      if (keys['s'] || keys['arrowdown'] || keys[' ']) thr = -1;
      if (keys['a'] || keys['arrowleft']) str = -1;
      if (keys['d'] || keys['arrowright']) str = 1;
      return { thr, str, drift: !!keys['shift'] };
    },
    isDown: (key: string) => !!keys[key],
    onPress(key: string, fn: () => void) {
      const list = presses.get(key) ?? [];
      list.push(fn);
      presses.set(key, list);
    }
  };
}
