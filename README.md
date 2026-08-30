# Melonpan Delivery Service

An arcade delivery game with one idea behind it: **a single continuous camera
view that is street-level perspective near you and a top-down map far ahead,
with no cut or split between them.** You drive a matcha-green kei truck
delivering melonpan across a city that folds up in front of you — or, on the
Kaidō pass, chasing a clock up five kilometres of mountain road with the corners
laid out flat above the horizon.

The camera is completely ordinary. The *world* bends.

![the fold](docs/fold.png)

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Typecheck, then build a static site into `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm test` | 142 headless tests over the rules, the physics, collision, the city plan and the pass |
| `npm run typecheck` | TypeScript, no emit |
| `npm run check` | Typecheck and tests — run this before committing |

`dist/` is plain static files with relative paths, so it drops onto Netlify,
GitHub Pages, Cloudflare Pages or a folder on a web server unchanged.

## Playing it

Pick a **place** first, then a mode. The two are not difficulty settings on one
game — they are two games that happen to share a truck.

| Place | The game |
|---|---|
| **The city** | Deliveries. Several orders live at once, three crates a load, rivals racing you for them, roadworks that move. The clock is only refilled by delivering. |
| **Kaidō pass** | A timed run, start line to summit and over. Five kilometres of road, nineteen corners, **six hairpins**, eight checkpoints and no rivals — and the plan region stops being a map and becomes a co-driver. |

**Keyboard** — **WASD** or the arrows, **Space** brake, **Shift** drift,
**Esc** pause, **M** mute, **T** the bend tuner.

**Controller** — left stick steers, **RT** throttle, **LT** brake (**A** and
**B** work too, for pads with digital triggers), either shoulder to drift.
**Start** pauses, **X** mutes, **Y** opens the tuner. On the menus the **D-pad**
moves between modes and **A** confirms, so you never have to reach for the
screen. The touch controls hide themselves once a pad is in use.

**Touch** — steering on the left, pedals on the right, so the two never compete
for one thumb. The pedals are one surface rather than three buttons: **hold GO
and slide your thumb up onto DRIFT** to hold both, then slide back down. Keeping
your foot on the gas through a drift is the whole point of drifting. The steering pad has no fixed position: **wherever your thumb
first lands becomes the centre**, and it reads horizontal movement only. On a
tablet you cannot see your thumb and are not looking at it anyway, so a control
with a fixed position is one you keep missing. Everything is multi-touch, so
steering, throttle and drift work together.

### Bouncing off things

Building footprints are padded with a **circle, not a square**, so corners are
round and the contact normal turns smoothly through them. Padding each axis
separately makes every corner a right angle, and clipping one diagonally then
flips the push-out between x and z from step to step, scrubbing speed each time
until the truck stops dead — which is exactly what it used to do.

The response is a reflection: the component into the wall comes back out at 35%,
the component along it survives at 88%. So a graze costs almost nothing, a
head-on bounces you back, and a deep bite into a corner costs real speed. What
you lose scales with how you hit it, and nothing parks you.

### Steering feel

Deliberately not a simulation. The road wheels are rate limited rather than
snapping to the commanded angle, they return to centre faster than they leave
it, and lock is taken away with speed. The **Steering** setting on the pause
screen moves the rate limit, the yaw inertia and the yaw damping together on one
dial, calm to lively, because a thumb on glass and an analogue stick want
different numbers.

Worth knowing: calmer is *faster* through quick corners. The lively end reaches
a tighter radius only because it cannot hold the speed — it scrubs 30 m/s down
to 24 where the calm end holds 28.

### Drift and boost

Press drift and the truck **hops**. That is not decoration: the wheels really
leave the ground, so the suspension unloads, the tyres lose grip for a moment
and the truck lands already rotating — all of it falling out of the raycast
suspension from one vertical impulse. **The direction you are steering as it
lands is the drift you get**, so entry is a deliberate flick.

Once locked, the stick stops being a steering input and becomes **a choice of
angle**, as it is in Mario Kart. Held into the turn you get a tight drift; let
go and you get a middle one; hold it against the drift and you get a wide, fast
one. All three turn the same way — counter-steer gives you a *wider version of
the same corner*, never the opposite one — and none of them can spin you out.

The bargain is in the numbers. Over two seconds of corner from 20 m/s:

