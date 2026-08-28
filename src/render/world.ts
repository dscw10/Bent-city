import * as THREE from 'three';
import { PAPER, uniforms } from './uniforms';
import { bentGlow, bentMat } from './materials';
import { buildCity, buildRoadSurface } from './city';
import type { CityData } from './city';
import { MarkerBatch } from './marker-batch';
import { ChaseCamera } from './chase-camera';

/**
 * Owns the three.js side of the game: renderer, scene, the static city, and the
 * two per-frame geometry batches.
 *
 * Nothing in here knows anything about gameplay. The bend is a rendering
 * transform and the rest of the game never sees it — that separation is what
 * keeps physics, audio and AI ordinary to write.
 */
export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly chase: ChaseCamera;
  readonly city: CityData;
  /** Unlit marks: route ribbon, objective rings, rivals, closures, arrows. */
  readonly marks: MarkerBatch;
  /** Lit movers: traffic and pedestrians, which must read as objects. */
  readonly movers: MarkerBatch;

  constructor(stage: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    // The palette was authored as raw linear-ish values feeding vertex colours,
    // so opt out of three's colour management and keep the prototype's look
    // exactly. Turning it on shifts every grey.
    THREE.ColorManagement.enabled = false;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    stage.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = PAPER;

    this.chase = new ChaseCamera();

    this.city = buildCity(this.scene);
    buildRoadSurface(this.scene);

    // Marks are flat colour, so writing depth would only make them fight each
    // other where a ring passes under a pillar. They still depth-TEST, so a
    // beacon behind a building is still correctly hidden by it.
    bentGlow.depthWrite = false;
    this.marks = new MarkerBatch(this.scene, bentGlow, 90_000, 1);

    this.movers = new MarkerBatch(this.scene, bentMat, 60_000, 0);
  }

  /**
   * Hand the shader the player's frame of reference. Note this uses the LAGGED
   * heading, not the truck's actual one — the near field is rotated back by
   * uDelta in the shader so it still tracks the truck.
   */
  setFrame(x: number, z: number, lagHeading: number): void {
    uniforms.uW2P.value
      .makeRotationY(-lagHeading)
      .multiply(new THREE.Matrix4().makeTranslation(-x, 0, -z));
    // uP2W is shared by reference with the road surface's uniform block, which
    // is how that locally-authored mesh works out which bit of hillside it is
    // currently sitting on. Its own uW2P stays the identity.
    uniforms.uP2W.value.copy(uniforms.uW2P.value).invert();
  }

  render(): void {
    this.renderer.render(this.scene, this.chase.camera);
  }

  resize(): void {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.chase.resize(w, h);
  }
}
