// ═══════════════════════════════════════════════════════════
//  Backdrop — sky, parallax ridges, stars, clouds, celestial disc, weather.
//
//  The old backdrop was a three-stop gradient plus a handful of cloud sprites,
//  so the battlefield had no depth behind it: terrain silhouette straight onto
//  flat colour. Three ridge layers with atmospheric haze fix that — distance now
//  reads as haze, which is what makes the near terrain pop forward.
//
//  Everything here lives at negative Z (the orthographic camera sits at z=+100
//  looking down −Z), and nothing writes depth, so ordering is purely by layer.
// ═══════════════════════════════════════════════════════════

import * as THREE from "three";
import { WORLD } from "../engine/constants";
import type { Art } from "./assets";
import type { ThemePalette } from "./themes";
import { ParticleLayer } from "./ParticleSystem";

const Z = { sky: -250, stars: -220, disc: -210, ridgeFar: -180, cloud: -150, ridgeMid: -140, ridgeNear: -110 };

// ─── sky ───

const skyFragment = /* glsl */ `
  precision highp float;
  uniform vec3  uTop;
  uniform vec3  uMid;
  uniform vec3  uHorizon;
  uniform float uHeight;
  varying vec2 vWorld;

  // Ordered dither — a 3-stop gradient across 1000+ px WILL band without it
  float dither(vec2 p) {
    return fract(sin(dot(floor(p), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  }

  void main() {
    float t = clamp(vWorld.y / uHeight, 0.0, 1.0);
    float t1 = smoothstep(0.0, 0.55, t);
    float t2 = smoothstep(0.42, 1.0, t);
    vec3 col = mix(uHorizon, uMid, t1);
    col = mix(col, uTop, t2);
    // warm lift right at the horizon line
    col += uHorizon * 0.22 * pow(1.0 - clamp(t * 2.2, 0.0, 1.0), 3.0);
    col += dither(gl_FragCoord.xy) * (1.0 / 255.0) * 2.0;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const skyVertex = /* glsl */ `
  varying vec2 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xy;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// ─── ridge silhouettes ───

function ridgeProfile(seed: number, samples: number, amp: number, base: number): number[] {
  // Two octaves of hashed value noise — deterministic per seed
  const h = (i: number) => {
    const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const at = (t: number, period: number) => {
    const x = t * period;
    const i0 = Math.floor(x);
    const f = x - i0;
    const s = f * f * (3 - 2 * f);
    return h(i0) * (1 - s) + h(i0 + 1) * s;
  };
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const n = at(t, 5) * 0.65 + at(t + 13.3, 13) * 0.27 + at(t + 71.9, 29) * 0.08;
    out.push(base + n * amp);
  }
  return out;
}

// Ridges drawn as one flat colour read as cardboard slabs. A vertical falloff
// below the crest — plus a haze lift right at the crest — gives them volume and
// makes the layers separate from each other.
const ridgeVertex = /* glsl */ `
  attribute float aTopY;
  varying float vDepth;
  void main() {
    vDepth = aTopY - position.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ridgeFragment = /* glsl */ `
  precision highp float;
  uniform vec3  uColor;
  uniform vec3  uHaze;
  uniform float uOpacity;
  varying float vDepth;
  void main() {
    float d = clamp(vDepth / 260.0, 0.0, 1.0);
    vec3 col = uColor * (1.0 - 0.45 * d);          // falls into shadow downward
    col = mix(col, uHaze, exp(-vDepth / 26.0) * 0.32); // lit crest, kept soft
    gl_FragColor = vec4(col, uOpacity);
  }
