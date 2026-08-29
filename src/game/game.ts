import type { Level } from './levels';
import type { Mode } from './modes';
import type { Car } from '../vehicle/vehicle';
import type { Block } from '../render/scenery';
import type { Builder } from '../render/builder';
import type { Rival } from '../world/rivals';
import type { Traffic } from '../world/traffic';
import type { FrameEvents, HudView, Rules, RunOutcome } from './rules';
import { noEvents } from './rules';

export type Phase = 'title' | 'playing' | 'paused' | 'over';

/**
 * THE SHELL.
 *
 * Everything every run has, whichever place it is in: a phase, a set of toast
 * messages, the list of things the truck can hit, and a Rules object that knows
 * what the run is actually about.
 *
 * This used to BE the delivery game, and the split happened when the mountain
 * pass arrived. Worth being precise about what moved and what stayed, because
 * the line is not obvious: anything that would have to be answered differently
 * on a pass went into Rules (what is the objective, what does the HUD say, what
 * counts as a score, what gets drawn on the world). Anything that is the same
 * question either way stayed here (are we playing, what do we collide with,
 * where do toasts go).
 *
 * The one thing NEITHER of them knows about is the bend. Rules draw into a
 * Builder in ordinary world coordinates; the fold happens later, in the vertex
 * shader, and it stays that way.
 */
export class Game {
  phase: Phase = 'title';
  mode!: Mode;

  /** Toast lines the UI should show, drained each frame. */
  readonly messages: Array<{ text: string; bad: boolean }> = [];

  private collision: Block[] = [];
  private staticBlocks: Block[] = [];
  private level!: Level;
  private rules!: Rules;

  /** Point the shell at a place. Builds that place's rules. */
  bind(level: Level, staticBlocks: Block[]): void {
    this.level = level;
    this.staticBlocks = staticBlocks;
    this.collision = staticBlocks.slice();
    this.messages.length = 0;
    this.rules = level.makeRules({ network: level.network, messages: this.messages });
  }

  get current(): Level { return this.level; }
  get network() { return this.level.network; }
  get game(): Rules { return this.rules; }

  /** For the spatial audio, which does not care whose road it is. */
  get rivals(): Rival[] { return this.rules.rivals; }
  get traffic(): Traffic | null { return this.rules.traffic; }
  get intensity(): number { return this.rules.intensity; }

  start(mode: Mode, car: Car): void {
    this.mode = mode;
    this.phase = 'playing';
    this.messages.length = 0;
    this.rules.start(mode, car);
  }

  end(): void {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.committed = this.rules.commit();
  }

  private committed = false;
  /** Whether the last committed run was a personal best. */
  get wasBest(): boolean { return this.committed; }

  update(dt: number, car: Car): FrameEvents {
    if (this.phase !== 'playing') return noEvents();
    const out = this.rules.update(dt, car);
    if (out.finished) this.end();
    return out;
  }

  /** Everything the truck can hit this frame. */
  collisionSet(): Block[] {
    this.collision.length = 0;
    for (const b of this.staticBlocks) this.collision.push(b);
    for (const b of this.rules.extraBlocks()) this.collision.push(b);
    return this.collision;
  }

  refresh(car: Car): void { this.rules.refresh(car); }

  drawMarks(b: Builder, car: Car): void { this.rules.drawMarks(b, car); }
  drawMovers(b: Builder, car: Car): void { this.rules.drawMovers(b, car); }

  hud(car: Car): HudView { return this.rules.hud(car); }
  focus(car: Car): { x: number; z: number } | null { return this.rules.focus(car); }
  outcome(): RunOutcome { return this.rules.outcome(); }
}
