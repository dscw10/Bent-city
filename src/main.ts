import { World } from './render/world';
import { Projection } from './render/projection';
import { makeCar, stepVehicle, resetCar } from './vehicle/vehicle';
import { collideBlocks } from './vehicle/collision';
import { buildCar } from './vehicle/car-mesh';
import { createKeyboard } from './ui/keyboard';
import { createTouchControls } from './ui/touch-controls';
import { Gamepads, BTN } from './ui/gamepad';
import { createTuner } from './ui/tuner';
import { Hud } from './ui/hud';
import { Screens } from './ui/screens';
import type { ResultRow } from './ui/screens';
import { Game } from './game/game';
import type { Mode } from './game/modes';
import { nodePos } from './core/city-layout';
import { save, applySavedBend, captureBend, persist } from './game/storage';
import { P } from './core/config';
import { uniforms } from './render/uniforms';
import { GameAudio } from './audio';

/* ---------------------------------------------------------------------------
   Bootstrap. Everything above this file is either rendering, physics or rules;
   this is the only place the three meet.
   --------------------------------------------------------------------------- */

applySavedBend();

const world = new World(document.getElementById('stage')!);
const projection = new Projection();
const car = makeCar();
const carMesh = buildCar(world.scene);
const hud = new Hud();
const game = new Game();
const audio = new GameAudio();

game.bind(world.city.blocks);
projection.intensity = save.settings.bendIntensity;

/** Where a shift begins: central, and not on top of a bakery. */
const START_X = nodePos(4);
const START_Z = nodePos(4);

const touch = createTouchControls(document.getElementById('touch')!);
const keyboard = createKeyboard();
const pads = new Gamepads();
// Polled on its own timer, so a quick tap is never lost to a slow frame.
pads.startPolling();
const tuner = createTuner(
  document.getElementById('tuner')!,
  document.getElementById('tuneBtn')!,
  captureBend
);


const topbarEl = document.getElementById('topbar')!;
const muteBtn = document.getElementById('muteBtn')!;
const pauseBtn = document.getElementById('pauseBtn')!;
const padNote = document.getElementById('padNote');

const screens = new Screens({
  onStart: startRun,
  onResume: resume,
  onQuit: () => { game.end(); showResults(); },
  onRestart: () => startRun(game.mode),
  onMenu: toMenu,
  onSettingsChanged: applySettings
});

function applySettings(): void {
  projection.intensity = save.settings.bendIntensity;
  audio.setVolume(save.settings.volume);
  audio.setMuted(save.settings.muted);
  // Persist here rather than in each caller: the mute button and the M key
  // both reach settings without going through the settings panel, and both
  // silently failed to save before this.
  persist();
  syncMuteButton();
  if (game.phase === 'playing' || game.phase === 'paused') game.refreshCityLife(car);
}

function syncMuteButton(): void {
  const on = !save.settings.muted;
  muteBtn.textContent = on ? 'Sound on' : 'Sound off';
  muteBtn.setAttribute('aria-pressed', String(!on));
}

function setPlayingChrome(on: boolean): void {
  hud.show(on);
  // The touch controls are dead weight once a controller is in play.
  touch.show(on && !pads.inUse);
  topbarEl.classList.toggle('on', on);
  if (!on) tuner.close();
}

function startRun(mode: Mode): void {
  // The Start button is the user gesture the AudioContext has been waiting for.
  audio.begin(save.settings.volume, save.settings.muted);
  resetCar(car, START_X, START_Z, 0);
  projection.reset(car.a);
  world.chase.reset();
  hud.clearOrders();
  game.start(mode, car);
  carMesh.setCargo(game.crates);
  screens.hideAll();
  setPlayingChrome(true);
  last = performance.now();
}

function pause(): void {
  if (game.phase !== 'playing') return;
  game.phase = 'paused';
  screens.showPause(game.mode.name);
  setPlayingChrome(false);
}

function resume(): void {
  if (game.phase !== 'paused') return;
  audio.resume();
  game.phase = 'playing';
  screens.hideAll();
  setPlayingChrome(true);
  // Otherwise the first frame back gets the whole paused wall-clock as its dt.
  last = performance.now();
}

