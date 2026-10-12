# TankStorm — Senior Engineering Review & Build Directives

**Audience:** The AI model (or engineer) implementing this game. Read this entire document before writing any code. The original plan is good; this document corrects the parts that will produce bugs, and prescribes exactly how to build the rest. Where this document contradicts the original plan, **this document wins.**

---

## Part 1 — Critical Verdicts (ranked by how badly they'll hurt you)

### 1.1 The game engine must NOT live in React state. (Highest severity)

The original plan says "State: React Context + useReducer" and the game loop step 5 says "Sync React UI." As written, this is the single most common way AI-generated games fail. If projectile positions, particle states, or per-frame physics flow through React Context, you get 60 re-renders/second of the entire component tree, dropped frames, stale-closure bugs in the game loop, and input latency.

**Directive:**
- The engine is a **plain TypeScript class/module** (`GameEngine`) holding all simulation state in mutable plain objects. It runs its own `requestAnimationFrame` loop. React never owns per-frame data.
- Three.js objects are updated **directly** by the engine every frame (`mesh.position.x = tank.x`). No React in the render path.
- React is for **HUD and menus only**, and it subscribes to a small, slow-changing snapshot: scores, current player, round number, wind, selected weapon, power/angle readouts, FSM phase. Expose this via `useSyncExternalStore` (or `zustand`, which wraps it) with a snapshot that changes **at most a few times per second**, not per frame. Power/angle while aiming may update per frame — render those two numbers in a tiny isolated component, or write them to a DOM node imperatively.
- Rule of thumb: **if a value changes every frame, React must not see it.** If a value changes on discrete game events (turn ended, score changed), React may see it.
- Context + useReducer is fine for the FSM phase and menu state. It is not fine for anything the game loop touches.

### 1.2 Fixed-timestep physics, not raw deltaTime. (Non-negotiable)

The plan's `vx += windEffect * deltaTime` per-frame update means the simulation behaves differently on a 60Hz laptop vs a 144Hz monitor, and large frame hitches cause tunneling and non-reproducible trajectories.

**Directive:**
- Simulate at a **fixed timestep** (recommend `dt = 1/120 s`) with the standard accumulator pattern:
  ```ts
  accumulator += clamp(frameDelta, 0, 0.1); // clamp to survive tab-switch hitches
  while (accumulator >= DT) { engine.step(DT); accumulator -= DT; }
  render(alpha = accumulator / DT); // interpolate visuals between last two states
  ```
- All physics constants (gravity, wind scale, power→velocity mapping) are defined **once** in a `constants.ts` in world units, tuned against the fixed dt. Never sample `performance.now()` inside `step()`.
- Use **semi-implicit Euler** (update velocity first, then position with the new velocity). It's stable and standard for this genre.
- Seed all randomness (wind, weapon scatter, terrain gen) from a single **seeded PRNG** (e.g., mulberry32) stored in game state. This makes bugs reproducible and enables replays and headless tests. `Math.random()` is banned inside the engine.

### 1.3 One coordinate system, declared once. (Silent-bug factory)

Three.js is Y-up. Canvas/screen coordinates are Y-down. The plan's pseudocode mixes them (`vy -= gravity` implies Y-up; heightmap "y-values per x-pixel" implies screen pixels). If you don't pin this down, you will get mirrored trajectories, inverted craters, and upside-down angle math — the classic artillery-game bug class.

**Directive:**
- **World space:** 2D, X right, **Y up**, origin at bottom-left of the battlefield. Units are abstract "world units" — recommend a battlefield of **1000 × 500 world units**. All game logic (physics, terrain, collision, scoring distances) lives exclusively in world space.
- **Angle convention:** degrees, `0° = pointing right (+X)`, `90° = straight up`, `180° = left`. Both tanks use the same convention; the left tank typically aims 20–90°, the right tank 90–160°. Do not implement per-player mirrored angle math — it's the #1 source of "player 2 shoots backwards" bugs.
- Velocity from fire action: `vx = cos(deg2rad(angle)) * power * POWER_SCALE`, `vy = sin(deg2rad(angle)) * power * POWER_SCALE`. Gravity subtracts from `vy`. Tune `POWER_SCALE` and `GRAVITY` so a 45°/75-power shot crosses ~60% of the map.
- Rendering maps world space → Three.js scene 1:1 (Three.js is also Y-up with an orthographic camera, so no flip is needed — this is exactly why Y-up world space is the right call). The **only** place any coordinate conversion happens is input handling (mouse screen coords → world) and it lives in one function.

