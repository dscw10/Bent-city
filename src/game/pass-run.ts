import type { Builder } from '../render/builder';
import type { Block } from '../render/scenery';
import type { Car } from '../vehicle/vehicle';
import type { Mode } from './modes';
import type { Rival } from '../world/rivals';
import type { Traffic } from '../world/traffic';
import type {
  FrameEvents, HudView, ResultRow, Rules, RulesContext, RunOutcome, Slot
} from './rules';
import { noEvents } from './rules';
import { C } from '../core/palette';
import { clamp } from '../core/math';
import { P } from '../core/config';
import { save, recordTime } from './storage';
import {
  drawGradedRibbon, drawCornerBoard, drawNoteBoard, drawGate, gradeColour
} from '../render/markers';
import type { Point } from '../world/network';
import {
  PASS_LENGTH, PASS_ROAD_HALF, trackPoint, trackHeading, trackNearest, trackRadius
} from '../core/pass-shape';
import { findCorners, noteText, cornerPoint, PASS_DISTANCE } from './pace-notes';
import type { Corner } from './pace-notes';

/**
 * ==================== THE PASS'S GAME: A TIMED RUN ====================
 *
 * One road, a clock that only checkpoints refill, and no way back. It is the
 * city's shift structure stripped of every choice except the one that matters
 * here — how fast you are prepared to take the next corner — which is exactly
 * the point: the two places had to want DIFFERENT things from the projection or
 * the second one would only be a reskin.
 *
 * WHAT THE PLAN REGION DOES HERE. In the city it shows you four drops and lets
 * you sequence them. There is nothing to sequence on a pass, so instead it
 * carries the co-driver's information: the graded ribbon ahead is the road's
 * shape three or four corners deep, coloured by how tight each one is. You can
 * see a red stretch nine hundred metres up the valley at the same time as your
 * own bonnet, and the decision it asks for — lift now or carry it in — is one
 * you genuinely cannot make from a street-level view.
 *
 * Every note has the two components the projection demands, as always: a corner
 * board painted flat across the road (which is what survives onto the map) and
 * a board on a post out on the verge (which is what you see coming).
 */

/** How far off the centreline still counts as through a gate. */
const GATE_HALF = 16;
/** How far ahead the notes are drawn. Beyond this the fog has eaten them. */
const NOTE_RANGE = 950;
/** How far before a corner its roadside board is planted. */
const BOARD_LEAD = 70;
/** Metres of ROAD between ribbon samples. */
const RIBBON_STEP = 10;
/**
 * A board closer than this is not a warning, it is an obstruction: it arrives
 * beside the camera at three metres tall and fills a quarter of the frame.
 */
const BOARD_MIN = 42;
/** Where the graded ribbon starts, and how long it takes to reach full width. */
const RIBBON_NEAR = 60;
const RIBBON_FADE = 70;

interface Checkpoint { s: number }

/** The road never changes, so its corners are found once. */
const CORNERS: Corner[] = findCorners();

/**
 * Checkpoints, laid out by distance along the road.
 *
 * Each one is then nudged off any corner it lands in. A gate on the apex of a
 * hairpin is a gate you clip, and losing eight seconds to scenery you could not
 * have seen behind a board is not the kind of difficulty this is after.
 *
 * This got simpler with the track rewrite too: the parameter IS distance along
 * the road now, so there is nothing to invert. The old version binary-searched
 * an arc-length table forty times per gate, because a run of 55° corners packs
 * far more driving into the same slice of valley than a straight does and gates
 * spaced by the axis would have arrived in a rush there.
 */
/** Metres of road between checkpoints. Eight of them over the pass. */
const CHECKPOINT_SPACING = 620;

const CHECKPOINTS: Checkpoint[] = (() => {
  const out: Checkpoint[] = [];
  for (let s = CHECKPOINT_SPACING; s < PASS_LENGTH - 200; s += CHECKPOINT_SPACING) {
    let at = s;
    // Slide forward until the road is straight enough to hang a gate on.
    for (let tries = 0; tries < 30 && trackRadius(at) < 200; tries++) at += 12;
    out.push({ s: at });
  }
  return out;
})();

export class PassRules implements Rules {
  clock = 0;
  elapsed = 0;
  /** Index of the next gate. Equals CHECKPOINTS.length once they are all done. */
  private next = 0;
  private mode!: Mode;
  private finished = false;
  private completed = false;
  private lowWarned = false;
  private offTime = 0;
  private wasOff = false;
  private cleanNotes = 0;
  /** Furthest point reached, in metres of road. Never goes backwards. */
  private covered = 0;
  /** Where the truck is along the road right now. */
  private at = 0;
  /**
   * The best time before this run started. Snapshotted at the line: `commit()`
   * runs before the results screen is drawn, so reading it afterwards would
   * always report this run as the record it is being compared against.
   */
  private previous: number | undefined;

