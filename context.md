# Melonpan Delivery Service — project context

_Last updated: 26 Aug 2026_

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
| Mechanics | Collect melonpan → deliver → score. Single analogue joystick. No timer yet. |
| Vehicle | Kei truck based on the 2010 Subaru Sambar. Cab-over, narrow track, tall body — it leans. |
| Aesthetic | Near-white concrete, cool grey shade, matcha green `#7FA650` as the only accent, with a warm melonpan `#E8C87A` for cargo. Flat shading, no textures. |
| Camera | Fixed chase cam. The **world** bends, not the camera. |
| HUD | Minimal. Uppercase, wide tracking, tabular numerals. |

Why the aesthetic matters technically: flat untextured surfaces bend cleanly.
The reference video looks melty because photogrammetry meshes distort under the
warp. Simple shapes don't.

## How the bend actually works

This is the whole concept, and it's about 12 lines of GLSL (`bendGLSL` in
`bent-city.html`).

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
  integrated once on the CPU (`computeBendEnd`, 800 steps) and passed in as a
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

Current defaults (Chris's preference): `z0` 70, `R` 20, `kMin` 0.40, `uEase` 1.00,
`uFlat` 0.06, camera 11. City grid widened to 13×13 so there's something to see
at that zoom.

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

## Current state — v0.1 playable

Working:
- Bend shader with live tuning sliders
- Endlessly repeating city — one 9×9 tile drawn 3×3, player position wrapped
- Accent-roofed landmark buildings (navigable features in the plan-view region)
- Driving with collision against blocks
- BFS route-finding on the intersection graph
- Red route ribbon that follows the bend
- Destination pillar (bends into a dramatic lean at distance)
- Pickup/delivery loop and score. **No timer** — this is a sandbox for
  experimenting with the projection, not a challenge yet. Add one back when the
  view stops being the thing under test.
- One virtual joystick, both axes (horizontal = steer, vertical = throttle/brake),
  spring-centred, built on pointer events with pointer capture. Keyboard
  (WASD / arrows / space) overrides it when held.

Not built yet:
- Traffic, pedestrians, anything alive
- Sound
- Junction-level guidance in the near field (turn arrows painted on the road)
- Any handling nuance — the car is a placeholder
- Menus, restart without refreshing

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
browser with three.js.** The reasoning is in `kickoff.md`, but in short: this
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

**Phase 0 — foundation**
Repo, Vite, TypeScript, port the prototype into modules (structure is in
`kickoff.md`). Deploy to Netlify so every commit publishes.
*Done when:* the current prototype runs from a URL, split across files, with
nothing new added.

**Phase 1 — driving feel**
Raycast suspension, weight transfer, tyre slip curves, camera lag and roll.
*Done when:* you'd enjoy driving around with no objective and no map.

**Phase 2 — audio spine**
Bus architecture, layered engine sound, tyre and surface noise, spatial sources
on unbent coordinates, first adaptive music stems.
*Done when:* closing your eyes tells you roughly what the car is doing.

**Phase 3 — a city worth looking at**
More variety per tile, landmarks that read from above, junction markings, traffic
if it earns its place. Speed-reactive bend tuned properly.
*Done when:* driving a straight line for a minute doesn't reveal the repeat.

**Phase 4 — the game**
The open design question: what decision can a player only make because they can
see both scales at once? This phase is design, not code, and it's the one that
decides whether this is a game or a demo.
*Done when:* a player who can't see the map region plays measurably worse.

**Phase 5 — ship**
PWA manifest, offline caching, performance pass on mid-range phones, Electron
build and Steamworks integration if going to Steam, title and settings screens.
*Done when:* someone else can find it, install it and play it without you there.

### Risks worth watching

- **Phase 4 is the real risk.** Phases 0–3 are known work. Phase 4 is invention,
  and it's tempting to keep polishing the view instead of doing it.
- **Motion sickness.** The speed-reactive bend is aggressive. Test on people who
  didn't build it, early, before more is built on top of it.
- **Mobile performance.** Vertex count is the constraint here, not fill rate,
  because the bend runs per vertex. Measure on a real mid-range phone rather than
  a desktop browser's device emulator.
- **Scope.** Everything above is achievable solo. Adding multiplayer, open-world
  streaming or a car roster is not.

## Files

- `bent-city.html` — the entire game, one self-contained file. Open in any browser.
- `kickoff.md` — how to take this from prototype to real project. Both paths.
- `context.md` — this file.

## Open design questions

1. **Does the seam read?** Right now the transition from perspective to plan is
   smooth but you can feel it. Is a *visible* seam actually better — an honest
   horizon line the player learns to read?
2. **Should the bend be dynamic?** Curl tighter at speed (more look-ahead) and
   relax when slow or stopped. Risk: motion sickness.
3. **What lives in the plan region that can't live in the perspective region?**
   Roof tone now encodes building height, which is a start. It needs more:
   other drivers, timers, competing objectives — things you can only judge from above.
4. **Turning.** When you turn a corner, the whole map region swings. That's
   either the best or the worst thing about this. Needs playtesting.

## Next session

Play it, note what feels wrong, and pick one of the open questions above to
attack. My suggestion: #3 — the strategic region needs a reason to exist beyond
looking cool.