### 1.4 Heightmap terrain cannot do tunnels — resolve the contradiction now.

The plan chooses a heightmap (one ground height per X column) **and** lists weapons that require overhangs/voids inside terrain: Tunneler (horizontal tunnel), Digger (covered vertical shaft), Phaser implications, Black Hole. A heightmap physically cannot represent a hole *under* solid ground. This is a design contradiction that must be resolved before Phase 2, not discovered in Phase 3.

**Directive — pick Option A:**
- **Option A (recommended): Keep the heightmap.** It makes terrain deformation, tank settling, rendering, and collision 10× simpler and matches how Pocket Tanks actually feels (dirt collapses; there are no true tunnels in Pocket Tanks either). Redesign the offending weapons:
  - *Tunneler* → carves a low horizontal **trench** toward the enemy (lowers heightmap along a path).
  - *Digger / Well Digger* → deep open pits (heightmap columns lowered a lot).
  - *Black Hole* → removes a large smooth crater and pulls the enemy tank toward the center.
  - Everything else in the arsenal works fine with a heightmap.
- **Option B (only if true tunnels are a must-have):** Worms-style destructible **bitmap terrain** (a 2D occupancy grid, e.g. 2048×1024 Uint8Array, rendered as a texture on a quad, collision via grid sampling). It's the more powerful model but costs you: harder tank settling (flood/support logic), harder "walk along surface" movement, more complex mesh/texture updates. Do not choose B casually.
- Heightmap spec (Option A): `Float32Array` of length **1024** (one height per column, world units), generated with 2–3 octaves of 1D simplex/value noise, smoothed, clamped so both tank spawn zones (18–22% and 78–82% of width) are locally flat (flatten a 40-unit window around each spawn).
- **Crater carving** is pure math on the array: for a crater at `(cx, cy)` radius `r`, for each column `x` within `r` of `cx`: compute the circle's vertical span at that column; if terrain height is inside the circle, lower it to the circle's bottom edge (`cy - sqrt(r² - (x-cx)²)`), but never below `max(cy - ..., MIN_FLOOR)`. Then re-settle tanks (see 1.7). Write **unit tests** for this function before rendering anything.
- Terrain **raise** weapons (Magic Wall, Terraformer, Barrier, Fortress) are the same operation with addition, clamped to a max height.

### 1.5 Decide the health model: points-only (recommended) or HP. Not both.

The plan gives tanks `health: 100` *and* a points-based scoring table *and* a "tank destroyed +50" bonus. Pocket Tanks — the game being improved on — is **pure points, no health, tanks never die**; that's precisely what makes every one of a fixed number of turns matter and eliminates a pile of edge cases (dead tank mid-round, simultaneous destruction, respawn?).

**Directive:** Ship **points-only**, exactly like Pocket Tanks:
- No HP bar. Damage numbers in the weapon table become **base point values**.
- Match = fixed **10 volleys** (each player fires 10 times, alternating who goes first each volley for fairness). Highest total score wins.
- Delete "tank destroyed / knocked off map +50" as a destruction bonus; replace with: if a tank is knocked off the map edge by knockback/tornado, it repositions at the edge and the shooter gets a flat +25 style bonus. The game must never enter a "tank doesn't exist" state.
- Keep self-damage as **negative points** (shooter loses points for hitting themselves). This is important for dirt-mover and bounce weapons to feel fair.
- This decision deletes an entire class of FSM states and bugs. If HP-mode is wanted later, add it as a second mode after the points game is stable.

### 1.6 Turn resolution: "impact resolved" is a settlement condition, not an event.

The FSM's `P1_FIRING → impact resolved` transition looks atomic but isn't. Cluster Bomb spawns 5 children; napalm burns over seconds and flows downhill; craters make tanks fall; a falling tank can trigger further scoring. If you transition turns on "first impact," multi-stage weapons break.