function toMenu(): void {
  game.phase = 'title';
  hud.clearOrders();
  setPlayingChrome(false);
  screens.showTitle();
}

function showResults(): void {
  audio.finish();
  const s = game.stats;
  const { previous, isBest } = game.commitScore();
  const rows: ResultRow[] = [
    { label: 'Delivered', value: String(s.deliveries) },
    { label: 'Longest streak', value: String(s.bestStreak) },
    { label: 'Expired', value: String(s.expired) },
    { label: 'Beaten to it', value: String(s.sniped) },
    {
      label: 'Time on shift',
      value: `${Math.floor(s.elapsed / 60)}:${String(Math.floor(s.elapsed % 60)).padStart(2, '0')}`
    }
  ];
  if (isBest && previous > 0) {
    rows.unshift({ label: 'Previous best', value: `¥${previous.toLocaleString('en-GB')}`, highlight: true });
  }
  screens.showResult(isBest ? 'New best shift' : 'Shift over', s.yen, rows);
  setPlayingChrome(false);
}

// ---------- shortcuts ----------
keyboard.onPress('escape', () => {
  if (game.phase === 'playing') pause();
  else if (game.phase === 'paused') resume();
});
keyboard.onPress('p', () => { if (game.phase === 'playing') pause(); });
keyboard.onPress('t', () => { if (game.phase === 'playing') tuner.toggle(); });
keyboard.onPress('m', () => { save.settings.muted = !save.settings.muted; applySettings(); });

pauseBtn.addEventListener('click', pause);
muteBtn.addEventListener('click', () => {
  save.settings.muted = !save.settings.muted;
  applySettings();
});
// A phone locking or the tab going away mid-run should not cost you the shift.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
  else audio.resume();
});

/**
 * Controller. Deliberately a small, fixed vocabulary rather than a focus model:
 * on a screen there are only ever two or three things worth doing, and a pad
 * that needs a cursor to press "Start shift" is worse than one that does not.
 */
function readGamepadUi(now: number): void {
  pads.poll();          // belt and braces: the timer may be throttled in background

  const st = pads.status;
  const label = !st.connected ? 'press a button'
    : st.standard ? shortPadName(st.id)
    : `${shortPadName(st.id)} (non-standard)`;
  screens.setControllerStatus(label);

  if (padNote) {
    const text = st.connected ? `\u2014 ${label} connected` : '\u2014 press a button on the pad to wake it';
    if (padNote.textContent !== text) padNote.textContent = text;
    padNote.parentElement?.classList.toggle('pad-live', st.connected);
  }

  switch (screens.open) {
    case 'title': {
      const step = pads.menuStep(now);
      if (step) screens.cycleMode(step);
      if (pads.pressed(BTN.A) || pads.pressed(BTN.START)) startRun(screens.mode);
      return;
    }
    case 'pause':
      if (pads.pressed(BTN.A) || pads.pressed(BTN.START)) resume();
      else if (pads.pressed(BTN.Y)) { game.end(); showResults(); }
      return;
    case 'result':
      if (pads.pressed(BTN.A) || pads.pressed(BTN.START)) startRun(game.mode);
      else if (pads.pressed(BTN.B)) toMenu();
      return;
    default:
      if (pads.pressed(BTN.START) || pads.pressed(BTN.SELECT)) pause();
      if (pads.pressed(BTN.X)) { save.settings.muted = !save.settings.muted; applySettings(); }
      if (pads.pressed(BTN.Y)) tuner.toggle();
      // Hide the touch controls the first time the pad is actually used.
      if (pads.inUse) touch.show(false);
  }
}