| stick | turned | speed held | charge | speed 1.6s later |
|---|---|---|---|---|
| into the drift | 109° | 11.5 | full | 24.0 |
| released | 88° | 15.7 | 0.56 | 21.2 |
| against it | 46° | 22.9 | 0.23 | 23.2 |
| *gripping, full lock* | *89°* | *19.3* | — | *23.0* |

A committed drift is the slowest way through a corner and the fastest way out
of one. Charge is time-based and runs faster with the stick hard over, so
committing pays — but you cannot farm it down a straight, because landing a hop
with no input and no rotation is just a hop.

Two things make it progressive rather than snappy: the target angle itself may
only travel so fast, so slamming the stick is a lean and not a step; and the
front wheels give up two thirds of their lock while drifting, because one stick
cannot do two jobs at full authority.

Releasing cashes the charge in as a boost. Boost is the one place a force is
applied to the body rather than through the tyres, because a boost that went
through the friction circle would do almost nothing in exactly the corner you
just earned it in.

Tyre smoke is flat ground-hugging quads rather than camera-facing sprites —
**billboards are one of the things the bend breaks**, since a sprite turned to
face the camera is turned in unbent space and ends up facing the wrong way once
the world folds.

Load three crates of melonpan at a bakery, then deliver them. Several orders
are live at once, each with its own countdown; rival couriers are racing you for
the same ones, and roadworks move around the city. Deliveries put time back on
the clock, so a shift lasts exactly as long as you keep earning it.

Three modes in the city:

- **Evening shift** — the standard run. Two rivals, roadworks that move.
- **Rush hour** — shorter clock, tighter orders, four rivals, half the city shut.
- **Free roam** — no clock, no rivals, nothing expires. The sandbox the
  projection was built in. Open this one to look at the view.

## The bend

Everything is transformed into player-local space first (`+Z` straight ahead,
`+Y` up, origin at the truck). Then, per vertex:

- `z < z0` — untouched. Ordinary perspective. This is the street you are on.
- `z >= z0` — the ground follows an arc of radius `R` that rotates it up through
  90°, **preserving arc length**, so the road never stretches or squashes.
- past 90° — it continues as a flat vertical plane, which the camera reads as a
  map.
- A vertex's height is pushed along the arc's normal, so distant buildings lean
  back and show you their roofs — then flattens through the fold, so they arrive
  on the map as footprints rather than as towers pointing at the camera.

It lives in `src/render/shaders.ts` and it is about a dozen lines.

**The bend never leaves `render/`.** Physics, audio, AI, routing and every game
rule run in ordinary unbent world space. That quarantine is the single most
important structural decision in the project: it is what keeps the rest of the
game normal to write, and it is why positional audio and collision were never
complicated by any of this.

Press **Tune the bend** to move all ten parameters live. They are the reason the
current defaults are what they are — every one was found by driving, not by
reasoning. Your settings are saved.

## What the map region is *for*

The design question the project spent its life circling was: what can live in
the plan region that cannot live in the perspective region? Pretty is not an
answer; the answer has to be a **decision only the map supports**. There are
three, and they compound:

1. **Simultaneous orders.** Several drops at once, each with a countdown ring on
   the ground. From the street you see the one you are pointed at. From the map
   you see all of them and choose an order to serve them in.
2. **A capacity limit.** Three crates, refilled at a bakery — so you cannot
   chase whatever is nearest, you have to pick a *cluster* one loop can serve.
   A cluster is a shape, and a shape is only visible from above.
3. **Rivals and closures.** A rival's chevron shows their heading and roughly
   their speed, so every order becomes "can I beat them there". A closure two
   blocks ahead is invisible from the street and obvious from the map.

Because block interiors are drivable, a closure does not stop you — it pushes
you onto the slow pavement cut-through. A cost, not a wall.

There is a fourth, and it only arrived once the city stopped being a grid:
**the streets themselves carry information.** On a lattice every route with the
same number of turns is the same length, so a map of it tells you nothing but
where the drops are. The city is an irregular Voronoi network now — blocks
differ in size and shape, a long diagonal beats the same displacement in steps,
and a junction is a place with a shape you can recognise. That is a map worth
looking at, which was the argument for the fold all along.

A rule falls out of all this: **anything that must be legible in both regions
needs a component built for each.** An objective has a tall pillar for the
street and a flat ring for the map. A closure has bars across the carriageway
and a flat X. A building has a facade and a roof tone that encodes its height.

