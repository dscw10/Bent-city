import type { Order } from '../game/dispatch';
import { wrapDist } from '../core/city-layout';

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
 * The one exception is the ORDER MANIFEST down the left edge. It is the textual
 * half of the same information the map shows spatially — the map tells you
 * where the orders are and who is racing you for them, the manifest tells you
 * exactly how long each has left. Neither is much use alone. Reading them
 * together, and deciding an order to serve them in, is the game.
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

  private rows = new Map<number, HTMLElement>();
  private toastTimer = 0;
  private lastClockText = '';

  show(on: boolean): void { this.root.classList.toggle('on', on); }

  setSpeed(mps: number): void {
    // 2.4 rather than 3.6: the truck's numbers are arcade numbers, and reading
    // "190" on a kei truck breaks the fiction harder than an inexact conversion.
    this.speed.textContent = String(Math.round(Math.abs(mps) * 2.4));
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

  setScore(yen: number, multiplier: number, streak: number): void {
    this.score.textContent = yen.toLocaleString('en-GB');
    this.combo.innerHTML = multiplier > 1
      ? `<span class="accent">&times;${multiplier}</span> &middot; ${streak} in a row`
      : '&nbsp;';
  }

  setTask(text: string, distance: number | null): void {
    if (this.what.innerHTML !== text) this.what.innerHTML = text;
    this.dist.textContent = distance === null ? '—' : `${Math.round(distance)} M`;
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
  setOrders(orders: Order[], carX: number, carZ: number, canDeliver: boolean): void {
    const seen = new Set<number>();
    const sorted = [...orders].sort((a, b) =>
      wrapDist(a.x, a.z, carX, carZ) - wrapDist(b.x, b.z, carX, carZ));

    for (let i = 0; i < sorted.length; i++) {
      const o = sorted[i];
      seen.add(o.id);
      let row = this.rows.get(o.id);
      if (!row) {
        row = document.createElement('div');
        row.className = 'order';
        row.innerHTML = '<i class="pip"></i><span class="tag"></span><span class="t"></span>';
        this.rows.set(o.id, row);
        this.manifest.appendChild(row);
      }
      const order = String(i);
      if (row.style.order !== order) row.style.order = order;

      const contested = o.claimedBy >= 0;
      row.classList.toggle('mine', canDeliver && !contested);
      row.classList.toggle('contested', contested);

      const d = Math.round(wrapDist(o.x, o.z, carX, carZ));
      const tag = row.querySelector<HTMLElement>('.tag')!;
      const label = `${o.hot ? '★ ' : ''}${d} m`;
      if (tag.textContent !== label) tag.textContent = label;

      const t = row.querySelector<HTMLElement>('.t')!;
      const text = o.life > 0 ? mmss(o.remaining) : '—';
      if (t.textContent !== text) t.textContent = text;
      t.classList.toggle('urgent', o.life > 0 && o.remaining < 12);
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
