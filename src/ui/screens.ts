import { MODES } from '../game/modes';
import type { Mode } from '../game/modes';
import { save, persist } from '../game/storage';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
};

export interface ResultRow { label: string; value: string; highlight?: boolean }

export interface ScreenCallbacks {
  onStart(mode: Mode): void;
  onResume(): void;
  onQuit(): void;
  onRestart(): void;
  onMenu(): void;
  onSettingsChanged(): void;
}

/**
 * Title, pause and results. Three overlays over the same running scene — the
 * world keeps rendering behind them, because a frozen frame behind a menu makes
 * a game feel switched off rather than paused.
 */
export type OpenScreen = 'title' | 'pause' | 'result' | null;

export class Screens {
  private readonly title = el('titleScreen');
  private readonly pause = el('pauseScreen');
  private readonly result = el('resultScreen');
  private selected: Mode = MODES[0];
  private modeButtons: HTMLElement[] = [];
  private controllerRow: HTMLElement | null = null;

  constructor(private readonly cb: ScreenCallbacks) {
    this.buildModeList();
    this.buildSettings();

    el('startBtn').addEventListener('click', () => this.cb.onStart(this.selected));
    el('resumeBtn').addEventListener('click', () => this.cb.onResume());
    el('quitBtn').addEventListener('click', () => this.cb.onQuit());
    el('againBtn').addEventListener('click', () => this.cb.onRestart());
    el('menuBtn').addEventListener('click', () => this.cb.onMenu());
  }

  get mode(): Mode { return this.selected; }

  get anyOpen(): boolean { return this.open !== null; }

  /** Which screen is up, so a controller knows what its buttons mean. */
  get open(): OpenScreen {
    if (this.title.classList.contains('on')) return 'title';
    if (this.pause.classList.contains('on')) return 'pause';
    if (this.result.classList.contains('on')) return 'result';
    return null;
  }

  /** Move the mode selection by one, for D-pad navigation. Wraps. */
  cycleMode(delta: number): void {
    const i = MODES.indexOf(this.selected);
    const next = (i + delta + MODES.length) % MODES.length;
    this.selectMode(next);
  }

  private selectMode(index: number): void {
    this.selected = MODES[index];
    this.modeButtons.forEach((b, i) => b.classList.toggle('sel', i === index));
    this.showTitle();          // refresh the best-score line for this mode
  }

  /** Live controller state, shown on the pause screen so a first pairing is diagnosable. */
  setControllerStatus(text: string): void {
    if (this.controllerRow && this.controllerRow.textContent !== text) {
      this.controllerRow.textContent = text;
    }
  }

  showTitle(): void {
    this.setOnly(this.title);
    const best = save.best[this.selected.id] ?? 0;
    const n = save.totalDeliveries;
    const tally = `${n} ${n === 1 ? 'delivery' : 'deliveries'} all told`;
    el('titleBest').textContent = best > 0
      ? `Best ${this.selected.name.toLowerCase()} — ¥${best.toLocaleString('en-GB')} · ${tally}`
      : tally;
  }

  showPause(modeName: string): void {
    this.setOnly(this.pause);
    el('pauseSub').textContent = modeName;
  }

