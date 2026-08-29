import * as THREE from 'three';
import { uniforms } from './uniforms';
import { TERRAIN_GLSL } from './shaders';
import { terrainAt } from '../core/terrain';

/**
 * Evaluate the SHADER's terrain function on the GPU and hand the answers back
 * to JavaScript, so the one invariant this codebase leans on hardest can
 * actually be measured instead of assumed.
 *
 * "`terrainAt` here and `terrainAt` in the vertex shader must stay identical"
 * has been written in three files since the beginning, and until now the only
 * way to check it was to drive around looking for the truck to sink. That is a
 * bad instrument: a divergence presents as a physics bug, or as scenery at the
 * wrong height, or as nothing at all until you reach the one corner where it
 * bites.
 *
 * It renders one texel per query point into a float target and reads it back —
 * a stall, which is exactly why this is a dev tool and not something the game
 * calls. Cheap enough to sweep a few thousand points.
 */
export function probeTerrain(
  renderer: THREE.WebGLRenderer, pts: Array<[number, number]>
): Array<{ x: number; z: number; cpu: number; gpu: number; diff: number }> {
  const n = pts.length;
  const coords = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { coords[i * 2] = pts[i][0]; coords[i * 2 + 1] = pts[i][1]; }

  const target = new THREE.WebGLRenderTarget(n, 1, {
    type: THREE.FloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter
  });

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uPts: { value: coords }, uN: { value: n } },
    vertexShader: /* glsl */ `
      void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uPts[${n * 2}];
      uniform float uN;
      uniform vec4 uPassD, uPassE;
      uniform vec4 uTrack[${(uniforms.uTrack.value as unknown[]).length}];
      uniform vec3 uTerr;
      uniform float uTK, uTerrMode;
      ${TERRAIN_GLSL}
      void main(){
        int i = int(floor(gl_FragCoord.x));
        // Uniform arrays need a constant-index-expression, so walk to it.
        vec2 p = vec2(0.0);
        for(int k = 0; k < ${n}; k++){
          if(k == i) p = vec2(uPts[k * 2], uPts[k * 2 + 1]);
        }
        gl_FragColor = vec4(terrainAt(p), 0.0, 0.0, 1.0);
      }`
  });

  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  scene.add(quad);
  const cam = new THREE.Camera();

  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  const buf = new Float32Array(n * 4);
  renderer.readRenderTargetPixels(target, 0, 0, n, 1, buf);
  renderer.setRenderTarget(prev);

  quad.geometry.dispose();
  mat.dispose();
  target.dispose();

  return pts.map(([x, z], i) => {
    const cpu = terrainAt(x, z);
    const gpu = buf[i * 4];
    return { x, z, cpu, gpu, diff: gpu - cpu };
  });
}