/** "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e...)" is not a label. */
function shortPadName(id: string): string {
  const cut = id.replace(/\s*\((?:STANDARD GAMEPAD|Vendor|Product).*$/i, '').trim();
  // Trimmed generously and left to CSS to ellipsis, so the useful part of an
  // unusual pad's name survives instead of being chopped mid-word.
  return (cut || id).slice(0, 44);
}

// ---------- loop ----------
let last = performance.now();

function tick(now: number): void {
  requestAnimationFrame(tick);

  // Cap dt: a long stall must not teleport the truck through a building, and
  // three substeps of a two-second frame is not a simulation.
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;

  const live = game.phase === 'playing';
  let throttle = 0;

  readGamepadUi(now);

  if (live) {
    const k = keyboard.read();
    const t = touch.state;
    const touchThr = (t.throttle ? 1 : 0) - (t.brake ? 1 : 0);

    /* Three input sources, and whichever is being pushed hardest wins — so a
       controller, the touch controls and the keyboard coexist without anything
       having to be "selected", and picking up a pad mid-run just works. */
    const strongest = (...v: number[]) =>
      v.reduce((best, x) => (Math.abs(x) > Math.abs(best) ? x : best), 0);
    const thr = strongest(pads.throttle, k.thr, touchThr);
    const str = strongest(pads.steer, k.str, t.steer);
    const drift = pads.drift || k.drift || t.drift;
    throttle = thr;

    // Three substeps: the springs are stiff and one big step goes unstable.
    const sub = dt / 3;
    const blocks = game.collisionSet();
    let impact = 0;
    car.boostFired = 0;
    for (let i = 0; i < 3; i++) {
      stepVehicle(car, sub, thr, str, drift);
      impact = Math.max(impact, collideBlocks(car, blocks));
    }
    if (car.boostFired > 0) {
      world.chase.addKick(0.5 + car.boostFired * 1.4);
      pads.rumble(220, 0.55);
      audio.boost(car.boostFired);
    }
    touch.setCharge(car.driftCharge);
    touch.setBoosting(car.boost > 0);
    car.impact = impact;
    if (impact > 6) {
      world.chase.addKick(Math.min(1.6, impact * 0.06));
      pads.rumble(90 + impact * 4, Math.min(1, impact / 22));
    }

    const ev = game.update(dt, car);
    carMesh.setCargo(game.crates);
    audio.impact(impact);

    if (ev.delivered > 0) {
      hud.flash(false);
      world.chase.addKick(0.5);
      audio.delivered(game.multiplier);
      pads.rumble(140, 0.35);
    }
    if (ev.restocked) audio.restocked();
    if (ev.expired) audio.expired();
    if (ev.snipedNow) audio.sniped();
    if (ev.scattered > 0) audio.scattered();
    if (ev.lost || ev.scattered > 0) { hud.flash(true); pads.rumble(200, 0.5); }
    for (const m of game.messages.splice(0)) hud.toast(m.text, m.bad);
    audio.clock(game.clock, game.mode.duration === 0);

    if (game.phase === 'over') showResults();
  }

  carMesh.sync(car);

  audio.update(
    dt, car, throttle, live,
    game.rivals.list, game.traffic,
    GameAudio.musicState(car.v, game.clock, game.mode?.duration ?? 0, game.stats.streak)
  );

  // The projection and camera keep running while paused, so the world behind
  // the menu stays alive rather than becoming a frozen screenshot.
  projection.update(dt, car);
  world.chase.update(dt, car, projection.resp);

  if (live) {
    hud.setSpeed(car.v);
    hud.setClock(game.clock, game.mode.duration || 1, game.mode.duration === 0);
    hud.setScore(game.stats.yen, game.multiplier, game.stats.streak);
    hud.setOrders(game.dispatch.orders, car.x, car.z, game.crates > 0);
    hud.setTask(game.taskText(), game.focusDistance(car));
  }

  const marks = world.marks.begin();
  if (game.phase !== 'title') game.drawMarks(marks, car);
  world.marks.end();

  const movers = world.movers.begin();
  if (game.phase !== 'title') game.drawMovers(movers, car);
  world.movers.end();

  world.setFrame(car.x, car.z, projection.aLag);
  world.cullTiles(car.x, car.z, projection.aLag);
  world.render();

  pads.endFrame();
}

/* AUDIO UNLOCK. A browser will not start an AudioContext without a user
   gesture — and a GAMEPAD BUTTON DOES NOT COUNT as one. So a player who pairs a
   controller and never touches the screen would drive in silence forever, with
   nothing to suggest why.

   Any real gesture anywhere on the page therefore starts the audio, whether or
   not it was the Start button. Once it is running these listeners remove
   themselves. */
function unlockAudio(): void {
  audio.begin(save.settings.volume, save.settings.muted);
  audio.resume();
  for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) {
    removeEventListener(ev, unlockAudio);
  }
}
for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) {
  addEventListener(ev, unlockAudio, { passive: true });
}

