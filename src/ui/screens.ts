import { modesFor } from '../game/modes';
import type { Mode } from '../game/modes';
import { LEVELS, LEVEL_ORDER } from '../game/levels';
import { save, persist } from '../game/storage';
import type { ResultRow } from '../game/rules';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
};

export type { ResultRow };

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
  private place = 0;
  private modes: Mode[] = modesFor(LEVEL_ORDER[0]);
  private selected: Mode = this.modes[0];
  private modeButtons: HTMLElement[] = [];
  private placeButtons: HTMLElement[] = [];
  private controllerRow: HTMLElement | null = null;

  constructor(private readonly cb: ScreenCallbacks) {
    this.buildPlaceList();
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

  /**
   * Move the mode selection by one, for D-pad navigation.
   *
   * It runs off the end of one place's modes and into the next place's rather
   * than wrapping inside a place, so a controller can reach every run in the
   * game with one axis and never has to find a second control for the picker.
   */
  cycleMode(delta: number): void {
    const i = this.modes.indexOf(this.selected);
    const next = i + delta;
    if (next < 0) {
      this.selectPlace((this.place - 1 + LEVEL_ORDER.length) % LEVEL_ORDER.length, -1);
    } else if (next >= this.modes.length) {
      this.selectPlace((this.place + 1) % LEVEL_ORDER.length, 0);
    } else {
      this.selectMode(next);
    }
  }

  /** `pick` is the mode index to land on: 0 for the first, −1 for the last. */
  private selectPlace(index: number, pick = 0): void {
    this.place = index;
    this.modes = modesFor(LEVEL_ORDER[index]);
    this.placeButtons.forEach((b, i) => b.classList.toggle('sel', i === index));
    this.buildModeList();
    this.selectMode(pick < 0 ? this.modes.length - 1 : pick);
  }

  private selectMode(index: number): void {
    this.selected = this.modes[index];
    this.modeButtons.forEach((b, i) => b.classList.toggle('sel', i === index));
    this.showTitle();          // refresh the best line for this mode
  }

  /** Live controller state, shown on the pause screen so a first pairing is diagnosable. */
  setControllerStatus(text: string): void {
    if (this.controllerRow && this.controllerRow.textContent !== text) {
      this.controllerRow.textContent = text;
    }
  }

  showTitle(): void {
    this.setOnly(this.title);
    const n = save.totalDeliveries;
    const tally = `${n} ${n === 1 ? 'delivery' : 'deliveries'} all told`;

    // The two places are scored on different things, so the best line has to
    // ask the right question: most yen in the city, least time on the pass.
    const time = save.bestTime[this.selected.id];
    const yen = save.best[this.selected.id] ?? 0;
    const name = this.selected.name.toLowerCase();
    el('titleBest').textContent =
      time !== undefined ? `Best ${name} — ${mmssT(time)} · ${tally}`
      : yen > 0 ? `Best ${name} — ¥${yen.toLocaleString('en-GB')} · ${tally}`
      : tally;

    const btn = el('startBtn');
    btn.textContent = this.selected.level === 'pass' ? 'Start the run' : 'Start shift';
  }

  showPause(modeName: string): void {
    this.setOnly(this.pause);
    el('pauseSub').textContent = modeName;
  }

  showResult(title: string, score: string, rows: ResultRow[]): void {
    this.setOnly(this.result);
    el('resultEyebrow').textContent = title;
    el('resultScore').textContent = score;
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

  private buildPlaceList(): void {
    const list = el('placeList');
    for (let i = 0; i < LEVEL_ORDER.length; i++) {
      // Built rather than played: this only needs the name and the blurb, and
      // constructing a level is a road network and nothing else until build().
      const level = LEVELS[LEVEL_ORDER[i]]();
      const btn = document.createElement('button');
      btn.className = 'place';
      btn.innerHTML =
        `<span class="name">${level.name}</span><span class="desc">${level.blurb}</span>`;
      btn.addEventListener('click', () => this.selectPlace(i));
      this.placeButtons.push(btn);
      list.appendChild(btn);
    }
    this.placeButtons[0].classList.add('sel');
  }

  private buildModeList(): void {
    const list = el('modeList');
    list.innerHTML = '';
    this.modeButtons = [];
    for (let i = 0; i < this.modes.length; i++) {
      const m = this.modes[i];
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

/** m:ss.t, matching how a pass run is reported everywhere else. */
function mmssT(t: number): string {
  const m = Math.floor(t / 60);
  const rest = t - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}
