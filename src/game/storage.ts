import { P, DEFAULT_BEND } from '../core/config';
import type { BendParams } from '../core/config';

/**
 * Everything the player has tuned or achieved, kept in localStorage.
 *
 * Bend settings are saved because they are the single most personal thing about
 * this game: how far ahead the world folds is a comfort setting as much as a
 * preference, and having to re-find your numbers every session would make
 * anyone stop touching the sliders — which is exactly the opposite of what the
 * sliders are for.
 */
const KEY = 'melonpan.save.v1';

export interface Settings {
  /** 0..1 master volume. */
  volume: number;
  muted: boolean;
  /** Scales the speed-reactive bend. 0 makes the projection completely static. */
  bendIntensity: number;
  /** Show traffic and pedestrians. Off is a meaningful performance lever. */
  cityLife: boolean;
  /**
   * Steering feel, 0 calm to 1 lively. Not an accuracy setting — it moves the
   * steering rate limit, the yaw inertia and the yaw damping together, because
   * what a thumb on glass wants and what an analogue stick wants are different
   * numbers.
   */
  steering: number;
  /**
   * Paint a turn arrow at the next junction. On, the near field answers the
   * immediate question and the map is only needed for the one after it. Off is
   * the sharpest test of whether the map is carrying its weight.
   */
  turnArrows: boolean;
  bend: BendParams;
}

export interface SaveData {
  settings: Settings;
  /** Best score per mode id. */
  best: Record<string, number>;
  /** Total deliveries ever, purely for the title screen. */
  totalDeliveries: number;
}

const DEFAULTS: SaveData = {
  settings: {
    volume: 0.75,
    muted: false,
    bendIntensity: 1,
    cityLife: true,
    steering: 0.28,
    turnArrows: true,
    bend: { ...DEFAULT_BEND }
  },
  best: {},
  totalDeliveries: 0
};

function read(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    return {
      settings: { ...DEFAULTS.settings, ...parsed.settings,
        bend: { ...DEFAULT_BEND, ...parsed.settings?.bend } },
      best: { ...parsed.best },
      totalDeliveries: parsed.totalDeliveries ?? 0
    };
  } catch {
    // Private browsing, a corrupt entry, storage disabled — none of it is worth
    // failing to start the game over.
    return structuredClone(DEFAULTS);
  }
}

export const save: SaveData = read();

export function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch { /* nothing useful to do; the game plays fine without it */ }
}

/** Push the saved bend numbers into the live parameter block. */
export function applySavedBend(): void {
  Object.assign(P, save.settings.bend);
}

/** Capture the live bend numbers back into the save. */
export function captureBend(): void {
  save.settings.bend = { ...P };
  persist();
}

export function recordScore(modeId: string, score: number): boolean {
  const prev = save.best[modeId] ?? 0;
  if (score <= prev) return false;
  save.best[modeId] = score;
  persist();
  return true;
}