**Directive:** The FIRING state ends only when the **world is settled**:
```
settled :=
  activeProjectiles.length === 0
  AND no tank currently falling (all tanks within ε of terrain surface)
  AND no active transient effects (napalm still spreading, tornado active)
  AND a 500ms post-quiet grace timer has elapsed
```
- All projectiles (including spawned children) live in one `activeProjectiles` array owned by the engine; weapons that split simply push more entries.
- Persistent zone effects (radiation DoT, fire patches) do **not** block settlement; they register as `ZoneEffect { area, ticksRemaining, pointsPerTick, owner }` and are applied during the **turn-transition step** (decrement ticks, apply points to any tank inside). This keeps lingering effects out of the flight-time hot path and out of the FSM.
- Add a hard **watchdog**: if FIRING exceeds 15 seconds (runaway bouncer, NaN velocity), force-detonate all projectiles and settle. Log it loudly in dev. This single guard prevents the most embarrassing class of "game froze" bugs.
- Score accumulates during flight into a per-shot ledger, and is committed + displayed as a floating total when settlement completes.

### 1.7 Tank settling must run after every terrain edit.

**Directive:** `settleTank(tank)`: sample terrain height at the tank's X (average of 3 samples across the tank's width for slope stability); if the tank is above it, it falls with gravity until contact; if terrain rose into the tank (wall weapons), push the tank up to the surface. Run for both tanks after **every** terrain modification and every knockback. Tanks take **no fall damage** (points-only model), but a tank buried by a dirt weapon stays buried until it digs out or is blasted out — that's a legitimate Pocket Tanks tactic (bury the enemy). Tank X-movement (the 4 move points) walks along the surface: new Y is always sampled from terrain; refuse movement if the slope exceeds ~60°.

### 1.8 Projectile–terrain collision must be swept, not point-sampled.

At high power a projectile moves many world units per step and will skip through terrain ridges if you only test its endpoint.

**Directive:** Each physics step, test the **segment** from previous position to new position: sample terrain height at 4–8 interpolated points along the segment (heightmap lookup is O(1), this is cheap); first sample where `y <= terrainHeight(x)` is the impact point — binary-search refine it to ~0.5 world units. Same swept test against tank AABBs (tank hitbox ≈ 24×14 world units). This one directive prevents the "shot went through the mountain" bug permanently.

---

## Part 2 — Architecture Directives

### 2.1 Module layout: engine is pure, rendering is a projection

Keep the plan's file structure, with one hard rule added: **`game/engine/`, `game/weapons/`, and `game/state/GameStateMachine.ts` must not import Three.js, React, or DOM APIs.** They operate on plain data. `game/rendering/` reads engine state and mutates Three.js objects. This makes the entire game logic testable headlessly in Vitest (see 2.6) and is the difference between a debuggable game and a haunted one.

```
engine.step(dt)            // pure simulation tick
engine.getSnapshot()       // cheap immutable-ish HUD snapshot (only rebuilt on change)
renderer.sync(engine, alpha) // engine state -> Three.js scene, with interpolation
```

### 2.2 Three.js usage (this is a 2D game wearing 3D clothes)

> **Note (art pass):** the rendering layer has since been rebuilt around this
> directive — modules, shaders, assets, the defects that were fixed and the
> headless harness used to verify them are documented in **[RENDERING.md](RENDERING.md)**.


- **OrthographicCamera**, fixed, showing the entire 1000×500 battlefield with a small margin. **Cut the "camera follows projectile" feature from v1** — Pocket Tanks shows the whole field, and a static camera removes an entire subsystem (smoothing, bounds, HUD-space vs world-space) for near-zero gameplay loss. Add a subtle zoom-punch on big explosions later if wanted.
- Terrain mesh: build a `BufferGeometry` triangle strip from the heightmap **once** (1024 columns → ~2046 triangles); on terrain change, **rewrite the position buffer attribute and set `needsUpdate = true`** — never dispose/recreate geometry per explosion. Vertex colors or a 1D gradient texture for the grass/dirt/deep-earth banding.
- Tanks: simple extruded shapes or low-poly models; turret is a child object rotated by angle — rotation happens in the renderer from engine state, no physics on the turret.
- Particles: **one pooled `THREE.Points` system** (preallocate ~4,000 particles with position/velocity/life/color attributes, reuse dead slots). Never allocate meshes per particle, never allocate per frame in the loop. Explosions, sparks, dirt spray, fire are all this one system with different spawn parameters.
- Screen shake: offset the camera, driven by a decaying trauma value (`shake = trauma²`), clamped. Applied in renderer only.
- Post-processing (bloom for lasers/glow): use `EffectComposer` + `UnrealBloomPass`, but add it in Phase 5 and keep a flag to disable it — it's the most common perf cliff on integrated GPUs.
- `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`, handle canvas resize via `ResizeObserver`, and dispose geometries/materials/renderer on route unmount (Electron apps that navigate Landing↔Game repeatedly will leak GPU memory otherwise).

