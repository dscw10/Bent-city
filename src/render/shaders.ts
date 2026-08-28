/**
 * ============================== THE BEND ==============================
 *
 * This is the whole concept, and it is about twelve lines of GLSL.
 *
 * The camera is completely ordinary. The WORLD curls upward ahead of you.
 * Everything is transformed into player-local space first (+Z straight ahead,
 * +Y up, origin at the truck), then per vertex:
 *
 *   z <  z0     -> untouched. Ordinary perspective. This is your street.
 *   z >= z0     -> the ground follows an arc of radius R that rotates it up
 *                  through 90°. ARC LENGTH IS PRESERVED, so the road never
 *                  stretches or squashes.
 *   past 90°    -> continues as a flat vertical plane, which the camera reads
 *                  as a top-down map.
 *
 * A vertex's height above the ground is pushed along the arc's normal, so
 * distant buildings lean back and show you their roofs.
 *
 * The bend is purely a RENDERING concern. Physics, audio, AI and every piece of
 * gameplay logic run in ordinary unbent world space and never see it. Keeping
 * it quarantined in the vertex stage is what makes the rest of the game normal
 * to write.
 */

/** Terrain, shared verbatim between the shader and `core/terrain.ts`. */
export const TERRAIN_GLSL = /* glsl */ `
  // MUST match terrainAt() in core/terrain.ts exactly, or the truck drives on a
  // ghost surface: the geometry says one height, the suspension says another.
  float terrainAt(vec2 p){
    return uTerr.x * sin(uTK*p.x)         * cos(uTK*p.y)
         + uTerr.y * sin(2.0*uTK*p.x+1.7) * sin(uTK*p.y+0.4)
         + uTerr.z * cos(3.0*uTK*p.x)     * cos(2.0*uTK*p.y+2.1);
  }`;

export const BEND_GLSL = /* glsl */ `
  #define HALFPI 1.5707963

  // Scale ramp: 1.0 (life size, at the truck) -> uKmin (zoomed out, on the map).
  // Because k is CONSTANT past the fold, straight roads stay straight there and
  // it reads as a real plan view rather than a funnel. Because the ramp lives
  // INSIDE the fold, the scale correction is hidden in the curve rather than
  // appearing as a seam.
  float kOf(float t){ return mix(1.0, uKmin, t*t*(3.0-2.0*t)); }

  // Fold angle. A plain circular arc (uEase = 0) turns at a CONSTANT rate, so
  // curvature jumps from zero to 1/R the instant the fold begins — and the eye
  // reads that discontinuity as a chamfered edge no matter how large R is. Same
  // reason a fillet still looks like a fillet.
  //
  // Easing toward smootherstep ramps curvature in and out from zero. This is the
  // same problem highway engineers solve with a clothoid on a slip road, and the
  // same reason industrial designers use G2 blends rather than G1.
  float phiOf(float t){
    float sm = t*t*t*(t*(t*6.0 - 15.0) + 10.0);
    return HALFPI * mix(t, sm, uEase);
  }

  vec3 bend(vec3 p, float z0, float R){
    float s = p.z - z0;
    if(s <= 0.0) return p;                 // near field: untouched, life size

    float sB  = R * HALFPI;                // raw distance the fold occupies
    float t   = min(s / sB, 1.0);
    float phi = phiOf(t);                  // fold angle: 0 -> 90 degrees
    float k   = kOf(t);                    // local scale at this point

    float x = p.x * k;                     // lateral shrink

    // Height flattening. In the map region a building's height would point along
    // −Z, straight at the camera: tall towers stand proud of the map plane,
    // occlude the streets around them and slide about with parallax. That reads
    // as a pincushion, not a plan view. So height is flattened through the fold
    // and buildings arrive lying down, as footprints. uFlat is the residual —
    // keep it slightly above 0 to avoid z-fighting with the pavement and to
    // leave a readable extruded edge.
    float fl = mix(1.0, uFlat, t*t*(3.0-2.0*t));
    float h  = p.y * k * fl;

    vec2 pos;                              // (along, up) on the folded curve
    if(s < sB){
      // Walk the curve. Each step advances by k*ds, so the world is being
      // progressively shrunk WHILE it folds — that IS the scale correction.
      // No closed form exists once k varies, hence the integration.
      vec2 acc = vec2(0.0);
      float ds = s / 16.0;
      for(int i = 0; i < 16; i++){
        float sm = (float(i) + 0.5) * ds;
        float tm = sm / sB;
        float pm = phiOf(tm);
        acc += kOf(tm) * vec2(cos(pm), sin(pm)) * ds;
      }
      pos = acc;
    } else {
      // Past the fold — and this is the majority of vertices, which is why the
      // fold's end point is integrated once on the CPU and passed in. They skip
      // the loop entirely.
      //
      // uFallA compresses distance logarithmically the higher up the map you go,
      // so the far end of the route folds into finite screen height instead of
      // running off the top. Large uFallA = no compression (linear map).
      float e = s - sB;
      float comp = uFallA * log(1.0 + e / uFallA);
      pos = uBendEnd + vec2(0.0, uKmin * comp);
    }

    return vec3(x,
                pos.y + h * cos(phi),
                z0 + pos.x - h * sin(phi));
  }`;