// ---------- go ----------
addEventListener('resize', () => world.resize());
world.resize();
resetCar(car, START_X, START_Z, 0);
projection.reset(car.a);
carMesh.setCargo(0);
syncMuteButton();
screens.showTitle();
requestAnimationFrame(tick);

// Dev-only inspection hooks, stripped from production builds by Vite.
if (import.meta.env.DEV) {
  // Put the truck on whatever it is currently being routed to. Software
  // rendering runs at a fifth of real time, so driving a full shift in a
  // headless browser is not a practical way to test the delivery chain.
  (window as unknown as Record<string, unknown>).__warp = () => {
    const f = game.focus(car);
    resetCar(car, f.x, f.z, car.a);
    return f;
  };
  // Wind the shift clock down, to reach the results screen without waiting.
  (window as unknown as Record<string, unknown>).__setClock = (s: number) => {
    game.clock = s;
  };

  // Measures the real RMS on the master bus, so "is there actually sound"
  // can be answered without a person and a pair of headphones.
  let analyser: AnalyserNode | null = null;
  (window as unknown as Record<string, unknown>).__level = () => {
    const a = (audio as unknown as { audio: { ctx: AudioContext | null; master: GainNode } }).audio;
    if (!a.ctx) return null;
    if (!analyser) {
      analyser = a.ctx.createAnalyser();
      analyser.fftSize = 2048;
      a.master.connect(analyser);
    }
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  };

  (window as unknown as Record<string, unknown>).__dbg = () => ({
    phase: game.phase,
    orders: game.dispatch.orders.length,
    closures: game.dispatch.closures.length,
    crates: game.crates,
    rivals: game.rivals.list.map(r => [Math.round(r.x), Math.round(r.z), r.targetId]),
    traffic: game.traffic.cars.length,
    peds: game.pedestrians.list.length,
    car: [Math.round(car.x), Math.round(car.z)],
    heading: car.a,
    stats: { ...game.stats, yen: game.stats.yen, clock: Math.round(game.clock) },
    focus: game.focus(car),
    routeLen: (game as unknown as { route: unknown[] }).route.length,
    markVerts: world.marks.builder.p.length / 3,
    moverVerts: world.movers.builder.p.length / 3,
    audio: (audio as unknown as { audio: { ctx: AudioContext | null } }).audio.ctx?.state ?? 'none',
    drawnVerts: world.scene.children
      .filter((o): o is import('three').Mesh => (o as import('three').Mesh).isMesh && o.visible)
      .reduce((n, m) => n + (m.geometry.getAttribute('position')?.count ?? 0), 0),
    kinds: world.city.kinds.flat().reduce<Record<string, number>>(
      (acc, k) => { acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    blocks: world.city.blocks.length,
    visibleTiles: world.visibleTiles,
    bend: { ...P },
    car2: {
      drifting: car.drifting, driftCharge: car.driftCharge,
      boost: car.boost, v: car.v
    },
    uniforms: {
      uZ0: uniforms.uZ0.value,
      uR: uniforms.uR.value,
      uKmin: uniforms.uKmin.value,
      uEase: uniforms.uEase.value,
      uPhiMaxDeg: uniforms.uPhiMax.value * 180 / Math.PI,
      uFallA: uniforms.uFallA.value,
      uBendEnd: [uniforms.uBendEnd.value.x, uniforms.uBendEnd.value.y],
      uFogEnd: uniforms.uFogEnd.value
    }
  });
}
