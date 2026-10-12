// ═══════════════════════════════════════════════════════════
//  Terrain material.
//
//  What the old renderer did: six rows of vertex colours whose depths were
//  measured DOWN FROM THE SURFACE. Every colour band therefore slid up and down
//  with the terrain, so the ground read as stacked ribbons and a fresh crater
//  cut no geology — it just moved the ribbons.
//
//  What this does instead:
//    • rock strata are defined in WORLD space, so digging a crater slices
//      through the layers and exposes them (the whole point of a destructible
//      terrain game),
//    • real photoscan grain at two scales, sampled in world space so the
//      texture never swims when the heightmap changes,
//    • a lit rim along the silhouette (the strongest readability cue on screen),
//    • freshly-carved columns glow with scorch heat for a moment.
//
//  Geometry is only TWO rows per column (surface + deep skirt) because all
//  colour is computed per-fragment from world position — the mesh only has to
//  describe the shape.
// ═══════════════════════════════════════════════════════════

import * as THREE from "three";
import type { Art } from "./assets";
import type { ThemePalette } from "./themes";

const vertexShader = /* glsl */ `
  attribute float aSurfaceY;
  attribute float aSlope;
  attribute float aDisturb;

  varying vec2  vWorld;
  varying float vSurfaceY;
  varying float vSlope;
  varying float vDisturb;

  void main() {
    vWorld    = position.xy;
    vSurfaceY = aSurfaceY;
    vSlope    = aSlope;
    vDisturb  = aDisturb;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D tSoil;
  uniform sampler2D tRock;
  uniform sampler2D tGrass;
  uniform sampler2D tNoise;

  uniform vec3  uGrassLow;
  uniform vec3  uGrassHigh;
  uniform vec3  uGrassDark;
  uniform vec3  uDirtLight;
  uniform vec3  uDirtMid;
  uniform vec3  uDirtDark;
  uniform vec3  uRock;
  uniform vec3  uDeep;
  uniform vec3  uRim;
  uniform vec3  uScorch;
  uniform vec2  uSunDir;
  uniform float uWorldHeight;

  varying vec2  vWorld;
  varying float vSurfaceY;
  varying float vSlope;
  varying float vDisturb;

  void main() {
    float depth = max(0.0, vSurfaceY - vWorld.y);   // 0 at the surface, grows down

    // ── detail grain, sampled in WORLD space so it stays welded to the ground
    float fine   = texture2D(tSoil,  vWorld / 42.0).r;
    float broad  = texture2D(tRock,  vWorld / 190.0).r;
    float blades = texture2D(tGrass, vWorld / 26.0).r;
    float n      = texture2D(tNoise, vWorld / 300.0).r;
    float nFine  = texture2D(tNoise, vWorld / 70.0).r;

    // ── layer boundaries, jittered by noise so they are never straight lines
    // Depths are tuned against what is actually ON SCREEN: the surface sits
    // around y=300 and the view floor is y=0, so anything below ~250 units is
    // never seen. The first pass put rock at 92-240 and the whole visible band
    // was topsoil.
    float j  = (n - 0.5) * 2.0;
    float jf = (nFine - 0.5) * 2.0;
    // Grass boundary uses the FINE noise: driven by the broad one it varied over
    // ~300 world units, i.e. a clean ribbon across the whole screen.
    // A 6-unit grass cap is ~5 px on screen; any bright 5 px band spanning the
    // map reads as a highlighter stroke. Thicker, with the tone falling away
    // fast inside it, reads as ground cover instead.
    float dGrass   = 15.0 + jf * 7.0 + j * 2.5;
    float dTop     = 30.0 + j * 10.0;
    float dSub     = 84.0 + j * 22.0;
    float dRockEnd = 165.0 + j * 38.0;

    // ── grass tint rises with elevation (high ground catches more light)
    float hf = clamp((vSurfaceY - 60.0) / (uWorldHeight * 0.6), 0.0, 1.0);
    vec3 grass = mix(uGrassLow, uGrassHigh, hf);
    grass *= 0.70 + 0.58 * blades;
    // Only the top sliver stays bright; the rest of the cap falls into shadow.
    float gDepth = pow(clamp(depth / dGrass, 0.0, 1.0), 0.55);
    grass = mix(grass, uGrassDark, gDepth);

    // Broad drift (≈190-unit wavelength) gives the face large-scale form; fine
    // grain alone left it reading as one flat sheet of orange.
    float form = 0.80 + 0.40 * broad;
    vec3 topsoil = uDirtLight * (0.66 + 0.44 * fine) * form;
    vec3 subsoil = uDirtMid   * (0.78 + 0.38 * mix(fine, broad, 0.6)) * form;
    // Patches of exposed dark earth break up the topsoil band
    topsoil = mix(topsoil, uDirtDark, smoothstep(0.62, 0.95, n) * 0.35);

    // ── WORLD-space strata: bands keyed to absolute Y, so a crater cuts across
    //    them and exposes the layering instead of dragging it along
    float band  = sin((vWorld.y + n * 55.0) * 0.062);
    float band2 = sin((vWorld.y * 0.021) + broad * 3.4);
    float strata = 0.68 + 0.38 * band + 0.16 * band2;
    vec3 rock = uRock * strata * (0.70 + 0.48 * broad);

    // Subsoil gets a weaker echo of the same banding so the transition into
    // rock reads as geology rather than as a colour fade.
    subsoil *= 0.90 + 0.14 * band;

    vec3 col = grass;
    col = mix(col, topsoil, smoothstep(dGrass, dTop, depth));
    col = mix(col, subsoil, smoothstep(dTop, dSub, depth));
    col = mix(col, rock,    smoothstep(dSub, dRockEnd, depth));
    col = mix(col, uDeep,   smoothstep(dRockEnd, dRockEnd + 170.0, depth));

    // ── contact shade: a thin dark line under the grass sells the overhang
    col *= 1.0 - 0.30 * exp(-pow((depth - dGrass) / 3.2, 2.0));

    // ── ambient occlusion in gullies: steep ground reads darker
    col *= 1.0 - 0.22 * smoothstep(0.4, 2.2, abs(vSlope));

    // ── lit rim along the silhouette (biggest readability win on screen)
    vec2 surfN = normalize(vec2(-vSlope, 1.0));
    float facing = clamp(dot(surfN, normalize(uSunDir)), 0.0, 1.0);
    // Kept deliberately gentle: at 0.85 this became a hard neon stripe running
    // the width of the map and drowned the terrain underneath it.
    float rim = smoothstep(2.2, 0.0, depth) * (0.30 + 0.70 * facing);
    col += uRim * rim * 0.20;

    // ── fresh carve glows, then cools (uDisturb decays in TerrainMesh)
    float heat = vDisturb * smoothstep(46.0, 0.0, depth);
    col = mix(col, uScorch, heat * 0.55);
    col += uScorch * heat * heat * 0.5;          // hot enough for bloom to catch

    // ── fine grain everywhere, keeps flat areas from looking like plastic
    col *= 0.90 + 0.20 * nFine;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createTerrainMaterial(art: Art, worldHeight: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    uniforms: {
      tSoil: { value: art.soil },
      tRock: { value: art.rock },
      tGrass: { value: art.grass },
      tNoise: { value: art.noise },
      uGrassLow: { value: new THREE.Color("#4fbf46") },
      uGrassHigh: { value: new THREE.Color("#8ff05a") },
      uGrassDark: { value: new THREE.Color("#2f7a2c") },
      uDirtLight: { value: new THREE.Color("#c08343") },
      uDirtMid: { value: new THREE.Color("#8a5a2c") },
      uDirtDark: { value: new THREE.Color("#4a2f16") },
      uRock: { value: new THREE.Color("#6b6f7d") },
      uDeep: { value: new THREE.Color("#140c06") },
      uRim: { value: new THREE.Color("#d8ff9a") },
      uScorch: { value: new THREE.Color("#ff9a3c") },
      uSunDir: { value: new THREE.Vector2(-0.5, 0.87) },
      uWorldHeight: { value: worldHeight },
    },
  });
}

export function applyThemeToTerrain(mat: THREE.ShaderMaterial, theme: ThemePalette): void {
  const u = mat.uniforms;
  u.uGrassLow.value.set(theme.grassLow);
  u.uGrassHigh.value.set(theme.grassHigh);
  u.uGrassDark.value.set(theme.grassDark);
  u.uDirtLight.value.set(theme.dirtLight);
  u.uDirtMid.value.set(theme.dirtMid);
  u.uDirtDark.value.set(theme.dirtDark);
  u.uRock.value.set(theme.rockTint);
  u.uDeep.value.set(theme.deep);
  u.uRim.value.set(theme.surfaceLine);
  u.uScorch.value.set(theme.scorch);
  const a = (theme.sunAngleDeg * Math.PI) / 180;
  u.uSunDir.value.set(Math.cos(a), Math.sin(a));
}
