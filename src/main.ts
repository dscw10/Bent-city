import { World } from './render/world';
import { Projection } from './render/projection';
import { makeCar, stepVehicle, resetCar } from './vehicle/vehicle';
import { collideBlocks } from './vehicle/collision';
import { buildCar } from './vehicle/car-mesh';
import { createJoystick, createKeyboard } from './ui/joystick';
import { createTuner } from './ui/tuner';
import { Hud } from './ui/hud';
import { Screens } from './ui/screens';
import type { ResultRow } from './ui/screens';
import { Game } from './game/game';
import type { Mode } from './game/modes';
import { nodePos } from './core/city-layout';
import { save, applySavedBend, captureBend } from './game/storage';

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

game.bind(world.city.blocks);
projection.intensity = save.settings.bendIntensity;

/** Where a shift begins: central, and not on top of a bakery. */
const START_X = nodePos(4);
const START_Z = nodePos(4);

const stick = createJoystick(document.getElementById('stickL')!);
const keyboard = createKeyboard();
const tuner = createTuner(
  document.getElementById('tuner')!,
  document.getElementById('tuneBtn')!,
  captureBend
);

const sticksEl = document.getElementById('sticks')!;
const topbarEl = document.getElementById('topbar')!;
const muteBtn = document.getElementById('muteBtn')!;
const pauseBtn = document.getElementById('pauseBtn')!;

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
  sticksEl.classList.toggle('on', on);
  topbarEl.classList.toggle('on', on);
  if (!on) tuner.close();
}

function startRun(mode: Mode): void {
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
  const s = game.stats;
  const isBest = game.commitScore();
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
  if (isBest) {
    rows.unshift({ label: 'Previous best beaten', value: 'yes', highlight: true });
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
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

// ---------- loop ----------
let last = performance.now();

function tick(now: number): void {
  requestAnimationFrame(tick);

  // Cap dt: a long stall must not teleport the truck through a building, and
  // three substeps of a two-second frame is not a simulation.
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;

  const live = game.phase === 'playing';

  if (live) {
    const { thr, str } = keyboard.read(stick);

    // Three substeps: the springs are stiff and one big step goes unstable.
    const sub = dt / 3;
    const blocks = game.collisionSet();
    let impact = 0;
    for (let i = 0; i < 3; i++) {
      stepVehicle(car, sub, thr, str);
      impact = Math.max(impact, collideBlocks(car, blocks));
    }
    car.impact = impact;
    if (impact > 6) world.chase.addKick(Math.min(1.6, impact * 0.06));

    const ev = game.update(dt, car);
    carMesh.setCargo(game.crates);

    if (ev.delivered > 0) { hud.flash(false); world.chase.addKick(0.5); }
    if (ev.lost || ev.scattered > 0) hud.flash(true);
    for (const m of game.messages.splice(0)) hud.toast(m.text, m.bad);

    if (game.phase === 'over') showResults();
  }

  carMesh.sync(car);

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
  world.render();
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

// Dev-only inspection hook, stripped from production builds by Vite.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__dbg = () => ({
    phase: game.phase,
    orders: game.dispatch.orders.length,
    closures: game.dispatch.closures.length,
    crates: game.crates,
    rivals: game.rivals.list.map(r => [Math.round(r.x), Math.round(r.z), r.targetId]),
    traffic: game.traffic.cars.length,
    peds: game.pedestrians.list.length,
    car: [Math.round(car.x), Math.round(car.z)],
    focus: game.focus(car),
    routeLen: (game as unknown as { route: unknown[] }).route.length,
    markVerts: world.marks.builder.p.length / 3,
    moverVerts: world.movers.builder.p.length / 3
  });
}
