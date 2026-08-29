# Melonpan Delivery Service — project context

_Last updated: 28 Aug 2026_

## What this is

A browser-based arcade delivery game built around one idea: a **single continuous
camera view that is street-level perspective near the player and top-down map far
ahead**, with no cut or split between them.

You drive a kei truck delivering melonpan across a city that folds up in front of
you.

Origin: a Reddit demo (r/UXDesign) showing a photogrammetry city where the
"Combined view" folds the ground plane upward, so tactical (what's in front of me)
and strategic (where am I going) information live in one frame.

## The pitch in one line

Crazy Taxi mechanics, Mirror's Edge aesthetics, a matcha-green kei truck, and a
navigation view that removes the need to ever look at a minimap.

## Design direction

| | |
|---|---|
| Mechanics | Load at a bakery, sequence several live orders against the clock, beat the rivals to them. Single analogue joystick. |
| Vehicle | Kei truck based on the 2010 Subaru Sambar. Cab-over, narrow track, tall body — it leans. |
| Aesthetic | Near-white concrete, cool grey shade, matcha green `#7FA650` as the only accent, with a warm melonpan `#E8C87A` for cargo. Flat shading, no textures. |
| Camera | Fixed chase cam. The **world** bends, not the camera. |
| HUD | Minimal. Uppercase, wide tracking, tabular numerals. |

Why the aesthetic matters technically: flat untextured surfaces bend cleanly.
The reference video looks melty because photogrammetry meshes distort under the
warp. Simple shapes don't.

## How the bend actually works

This is the whole concept, and it's about 12 lines of GLSL — `BEND_GLSL` in
`src/render/shaders.ts` (it was `bendGLSL` in `bent-city.html`, back when the
whole game was one file).

Everything is transformed into **player-local space** first: `+Z` is straight
ahead, `+Y` is up, origin is the car. Then, per vertex:

- If `z < z0` — leave it alone. Ordinary perspective. This is the street you're driving on.
- If `z >= z0` — the ground follows a circular arc of radius `R` that rotates it
  up through 90°. **Arc length is preserved**, so the road doesn't stretch or squash.
- Past 90° — it continues as a flat vertical plane, which the camera reads as a map.
- A vertex's height above ground is pushed along the arc's normal, so distant
  buildings lean back and show you their roofs.

### Scale compression (added 26 Aug)

The fold now also *shrinks* the world as it lifts it. A scale factor `k` ramps
smoothly from `1.0` at the car to `kMin` by the time the fold reaches 90°, and
stays constant at `kMin` after that.

- Because `k` is **constant** in the map region, straight roads stay straight
  there and it reads as a real plan view rather than a funnel.
- Because the ramp lives **inside the fold**, the scale correction is hidden in
  the curve rather than appearing as a seam.
- The curve is walked by numerical integration (16 steps in the shader), since
  there's no clean closed form once `k` varies. The fold's end point is
  integrated once on the CPU (`computeBendEnd`, 240 steps) and passed in as a
  uniform, so the majority of vertices — everything past the fold — skip the
  loop entirely.

### Height flattening (added 26 Aug — fixed the "feels wrong" problem)

Scale compression alone wasn't enough. In the map region a building's height
points **along −Z, straight at the camera**, so tall towers stood proud of the
map plane, occluded the streets around them, and slid about with parallax as you
drove. It looked like a pincushion, not a plan view. Chris spotted it before I did.

Fix: a second ramp flattens height through the fold, from full at the car to
`uFlat` on the map. Buildings arrive lying down, as footprints.

Consequences that had to be handled:

- **Roof tone now encodes height.** Once buildings are flat, the roof is the only
  channel left, so roof lightness is derived from building height — tall blocks
  read as dark masses from above. This is the first thing in the build where the
  strategic region carries information the tactical region can't (open question #3).
- **The destination marker had to be split in two.** A tall pillar flattens into
  nothing, so it now has a pillar (the beacon you see down the street) *and* a
  flat ground ring (the footprint that survives onto the map). General principle:
  anything that must be legible in both regions needs a component built for each.
- Keep `uFlat` slightly above 0 (0.06 default) to avoid z-fighting between roofs
  and the pavement slab, and to leave a readable extruded edge.

### Fold easing / the chamfer problem (added 26 Aug)

Chris: "it feels almost like a chamfer." Correct, and the cause is geometric.
A constant-radius arc has a **curvature discontinuity** where it meets the flat
near field — curvature jumps from 0 to 1/R instantly. The eye reads that jump as
a hard edge no matter how large R is. Same reason a fillet still looks like a
fillet.

Fix: ease the fold angle with a smootherstep (`t³(6t²−15t+10)`) so curvature
ramps in and out from zero. This is the same problem highway and rail engineers
solve with a clothoid / Euler spiral on a slip road, and the same reason
industrial designers use G2 surface blends rather than G1.

`uEase` slider blends between the two: 0.00 = circular arc (chamfer),
1.00 = fully progressive. Default 1.00.

Note: the CPU `computeBendEnd()` integration must use the **same** `phiOf()`
curve as the shader, or the map region detaches from the fold.

Five parameters now control the feel:

- **`z0` (bend start)** — how much life-size street you keep. Bigger = more street.
- **`R` (curl radius)** — the span the fold occupies. Smaller = more map, less street.
- **`kMin` (map scale)** — how far the plan region is zoomed out. Lower = more ground covered.
- **`uEase` (fold easing)** — 0 = circular arc, 1 = progressive clothoid-like fold.
- **`uFlat` (map flatten)** — residual building height on the map. 0 = perfectly flat.

Plus **camera distance**, which moves back and up along a single diagonal so the
car stays in shot at any setting.

All six are exposed as sliders in the running build under "Tune the bend".

These numbers moved again after more playtesting — see **Agreed defaults**
below, which is the authoritative table. The grid stayed at 9×9; widening it to
13×13 was tried and reverted, because tighter map scale showed enough ground
without the vertex cost.

### The gotchas (learned the hard way)

1. **The bend happens per-vertex.** A long flat road with only 4 corners will bend
   as a straight chord and look broken. All geometry is heavily subdivided —
   that's what `Builder.quad(a,b,c,d, su, sv, col)` is for.
2. **Lighting uses the unbent world normal.** If you light the bent geometry,
   shadows swim around as you turn. Shading it before the bend keeps it stable.
3. **The camera never moves.** It sits at a fixed spot in player-local space.
   The world is transformed into that space each frame via the `uW2P` matrix.
4. **Never declare `attribute vec3 color` in a custom vertex shader.** Three.js
   injects that declaration itself whenever the material has `vertexColors: true`,
   so declaring it again fails to compile with `'color': redefinition` and the
   screen stays blank. Same applies to `position`, `normal`, `uv`, and the standard
   matrix uniforms — they're all provided for you. (Hit this on first run, 26 Aug.)
5. **Any full-screen overlay needs `pointer-events: none`.** The delivery flash
   is a `position:fixed; inset:0` div sitting above everything. Without that rule
   it silently eats every tap on the page — steering and the tuning sliders both
   went dead and there was no error to see. (Hit this 26 Aug.)
6. **Distant geometry stacks vertically forever.** Fog fade (`uFogStart`/`uFogEnd`)
   dissolves it into the background colour before it becomes a tower of noise.
7. **The arcade grip assist assumed you were going forwards.** It rotates the
   velocity vector toward the nose; in reverse that means it spends every frame
   rotating your reverse back into forward motion. It fought the reverse gear to
   a standstill at 1.5 m/s and looked exactly like the brakes were stuck on. It
   aligns to the truck's longitudinal AXIS now — whichever end it is actually
   travelling along. There was also no reverse gear to fight: negative input was
   always a brake opposing the wheel's direction, so it flipped sign the instant
   you started rolling back.
8. **Collision resolved every overlap in one pass, so two facing walls cancelled
   out** and each scrubbed the velocity, pinning anything that nosed into a
   narrow gap. It resolves only the deepest overlap now. The gaps themselves
   were also too narrow — 0.54 units between market stalls, against a truck
   1.4 wide — so a test now walks every archetype and fails if any two
   footprints leave a gap the truck cannot fit through.
9. **`uBuildH` catches you twice.** It scaled the viaducts (see below) and then,
   months later, it scaled the traffic — cars rendered at a third height and
   read as grey shards lying in the road. The rule is one line and applies to
   everything: that uniform scales BUILDING height for map legibility, so
   anything meant to be life size must pre-divide by it, and anything the truck
   drives ON is added after it.
10. **A moving object cannot be moved with a transform.** Every vertex carries an
   anchor naming the bit of hillside to lift it onto, baked in at build time —
   so translating the mesh leaves the anchor stale and the object floats or
   sinks. Moving things (traffic, pedestrians, rivals, rings, the ribbon) are
   re-authored in world space every frame into preallocated buffers. That is
   cheaper than the GC churn of rebuilding a BufferGeometry sixty times a second.
11. **Markers must be drawn through the seam.** Gameplay measures distance across
   the tile wrap, so a drop 60m away really is 60m away — but drawn in home-tile
   coordinates its beacon sat half a city away and the HUD looked like it was
   lying. Marks are positioned on the copy of the city nearest the truck. The
   route is still computed and drawn once; it is only drawn in the tile you are
   standing in.
12. **Vertical subdivision of a box is pointless, and it was costing four to
    nine times the geometry of every tall building.** Work the bend through at a
    fixed player-local z: fold angle, local scale, flatten ramp and the point on
    the folded curve are all functions of z alone, and height then enters only
    as `y + h·cos φ` and `z − h·sin φ` — affine in h. The map-lock twist is a
    rotation about Y whose blend ramp is on radial distance in xz, so it does
    not touch y either. Subdividing vertically produced vertices that land
    exactly on the straight edge between the corners. Subdivision along **z** is
    the one that matters: that is the axis the fold consumes.
13. **Two surfaces that both drape will fight.** The road surface and the
    pavement pads each approximate the same curved terrain with their own
    tessellation, and the coarser one pokes through the finer. It showed as a
    sawtooth along every kerb and as white slivers on the horizon. Fixed by
    packing the road's lateral subdivision toward the camera and pushing it
    further back with `polygonOffset` — not by subdividing the pads, which would
    have doubled the tile.

## Current state — v1.0, an actual game (28 Aug)

It is no longer a projection demo with a scoring loop bolted on. There is a
game, and the game is *about* the projection.

Working:
- The bend, with all ten parameters live on sliders and saved between sessions
- Endlessly repeating city — one 9×9 tile drawn 5×5, player position wrapped
- Nine block archetypes, several of them landmarks designed to be read from above
- Terrain, raycast suspension, weight transfer, pavements as costly shortcuts
- **Dispatch**: several live orders at once, a three-crate capacity, bakeries,
  rival couriers and road closures — see the section below, which is the answer
  to open question #3
- Traffic and pedestrians
- Turn arrows painted at the junction you are about to reach
- Three modes: Evening shift, Rush hour, Free roam
- Title, pause, results, restart, settings, best scores — no refreshing to replay
- Full synthesised audio: layered engine, tyre and surface noise, panned rivals,
  four-stem adaptive music
- 42 headless tests over the rules, the physics and collision

Not built yet:
- Any handling nuance beyond what is there — the truck is good, not finished
- Non-uniform block pitch, diagonal avenues, a river with bridges
- PWA offline caching, an Electron build, Steamworks

### It is a repo now, not a file

Phase 0 is done. `bent-city.html` is kept as the historical prototype and is no
longer the game; the game is a Vite + TypeScript application under `src/`.

```
core/     layout, terrain, palette, maths, projection tuning
render/   bend shader, geometry builder, city, block archetypes, materials,
          marker batching, chase camera, projection state
vehicle/  raycast suspension, collision, truck mesh
world/    routing graph, rivals, traffic, pedestrians
game/     dispatch, modes, run state machine, persistence
audio/    bus graph, engine, world sound, music, one-shots
ui/       HUD, screens, joystick, bend tuner, stylesheet
```

The split that matters is not the folder names, it is this: **the bend never
leaves `render/`.** Physics, audio, AI, routing and every rule run in ordinary
unbent world space. That was always the plan, and building a whole game on top
of it confirmed it — nothing outside the vertex shader ever needed to know the
world was folding.

### Driving dynamics — raycast suspension (26 Aug — v0.5)

Four springs, each finding the ground independently, carrying a share of the
car's weight. The body rides on them, so **pitch and roll are results, not
animations** — and because each tyre's grip limit is proportional to the load its
own spring is carrying, weight transfer feeds straight back into handling. Brake
hard and the front bites; get on the power and the unloaded rear lets go.

The ground here is flat, so the "ray" is just the attachment point's height. The
*structure* is what matters — swap in a height lookup and hills work unchanged.

Structure: three substeps per frame, then per step —
1. Suspension geometry for all four corners (compression + corner velocity)
2. Loads, springs plus anti-roll bar
3. Tyre forces, each limited by its own wheel's load
4. Integrate body, then position and orientation

Tyres use slip **angle** (`atan2(lateral, |longitudinal| + 1.4)`) rather than slip
velocity, so behaviour is sane at all speeds, with a friction circle so a tyre
can't give full braking and full cornering at once. Rear-wheel drive, which gives
power oversteer for free.

#### Four bugs worth remembering

Each was found by running the physics headlessly in Node and printing state over
time — far faster than driving it and guessing.

1. **Off-road drag was ~3× too high**, capping the car at walking pace on any
   pavement. Resistance is now a constant part plus a small speed-dependent part,
   with aerodynamic drag on the body separately.
2. **No weight transfer at all.** Tyre forces act at the contact patch, which is
   `comH` *below* the centre of mass, so each one twists the body. Without that
   term the loads never changed and the suspension was decorative.
3. **The anti-roll bar created force instead of transferring it.** When the
   inside wheel lifted, its partner got a huge one-sided shove and the car
   launched itself off the road. An ARB must be computed per axle, applied equal
   and opposite, clamped, and switched off entirely if either wheel leaves the
   ground.
4. **Grip exceeded the rollover threshold.** Track ÷ (2 × CoM height) gave 1.70g
   but tyre grip was set to 1.8g, so the car physically two-wheeled in *every*
   corner — correct physics, terrible car. Fixed by widening the track, lowering
   the CoM and dropping grip to 1.35g. **Rule: `mu` must stay comfortably below
   `track / (2 × comH)`.**

Body rates are also zeroed at the pitch/roll stops, or the body winds up against
the limit and snaps back the moment load comes off.

#### Arcade handling pass (26 Aug)

First tune understeered badly and was slow. Four changes:

1. **Front cornering stiffness above rear** (10.0 vs 9.0). Understeer means the
   front saturates before the rear, so the fix is at the front, not more grip
   everywhere.
2. **Velocity redirection instead of yaw assist.** The first attempt added free
   yaw torque into corners — the car simply spun, ending corners travelling
   backwards. The right trick is to rotate the *velocity vector* a little way
   toward where the nose already points (`V.assist`, per second). The car follows
   its nose and recovers from slides, while the tyres keep behaving consistently.
   Nothing about the forces is faked. **Lower `assist` = more sliding and more
   skill required** — it's the difficulty dial.
3. **Grip raised to 1.75g** with the CoM dropped to 0.45 m, keeping the rollover
   threshold at 2.18g so there's headroom.
4. **More performance:** drive 21000, aero drag retuned, steering falloff with
   speed reduced from 0.70 to 0.45.

Yaw rate is also hard-limited to ±2.6 rad/s so the car can never spin like a top.

#### Where it landed

- 0–30 m/s in 3.0s; top speed 53 m/s (was 39)
- Turn radius 6 m at 10 m/s, 21 m at 20, 37 m at 30 — you must slow for junctions
- ~2.6° dive under braking with front loads tripling; ~5° roll in hard cornering
- Brief inside-wheel lift in the hardest corners only; no launching, no divergence

The car is now **grip-limited rather than slip-limited** — raising `assist`
barely changes the steady-state radius, which means the tyres are the constraint.
That's the right place to be: it makes the handling legible.

Still to come: engine and tyre audio, which is the next big perceived-quality
jump. See the audio section of the development plan.

### Pavements are drivable (added 26 Aug)

Collision is now per **building**, not per block. The pavement pad and plazas are
open, so cutting a corner across the pavement is a real option — but off-road
drag is roughly three times road drag and lateral grip is lower, so it costs you
speed and stability. A shortcut with a price rather than a free one.

`onOffroad()` works out surface from grid arithmetic rather than a lookup, so it
costs nothing and works across the tile wrap automatically.

This matters for the projection too: it gives the plan-view region something
genuinely useful to show, since block interiors are now navigable space and you
can only judge a cut-through from above.

## Map variety and the truck (26 Aug)

Blocks are one of: park/plaza, open car park (drivable, dashed), superblock (one
big tower), or the usual 1–4 buildings.

**Destinations are at least 5.2 blocks away** (was 2.2), specifically so the
plan-view region has to earn its place — at short range you could navigate from
the street view alone, which rather defeated the point.

Still to try if more variety is wanted: non-uniform block pitch, diagonal
avenues, a river with bridges.

### The truck

Kei truck geometry: mass 900 kg, track 1.40 m, CoM 0.42 m. That gives a rollover
threshold of 1.67g, so grip sits at 1.42g — a deliberately slim margin. It leans
about 7° in hard cornering and lifts an inside wheel at full lock, which is
correct for the vehicle and reads well.

0–30 m/s in 3.4s, top speed 56 m/s. Turn radius 7 m at 10 m/s, 28 m at 20, 51 m
at 30 — wider than the previous car, which pushes you toward the pavement
shortcuts rather than muscling through junctions.

## Terrain — hills and slopes (26 Aug — v0.7)

### The bug that killed the viaducts

The first attempt at elevated roads failed, and the cause is worth keeping:
**`uBuildH` scales everything's height in the shader, including the road deck.**
So the viaduct rendered at 9 × 0.31 ≈ 2.8 units while the physics kept it at 9 —
the truck floated above a road that wasn't where it looked.

**Rule that came out of it:** `uBuildH` scales BUILDING height only, for map
legibility. Anything the truck drives ON is added *after* it, at full size,
because the physics reads it unscaled:

```glsl
world.y = position.y * uBuildH + terrainAt(anc);
```

### Height is a function

`terrainAt(x,z)` is three sine/cosine terms at integer multiples of `2π/TILE`,
so it is **exactly periodic over one tile** and the infinite wrap still works.
The same function exists in JS and in GLSL and must stay identical — if they
drift, the truck drives on a ghost surface.

Range −8 to +8 m, steepest grade 17%. Verified seamless at the tile edges.

### Buildings stay vertical, roads drape

Every vertex now carries an **anchor**: the x,z the shader samples terrain at.

- **No anchor** → each vertex uses its own position, so the surface drapes over
  the hills. Roads, pavements, lane markings, the route ribbon.
- **An anchor** → every vertex lifts by the same amount, so the shape stays rigid
  and vertical. Buildings, which must stand up in the direction of gravity rather
  than lean with the hillside.

Two consequences that had to be handled:

1. **Buildings need a skirt.** A rigid flat base floats clear of the ground on
   the uphill side, so boxes are buried 20 units. It has to be generous, because
   `uBuildH` shrinks the skirt but never shrinks the terrain.
2. **The road surface mesh needed real lateral subdivision** (8 columns → 64).
   It could be coarse when the ground was flat, because the bend only scales x
   linearly — but terrain varies in x too.

The locally-authored road mesh doesn't know its world position, so it gets
`uP2W` (the inverse transform) and a `uLocal` flag to look up where on the
hillside it currently is.

### Slopes affect driving

Gravity's component along the hillside is added to the planar forces, so climbs
cost speed and descents give it back. Coasting for 4s from 30 m/s loses 6.7 m/s
uphill against 2.5 m/s downhill.

Verified across five start points, 20s each with steering input: no divergence,
ride height stays within 0.28 m of nominal over the whole terrain.

### Agreed defaults (26 Aug — Chris's settings)

These are now the build defaults. They came from playtesting, not theory, so
treat them as the reference point for any future change:

| Parameter | Value |
|---|---|
| Bend start | 70 |
| Curl radius | 13 |
| Map scale | 0.34 |
| Speed push | 120 |
| Fold easing | 1.00 |
| Map falloff | 0.51 |
| Building height | 0.31 |
| Map lock | 0.10 |
| Camera distance | 11 |

Worth noting what the combination says: a tight fold (13) with a long life-size
street (70) and low buildings (0.31). The horizon is hard and close, the street
is generous, and almost nothing blocks the map. Map lock at 0.10 is a small
amount of drift — enough to take the whip out of corners without the map ever
feeling detached.

### Camera behaviour (added 26 Aug)

The camera never moves in world terms; it only moves within player-local space,
which is the only space it knows about. Two behaviours:

- **Distance grows with speed** (up to +42%), on the same smoothstep response and
  a 0.5s lag. The car shrinks, the road opens up.
- **Height rides the truck.** Player-local space keeps world Y, so a camera at a
  fixed local y stays at a fixed *altitude* — over hills the truck simply climbed
  away from it. It now tracks `car.y`, lightly smoothed (0.16s) so suspension
  movement doesn't shake the whole frame, and snaps rather than glides on the
  first frame.
- **It aims at the hillside ahead**, sampling terrain 24 m in front, so the view
  pitches over crests and down into dips instead of staring at a fixed altitude.
- **It trails behind turns.** Yaw rate is smoothed with a 0.20s lag and used to
  swing the camera to the outside of the turn, with the look target rotated back
  by half so it still looks into the corner, plus a slight bank. Deliberately
  small — the first version at 0.30 gain read as a swinging camera rather than
  as weight, so the gain came down to 0.11 and the clamp from 0.42 to 0.16 rad.

Note the interaction worth watching: camera turn lag and map lock are two
different lags applied to the same event. Too much of both and a corner becomes
mush. Currently 0.26s on the camera and a light 0.10 on the map.

### Map orientation, falloff and building height (added 26 Aug — v0.3)

Three experiments aimed at one goal: **seeing the whole route while keeping the
chase view.**

**Map falloff.** Past the fold, distance is now compressed logarithmically
(`uFallA * log(1 + e/uFallA)`), so the far end of the route folds into finite
screen height instead of running off the top. Large `uFallA` = linear map,
i.e. the old behaviour.

Tradeoff, currently unresolved: compression is applied **vertically only**.
Lateral scale stays at `kMin`, so straight roads stay parallel and the map stays
a map — but block shapes squash progressively the higher up they are. Matching
the lateral scale to the vertical would keep shapes proportional but reintroduce
a vanishing point, which arguably stops it being a plan view at all. Worth trying
both.

**Map lock.** The map's orientation is now decoupled from the car. `uW2P` is
built from a **lagged heading** `aLag`; `uDelta` is how far the car has turned
since. The near field is rotated back by `uDelta` so the chase view stays
car-relative, while the far field stays where the lagged heading left it.

- lock 0.00 — `aLag` tracks the car exactly. Original behaviour, map turns with you.
- lock 1.00 — `aLag` never moves. World-locked map, north stays north.
- in between — the map swings lazily behind your turns.

Key implementation detail: the blend ramp uses **radial distance**, which is
rotation-invariant. Ramping on local `z` would be circular, since the rotation
changes `z`. All the twist is confined to the transition band, so straight roads
stay straight in the map region at any lock setting.

Known consequence at lock 1.00: the fold direction is world-aligned too, so the
map shows what's north of you regardless of travel direction. Drive south and
your destination can fall off the bottom of the map. Not obviously wrong — it's
the standard north-up versus heading-up tradeoff in navigation — but it needs
playtesting rather than a decision from first principles.

**Building height** is a global scale uniform (`uBuildH`), applied before the
bend so it affects near field and map alike. Default dropped to 0.55, which
reveals substantially more map.

**Tiles widened to 5×5** (from 3×3) and fog now scales with falloff, because
compression can see much further than the old fog distance allowed. This is the
build's main performance risk — 25 draw calls of the tile geometry.

### Speed-reactive projection (added 26 Aug — v0.2)

Built the idea flagged above: **the camera is the projection, so speed can drive
it.** The bend start now pushes outward with speed instead of sitting still.

- Standing still: near horizon, large map. You're manoeuvring, so you want
  situational awareness.
- At speed: the bend start travels out, the life-size street grows, and your
  look-ahead extends with your stopping distance.
- The map scale zooms out by up to 30% as it goes, compensating for the map
  region sitting further away and shrinking.

Implementation notes:
- Response curve is smoothstep on `|v| / vMax`, not linear — the change should
  happen across the mid speed range, not creep in from a standstill.
- Smoothed with a ~0.55s lag term (`1 - exp(-dt/lag)`), which is frame-rate
  independent. Without the lag it snaps and is unusable.
- 15% of the push comes from actual acceleration rather than speed, which gives
  the surge some punch on the throttle. Small on purpose — more than this and it
  pumps on every gear-less throttle blip.
- `computeBendEnd()` now runs every frame (240 steps, negligible) because the
  map scale is animating.
- The **Bend start** slider is now the *standstill* value; **Speed push** is how
  far it travels at full speed. Set push to 0 to get the old static behaviour.

Open: does this help or does it induce motion sickness? It's the same family of
trick as FOV-widening in racing games, but far more aggressive. Needs testing on
someone who isn't the person who built it.

## Infinite tiling (added 26 Aug)

The city is one **tile** (9×9 intersections, 522 units square) drawn 3×3 around
the player. The player's position is wrapped into the home tile every frame, so
the eight surrounding copies never move — no streaming, no pop-in, nine draw
calls sharing one geometry.

- Loops run to `GRID`, not `GRID-1`, so the block and lane-dash pattern is
  continuous across the tile join. Off-by-one here shows up as a visible seam.
- Fog ends at 490, inside the 522 repeat, so the world dissolves into paper
  before you can catch the same building twice.
- **The route never wraps.** BFS stays inside the home tile and the ribbon,
  pillar and ring are drawn once. The repeated city is scenery; the route is the
  one thing that tells you where you actually are. This is deliberate — a route
  that crossed seams would make the repetition ambiguous instead of ignorable.

### The road surface is not tiled

It's a featureless grey field, so instead of repeating it there's **one mesh
authored permanently in player-local space** — it never moves or rotates. Its own
material carries an identity `uW2P` while sharing every other uniform by
reference, so the sliders still drive it.

Its subdivision is packed toward the camera with a power curve (`z = f(u^2.2)`),
which means the fold always lands in the dense part of the mesh wherever you put
`z0`. Lateral subdivision can be almost nothing (8 columns) because the bend only
scales x linearly. Total cost: about 12k vertices instead of the 150k the old
uniformly-subdivided ground plane needed.

### Depth precision

Once bent, the whole visible world sits within a few hundred units of the camera,
so the far plane came down from 6000 to 1400. That plus `polygonOffset` on the
road surface is what stops pavements, lane dashes and the route ribbon from
z-fighting after flattening squashes them into nearly the same plane.


## Dispatch — the answer to open question #3 (28 Aug)

This is the section the whole project has been circling. The question was:
**what lives in the plan region that cannot live in the perspective region?**

Roof tone encoding building height was a start, but it is scenery. The answer
has to be a *decision the player can only make from above*. There are three
now, and the important thing is that they compound.

**1. Simultaneous orders.** Three to five drops are live at once, each with its
own countdown, drawn as a ring of ticks on the ground. At street level you can
see the one you are pointed at. From the map you can see all of them, with how
long each has left, and choose an order to serve them in. Ticks rather than a
smooth wedge, because ticks stay countable when the map scale shrinks them to a
few pixels — a smooth arc just becomes a smudge.

**2. A capacity limit.** The truck holds three crates and refills at a bakery.
That is the piece that turns a list of objectives into a routing problem: you
cannot simply chase whatever is nearest, you have to pick a *cluster* of three
that one loop can serve, and then get back. A cluster is a shape, and a shape is
only visible from above.

**3. Rivals and closures.** Rival couriers race you for the same drops. Their
chevron shows heading and, by its trail length, roughly their speed — so every
order becomes "can I beat them there, and if not which of the others should I
take instead". Road closures block edges of the graph; a closure two blocks
ahead is invisible from the street and obvious from the map, and it changes
which way you should already be turning.

Because block interiors are drivable, a closure does not stop you — it pushes
you onto the slow pavement cut-through. A cost, not a wall. That interaction
between two features built weeks apart is the best thing in the game.

### What this forced on the visual design

**Anything that must be legible in both regions needs a component built for
each.** This started as a note about the destination pillar and is now a rule
the whole game obeys:

| Thing | Street component | Map component |
|---|---|---|
| Objective | tall pillar beacon | flat ring + countdown ticks |
| Rival | stubby beacon | chevron + trail |
| Closure | bars across the carriageway | flat X |
| Building | facade | roof tone, encoding height |
| Route | ribbon under your wheels | ribbon running up the map |
| Next turn | arrow painted on the road | (nothing — the map has the rest) |

That last row is worth spelling out. The turn arrow handles the *immediate*
junction, which frees the map to be about the decision **after** this one. That
is the level the plan region is actually good at, and it was doing both jobs
badly before.

### Verdict on the open question

It works, and the test in the phases document — *a player who cannot see the map
region plays measurably worse* — is now obviously true rather than aspirational.
Without the map you can still drive to the arrow. You cannot sequence three
drops, you cannot tell which one a rival will reach first, and you will drive
into a closure at speed.

### Traffic earns its place by making the map expensive

Traffic and pedestrians are not decoration. Reading the map means not reading
the street, and traffic is what makes not reading the street cost you. That
tension is the reason to have both regions in one frame at all — without it the
plan view is free information and the game is just a driving game with a good
minimap.

## Block archetypes (28 Aug)

Nine kinds now. The landmarks are designed as **shapes read from above first**
and as things you drive past second, because once buildings lie flat the
footprint and the roof tone are the only channels left.

| Kind | What it is from above |
|---|---|
| buildings | one to four masses, the default texture of the city |
| superblock | one big dark square |
| podium | nested squares — the only shape that changes width as it rises |
| market | a fine 3×3 grain nothing else has |
| park | green with a white cross of paths, and trees |
| lot | pale, ruled with bays |
| shrine | a cross inside a square — the most findable shape in the tile |
| works | an orange ring with an L-shaped crane |
| dock | a dark hole |

Roughly one block in eight is a landmark. A shrine on every corner is not a
landmark, it is wallpaper.

Two of them change how you drive rather than just how you navigate: the dock is
the only block you cannot cut through, and the works hoarding makes its interior
a trap rather than a shortcut — the one block you learn to go around.

## Audio (28 Aug — Phase 2 done)

Built as planned, entirely synthesised, no asset files. The bus graph and the
signal chain are exactly as sketched in the development plan below.

Things worth keeping from doing it:

- **The fake gearbox is most of it.** There is no gearbox in the physics, so one
  exists purely for the sound: revs sweep up, drop on a shift, sweep again. That
  single detail is the difference between "a drone that rises" and "a vehicle
  accelerating", and it took twenty lines.
- Building the tone from the actual firing frequency — `rpm/60 × 1.5` for a
  four-stroke triple, because it is a 660cc kei unit — is why it sounds like an
  engine rather than a synthesiser doing an impression of one.
- **Surface noise is a gameplay channel, not an ambience.** It is brighter and
  louder off-road, so you can hear that you have left the carriageway without
  looking down. In a game whose whole point is that you are reading somewhere
  else, that matters more than it would anywhere else.
- Rivals get panned drones; traffic gets one density hum. Twenty-six panned
  engines is mud, one hum is a busy street. That is a mix decision before it is
  a performance one.
- Music is scheduled on the **audio clock** with the usual lookahead, never from
  `requestAnimationFrame`. A phone dropping frames in a corner is exactly where
  the groove must not wobble.
- The positional-audio rule held: everything is fed unbent world coordinates, on
  the copy of the city nearest the listener.

Verified by measuring real RMS on the master bus across idle, power, cornering,
pause and mute, rather than by assuming the graph was connected.

## Controllers (29 Aug)

Added for testing on an iPad with a pad paired over Bluetooth. Left stick
steers, RT/LT are throttle and brake, A/B cover pads with digital triggers,
D-pad and A drive the menus so you never have to reach for the screen.

Three things about the Gamepad API that all bit, and are worth remembering
because none of them produce an error:

1. **The pad does not exist until you press something.** Safari will not report
   a connected pad, and will not fire `gamepadconnected`, until a button is
   pressed on it. So the UI cannot say "no controller found" — it has to say
   "press a button", which is what the title screen and the pause row now do.
2. **A GAMEPAD BUTTON IS NOT A USER GESTURE.** A player who pairs a pad and
   never touches the screen would never unlock the AudioContext and would drive
   in total silence with nothing to explain it. Any real tap anywhere on the
   page now starts the audio, whether or not it was the Start button.
3. **Polling must not live in the render loop.** There is no input event to
   subscribe to — the API is poll-only — so tying it to frames means a quick tap
   can fall entirely between two of them the moment the frame rate dips. A menu
   button that works at 60fps and not at 15 is a horrible thing to debug. It
   polls on its own 60Hz timer and latches presses; the frame consumes them.

Found (3) immediately, because the software renderer in the test harness runs at
about two frames a second, which turned out to be an excellent accidental
stress test of exactly this.

Triggers are buttons 6 and 7 with an analogue `.value` under the standard
mapping, not axes — reading them as axes gets you nothing on the controllers
people actually own.

## The projection, revisited (29 Aug) — why the map wasn't being used

Chris, playing on an iPad with a controller: *"I wasn't using the vertical map
at all. I think this is a problem as it's the whole point."* He asked to try a
cylinder, or one big constant curve, instead of the fold.

Built it as a switchable preset rather than a replacement — and building it
turned up three things that are worth writing down, because all three are the
opposite of what you would assume.

**1. Past 90° the map LEAVES the shot.** The obvious reading of "cylinder" is to
let the surface keep curving past vertical. It does, and the far field promptly
curls over and behind the camera: at a 130° fold the city 500m out lands at
local z = −33, y = +139. It is above and behind your head. Worse, a plane at 90°
is precisely the orientation that faces the camera squarely, so it presents its
maximum screen area — tilt past that and it foreshortens toward nothing. **More
cylinder gives you less map, not more.** 90° is not an arbitrary stopping point.

**2. Bringing the fold closer also gives you less map.** The second obvious
move — start the curve near the truck so there is less life-size street — pushes
the map plane's bottom edge UP out of frame. The frame is 58° tall; the fold
preset's distant plane has its bottom edge about 1–6° above the lens, so it fills
the upper half, whereas a fold at z0 = 10 puts that edge 18° up where only a
sliver fits. Both intuitions are wrong for the same reason: what matters is not
where the fold is, it is **what fraction of the map plane falls inside the
vertical field of view.**

**3. The control that was actually missing is camera aim.** Nothing pointed the
camera up. Adding `camAim` — how far above the road it looks — is what trades
street at the bottom of the frame for map at the top, and it is the only lever
that directly sets the map's share. It is a small number: the truck already sits
23° below the lens, so past about 6m of aim it leaves the shot entirely. The
first attempt at 17 lost the truck completely.

With those understood the numbers stop being guesswork. The frame is ±29°, the
truck is at −23°, and the map's bottom edge wants to be a few degrees above the
lens. The Cylinder preset lands it at 3.5° for 44% of the frame, against the
Fold preset's 40% — while being a genuine constant-radius arc with no easing and
no hard horizon.

### The likelier culprit, though, is not the curve at all

Two things conspire to make the map optional, and neither is the projection:

- **Speed push.** At the Fold defaults the life-size street grows from 70 to 190
  units at speed. That is three blocks of ordinary perspective, which is more
  than enough to drive by.
- **Turn arrows.** They were added so the map would be free to be about the
  decision AFTER the next junction. Combined with a three-block street, there is
  nothing left for it to be about at all.

So the Cylinder preset sets `push` to 0, and turn arrows are now a setting you
can switch off. Turning them off is the sharpest available test of whether the
map is carrying its weight, and it costs one tap rather than a rebuild.

## Performance (28 Aug)

The stated risk was vertex count, and it was real: a bigger, more varied city
across 25 tile copies reached 2.7M vertices a frame. Now 1.08M, with no visible
difference, from two changes:

- Vertical box subdivision dropped to 1 — see gotcha 10 above. Provably free.
- Tile copies are culled in **player-local space**. Three.js's own frustum
  culling is worse than useless here, because it tests the unbent position: it
  hides what the bend has brought into view and keeps what it has taken out,
  which is why everything bent has `frustumCulled = false`. But the bend only
  ever moves a vertex along local z and inward, so a tile entirely behind the
  truck or entirely past the fog cannot appear whatever the fold is doing.
  Typically ten of the twenty-five drop out.

Still unmeasured on a real mid-range phone. That remains the open risk.

## Testing (28 Aug)

42 headless tests, run with `npm test`. Nothing touches WebGL or the DOM.

This is the same technique that found the four suspension bugs — running the
thing headlessly and printing state over time beats driving it and guessing —
turned into a net that stays. Worth having for: the rollover margin
(`mu` below `track / (2 × comH)`), weight transfer actually transferring, no
divergence anywhere on the terrain, frame-rate independence, terrain periodicity
across the seam, closures never disconnecting the graph, rivals never
double-booking an order, and a closure being something you hit rather than drive
through while still leaving a way round.

## Building it out properly

### The constraint that decides everything

The bend is a **non-standard projection**. Every game engine assumes a linear
one. So the question "which engine" is really "which engine fights this least".

What the bend breaks:
- **Frustum culling** — the engine culls against the unbent position, so objects
  wrongly vanish. Already had to set `frustumCulled = false` on everything here.
- **Shadow maps** — rendered from the light's point of view in unbent space, so
  shadows land in the wrong place.
- **LOD selection** — picked by unbent distance, which no longer matches how big
  a thing appears on screen.
- **Screen-space effects** (SSAO, SSR), decals, billboards, particles.
- **Screen-to-world raycasting** — needed for touch/click, has to be inverted
  through the bend by hand.
- **Nanite specifically** — does its own rasterization and doesn't tolerate an
  extreme world-position offset.

What the bend does **not** break: physics, audio, AI, and all gameplay logic.
Those run in ordinary unbent world space. That's the important insight — the bend
is purely a rendering concern, and it stays quarantined in the vertex stage.

### Decision (26 Aug): no engine, for now

Evaluated Unity, Unreal, Godot, Armory3D/UPBGE and browser. **Staying in the
browser with three.js.** The full reasoning was in `kickoff.md`, which never made
it into the repo; the short version: this
game needs almost nothing an engine sells (no assets, ~300 lines of arcade
physics, procedural geometry), while the bend costs you real engine features
(culling, shadows, LOD, decals). And the deliverable being a URL matters.

Unity remains the destination if any of these become true: real audio middleware,
console/app-store builds, bought assets, more than one person, or a *measured*
WebGL performance ceiling.

Rejected specifically:
- **Unreal 5** — Nanite and Lumen are the reasons to use it and both are
  incompatible with an extreme world-position offset.
- **Blender Game Engine** — removed from Blender in 2.80 (2019). UPBGE is the
  surviving fork; small community, dated architecture.
- **Armory3D** — genuinely still alive (2026.2 release, commits through mid-2026)
  and its scriptable render path is a real plus. But the bend would have to be
  injected into its Cycles-node shader generator with nobody else having solved
  it, and Haxe/Kha is niche enough that AI assistance on it is materially worse
  than for C# or JavaScript. That last point matters more than it sounds.
- The Blender-integration argument for both is weaker than it looks: glTF export
  solves the asset pipeline for any engine, and this game's geometry is
  procedural anyway. Keep Blender as an authoring and sketching tool regardless.

### Engine assessment

| | Verdict |
|---|---|
| **Unreal 5** | Fights hardest. Nanite and Lumen are the reasons to choose UE5 and both are incompatible with this. Skip. |
| **Unity (URP)** | Best balance if this becomes a real game. The bend can go in a shared shader include so every material inherits it; renderer bounds can be overridden to defeat culling. Large vehicle-physics ecosystem. |
| **Godot 4** | Lightest and free. `vertex()` shaders are easy. But thinner vehicle physics and more written from scratch. |
| **Browser / three.js** | Where we are. Total control, nothing fighting us, and the output is a shareable link. |

### Staged plan

**Stage 1 — stay in the browser.** Every open question below is about the *view*,
not about scale. Switching engines now costs weeks and answers none of them. Move
from a single HTML file to a proper repo (Vite + three.js + TypeScript) so the
project can grow.

**Stage 2 — port to Unity** only once the view is settled. The bend itself is
about thirty lines and ports in an afternoon; the game around it is the slow part,
so don't build that twice.

### On GTA V driving feel

It isn't simulation. It's a **raycast suspension** model — one ray per wheel into
a spring — with very carefully tuned parameters. The feel comes from:

- The body sitting on springs, so weight transfer is visible as pitch and roll
- Separate longitudinal and lateral tyre forces with a slip curve, so the rear
  steps out predictably and comes back
- Rearward brake bias and throttle-off lift
- Camera lag, FOV widening with speed, and a little roll into corners

That last point is roughly a third of the feel and is pure camera work, not
physics. Which raises something specific to this project: **here the camera is
also the projection.** Speed drives the bend parameters — see the
speed-reactive projection section above, now built. Nobody else can do that.

## Development plan

_Written 26 Aug 2026. Engine-free, browser-based, but a real application rather
than a web page._

### It isn't "an HTML project"

The confusion is worth clearing up, because it changes how seriously to treat the
work. What we're building is a **TypeScript application** that happens to render
through a browser engine. That's the same relationship Figma, Spotify's desktop
app and VS Code have with the web — nobody calls those web pages.

One codebase, several ways to ship it:

| Target | How | Why bother |
|---|---|---|
| Web | The build itself | Sharing is a URL. Nothing to install. |
| Installable app | PWA manifest | Icon on a phone home screen, works offline, full screen, no browser chrome |
| Desktop (casual) | Tauri wrapper | A real .app / .exe. Tauri is a few MB, unlike Electron. |
| Desktop (Steam) | **Electron or NW.js** — see below | Bundles its own Chromium, so rendering is identical on every customer's machine |
| Mobile store | Capacitor wrapper | Only if it ever needs to be in an app store |

The web build is the source of truth. The others are thin wrappers added later
and cost days, not months.

### Steam

Shipping a browser-based game on Steam is normal and well-trodden. Two parts:
the wrapper, and Valve's process.

**The wrapper — and a correction.** Tauri is the right choice for a general
desktop app but the *wrong* one for Steam: it uses whatever webview the OS
provides, so WebGL rendering varies machine to machine. Unacceptable in something
you're selling. Use **Electron or NW.js**, which bundle a known Chromium build so
every customer sees identical output. Larger download, entirely predictable.

Steamworks features (achievements, cloud saves, the overlay) reach Electron via a
native binding such as `steamworks.js`. The **Steam overlay needs specific
Chromium launch flags** to work — a known friction point worth handling early
rather than discovering during review.

**Valve's process.** $100 per game via Steam Direct, refunded as credit once the
game earns $1,000 in adjusted gross revenue. Valve takes 30% of each sale. No
approval vote — identity and tax verification plus a technical review.

The timing traps matter more than the money:

- **30-day mandatory wait** after paying the fee, before you can release
- **Coming Soon page must be public for at least two weeks** before launch
- These can overlap, but budget six to eight weeks for a first release, not the
  theoretical minimum

**Do the store page early.** Steam's algorithm weights pre-launch wishlists
heavily, so the window between page approval and launch is where most of the
marketing happens. The store page should exist long before the game is finished —
which for this project is easy, because the bent view is inherently screenshot-
and trailer-friendly.

Practical consequence for the plan above: pay the fee and open the Coming Soon
page around **Phase 3**, not Phase 5.

### Audio: the browser is not the limitation

This is the part worth being clear about, because it's the usual reason people
assume they need an engine.

The **Web Audio API** is a full DSP graph, not a play-a-sound function. It gives
you real-time filters, compression, convolution reverb from impulse responses,
spatial panning with distance falloff and doppler, and sample-accurate
scheduling. It is the same class of tool as an engine's audio layer.

Planned stack:

- **Tone.js** for musical timing and scheduling — it solves the hard problem of
  keeping music in sync with a game loop that runs at a variable frame rate.
- **Howler.js** or raw Web Audio for one-shot effects.
- **FMOD Studio** later if it ever needs proper authoring tooling — it has an
  HTML5/WASM export, so that door stays open.

Signal graph to build:

```
engine bus   ─┐
world bus    ─┼─→ master → compressor → limiter → out
music bus    ─┤
UI bus       ─┘
```

Separate buses because that's what lets music duck under a delivery chime, or
the engine drop away during a slow-motion moment, without touching anything else.

**Engine sound.** Don't loop one sample and pitch it — it sounds like a
hairdryer. Layer three or four loops (idle, low, mid, high), crossfade between
them on RPM and pitch each slightly. Add a separate load-dependent layer so
throttle-on and throttle-off differ. This is 90% of the perceived quality of a
driving game.

**Adaptive music.** Compose in stems (drums, bass, pad, lead), all the same
length and tempo. Fade layers in and out on game state — speed, whether you're
carrying, how close the objective is. It's simple to build and reads as
sophisticated because the music appears to respond to the player.

**One thing specific to this project:** positional audio must use the **unbent**
world coordinates, not the bent ones. Same principle as physics — the bend is a
rendering transform and nothing else may see it. Feed the `PannerNode` the real
world position. If a sound ever appears to come from where a bent building looks
like it is, that's the bug.

### Phases

Each phase ends with something playable. Don't start the next until the current
one is committed and works.

**Phase 0 — foundation** — ✅ **done, 28 Aug**
Repo, Vite, TypeScript, port the prototype into modules. Deploy to Netlify so
every commit publishes.
*Done when:* the current prototype runs from a URL, split across files, with
nothing new added.
*Note:* the deploy is the one part still outstanding. `npm run build` produces a
static `dist/` that will drop onto Netlify, Pages or anything else unchanged.

**Phase 1 — driving feel** — ✅ **done**
Raycast suspension, weight transfer, tyre slip curves, camera lag and roll.
*Done when:* you'd enjoy driving around with no objective and no map.
*That is what Free roam is for, and it passes.*

**Phase 2 — audio spine** — ✅ **done, 28 Aug**
Bus architecture, layered engine sound, tyre and surface noise, spatial sources
on unbent coordinates, first adaptive music stems.
*Done when:* closing your eyes tells you roughly what the car is doing.
*Revs, load, shifts, surface and slip are all audible. What is still missing is
authored variety — every sound is a synthesis rule, and a few of them will
eventually want a real recording behind them.*

**Phase 3 — a city worth looking at** — 🟡 **mostly done, 28 Aug**
More variety per tile, landmarks that read from above, junction markings, traffic
if it earns its place. Speed-reactive bend tuned properly.
*Done when:* driving a straight line for a minute doesn't reveal the repeat.
*Nine archetypes, landmarks designed for the plan view, junction arrows, traffic
and pedestrians are all in. But the honest answer to the completion test is
still no: the tile is 522m and at 30 m/s that is seventeen seconds. Variety
inside the tile makes each block distinct; it does not change the period.
Fixing that properly means a bigger tile or a second tile that alternates, and
either one is a real piece of work with a real vertex-count cost.*

**Phase 4 — the game** — ✅ **answered, 28 Aug**
The open design question: what decision can a player only make because they can
see both scales at once? This phase is design, not code, and it's the one that
decides whether this is a game or a demo.
*Done when:* a player who can't see the map region plays measurably worse.
*See the Dispatch section above. Sequencing simultaneous orders under a capacity
limit, judging races against rivals, and routing around closures are all
decisions the street view cannot support. The phase that was flagged as the real
risk turned out to be the one that made everything else make sense.*

**Phase 5 — ship** — 🟡 **started**
PWA manifest, offline caching, performance pass on mid-range phones, Electron
build and Steamworks integration if going to Steam, title and settings screens.
*Done when:* someone else can find it, install it and play it without you there.
*Manifest, icon and the title/pause/results/settings screens are in. Offline
caching, the phone performance pass and anything Steam-shaped are not.*

### Risks worth watching

- ~~**Phase 4 is the real risk.**~~ Answered, 28 Aug — see Dispatch above. The
  fear was right that it was tempting to keep polishing the view instead; the
  thing that broke the deadlock was asking what *decision* the map supports,
  rather than what information it shows.
- **Motion sickness.** The speed-reactive bend is aggressive. Test on people who
  didn't build it, early, before more is built on top of it.
- **Mobile performance.** Still the live one. Vertex count is the constraint,
  not fill rate, because the bend runs per vertex. It is down from 2.7M to 1.08M
  a frame and there is a City life toggle that removes traffic and pedestrians —
  but nobody has yet put this on a real mid-range phone, and a desktop browser's
  device emulator does not answer the question.
- **Scope.** Everything above is achievable solo. Adding multiplayer, open-world
  streaming or a car roster is not.

## Files

- `src/` — the game. See the module map under "Current state" above.
- `tests/` — 42 headless tests over the rules, the physics and collision.
- `bent-city.html` — the original single-file prototype, kept as the historical
  record of where the bend came from. **It is no longer the game** and does not
  receive changes; open it to see what v0.7 looked like, not to play.
- `README.md` — how to run, build, test and deploy.
- `context.md` — this file. The project's memory.

## Open design questions

1. **Does the seam read?** Still open, and now with more riding on it. The
   transition from perspective to plan is smooth but you can feel it, and the
   horizon is where two differently-tessellated surfaces meet — the white
   slivers there took two separate fixes. Is a *visible* seam actually better —
   an honest horizon line the player learns to read?
2. **Should the bend be dynamic?** Built and shipped: it curls tighter at speed
   and relaxes when stopped. The risk flagged here — motion sickness — is why
   there is now a **Bend intensity** setting that scales the whole effect to
   zero. Nobody outside this project has tested it yet, which is the point of
   the risk.
3. ~~**What lives in the plan region that can't live in the perspective
   region?**~~ **Answered, 28 Aug.** Simultaneous orders with countdowns, a
   capacity limit that turns them into a routing problem, rivals racing you for
   them, and closures to route around. See the Dispatch section.
4. **Turning.** When you turn a corner, the whole map region swings. Still
   either the best or the worst thing about this, and still needs playtesting
   rather than argument. `uLock` is at 0.10, which is a small drift — enough to
   take the whip out of corners without the map feeling detached. The extremes
   (0.00, heading-up and violent; 1.00, world-locked and calm but showing you
   what is north rather than what is ahead) are both a slider away.
5. **New: is the tile repeat actually a problem?** Nine archetypes make each
   block distinct, but the period is still 522m. Nobody playing has complained
   about it yet, because the route and the orders never repeat and those are
   what you are looking at. It may be that the repeat only bothers the person
   who knows it is there. Worth finding out before paying for a bigger tile.

## Next session

Phases 0, 1, 2 and 4 are done; 3 and 5 are partly done. The view is no longer
the only thing under test, which changes what is worth doing next.

My suggestion, in order:

1. **Put it on a phone.** Both open risks — motion sickness from the
   speed-reactive bend, and vertex-bound performance — need a real device and a
   person who did not build it. Everything else is guessing. The settings that
   would rescue either case (Bend intensity, City life) already exist, so this
   is a measurement session, not a building one.
2. **Deploy it.** `npm run build` gives a static `dist/`. The deliverable being
   a URL was one of the reasons for staying in the browser, and right now it
   still isn't one.
3. **Tune the difficulty with someone else driving.** The numbers in
   `game/modes.ts` — order lifetimes, rival speed, how much clock a delivery
   pays back — were set by reasoning, not by playing. That is exactly the mistake
   the bend defaults avoided by being sliders.
4. Only then: open question 1 or 4, or the tile period.