### 2.3 Weapon system: data + composable behaviors, never 55 classes

55 bespoke weapon implementations is how the project dies in Phase 3. Almost every weapon in the table is a composition of ~8 primitives.

**Directive:** A weapon is a **data record** referencing shared behavior components:

```ts
interface WeaponDef {
  id: string; name: string; category: Category;
  basePoints: number;
  projectile: {
    count: number;              // shots fired (Scattershot: 6)
    spreadDeg?: number;         // angular spread for count > 1
    salvoDelayMs?: number;      // Tommy Gun: sequential firing
    windImmune?: boolean;
    massScale?: number;         // Cannonball: less wind, faster fall
    bounces?: number;           // 0 default; Rubber Ball: 8
    bounceRestitution?: number;
    homing?: { turnRateDegPerSec: number; acquireDelayMs: number };
    trailFx: TrailFxId;
  };
  impact: ImpactSpec[];         // executed in order at impact point
}

type ImpactSpec =
  | { kind: 'explosion'; radius: number; knockback: number; craterScale: number }
  | { kind: 'carve'; shape: 'crater'|'trench'|'shaft'|'wideShallow'; size: number } // dirt movers: carve, little/no points
  | { kind: 'build'; shape: 'wall'|'pillar'|'dome'; size: number }
  | { kind: 'zone'; effect: 'fire'|'radiation'; radius: number; ticks: number; pointsPerTick: number }
  | { kind: 'split'; child: WeaponRef; count: number; spreadDeg: number; inheritVelocity: number } // cluster
  | { kind: 'beam'; piercesTerrain: boolean; width: number }   // lasers resolve instantly on fire, skip ballistics
  | { kind: 'displaceTank'; mode: 'pull'|'lift'|'random'; strength: number }; // gravity well, tornado
```