`;

function ridgeMesh(seed: number, amp: number, base: number, color: string): THREE.Mesh {
  const samples = 160;
  const prof = ridgeProfile(seed, samples, amp, base);
  const left = -WORLD.WIDTH * 0.35;
  const right = WORLD.WIDTH * 1.35;
  const span = right - left;

  const positions = new Float32Array(samples * 2 * 3);
  const tops = new Float32Array(samples * 2);
  const indices: number[] = [];
  for (let i = 0; i < samples; i++) {
    const x = left + (i / (samples - 1)) * span;
    positions[i * 6] = x;
    positions[i * 6 + 1] = prof[i];
    positions[i * 6 + 2] = 0;
    positions[i * 6 + 3] = x;
    positions[i * 6 + 4] = -200;
    positions[i * 6 + 5] = 0;
    tops[i * 2] = prof[i];
    tops[i * 2 + 1] = prof[i];
  }
  for (let i = 0; i < samples - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    indices.push(a, b, c, c, b, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aTopY", new THREE.BufferAttribute(tops, 1));
  geo.setIndex(indices);
  const mat = new THREE.ShaderMaterial({
    vertexShader: ridgeVertex,
    fragmentShader: ridgeFragment,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uHaze: { value: new THREE.Color(color) },
      uOpacity: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

export class Backdrop {
  readonly group = new THREE.Group();
  private sky: THREE.Mesh;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;
  private ridges: THREE.Mesh[] = [];
  private clouds: THREE.Sprite[] = [];
  private disc: THREE.Sprite;
  private discGlow: THREE.Sprite;
  private weather: ParticleLayer;
  private rain: THREE.LineSegments;
  private rainPos: Float32Array;
  private rainVel: Float32Array;
  private rainCount = 0;
  private theme: ThemePalette | null = null;
  private emitAccum = 0;

  constructor(art: Art) {
    // ── sky ──
    const skyGeo = new THREE.PlaneGeometry(WORLD.WIDTH * 6, WORLD.HEIGHT * 10);
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: {
        uTop: { value: new THREE.Color("#050916") },
        uMid: { value: new THREE.Color("#132048") },
        uHorizon: { value: new THREE.Color("#3b5490") },
        uHeight: { value: WORLD.HEIGHT * 1.35 },
      },
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.position.set(WORLD.WIDTH / 2, WORLD.HEIGHT / 2, Z.sky);
    this.group.add(this.sky);

    // ── stars (soft sprites, not hard pixels) ──
    const COUNT = 190;
    const sp = new Float32Array(COUNT * 3);
    const ss = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      sp[i * 3] = -300 + Math.random() * (WORLD.WIDTH + 600);
      sp[i * 3 + 1] = 210 + Math.random() * 760;
      sp[i * 3 + 2] = 0;
      ss[i] = 1.4 + Math.random() * Math.random() * 4.2;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    this.starMat = new THREE.PointsMaterial({
      map: art.particle, size: 4.5, color: 0xcfe0ff, transparent: true, opacity: 0.75,
      sizeAttenuation: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.position.z = Z.stars;
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    // ── celestial disc + glow ──
    this.discGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: art.particle, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.discGlow.position.z = Z.disc;
    this.group.add(this.discGlow);

    this.disc = new THREE.Sprite(new THREE.SpriteMaterial({
      map: art.particle, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.disc.position.z = Z.disc + 1;
    this.group.add(this.disc);

    // ── three ridge layers: far is hazed into the sky, near is nearly solid ──
    const far = ridgeMesh(3.1, 210, 250, "#2c3f6e");
    far.position.z = Z.ridgeFar;
    const mid = ridgeMesh(9.7, 150, 170, "#20304f");
    mid.position.z = Z.ridgeMid;
    const near = ridgeMesh(21.3, 96, 110, "#16223a");
    near.position.z = Z.ridgeNear;
    this.ridges = [far, mid, near];
    for (const r of this.ridges) this.group.add(r);

    // ── clouds ──
    for (let i = 0; i < 7; i++) {
      const mat = new THREE.SpriteMaterial({
        map: art.cloud, transparent: true, opacity: 0.3, depthWrite: false,
      });
      const s = new THREE.Sprite(mat);
      const w = 220 + Math.random() * 300;
      s.scale.set(w, w * 0.45, 1);
      s.position.set(Math.random() * WORLD.WIDTH, 360 + Math.random() * 260, Z.cloud);
      this.clouds.push(s);
      this.group.add(s);
    }

    // ── weather: embers / dust use particles, rain uses line segments ──
    this.weather = new ParticleLayer(art.particle, 700, { additive: true, grow: 0.2, z: -80, opacity: 0.9 });
    this.group.add(this.weather.points);

    const RAIN = 420;
    this.rainPos = new Float32Array(RAIN * 2 * 3);
    this.rainVel = new Float32Array(RAIN * 2);
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute("position", new THREE.BufferAttribute(this.rainPos, 3));
    rainGeo.setDrawRange(0, 0);
    this.rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({
      color: 0xa9c2dd, transparent: true, opacity: 0.42, depthWrite: false,
    }));
    this.rain.position.z = -70;
    this.rain.frustumCulled = false;
    this.group.add(this.rain);
  }

  applyTheme(theme: ThemePalette): void {
    this.theme = theme;
    const u = (this.sky.material as THREE.ShaderMaterial).uniforms;
    u.uTop.value.set(theme.skyTop);
    u.uMid.value.set(theme.skyMid);
    u.uHorizon.value.set(theme.skyHorizon);

    this.starMat.opacity = theme.starOpacity;

    const ridgeColors = [theme.ridgeFar, theme.ridgeMid, theme.ridgeNear];
    const ridgeAlpha = [0.72, 0.86, 1.0];
    const hazeMix = [0.85, 0.55, 0.3];   // far ridges catch the most atmosphere
    this.ridges.forEach((r, i) => {
      const u = (r.material as THREE.ShaderMaterial).uniforms;
      u.uColor.value.set(ridgeColors[i]);
      u.uHaze.value.set(theme.haze).lerp(new THREE.Color(ridgeColors[i]), 1 - hazeMix[i]);
      u.uOpacity.value = ridgeAlpha[i];
    });

    for (const c of this.clouds) {
      const m = c.material as THREE.SpriteMaterial;
      m.color.set(theme.cloudColor);
      m.opacity = theme.clouds ? 0.32 : 0;
    }

    const d = theme.disc;
    const discMat = this.disc.material as THREE.SpriteMaterial;
    const glowMat = this.discGlow.material as THREE.SpriteMaterial;
    if (d) {
      this.disc.position.set(d.x, d.y, Z.disc + 1);
      this.disc.scale.set(d.r * 2.6, d.r * 2.6, 1);
      discMat.color.set(d.color);
      discMat.opacity = d.opacity;
      this.discGlow.position.set(d.x, d.y, Z.disc);
      this.discGlow.scale.set(d.r * 11, d.r * 11, 1);
      glowMat.color.set(d.color);
      glowMat.opacity = d.opacity * 0.16;
    } else {
      discMat.opacity = 0;
      glowMat.opacity = 0;
    }

    (this.rain.material as THREE.LineBasicMaterial).color.set(theme.weatherColor);
    (this.rain.material as THREE.LineBasicMaterial).opacity = theme.weather === "rain" ? 0.42 : 0;
    if (theme.weather !== "rain") this.rainCount = 0;
  }

  setScale(pixelsPerWorldUnit: number): void {
    this.weather.setScale(pixelsPerWorldUnit);
  }

  update(dt: number, wind: number, timeSec: number): void {
    // clouds drift, wrapping across the map
    const drift = 3 + wind * 0.35;
    for (const c of this.clouds) {
      c.position.x += drift * dt;
      if (c.position.x > WORLD.WIDTH + 400) c.position.x = -400;
      if (c.position.x < -400) c.position.x = WORLD.WIDTH + 400;
    }

    // stars breathe
    this.starMat.opacity = (this.theme?.starOpacity ?? 0) * (0.86 + 0.14 * Math.sin(timeSec * 1.7));

    const theme = this.theme;
    if (theme) {
      if (theme.weather === "embers" || theme.weather === "dust") {
        this.emitAccum += dt * (theme.weather === "embers" ? 26 : 14) * theme.weatherIntensity;
        const n = Math.floor(this.emitAccum);
        if (n > 0) {
          this.emitAccum -= n;
          const rising = theme.weather === "embers";
          this.weather.spawn({
            x: -60 + Math.random() * (WORLD.WIDTH + 120),
            y: rising ? 20 + Math.random() * 120 : 120 + Math.random() * 500,
            count: n,
            color: new THREE.Color(theme.weatherColor),
            speedMin: 2, speedMax: 14,
            lifeMin: 2.4, lifeMax: 5.5,
            sizeMin: rising ? 1.6 : 2.4, sizeMax: rising ? 4.4 : 6.0,
            gravityScale: rising ? -0.012 : 0.004,
            upwardBias: rising ? 16 : -2,
            drag: 0.5,
          });
        }
      }
      this.weather.update(dt, wind * 0.35, 300, timeSec);

      if (theme.weather === "rain") this.updateRain(dt, wind);
    }
  }

  private updateRain(dt: number, wind: number): void {
    const total = this.rainPos.length / 6;
    if (this.rainCount < total) {
      // seed the field over the first second so it doesn't pop in as a wall
      const add = Math.min(total - this.rainCount, Math.ceil(total * dt * 1.4));
      for (let k = 0; k < add; k++) {
        const i = this.rainCount++;
        this.rainPos[i * 6] = -200 + Math.random() * (WORLD.WIDTH + 400);
        this.rainPos[i * 6 + 1] = Math.random() * (WORLD.HEIGHT + 500);
        this.rainVel[i * 2] = 0;
        this.rainVel[i * 2 + 1] = -(620 + Math.random() * 340);
      }
    }

    const shear = wind * 3.4;
    for (let i = 0; i < this.rainCount; i++) {
      const vy = this.rainVel[i * 2 + 1];
      let x = this.rainPos[i * 6] + shear * dt;
      let y = this.rainPos[i * 6 + 1] + vy * dt;
      if (y < -40) {
        y = WORLD.HEIGHT + 380 + Math.random() * 160;
        x = -200 + Math.random() * (WORLD.WIDTH + 400);
      }
      if (x < -260) x += WORLD.WIDTH + 460;
      if (x > WORLD.WIDTH + 260) x -= WORLD.WIDTH + 460;
      // streak length follows velocity, so hard rain visibly falls faster
      const len = 0.026;
      this.rainPos[i * 6] = x;
      this.rainPos[i * 6 + 1] = y;
      this.rainPos[i * 6 + 2] = 0;
      this.rainPos[i * 6 + 3] = x + shear * len;
      this.rainPos[i * 6 + 4] = y + vy * len;
      this.rainPos[i * 6 + 5] = 0;
    }
    const attr = this.rain.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.rain.geometry.setDrawRange(0, this.rainCount * 2);
  }

  dispose(): void {
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.stars.geometry.dispose();
    this.starMat.dispose();
    for (const r of this.ridges) {
      r.geometry.dispose();
      (r.material as THREE.Material).dispose();
    }
    for (const c of this.clouds) (c.material as THREE.SpriteMaterial).dispose();
    (this.disc.material as THREE.SpriteMaterial).dispose();
    (this.discGlow.material as THREE.SpriteMaterial).dispose();
    this.weather.dispose();
    this.rain.geometry.dispose();
    (this.rain.material as THREE.Material).dispose();
  }
}
