import type { HudView, Slot } from '../game/rules';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
};

const mmss = (t: number): string => {
  const s = Math.max(0, Math.ceil(t));
  return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The HUD is deliberately quiet. The projection is what you are meant to be
 * reading; text on top of it is a fallback, not the interface.
 *
 * The one exception is the COLUMN down the left edge. It is the textual half of
 * the same information the map shows spatially, and each place fills it with
 * its own half of that pairing:
 *
 *   - in the city it is the order manifest. The map tells you where the drops
 *     are and who is racing you for them; the column tells you exactly how long
 *     each has left. Neither is much use alone, and reading them together is
 *     the game.
 *   - on the pass it is the pace notes. The map tells you the SHAPE of the road
 *     ahead; the column tells you the grade and the distance to each corner.
 *
 * The HUD knows about neither. It renders `Slot`s — a tag, a value, a sort
 * order and a couple of highlight flags — and the rules decide what they mean.
 */
export class Hud {
  private readonly root = el('hud');
  private readonly speed = el('speed');
  private readonly clock = el('clock');
  private readonly clockBar = el('clockBar');
  private readonly score = el('score');
  private readonly combo = el('combo');
  private readonly manifest = el('manifest');
  private readonly what = el('what');
  private readonly dist = el('dist');
  private readonly toastEl = el('toast');
  private readonly flashEl = el('flash');

  private rows = new Map<string, HTMLElement>();
  private toastTimer = 0;
  private lastClockText = '';

  show(on: boolean): void { this.root.classList.toggle('on', on); }

  setSpeed(mps: number): void {
    /* True km/h now. It used to be a fudged 2.4 because the truck did 167 km/h
       and reading that on a kei truck broke the fiction — but the honest fix
       was to slow the truck down, and at about 110 km/h flat out the real
       conversion is the believable one. */
    this.speed.textContent = String(Math.round(Math.abs(mps) * 3.6));
  }

  setClock(remaining: number, total: number, endless: boolean): void {
    const text = endless ? '∞' : mmss(remaining);
    if (text !== this.lastClockText) {
      this.clock.textContent = text;
      this.lastClockText = text;
    }
    const low = !endless && remaining <= 15;
    this.clock.classList.toggle('low', low);
    this.clockBar.classList.toggle('low', low);
    const frac = endless ? 1 : Math.max(0, Math.min(1, remaining / total));
    this.clockBar.style.transform = `scaleX(${frac})`;
  }

  /** Everything a live frame needs, in one call. */
  setView(v: HudView): void {
    this.setClock(v.clock, v.clockTotal, v.endless);
    if (this.score.textContent !== v.score) this.score.textContent = v.score;
    if (this.combo.innerHTML !== v.sub) this.combo.innerHTML = v.sub;
    if (this.what.innerHTML !== v.task) this.what.innerHTML = v.task;
    const d = v.distance === null ? '—' : `${Math.round(v.distance)} M`;
    if (this.dist.textContent !== d) this.dist.textContent = d;
    this.setSlots(v.slots);
  }

  /** Label above the big number: what the run is actually scored on. */
  setScoreLabel(text: string): void {
    const el = document.getElementById('scoreLabel');
    if (el && el.textContent !== text) el.textContent = text;
  }

  /**
   * Rows are reused rather than rebuilt, so the entry animation only plays for
   * genuinely new orders.
   *
   * They are re-ORDERED with the CSS `order` property rather than by moving
   * them in the DOM. Re-appending an element restarts its CSS animation, and
   * since this runs every frame the rows never got past the first keyframe —
   * the whole manifest sat at opacity 0 and looked like a bug in the game logic
   * rather than in three lines of CSS.
   */
  private setSlots(slots: Slot[]): void {
    const seen = new Set<string>();
    const sorted = [...slots].sort((a, b) => a.order - b.order);

    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      seen.add(s.key);
      let row = this.rows.get(s.key);
      if (!row) {
        row = document.createElement('div');
        row.className = 'order';
        row.innerHTML = '<i class="pip"></i><span class="tag"></span><span class="t"></span>';
        this.rows.set(s.key, row);
        this.manifest.appendChild(row);
      }
      const order = String(i);
      if (row.style.order !== order) row.style.order = order;

      row.classList.toggle('mine', !!s.live && !s.contested);
      row.classList.toggle('contested', !!s.contested);

      const tag = row.querySelector<HTMLElement>('.tag')!;
      if (tag.textContent !== s.tag) tag.textContent = s.tag;

      const t = row.querySelector<HTMLElement>('.t')!;
      if (t.textContent !== s.value) t.textContent = s.value;
      t.classList.toggle('urgent', !!s.urgent);
    }

    for (const [id, row] of this.rows) {
      if (!seen.has(id)) { row.remove(); this.rows.delete(id); }
    }
  }

  clearOrders(): void {
    for (const [, row] of this.rows) row.remove();
    this.rows.clear();
  }

  toast(text: string, bad = false): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.toggle('warn', bad);
    this.toastEl.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('on'), 1100);
  }

  flash(bad = false): void {
    this.flashEl.classList.toggle('bad', bad);
    this.flashEl.style.opacity = bad ? '0.42' : '0.5';
    setTimeout(() => { this.flashEl.style.opacity = '0'; }, 60);
  }
}