  showResult(title: string, score: number, rows: ResultRow[]): void {
    this.setOnly(this.result);
    el('resultEyebrow').textContent = title;
    el('resultScore').textContent = `¥${score.toLocaleString('en-GB')}`;
    const box = el('resultRows');
    box.innerHTML = '';
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = r.highlight ? 'r hi' : 'r';
      div.innerHTML = `<span>${r.label}</span><b>${r.value}</b>`;
      box.appendChild(div);
    }
  }

  hideAll(): void {
    for (const s of [this.title, this.pause, this.result]) s.classList.remove('on');
  }

  private setOnly(target: HTMLElement): void {
    this.hideAll();
    target.classList.add('on');
  }

  private buildModeList(): void {
    const list = el('modeList');
    for (let i = 0; i < MODES.length; i++) {
      const m = MODES[i];
      const btn = document.createElement('button');
      btn.className = 'mode';
      btn.innerHTML =
        `<i class="dot"></i><span><span class="name">${m.name}</span>` +
        `<span class="desc">${m.desc}</span></span>`;
      btn.addEventListener('click', () => this.selectMode(i));
      this.modeButtons.push(btn);
      list.appendChild(btn);
    }
    this.modeButtons[0].classList.add('sel');
  }

  /**
   * Settings live on the pause screen rather than behind their own menu,
   * because every one of them is something you want to change the moment you
   * notice it — mid-run, not before you start.
   */
  private buildSettings(): void {
    const list = el('settingsList');

    list.appendChild(this.toggleRow(
      'Sound', 'Engine, tyres, city and music.',
      () => !save.settings.muted,
      v => { save.settings.muted = !v; persist(); this.cb.onSettingsChanged(); }
    ));

    list.appendChild(this.sliderRow(
      'Volume', '', 0, 1, 0.05,
      () => save.settings.volume,
      v => { save.settings.volume = v; persist(); this.cb.onSettingsChanged(); },
      v => `${Math.round(v * 100)}`
    ));

    list.appendChild(this.sliderRow(
      'Bend intensity',
      'How much speed pushes the fold outward. The effect is aggressive by design — turn it down if it makes you queasy, and 0 freezes the projection completely.',
      0, 1, 0.05,
      () => save.settings.bendIntensity,
      v => { save.settings.bendIntensity = v; persist(); this.cb.onSettingsChanged(); },
      v => `${Math.round(v * 100)}`
    ));

    list.appendChild(this.toggleRow(
      'Traffic', 'Other vehicles on the road. Off while the driving is being tuned.',
      () => save.settings.traffic,
      v => { save.settings.traffic = v; persist(); this.cb.onSettingsChanged(); }
    ));

    list.appendChild(this.toggleRow(
      'Pedestrians', 'People on the pavements. The cheaper half of the crowd, and the biggest single frame-rate lever on a slow device.',
      () => save.settings.pedestrians,
      v => { save.settings.pedestrians = v; persist(); this.cb.onSettingsChanged(); }
    ));

    list.appendChild(this.sliderRow(
      'Steering',
      'Calm to lively. Moves the steering rate, the yaw inertia and the damping together — this is a feel setting, not an accuracy one.',
      0, 1, 0.02,
      () => save.settings.steering,
      v => { save.settings.steering = v; persist(); this.cb.onSettingsChanged(); },
      v => v < 0.2 ? 'calm' : v > 0.75 ? 'lively' : `${Math.round(v * 100)}`
    ));

    list.appendChild(this.sliderRow(
      'Power',
      'How quick the truck is. At full power a city block goes past in under two seconds, which is not long enough to read the map — so this is a pacing setting as much as a performance one.',
      0.6, 1.4, 0.05,
      () => save.settings.power,
      v => { save.settings.power = v; persist(); this.cb.onSettingsChanged(); },
      v => `${Math.round(v * 100)}`
    ));

    list.appendChild(this.toggleRow(
      'Turn arrows',
      'Paints the next turn on the road. With it on, the street answers the immediate question and the map is only needed for the corner after that — turn it off to find out whether you are really reading the map.',
      () => save.settings.turnArrows,
      v => { save.settings.turnArrows = v; persist(); this.cb.onSettingsChanged(); }
    ));

    // A controller readout. A pad does not exist to the browser until a button
    // is pressed on it, so "not detected" is genuinely ambiguous and the row
    // has to say what to do about it rather than just reporting a negative.
    const { row, ctl } = this.row('Controller', 'A / ✕ resume · Y / △ end shift · Start pauses.');
    const status = document.createElement('span');
    status.className = 'num controller-status';
    status.textContent = 'press a button';
    ctl.appendChild(status);
    this.controllerRow = status;
    list.appendChild(row);
  }

  private row(name: string, sub: string): { row: HTMLElement; ctl: HTMLElement } {
    const row = document.createElement('div');
    row.className = 'setting';
    const text = document.createElement('div');
    text.innerHTML = `<div class="name">${name}</div>` + (sub ? `<div class="sub">${sub}</div>` : '');
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    row.append(text, ctl);
    return { row, ctl };
  }

  private toggleRow(name: string, sub: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const { row, ctl } = this.row(name, sub);
    const btn = document.createElement('button');
    btn.className = 'toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', name);
    const sync = () => btn.setAttribute('aria-pressed', String(get()));
    btn.addEventListener('click', () => { set(!get()); sync(); });
    sync();
    ctl.appendChild(btn);
    return row;
  }

  private sliderRow(
    name: string, sub: string, min: number, max: number, step: number,
    get: () => number, set: (v: number) => void, fmt: (v: number) => string
  ): HTMLElement {
    const { row, ctl } = this.row(name, sub);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(get());
    input.setAttribute('aria-label', name);
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = fmt(get());
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      set(v);
      num.textContent = fmt(v);
    });
    ctl.append(input, num);
    return row;
  }
}
