import * as THREE from 'three';
import { Builder } from '../render/builder';
import { C } from '../core/palette';
import type { RGB } from '../core/palette';
import { unbentMaterial } from '../render/materials';
import { WHEELS, V } from './vehicle';
import type { Car } from './vehicle';

/**
 * The truck: a kei truck based on the 2010 Subaru Sambar. Cab-over, so the cab
 * sits right over the front axle with almost no bonnet and the bed runs behind
 * it. Narrow track, tall body — which is exactly why it leans so much.
 *
 * It lives at the local origin, so it never bends.
 */
export interface CarMesh {
  body: THREE.Mesh;
  wheels: THREE.Mesh[];
  cargo: THREE.Object3D[];
  setCargo(n: number): void;
  sync(car: Car): void;
  dispose(): void;
}

const TYRE: RGB = [0.10, 0.11, 0.12];
const GLASS: RGB = [0.30, 0.36, 0.42];
const SHELL: RGB = [0.94, 0.95, 0.96];

export function buildCar(scene: THREE.Scene): CarMesh {
  const bb = new Builder();
  bb.box(0,  0.00, 1.40, 0.22, 3.20, C.deckS, C.deckS, 4, 0.34);   // chassis rail
  bb.box(0,  0.98, 1.42, 1.16, 1.30, SHELL, SHELL, 3, 0.56);       // cab
  bb.box(0,  1.02, 1.30, 0.42, 1.06, GLASS, GLASS, 2, 1.10);       // glass band
  bb.box(0, -0.70, 1.40, 0.16, 1.86, C.matcha, C.matcha, 3, 0.56); // bed floor
  bb.box(0, -1.62, 1.40, 0.44, 0.10, C.matcha, C.matcha, 2, 0.56); // tailgate
  bb.box( 0.65, -0.70, 0.10, 0.40, 1.86, C.matcha, C.matcha, 3, 0.56);
  bb.box(-0.65, -0.70, 0.10, 0.40, 1.86, C.matcha, C.matcha, 3, 0.56);

  const body = new THREE.Mesh(bb.toGeometry(), unbentMaterial());
  scene.add(body);

  // Cargo crates are separate objects so they can appear and disappear with the
  // load you are actually carrying — the bed being visibly empty or full is the
  // cheapest possible readout of game state, and it needs no HUD.
  const crateSpots: Array<[number, number, number, number]> = [
    [0.30, -0.35, 0.72, 0.52],
    [-0.32, -0.98, 0.72, 0.52],
    [0.28, -1.10, 1.06, 0.44]
  ];
  const cargo = crateSpots.map(([cx, cz, y, s]) => {
    const cb = new Builder();
    cb.box(cx, cz, s, 0.34, s, C.melon, C.melon, 2, y);
    const m = new THREE.Mesh(cb.toGeometry(), unbentMaterial());
    body.add(m);
    return m;
  });

  // Wheels are separate objects, NOT children of the body — they stay upright
  // and vertical while the body pitches and rolls above them.
  const wheels: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const wb = new Builder();
    wb.box(0, 0, 0.26, 0.56, 0.56, TYRE, TYRE, 2, -0.28);
    const w = new THREE.Mesh(wb.toGeometry(), unbentMaterial());
    wheels.push(w);
    scene.add(w);
  }

  return {
    body, wheels, cargo,

    setCargo(n: number) {
      for (let i = 0; i < cargo.length; i++) cargo[i].visible = i < n;
    },

    sync(car: Car) {
      // The truck sits at the local origin. Only its ride height above nominal,
      // and its attitude, are expressed here — everything else is the world moving.
      body.position.set(0, car.y - V.comH, 0);
      body.rotation.set(-car.pitch, 0, car.roll);
      for (let i = 0; i < 4; i++) {
        wheels[i].position.set(WHEELS[i].s, car.wheelY[i], WHEELS[i].f);
      }
    },

    dispose() {
      body.geometry.dispose();
      (body.material as THREE.Material).dispose();
      for (const w of wheels) {
        w.geometry.dispose();
        (w.material as THREE.Material).dispose();
      }
      for (const c of cargo) {
        (c as THREE.Mesh).geometry.dispose();
        ((c as THREE.Mesh).material as THREE.Material).dispose();
      }
    }
  };
}