/**
 * NOTE, hit on the very first run: do NOT declare `attribute vec3 color` here.
 * three.js injects that declaration itself whenever the material has
 * vertexColors:true, so declaring it again fails to compile with
 * `'color': redefinition` and the screen simply stays blank with no error
 * anywhere useful. Same applies to position, normal, uv and the standard matrix
 * uniforms — they are all provided for you.
 */
export const BENT_VERT = /* glsl */ `
  attribute vec2 aAnchor;
  uniform mat4 uW2P;      // world -> player-local (LAGGED heading)
  uniform mat4 uP2W;      // and back again, for locally-authored meshes
  uniform float uLocal;   // 1.0 if this mesh is authored in player-local space
  uniform float uZ0, uR, uKmin, uFlat, uEase, uFallA, uBuildH;
  uniform float uDelta, uRampA, uRampB, uFogStart, uFogEnd;
  uniform vec2 uBendEnd;  // where the fold ends, integrated on the CPU
  uniform vec3 uTerr;     // hill amplitudes
  uniform float uTK;      // hill frequency
  varying vec3 vColor; varying vec3 vN; varying float vFog;
  ${BEND_GLSL}
  ${TERRAIN_GLSL}

  void main(){
    vec4 world = modelMatrix * vec4(position, 1.0);

    // Locally-authored meshes (the road surface) must be pushed back out to
    // world space to find out which bit of hillside they are currently sitting on.
    vec2 anc = uLocal > 0.5 ? (uP2W * world).xz : aAnchor;

    /* uBuildH scales BUILDING height ONLY, for map legibility. Terrain is added
       AFTERWARDS, at full size, because the physics reads it unscaled.
       Getting this order wrong is exactly what broke the first attempt at
       elevated roads: the deck rendered at a third of its height while the
       physics kept it at full, and the truck floated above a road that wasn't
       where it looked. Anything the truck drives ON is added after uBuildH. */
    world.y = position.y * uBuildH + terrainAt(anc);

    vec3 local = (uW2P * world).xyz;

    /* Map orientation. uW2P aligns everything to a LAGGED heading; uDelta is how
       far the truck has turned since. Rotating the NEAR field back by uDelta
       keeps the chase view truck-relative, while the far field stays where the
       lagged heading left it.

       The blend ramp is on RADIAL distance, which is rotation-invariant.
       Ramping on local z would be circular, since the rotation changes z. All
       the twist is confined to the transition band, so straight roads stay
       straight in the map region at any lock setting. */
    float rr  = length(local.xz);
    float b   = smoothstep(uRampA, uRampB, rr);
    float ang = uDelta * (1.0 - b);
    float ca  = cos(ang), sa = sin(ang);
    local = vec3(ca*local.x - sa*local.z, local.y, sa*local.x + ca*local.z);

    // Distant geometry stacks vertically forever once folded. Fog dissolves it
    // into the background colour before it becomes a tower of noise.
    vFog = smoothstep(uFogStart, uFogEnd, local.z);
    vColor = color;

    // Lighting uses the UNBENT world normal. Light the bent geometry instead and
    // the shadows swim around as you turn.
    vN = normalize(mat3(modelMatrix) * normal);

    gl_Position = projectionMatrix * viewMatrix * vec4(bend(local, uZ0, uR), 1.0);
  }`;

export const BENT_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uPaper; uniform vec3 uLight;
  varying vec3 vColor; varying vec3 vN; varying float vFog;
  void main(){
    vec3 n = normalize(vN);
    float d = max(dot(n, normalize(uLight)), 0.0);
    float sky = 0.5 + 0.5 * n.y;                      // hemisphere fill
    vec3 col = vColor * (0.42 + 0.34*d + 0.24*sky);
    gl_FragColor = vec4(mix(col, uPaper, vFog), 1.0);
  }`;

/**
 * Unlit variant for things that must read as marks on the world rather than as
 * objects in it: the route ribbon, destination rings, hazard bars. They carry
 * their colour flat so they stay legible at any angle, including lying almost
 * edge-on in the map region.
 */
export const BENT_FLAT_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uPaper;
  varying vec3 vColor; varying vec3 vN; varying float vFog;
  void main(){
    gl_FragColor = vec4(mix(vColor, uPaper, vFog*0.85), 1.0);
  }`;

/**
 * The truck itself lives at the local origin, so it never bends — it gets an
 * ordinary shader. Same lighting model as the world so it doesn't look pasted on.
 */
export const UNBENT_VERT = /* glsl */ `
  varying vec3 vColor; varying vec3 vN;
  void main(){
    vColor = color;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

export const UNBENT_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uLight;
  varying vec3 vColor; varying vec3 vN;
  void main(){
    vec3 n = normalize(vN);
    float d = max(dot(n, normalize(uLight)), 0.0);
    float sky = 0.5 + 0.5 * n.y;
    gl_FragColor = vec4(vColor * (0.44 + 0.34*d + 0.22*sky), 1.0);
  }`;