  /** Nothing else is on this road, and nothing else makes a noise on it. */
  readonly rivals: Rival[] = [];
  readonly traffic: Traffic | null = null;

  constructor(private readonly ctx: RulesContext) {}

  /** The music builds as the pass does — there is no combo up here to build it. */
  get intensity(): number { return clamp(this.covered / PASS_DISTANCE, 0, 1); }

  start(mode: Mode, car: Car): void {
    this.mode = mode;
    this.clock = mode.duration;
    this.elapsed = 0;
    this.next = 0;
    this.finished = false;
    this.completed = false;
    this.lowWarned = false;
    this.offTime = 0;
    this.wasOff = false;
    this.cleanNotes = 0;
    this.at = trackNearest(car.x, car.z).s;
    this.covered = this.at;
    this.previous = save.bestTime[mode.id];
  }

  refresh(): void { /* nothing here is togglable */ }

  extraBlocks(): Block[] { return []; }

  update(dt: number, car: Car): FrameEvents {
    const out = noEvents();
    if (this.finished) return out;

    this.elapsed += dt;
    /* One solve gives both halves of "where am I": how far along the road, and
       how far off it. Progress is measured along the ROAD now rather than along
       a straight axis — it has to be, because a hairpin doubles back and world
       z stopped being monotonic the moment the road became a real track. */
    const here = trackNearest(car.x, car.z);
    this.at = here.s;
    this.covered = Math.max(this.covered, here.s);

    // --- off the road, which on a mountain costs you rather than helping ---
    const off = here.d > PASS_ROAD_HALF + 1.5;
    if (off) this.offTime += dt;
    if (off && !this.wasOff && Math.abs(car.v) > 12) {
      this.ctx.messages.push({ text: 'Off the road', bad: true });
      this.cleanNotes = 0;
    }
    this.wasOff = off;

    // --- checkpoints ---
    while (this.next < CHECKPOINTS.length && here.s >= CHECKPOINTS[this.next].s) {
      const through = here.d < GATE_HALF;
      this.next++;
      if (through) {
        this.clock += this.mode.timeBonus;
        out.scored = this.mode.timeBonus;
        this.cleanNotes++;
        this.ctx.messages.push({
          text: `Checkpoint ${this.next}/${CHECKPOINTS.length} · +${this.mode.timeBonus}s`,
          bad: false
        });
      } else {
        out.lost = true;
        this.ctx.messages.push({ text: 'Missed the gate', bad: true });
      }
    }

    // --- the line ---
    if (here.s >= PASS_LENGTH - 6) {
      this.completed = true;
      this.finished = true;
      out.finished = true;
      return out;
    }

    // --- clock ---
    if (this.mode.duration > 0) {
      this.clock -= dt;
      if (this.clock <= 10 && !this.lowWarned) { this.lowWarned = true; out.ending = true; }
      if (this.clock > 10) this.lowWarned = false;
      if (this.clock <= 0) {
        this.clock = 0;
        this.finished = true;
        out.finished = true;
      }
    }
    return out;
  }

  focus(): { x: number; z: number } {
    const s = this.next < CHECKPOINTS.length ? CHECKPOINTS[this.next].s : PASS_LENGTH;
    const [x, z] = trackPoint(s);
    return { x, z };
  }

  /** The corners still ahead of the truck, nearest first. */
  private ahead(range = NOTE_RANGE): Corner[] {
    const out: Corner[] = [];
    for (const c of CORNERS) {
      if (c.exit < this.at - 8) continue;
      if (c.entry > this.at + range) break;
      out.push(c);
    }
    return out;
  }

