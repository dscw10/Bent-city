import type { Builder } from '../render/builder';
import type { Car } from '../vehicle/vehicle';
import type { Block } from '../render/scenery';
import type { Rival } from '../world/rivals';
import type { Traffic } from '../world/traffic';
import type { RoadNetwork } from '../world/network';
import type { Mode } from './modes';

/**
 * ======================= WHAT A GAME IS =======================
 *
 * The city and the pass are not the same game with different scenery. In the
 * city you are choosing an order to serve four simultaneous drops in, against
 * rivals, with a clock only deliveries refill. On the pass there is one road,
 * no choice of route and nothing to deliver — you are trying to get to the top
 * before the clock runs out, and the plan region has stopped being a map and
 * become a co-driver.
 *
 * Trying to express both through one set of rules produced a Dispatch with a
 * "no orders" mode and a HUD full of hidden rows. This interface is the seam
 * instead: the SHELL (game/game.ts) owns the things every run has — a phase, a
 * clock, toast messages, a collision set — and the RULES own everything that
 * makes a place its own game.
 *
 * What is deliberately NOT in here: anything about rendering the world, the
 * network's shape, or the bend. Rules draw marks into a Builder in ordinary
 * world coordinates and never learn that the far half of them is folded.
 */

/** A row on the results screen. */
export interface ResultRow { label: string; value: string; highlight?: boolean }

/** What the game wants the rest of the app to react to this frame. */
export interface FrameEvents {
  /** Something was scored — yen in the city, a checkpoint on the pass. */
  scored: number;
  restocked: boolean;
  /** An objective was lost, or a checkpoint missed. */
  lost: boolean;
  expired: boolean;
  snipedNow: boolean;
  scattered: number;
  /** The clock crossed into the last ten seconds this frame. */
  ending: boolean;
  /** The run reached its natural end — delivered out, or over the line. */
  finished: boolean;
}

export const noEvents = (): FrameEvents => ({
  scored: 0, restocked: false, lost: false, expired: false,
  snipedNow: false, scattered: 0, ending: false, finished: false
});

/** One line in the left-hand column: an order in the city, a note on the pass. */
export interface Slot {
  /** Stable identity, so a row is reused rather than rebuilt and re-animated. */
  key: string;
  /** The bold half — "★ 240 m", or "L2". */
  tag: string;
  /** The right-hand half — a countdown, or a distance. */
  value: string;
  /** Sorting weight, lowest first. Distance, normally. */
  order: number;
  /** Highlight states, which the two games use for different things. */
  live?: boolean;
  urgent?: boolean;
  contested?: boolean;
}

/** Everything the HUD draws, so it never has to know which game is running. */
export interface HudView {
  clock: number;
  clockTotal: number;
  endless: boolean;
  /** The big number, already formatted — yen, or a time. */
  score: string;
  /** Small line under it. HTML, because the combo has an accent span. */
  sub: string;
  /** The task line. HTML for the same reason. */
  task: string;
  /** Range to whatever you are being pointed at, or null for none. */
  distance: number | null;
  /** Crates aboard, which the truck's mesh draws. Zero where there is no cargo. */
  cargo: number;
  /** The left-hand column. */
  slots: Slot[];
}

/** Where a run's numbers go when it ends. */
export interface RunOutcome {
  title: string;
  /** The headline, formatted by the rules — "¥4,120" or "3:42". */
  score: string;
  rows: ResultRow[];
}

export interface RulesContext {
  network: RoadNetwork;
  /** Toast lines. Rules push, the shell drains. */
  messages: Array<{ text: string; bad: boolean }>;
}

export interface Rules {
  /** Begin a run. The car has already been placed on the level's spawn. */
  start(mode: Mode, car: Car): void;
  update(dt: number, car: Car): FrameEvents;

  /** Unlit marks: routes, rings, notes, gates. */
  drawMarks(b: Builder, car: Car): void;
  /** Lit movers: traffic and pedestrians. Nothing on the pass. */
  drawMovers(b: Builder, car: Car): void;

  /** Anything beyond the level's static scenery that the truck can hit. */
  extraBlocks(): Block[];

  hud(car: Car): HudView;
  /** Where the player is being pointed, for the dev warp. Null if nowhere. */
  focus(car: Car): { x: number; z: number } | null;

  outcome(): RunOutcome;
  /** Record the run against the save. Returns whether it was a personal best. */
  commit(): boolean;

  /** Rebuild anything the settings panel can toggle mid-run. */
  refresh(car: Car): void;

  /** For the audio's spatial world. Empty on a road with nothing else on it. */
  readonly rivals: Rival[];
  readonly traffic: Traffic | null;
  /** 0..1, feeding the music's intensity layer. */
  readonly intensity: number;
}
