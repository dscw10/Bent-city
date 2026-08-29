import * as THREE from 'three';
import { P, foldRadians } from '../core/config';
import { TA, TB, TC, TK } from '../core/terrain';
import { passUniformValues } from '../core/pass-shape';
import { smootherstep, smoothstep } from '../core/math';

export const PAPER = new THREE.Color(0xEDEFF1);

/**
 * One uniform block, shared by reference across every bent material, so a
 * slider moves the whole world at once.
 */
const PASS = passUniformValues();

export const uniforms = {
  uW2P:      { value: new THREE.Matrix4() },
  uP2W:      { value: new THREE.Matrix4() },
  uLocal:    { value: 0 },
  uTerr:     { value: new THREE.Vector3(TA, TB, TC) },
  uTK:       { value: TK },
  /* Which terrain the shader should evaluate: 0 city, 1 pass. Levels set it,
     alongside setTerrain() on the CPU side. The two must always move together
     — that pairing is the ghost-surface bug waiting to happen. */
  uTerrMode: { value: 0 },
  /* Ground height under the truck. The fold measures building height from this
     rather than from sea level; see the note in BENT_VERT. */
  uGroundY:  { value: 0 },
  uPassD:    { value: new THREE.Vector4(...PASS.D) },
  uPassE:    { value: new THREE.Vector4(...PASS.E) },
  /* The road itself, four vec4 per piece. Uploaded once — the track never
     changes — and read only when uTerrMode says the pass is loaded, so the city
     pays nothing for it beyond the uniform slots. */
  uTrack:    { value: PASS.track.map(v => new THREE.Vector4(v[0], v[1], v[2], v[3])) },
  uZ0:       { value: P.z0 },
  uR:        { value: P.R },
  uKmin:     { value: P.kMin },
  uFlat:     { value: P.flat },
  uEase:     { value: P.ease },
  uPhiMax:   { value: foldRadians(P) },
  uFallA:    { value: 4000 },
  uBuildH:   { value: P.buildH },
  uDelta:    { value: 0 },
  uRampA:    { value: 40 },
  uRampB:    { value: 110 },
  uBendEnd:  { value: new THREE.Vector2() },
  uFogStart: { value: 240 },
  uFogEnd:   { value: 490 },
  uPaper:    { value: new THREE.Vector3(PAPER.r, PAPER.g, PAPER.b) },
  uLight:    { value: new THREE.Vector3(0.45, 0.82, 0.35) }
};

export type BentUniforms = typeof uniforms;

/**
 * The fold's end point has no closed form once scale compression is in play, so
 * integrate it on the CPU. The shader then skips its own loop for every vertex
 * past the fold — which is the majority of them.
 *
 * CRITICAL: this must walk the SAME phiOf() curve as the shader. If the two
 * drift, the map region visibly detaches from the fold.
 */
export function computeBendEnd(k: number = P.kMin, steps = 240): void {
  const phiMax = foldRadians(P);
  const sB = P.R * phiMax;
  const ds = sB / steps;
  let Z = 0, Y = 0;
  for (let i = 0; i < steps; i++) {
    const t = ((i + 0.5) * ds) / sB;
    const kk = 1 + (k - 1) * smoothstep(t);
    const phi = phiMax * (t + (smootherstep(t) - t) * P.ease);
    Z += kk * Math.cos(phi) * ds;
    Y += kk * Math.sin(phi) * ds;
  }
  uniforms.uBendEnd.value.set(Z, Y);
}