### …and on a road with no junctions

The mountain pass is the same question asked again, with the city's answer taken
away. One road means no route to choose, so a map of it would be a stripe of
nothing.

What lives up there instead is **what the road is about to do**. The route ahead
is drawn as a ribbon coloured by corner grade — rally notes, where 1 is the
tightest and 6 is barely a bend — so a red stretch nine hundred metres up the
valley is on screen at the same time as your own bonnet. Lifting for a corner
you cannot yet see is a decision no street-level view can offer you.

The two-component rule holds: a corner has **rungs painted flat across the road**
(countable at map scale, where a smooth gradient would be a smudge) and a
**board on a post** out on the verge for the near field. The left-hand HUD column
carries the same information as text — grade and distance — exactly as it
carries the order manifest in the city.

There is no crash barrier. The valley wall is steep enough that gravity beats
what the tyres can put down, so going off costs you the corner rather than the
run.

The road is built from straights and constant-radius arcs rather than from a
curve, and that is not an implementation detail — it is what makes hairpins
possible at all. A road written as `x = f(z)` has an apex radius of `1/f″`, so
swinging it through ±71° at a 30-metre apex leaves the ends at a 717-metre
radius: tight for an instant, nearly straight either side. A hairpin needs a
*sustained* tight radius through 160°, which that form cannot express at any
amplitude.

## Testing it on an iPad with a controller

**Get it onto a URL — no computer required.** `.github/workflows/deploy.yml`
builds and publishes the game on GitHub's own runners, so a phone or an iPad
with a browser is enough to ship a change. One-time setup, doable entirely from
Safari:

> repo → **Settings** → **Pages** → Build and deployment → Source: **GitHub Actions**

That is the whole setup. Every push then publishes to
`https://<user>.github.io/<repo>/`. The build is gated on the test suite, so a
broken push does not become a broken URL.

**To redeploy without changing anything**, the simplest trigger is a push — any
commit on a watched branch starts a run. GitHub's own buttons for this are
genuinely awkward on a tablet:

- *Re-run failed jobs* lives on the **run's own page** (Actions → click the run),
  top right, behind a **Re-run jobs** dropdown. It is not on the Actions list
  page, and on a narrow screen it collapses to an icon that is easy to miss.
- *Run workflow* only appears once you have selected the workflow **by name in
  the left-hand sidebar** of the Actions tab. On the "All workflows" view there
  is no such button, which is the usual reason people cannot find it.

If the deploy job fails with `Failed to create deployment (status: 404)` and
`Ensure GitHub Pages has been enabled`, that is the Pages source not being set
to GitHub Actions yet — the build itself is fine. Set it, then push anything.

The build output uses relative paths throughout, which is why it works from a
project subpath rather than only from a domain root.

