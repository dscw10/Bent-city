import * as THREE from 'three';
import { uniforms } from './uniforms';
import {
  BENT_VERT, BENT_FRAG, BENT_FLAT_FRAG, UNBENT_VERT, UNBENT_FRAG
} from './shaders';

/** Ordinary lit world geometry: buildings, pavements, parks. */
export const bentMat = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: BENT_VERT,
  fragmentShader: BENT_FRAG,
  vertexColors: true,
  side: THREE.DoubleSide
});

/** Unlit marks on the world: route ribbon, rings, hazard bars, beacons. */
export const bentGlow = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: BENT_VERT,
  fragmentShader: BENT_FLAT_FRAG,
  vertexColors: true,
  side: THREE.DoubleSide
});

/**
 * The road surface is authored directly in player-local space, so it must NOT
 * be transformed by uW2P — it gets its own material with an identity there and
 * uLocal = 1. Every other uniform is shared BY REFERENCE, so the sliders still
 * drive it.
 *
 * polygonOffset pushes it a hair away from the camera, so pavements, lane dashes
 * and the route ribbon always win the depth test once flattening squashes them
 * all into nearly the same plane.
 */
export const roadUniforms = {
  ...uniforms,
  uW2P: { value: new THREE.Matrix4() },
  uLocal: { value: 1 }
};

export const roadMat = new THREE.ShaderMaterial({
  uniforms: roadUniforms,
  vertexShader: BENT_VERT,
  fragmentShader: BENT_FRAG,
  vertexColors: true,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: 2,
  polygonOffsetUnits: 2
});

/** Anything at the local origin — the truck — never bends. */
export function unbentMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uLight: uniforms.uLight },
    vertexShader: UNBENT_VERT,
    fragmentShader: UNBENT_FRAG,
    vertexColors: true,
    side: THREE.DoubleSide
  });
}

/**
 * The bend moves vertices arbitrarily far from where three.js thinks they are,
 * so frustum culling — which tests the UNBENT bounds — wrongly makes things
 * vanish. Every bent object must opt out.
 */
export function addBent(scene: THREE.Scene, mesh: THREE.Object3D): void {
  mesh.frustumCulled = false;
  scene.add(mesh);
}