  drawMarks(b: Builder, car: Car): void {
    const inv = 1 / P.buildH;

    /* ---- the graded ribbon: the road's shape, three or four corners deep ----
       Faded up across the fold rather than drawn to the bumper. The near field
       already answers "what is this corner" with a board painted across the
       road; the ribbon is for the three corners after it, and laying it over
       your own bonnet only costs you the road surface. */
    const path: Point[] = [];
    const colours = [];
    const widths: number[] = [];
    const from = Math.max(0, this.at - 6);
    const to = Math.min(PASS_LENGTH, this.at + NOTE_RANGE);
    /* Stepped along the ROAD, so a hairpin gets the same number of segments per
       metre driven as a straight does. Stepping along a world axis would draw
       the tight corners — the ones the ribbon exists for — as three points and
       a chord. */
    for (let s = from; s <= to; s += RIBBON_STEP) {
      path.push(trackPoint(s));
      colours.push(gradeColour(gradeAt(s)));
      widths.push(5.6 * clamp((s - this.at - RIBBON_NEAR) / RIBBON_FADE, 0, 1));
    }
    drawGradedRibbon(b, path, colours, widths);

    // ---- one board per corner, in both regions ----
    for (const c of this.ahead()) {
      const at = cornerPoint(c);
      drawCornerBoard(b, at.x, at.z, at.heading, c.grade);

      /* The roadside board goes on the OUTSIDE of the corner, where you are
         looking as you set the car up, and where the bank on the inside cannot
         hide it. */
      const bs = c.entry - BOARD_LEAD;
      if (bs > this.at + BOARD_MIN) {
        const [bx, bz] = trackPoint(bs);
        const h = trackHeading(bs);
        // Right of the direction of travel is (cos h, −sin h).
        const side = -c.dir * 11;
        drawNoteBoard(b, bx + Math.cos(h) * side, bz - Math.sin(h) * side, c.grade, inv);
      }
    }

    // ---- gates ----
    for (const g of CHECKPOINTS.slice(this.next, this.next + 2)) {
      if (g.s > this.at + NOTE_RANGE + 200) break;
      const [gx, gz] = trackPoint(g.s);
      drawGate(b, gx, gz, trackHeading(g.s), C.matcha, inv);
    }
    if (PASS_LENGTH < this.at + NOTE_RANGE + 400) {
      const [fx, fz] = trackPoint(PASS_LENGTH);
      drawGate(b, fx, fz, trackHeading(PASS_LENGTH), C.melon, inv);
    }
    void car;
  }

  drawMovers(): void { /* nothing lives up here */ }

  hud(_car: Car): HudView {
    const notes = this.ahead(700).slice(0, 5);
    const slots: Slot[] = notes.map((c, i) => {
      const d = Math.max(0, c.entry - this.at);
      return {
        key: `c${c.entry.toFixed(0)}`,
        tag: noteText(c),
        value: `${Math.round(d)} m`,
        order: d,
        live: i === 0,
        urgent: i === 0 && c.grade <= 2 && d < 160
      };
    });

    const left = Math.max(0, (this.next < CHECKPOINTS.length
      ? CHECKPOINTS[this.next].s : PASS_LENGTH) - this.at);
    const gate = this.next < CHECKPOINTS.length
      ? `Checkpoint <span class="accent">${this.next + 1}/${CHECKPOINTS.length}</span>`
      : 'To the <span class="accent">line</span>';

    return {
      clock: this.clock,
      clockTotal: this.mode.duration || 1,
      endless: this.mode.duration === 0,
      score: clockText(this.elapsed),
      sub: notes.length > 0
        ? `next <span class="accent">${noteText(notes[0])}</span>`
        : 'summit ahead',
      task: gate,
      distance: left,
      cargo: 0,
      slots
    };
  }

  outcome(): RunOutcome {
    const previous = this.previous;
    const isBest = this.completed && this.mode.duration > 0 &&
      (previous === undefined || this.elapsed < previous);

    const rows: ResultRow[] = [
      { label: 'Distance', value: `${Math.round(this.covered)} m of ${Math.round(PASS_DISTANCE)}` },
      { label: 'Checkpoints', value: `${this.next}/${CHECKPOINTS.length}` },
      { label: 'Off the road', value: `${this.offTime.toFixed(1)} s` }
    ];
    if (previous !== undefined) {
      rows.unshift(isBest
        ? { label: 'Previous best', value: clockText(previous), highlight: true }
        : { label: 'Best', value: clockText(previous) });
    }

    return {
      title: this.completed ? (isBest ? 'New best run' : 'Over the line') : 'Out of time',
      score: this.completed ? clockText(this.elapsed) : '—',
      rows
    };
  }

  commit(): boolean {
    if (!this.completed || this.mode.duration === 0) return false;
    return recordTime(this.mode.id, this.elapsed);
  }
}

/**
 * Grade of the road at a point, from a table built once.
 *
 * A linear scan of nineteen corners per ribbon segment would be a hundred scans
 * a frame; a lookup every four metres is 1300 bytes and one index.
 */
const GRADE_STEP = 4;
const GRADE_TABLE: Uint8Array = (() => {
  const n = Math.ceil(PASS_LENGTH / GRADE_STEP) + 1;
  const t = new Uint8Array(n).fill(6);
  for (const c of CORNERS) {
    const a = Math.floor(c.entry / GRADE_STEP), b = Math.ceil(c.exit / GRADE_STEP);
    for (let i = a; i <= b && i < n; i++) t[i] = c.grade;
  }
  return t;
})();

export function gradeAt(s: number): number {
  const i = Math.round(s / GRADE_STEP);
  if (i < 0 || i >= GRADE_TABLE.length) return 6;
  return GRADE_TABLE[i];
}

/** m:ss.t — tenths matter when the whole run is under four minutes. */
export function clockText(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

export { CHECKPOINTS };