If you do have a machine and want a one-off without touching GitHub settings,
`npm run build` produces `dist/`, and dragging that folder onto
[Netlify Drop](https://app.netlify.com/drop) gives you an HTTPS URL with no
account. For a fast iteration loop on the same wifi, `npm run dev -- --host`
prints a LAN address the iPad can open directly.

**Install it to the home screen.** In Safari, Share → *Add to Home Screen*.
Launched from the icon it runs without browser chrome, which is worth a
surprising amount on a device this size — the manifest and the iOS-specific meta
tags are already in place.

**Pair the controller first**, in Settings → Bluetooth (Xbox, DualSense,
Backbone and MFi pads all work). Then, on the title screen:

1. **Tap the screen once.** This matters and is not obvious: a browser will not
   start an AudioContext without a user gesture, and *a gamepad button does not
   count as one*. Any tap anywhere unlocks the sound; without it you would drive
   in silence with nothing to explain why.
2. **Press a button on the pad.** Safari does not report a connected pad at all
   until you do — it will not even fire `gamepadconnected`. The title screen
   says so, and turns green with the pad's name once it sees it.

If the pad is not being seen, pause and look at the **Controller** row on the
pause screen: it shows the detected pad's name, or `press a button`, or flags a
non-standard mapping.

**What to look for**, since both of the project's open risks live on exactly
this device:

- **Motion sickness.** The speed-reactive bend is aggressive by design. If it
  is uncomfortable, drop **Bend intensity** on the pause screen — 0 freezes the
  projection completely, and somewhere in between is the interesting answer.
- **Frame rate.** Vertex count is the constraint here, not fill rate, because
  the bend runs per vertex. **City life** off removes traffic and pedestrians,
  which is the biggest single lever. If it is still short of smooth, the next
  levers are **Map scale** up and **Building height** down in the bend tuner.

## Layout

```
src/
  core/     city layout, pass shape, terrain, place (wrap + off-road),
            palette, maths, projection tuning
  render/   bend shader, geometry builder, city, pass scenery, block
            archetypes, materials, marker batching, chase camera, projection
  vehicle/  raycast suspension, collision, truck mesh
  world/    road network + its generators (organic city, pass), rivals,
            traffic, pedestrians
  game/     levels, rules (delivery / pass run), dispatch, pace notes, modes,
            run shell, persistence
  audio/    bus graph, engine, world sound, music, one-shots
  ui/       HUD, screens, joystick, bend tuner, stylesheet
tests/      headless tests — nothing here touches WebGL or the DOM
```

`bent-city.html` at the root is the original single-file prototype, kept as the
historical record. **It is not the game** and does not receive changes.

`context.md` is the project's memory: every design decision, every trap, and why
the numbers are the numbers. Read it before changing anything structural.

## Things that will bite you

Kept short here; the full list with the stories is in `context.md`.

- **The bend happens per vertex.** A long quad with four corners bends as a
  chord and looks broken. Subdivide along **z** — that is the axis the fold
  consumes. Subdividing vertically is provably free of effect and was costing
  four to nine times the geometry of every tall building.
- **`uBuildH` scales BUILDING height only.** Anything meant to be life size must
  pre-divide by it; anything the truck drives *on* is added after it. This trap
  has been fallen into twice, once for viaducts and once for traffic.
- **Never declare `attribute vec3 color`** in a custom vertex shader. Three.js
  injects it when `vertexColors: true`, and the redefinition fails to compile
  with a blank screen and no useful error.
- **Frustum culling is worse than useless here** — it tests the unbent position.
  Everything bent sets `frustumCulled = false`; tile copies are culled by hand
  in player-local space instead.
- **A moving object cannot be moved with a transform.** Every vertex carries an
  anchor naming the terrain to lift it onto, baked in at build time. Movers are
  re-authored in world space each frame.
- **All positional audio uses unbent world coordinates.** If a sound seems to
  come from where a bent building *looks* like it is, that is the bug.
- **Any full-screen overlay needs `pointer-events: none`,** or it silently eats
  every tap on the page.
- **A bearing is `(sin a, cos a)`, everywhere.** `slabRot` mapped its along axis
  to `(−sin a, cos a)` — the heading reflected in z — for the whole life of the
  grid city, and nobody noticed, because those two agree at 0° and ±180° and
  differ by exactly 180° at ±90°, and a lattice has no other angles. It broke
  the instant a street ran at 23°.
- **Inset a polygon by offsetting its EDGES,** not by scaling toward the
  centroid. Scaling under-insets corners by roughly half, which put corner
  buildings 4.7 m from the road centreline. And do not check the result with a
  signed area: inverting a polygon through its centre is a 180° rotation, which
  preserves orientation. Check every new vertex is inside every original edge.
- **Quad winding decides the lighting.** `Builder.quad` derives the face normal
  from the corner order, and the materials are double-sided — so a strip wound
  the wrong way still draws, just lit from underneath. The pass's whole valley
  shipped like that for an afternoon and read as permanent shadow.
- **The world wraps only where the level says it does.** `core/place.ts` owns
  that. Fold a mountain pass and driving off the summit puts you back on the
  start line at ninety kilometres an hour.
- **CPU terrain and shader terrain must stay identical, in both branches.** They
  live next to each other on purpose: the city's in `core/terrain.ts`, the
  pass's in `core/pass-shape.ts` beside its GLSL twin. Let them drift and the
  truck drives on a ghost surface, which presents as a physics bug. Don't
  suspect it, measure it: `__parity()` in a dev build renders the shader's
  terrain into a float target and reports the worst gap against the CPU's.

## Built with

[three.js](https://threejs.org), [Vite](https://vite.dev), TypeScript and
[Vitest](https://vitest.dev). No art assets, no audio files — the city is
procedural and every sound is synthesised, so the whole thing is one small
download.
