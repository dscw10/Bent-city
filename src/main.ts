import { World } from './render/world';
import { Projection } from './render/projection';
import { makeCar, stepVehicle, resetCar } from './vehicle/vehicle';
import { collideBlocks } from './vehicle/collision';
import { buildCar } from './vehicle/car-mesh';
import { createJoystick, createKeyboard } from './ui/joystick';
import { createTuner } from './ui/tuner';
import { drawRibbon, drawObjective } from './render/markers';
import { bfs, nearestNode } from './world/graph';
import type { Point } from './world/graph';
import { nodePos, wrapDist, GRID } from './core/city-layout';
import { C } from './core/palette';

const stage = document.getElementById('stage')!;
const world = new World(stage);
const projection = new Projection();
const car = makeCar();
const carMesh = buildCar(world.scene);
carMesh.setCargo(0);

resetCar(car, nodePos(1), nodePos(1), 0);
projection.reset(car.a);

const stick = createJoystick(document.getElementById('stickL')!);
const keyboard = createKeyboard();
createTuner(document.getElementById('tuner')!, document.getElementById('tuneBtn')!);

document.getElementById('hud')!.classList.add('on');
document.getElementById('sticks')!.classList.add('on');
document.getElementById('topbar')!.classList.add('on');

let target: [number, number] = [4, 4];
let carrying = false;
let route: Point[] = [];

function newTarget(): void {
  let t: [number, number] = target;
  for (let i = 0; i < 60; i++) {
    t = [(Math.random() * GRID) | 0, (Math.random() * GRID) | 0];
    if (wrapDist(nodePos(t[0]), nodePos(t[1]), car.x, car.z) >= 58 * 5.2) break;
  }
  target = t;
  route = bfs(nearestNode(car.x, car.z), target);
}
newTarget();

let last = performance.now();
function tick(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const { thr, str } = keyboard.read(stick);
  const sub = dt / 3;
  for (let i = 0; i < 3; i++) {
    stepVehicle(car, sub, thr, str);
    collideBlocks(car, world.city.blocks);
  }
  carMesh.sync(car);

  const tx = nodePos(target[0]), tz = nodePos(target[1]);
  const dist = wrapDist(tx, tz, car.x, car.z);
  if (dist < 9) {
    carrying = !carrying;
    carMesh.setCargo(carrying ? 1 : 0);
    newTarget();
  }
  document.getElementById('dist')!.textContent = `${Math.round(dist)} M`;
  document.getElementById('what')!.innerHTML = carrying
    ? 'Deliver the <span class="accent">melonpan</span>'
    : 'Collect the <span class="accent">melonpan</span>';
  document.getElementById('speed')!.textContent = String(Math.round(Math.abs(car.v) * 2.4));

  if (Math.random() < 0.06) route = bfs(nearestNode(car.x, car.z), target);

  projection.update(dt, car);
  world.chase.update(dt, car, projection.resp);

  const b = world.marks.begin();
  drawRibbon(b, route);
  drawObjective(b, tx, tz, carrying ? C.matcha : C.melon);
  world.marks.end();

  world.movers.begin();
  world.movers.end();

  world.setFrame(car.x, car.z, projection.aLag);
  world.render();
  requestAnimationFrame(tick);
}

addEventListener('resize', () => world.resize());
world.resize();
requestAnimationFrame(tick);