- **Lasers/beams are not projectiles.** On fire, raycast the aim line against terrain (heightmap march) and tank AABBs, apply damage/carve along the line, render a beam quad that fades over ~300ms. Trying to make lasers "very fast projectiles" causes tunneling and wind bugs — special-case them cleanly.
- Homing: cap the turn rate and add an acquire delay (~400ms of pure ballistic flight first) or homing weapons become no-skill auto-hits; wind-immune by definition.
- Shields (Dome, Bubble Wrap) are a **tank status** (`shieldHp` / `absorbNextHit`) checked in the damage-application function — one `applyHitToTank()` chokepoint through which ALL damage flows (this is also where self-damage negative points and scoring multipliers live). Never apply damage from more than one code path.
- **Cut list for v1.0** (ship with ~40, add the rest post-stability): *Boomerang* (curve-back logic is fiddly and unsatisfying), *Death Ray* sweeping (make it a fat instant beam), *Flea Circus* 25 bouncing bodies (perf/settlement stress), *Tracker Dart* (cross-turn targeting state complicates the FSM), *Flamethrower* (stream weapons don't fit the ballistic turn model — replace with a short-range fire cone burst).
- Build order within Phase 3: implement the **8 archetypes first** — Single Shot (explosion), Cluster (split), Napalm (zone), Dirt Mover (carve), Magic Wall (build), Skipper (bounce), Heatseeker (homing), Laser (beam). When all 8 work end-to-end with scoring and settlement, the remaining ~32 weapons are **data entry**, ~15 lines each. Do not write weapon #9 before all 8 archetypes pass tests.

### 2.4 Scoring: one function, distance-based, from the plan's table

```ts
// in applyHitToTank / resolveExplosion — the single scoring chokepoint
score = basePoints * (directHit ? 1.0 : dist <= 30 ? 0.5 : dist <= 60 ? 0.25 : 0)
if (victim === shooter) score = -abs(score) * 0.5
```
Distances in world units from explosion center to tank center. Multi-hit weapons score per pellet (so Tommy Gun's 15×3 must be balanced knowing most pellets miss). Show floating score popups (+18, −7) at impact points — this is the core feedback loop of Pocket Tanks; treat it as a Phase-2 feature, not polish.

### 2.5 Weapon shop / draft (define it precisely — the plan doesn't)

Pocket Tanks' draft: alternating picks. **Directive:** 5 draft rounds; each round deals **6 random weapons** from the registry (weighted so at least 2 are "premium" category); players alternate first-pick (P1 picks first in odd rounds, P2 in even); each player picks 1 per round + both players also receive 5 random weapons hidden until game start → each player enters with **10 weapons**, each usable once. Duplicates allowed across players, not within a player's arsenal. This is a self-contained React modal — engine not involved until it hands over two 10-weapon arrays.

### 2.6 Testing (this is how you get "without errors and without bugs")

The request is a bug-free game; the only honest path is a headless-testable engine. **Directive — write these in Vitest as the systems are built, not after:**
1. **Trajectory golden tests:** given seed/angle/power/wind, the projectile lands at an exact expected x (regression-locks the physics; any constant change fails loudly).
2. **Crater math:** carve at known points → assert exact heightmap values; crater at map edge doesn't index out of bounds (clamp all heightmap access — off-by-one at column 0/1023 is a guaranteed bug otherwise).
3. **Settlement:** cluster bomb → assert turn doesn't end until all 5 children resolve; watchdog fires on an immortal bouncer.
4. **Scoring:** direct/near/graze/self-hit through `applyHitToTank`, including shield absorption.
5. **FSM:** full 10-volley game driven by scripted inputs completes with correct winner; firing during opponent's turn is rejected.
6. **Determinism:** same seed + same input script twice → identical final state (catches hidden `Math.random()` / time-dependence instantly).

Run `tsc --noEmit` + tests in CI/pre-commit. TypeScript `strict: true`, no `any` in `game/engine/**`.

### 2.7 Electron: defer it, then lock it down

Electron contributes nothing to gameplay and complicates the dev loop.
- **Phases 1–4: develop as a pure Vite web app in the browser.** Faster HMR, DevTools, zero packaging friction. Structure `electron/main.ts` + `electron-builder` as a Phase 5 wrapper (use `electron-vite` or `vite-plugin-electron` then).
- When wrapping: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a preload exposing only what's needed (probably just a save-file API via `contextBridge`), and a strict CSP. The game needs no Node APIs at runtime — keep it that way.
- Persist settings/stats with `localStorage` first; move to `app.getPath('userData')` JSON through the preload bridge only if needed.

### 2.8 Stack trims

- **Cut GSAP.** Game-world FX belong in the engine/particle system (a 20-line tween helper inside the engine covers turret recoil etc.); UI animation is framer-motion's job. Two DOM animation libraries is a dependency and a decision tax with no payoff.
- shadcn/ui: use it for the shop/pause/menus, but verify the components you generate target **Tailwind v4** (shadcn's Tailwind v4/React 19 support is current but codemods from older snippets break — prefer freshly generated components).
- `backdrop-filter: blur(20px)` on large HUD panels layered over a WebGL canvas is a real GPU cost. Keep glass panels small, prefer `blur(8–12px)`, and have a "reduced effects" toggle. Test on integrated graphics early, not after the UI is final.
- Input: the plan lists both "hold spacebar" and "drag power slider" for power. **Directive:** keys are canonical (hold-to-charge with visible fill, release = fire is satisfying and Pocket-Tanks-authentic); the on-screen slider is a mouse alternative that sets the same engine value. One source of truth in the engine: `aim: { angleDeg, power }`, mutated only via `InputManager` actions. Gate ALL gameplay input on `phase === AIMING && isCurrentPlayer` — input leaking into the FIRING phase is a classic bug.

---

## Part 3 — Revised Implementation Phases (vertical-slice order)

The original phases build all foundation, then all gameplay, then all weapons. Invert it: get one complete playable loop as early as possible, because turn flow + settlement + scoring is where the design risk is.

**Phase 0 — Skeleton (small):** Vite + React + TS strict + Tailwind + routes; plain-page Landing (pretty version comes last); empty Game route mounting a Three.js ortho canvas; Vitest wired.

**Phase 1 — Vertical slice (the milestone that matters):** heightmap gen + terrain mesh; two tanks settled on terrain; aim/power input; ONE weapon (Single Shot) with fixed-timestep ballistics, swept collision, crater carving, tank settling, knockback; scoring popups; full FSM for a 3-volley match with wind; game-over screen with winner. *At the end of Phase 1 the game is genuinely playable with one weapon.* Every later phase is additive.

**Phase 2 — Weapon architecture:** WeaponDef schema, the single damage chokepoint, zone-effect system, settlement condition + watchdog, the 8 archetype weapons, tests from §2.6.

**Phase 3 — Content:** remaining ~32 weapons as data; draft shop; movement points; particle system variety per category; floating score juice.

**Phase 4 — Presentation:** glassmorphism HUD pass, landing page, sound (Howler.js or plain WebAudio; pool audio nodes), screen shake/bloom behind a quality toggle.

**Phase 5 — Ship:** Electron wrapper + hardening (§2.7), electron-builder packaging, optional AI opponent (a simple one is very doable in this architecture: simulate candidate shots headlessly with the pure engine — pick angle/power by running `engine.simulateShot()` on a cloned state, add gaussian aim error for difficulty levels; this is the payoff of a pure engine).

---

## Part 4 — Bug-Trap Checklist for the Implementing AI

Verify each of these explicitly; they are the historical failure modes of this exact genre:

1. **Y-axis flips** between input (screen Y-down), world (Y-up), and Three.js — conversions in exactly one function.
2. **Player 2 aims backwards** — one global angle convention, no mirrored math.
3. **Tunneling** — swept segment collision (§1.8), never endpoint-only.
4. **Frame-rate-dependent physics** — fixed timestep (§1.2); test by simulating with artificial 30/144 fps frame deltas → identical results.
5. **Heightmap edge indexing** — clamp `x` to `[0, N-1]` in ONE accessor function; craters at map edges are the test case.
6. **Turn ends too early / never ends** — settlement condition + 15s watchdog (§1.6).
7. **React re-render storms** — no per-frame values in Context; profile with React DevTools during a cluster-bomb shot.
8. **Damage applied twice** (explosion + child projectile + zone tick overlapping) — single `applyHitToTank` chokepoint with a per-explosion once-per-tank guard.
9. **Tank floating/buried after terrain change** — settle both tanks after every terrain write, including builds.
10. **NaN propagation** — a NaN in velocity silently freezes settlement; add a dev-mode assert in `step()` that all positions/velocities are finite.
11. **GPU leaks on route change** — dispose renderer/geometries/textures on unmount; navigating Landing↔Game 10 times must not grow GPU memory.
12. **rAF running while paused/in menus** — pause halts `engine.step` (accumulator frozen) but keeps rendering one static frame; resuming must not fast-forward accumulated time (that's what the 0.1s clamp is for).
13. **Keyboard ghosting** — hot-seat is turn-based so simultaneous input is rare, but gate inputs by current player anyway; also `preventDefault()` on Space/arrows or the page scrolls in dev.
14. **Weapon count balance** — multi-shot weapons must total roughly the same expected points as single-shots given realistic hit rates; tune with the headless simulator, not by feel alone.

---

## Part 5 — Decisions Made (so the implementer doesn't relitigate)

| Question | Decision |
|---|---|
| Health or points? | **Points-only**, Pocket Tanks style. Tanks never die. 10 volleys, highest score wins. |
| Terrain model | **Heightmap (1024 columns, Float32Array)**; tunnel weapons redesigned as trenches/pits. |
| Camera | **Fixed orthographic, whole battlefield visible.** No projectile-follow in v1. |
| Timestep | Fixed 1/120s, semi-implicit Euler, render interpolation. |
| RNG | Single seeded PRNG in engine state; `Math.random()` banned in engine. |
| State | Engine = plain TS outside React; React subscribes to event-driven snapshots. |
| Lasers | Instant raycasts, not fast projectiles. |
| Wind | Per-volley (rerolled each round, both players fire under the same wind — fairer than per-shot), −50..+50, shown in HUD. |
| GSAP | Cut. framer-motion for UI, engine-side tweens for game FX. |
| Electron | Deferred to Phase 5; develop as web app; harden on wrap. |
| Weapon count v1.0 | ~40 shipped (8 archetypes + data-driven rest); 5 fiddly ones cut/redesigned (§2.3). |
| Weapons per match | 10 each via draft (§2.5), single-use each. |

---

*If any directive here conflicts with an implementation convenience discovered mid-build, the priority order is: (1) determinism & testability, (2) the settlement/turn correctness rules, (3) performance, (4) feature completeness. Cut features before cutting correctness.*
