import { P, DEFAULT_BEND } from '../core/config';
import type { BendParams } from '../core/config';
import { uniforms, computeBendEnd } from '../render/uniforms';

/**
 * The "Tune the bend" panel. Every parameter of the projection is exposed live,
 * because the projection is still the thing under test — the settings that ship
 * as defaults were arrived at by moving these sliders while driving, not by
 * reasoning about them.
 */
interface Slider {
  key: keyof BendParams;
  label: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  hint: string;
  /** Applied after P[key] is set. */
  apply?: (v: number) => void;
}

const applyR = (v: number) => { uniforms.uR.value = v; computeBendEnd(); };

export const SLIDERS: Slider[] = [
  { key: 'z0', label: 'Bend start', min: 8, max: 200, step: 1, decimals: 0,
    hint: 'The life-size street ahead of you at a standstill.' },
  { key: 'push', label: 'Speed push', min: 0, max: 240, step: 1, decimals: 0,
    hint: 'How much further out the bend start travels at full speed. 0 freezes the view; high values give you a long road when moving and a wide map when not.' },
  { key: 'R', label: 'Curl radius', min: 5, max: 120, step: 1, decimals: 0,
    hint: 'How tightly the world folds up. Small = a sharp horizon.', apply: applyR },
  { key: 'kMin', label: 'Map scale', min: 0.12, max: 1, step: 0.01, decimals: 2,
    hint: '1.00 is life size; drop it and the fold shrinks the world as it lifts, so the map covers far more ground.',
    apply: v => computeBendEnd(v) },
  { key: 'ease', label: 'Fold easing', min: 0, max: 1, step: 0.01, decimals: 2,
    hint: '0.00 is a constant-radius arc, which reads as a chamfered edge. 1.00 eases curvature in and out from zero, like a clothoid on a motorway slip road.',
    apply: v => { uniforms.uEase.value = v; computeBendEnd(); } },
  { key: 'flat', label: 'Map flatten', min: 0, max: 0.6, step: 0.01, decimals: 2,
    hint: 'How much building height survives onto the map. 0.00 lays them perfectly flat. Turn it to 0.60 to see the problem it solves.',
    apply: v => { uniforms.uFlat.value = v; } },
  { key: 'fall', label: 'Map falloff', min: 0, max: 1, step: 0.01, decimals: 2,
    hint: 'Compresses distance the higher up the map you go, so the far end of the route folds into finite screen height. 0.00 is a linear map.' },
  { key: 'buildH', label: 'Building height', min: 0.1, max: 1.4, step: 0.01, decimals: 2,
    hint: 'Global scale. Lower buildings mean less of the map hidden behind them.',
    apply: v => { uniforms.uBuildH.value = v; } },
  { key: 'lock', label: 'Map lock', min: 0, max: 1, step: 0.01, decimals: 2,
    hint: '0.00 turns the map with you. 1.00 world-locks it so north stays north and only the transition band twists. In between, the map swings lazily behind your turns.' },
  { key: 'camDist', label: 'Camera distance', min: 5, max: 46, step: 0.5, decimals: 1,
    hint: 'Pulls back and up along one diagonal.' }
];

export interface Tuner {
  toggle(): void;
  close(): void;
  readonly open: boolean;
  syncFromParams(): void;
}

export function createTuner(
  panel: HTMLElement,
  button: HTMLElement,
  onChange?: () => void
): Tuner {
  const inputs = new Map<keyof BendParams, HTMLInputElement>();
  const readouts = new Map<keyof BendParams, HTMLElement>();

  for (const s of SLIDERS) {
    const wrap = document.createElement('div');
    wrap.className = 'ctrl';
    wrap.innerHTML =
      `<label>${s.label} <b></b></label>` +
      `<input type="range" min="${s.min}" max="${s.max}" step="${s.step}">`;
    const out = wrap.querySelector('b')!;
    const input = wrap.querySelector('input')!;
    input.value = String(P[s.key]);
    out.textContent = P[s.key].toFixed(s.decimals);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      P[s.key] = v;
      out.textContent = v.toFixed(s.decimals);
      s.apply?.(v);
      onChange?.();
    });
    inputs.set(s.key, input);
    readouts.set(s.key, out);
    panel.appendChild(wrap);
  }

  const reset = document.createElement('button');
  reset.className = 'tuner-reset';
  reset.textContent = 'Reset to defaults';
  reset.addEventListener('click', () => {
    Object.assign(P, DEFAULT_BEND);
    applyAll();
    api.syncFromParams();
    onChange?.();
  });
  panel.appendChild(reset);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML = SLIDERS.map(s => `<b>${s.label}</b> — ${s.hint}`).join('<br>');
  panel.appendChild(hint);

  function applyAll(): void {
    uniforms.uR.value = P.R;
    uniforms.uEase.value = P.ease;
    uniforms.uFlat.value = P.flat;
    uniforms.uBuildH.value = P.buildH;
    computeBendEnd(P.kMin);
  }

  const api: Tuner = {
    get open() { return panel.classList.contains('on'); },
    toggle() {
      panel.classList.toggle('on');
      button.classList.toggle('active', panel.classList.contains('on'));
    },
    close() {
      panel.classList.remove('on');
      button.classList.remove('active');
    },
    syncFromParams() {
      for (const s of SLIDERS) {
        inputs.get(s.key)!.value = String(P[s.key]);
        readouts.get(s.key)!.textContent = P[s.key].toFixed(s.decimals);
      }
    }
  };

  button.addEventListener('click', () => api.toggle());
  return api;
}
