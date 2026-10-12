# TankStorm — Rendering

Art direction: **modern arcade**. Saturated, high contrast, bold silhouettes,
bloom. Readability wins every tie: the terrain surface, the two tanks and the
shell in flight must always be the easiest things on screen to find.

`GameRenderer` is an orchestrator. Each visual concern lives in its own module
so it can be reasoned about — and replaced — on its own.

| Module | Owns |
|---|---|
| `themes.ts` | per-mode palette, key light, bloom + grade settings, weather |
| `assets.ts` | CC0 texture loading, procedural fallbacks, `ready` promise |
| `TerrainMaterial.ts` | world-space strata shader |
| `TerrainMesh.ts` | 2-row geometry, slope + carve-heat attributes |
| `TankModel.ts` | authored 2D silhouettes, outlines, muzzle flash, treads |
| `ParticleSystem.ts` | textured points with per-particle size / spin / life |
| `Explosions.ts` | atlas fireball + shockwave ring + core flash |
| `Backdrop.ts` | sky, parallax ridges, stars, clouds, rain / embers / dust |
| `PostFX.ts` | bloom → colour grade → output |
| `GameRenderer.ts` | camera, resize, theme switching, per-frame wiring |

---

## The five things that made the old renderer look wrong

Each of these was a specific, findable defect — worth recording so they don't
come back.

**1. Terrain colour bands were measured DOWN FROM THE SURFACE.**
Six rows of vertex colours at `surfaceY − 5`, `−13`, `−55`, `−150`. Every band
slid up and down with the ground, so the terrain read as stacked ribbons and a
fresh crater cut no geology — it just moved the ribbons.
→ Strata are now defined in **world space** in a fragment shader, so digging
slices through the layers and exposes them. Geometry dropped from six rows per
column to two, because the mesh now only has to describe the silhouette.

**2. Tanks were literal 3D geometry in an unlit 2D scene.**
`BoxGeometry` hull, `SphereGeometry` turret, `CylinderGeometry` wheels, lit by a
`DirectionalLight` while nothing else in the scene was lit at all. Through an
orthographic camera that reads as a shaded 3D toy glued onto a flat backdrop.
→ Authored `THREE.Shape` silhouettes with hand-authored dark outline polygons, a
vertical gradient fill and a lit top edge. There are no lights in the scene now.

**3. Particles were untextured `PointsMaterial`.**
One global size, no map — every particle an identical hard-edged square. Sizes
were also in fixed **device pixels**, so effects changed size with the window.
→ Custom shader with per-particle size, spin and life curve, sized in **world
units** via pixels-per-world-unit.

**4. Explosions were a single expanding ring.**
A ring alone has no mass; it reads as a diagram of an explosion.
→ Three stacked elements: core flash (the detonation instant), a 64-frame CC0
fireball atlas, and a shockwave racing ahead of it. Dark smoke deliberately is
*not* part of this — additive blending cannot draw anything darker than its
background, which is why the smoke particle layer exists separately.

**5. There was no post-processing at all.**
Without bloom there is nothing to bleed light into neighbouring pixels, so
"glowing" and "just bright" look identical.
→ `bloom → grade → output`, with a multisampled render target (EffectComposer
otherwise discards the renderer's MSAA, which would shred the tank outlines).

---

## Two bugs found by actually looking at the output

Both were invisible in code review and obvious in a screenshot.

**The colour grade crushed every dark sky to pure black.** Contrast was
`(col - 0.5) * c + 0.5`, which drives anything below ~0.06 negative. This pass
runs *before* tone mapping, where the night sky legitimately sits around 0.007.
Contrast is now a gamma curve — it preserves 0 and 1 and never clips the HDR
highlights bloom needs.

**The terrain palette's value ramp was inverted.** `rockTint` (`#6b6f7d`, L≈45%)
was *lighter* than `dirtMid` (`#8a5a2c`, L≈36%), so the deeper you dug the paler
it got and the bottom of the screen read as fog instead of stone. Depth must
descend in value and drift cool.

---

## Assets

Everything bundled is **CC0** — see `src/game/rendering/art/LICENSES.md`.
Total: **~430 KB**.

Terrain photoscans (ambientCG) are stored as **grayscale detail**, not colour:
the four themes supply colour and the texture supplies only grain, so one
texture set serves every theme. The explosion atlas is OpenGameArt; the sprites
(particle, smoke, spark, flash, ring, cloud, noise) are generated procedurally.

Art files are **imported**, never referenced as `/assets/...`. `vite.config.ts`
sets `base: "./"` and Electron loads the production build through `loadFile`
(file://), where an absolute path resolves to the filesystem root and 404s.
Importing lets Vite emit a correct relative URL for both dev and the packaged
app — and files under 4 KB get inlined as data URIs, which is safer still.

---

## Looking at it: the visual harness

`GameRenderer` can be driven headlessly, which is how the screenshots above were
checked. This matters: three of the defects in this document were found by
looking at a PNG, not by reading code.

```bash
npm run shots      # builds the harness and writes devtools/shots/*.png
```

`harness.html` + `devtools/harness.ts` boot `GameRenderer` straight into a staged
frame (craters carved, explosions mid-animation, a shell in flight) and render a
fixed number of frames. Query params: `?theme=night|storm|lunar|inferno`,
`&scene=calm|battle|dug`, `&t=<seconds>`.

Three things make it work, and all three are load-bearing:

- **`render(dtOverride)`** — on software GL a single frame costs over a second of
  real time, so wall-clock delta would fast-forward every effect past its
  lifetime. The harness passes a fixed step.
- **`art.ready`** — textures decode asynchronously; rendering before they land
  gives flat untextured terrain, which is exactly what the first screenshot
  showed.
- **`msaaSamples: 0`** — multisampled float targets are pathologically slow under
  software rasterisation. Everything else (bloom, grade, every shader) is real.

The harness is served over `file://` with `--allow-file-access-from-files`
because headless Chrome cannot always reach a localhost dev server. It uses its
own `devtools/vite.harness.config.ts`: the shipped config runs
`vite-plugin-electron`, which spawns Electron on dev-server start.
`harness.html` is **not** part of `npm run build`.
