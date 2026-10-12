// ═══════════════════════════════════════════════════════════
//  Particle layers — textured points with PER-PARTICLE size, rotation and fade.
//
//  The old system used THREE.PointsMaterial, which has exactly one global size
//  and no texture, so every particle was an identical hard-edged square. Squares
//  are the single loudest "programmer art" tell in a particle effect.
//
//  Two things changed:
//    • a custom shader gives each particle its own size, spin and life curve,
//    • sizes are in WORLD units (gl_PointSize is scaled by pixels-per-world-unit)
//      instead of fixed device pixels, so effects look identical at any window
//      size or DPI — the old fixed-pixel sizing is why explosions looked tiny on
//      a big screen and huge on a small one.
// ═══════════════════════════════════════════════════════════

import * as THREE from "three";

const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aSeed;
  attribute float aLife;      // 1 at birth -> 0 at death
  attribute vec3  aColor;

  uniform float uScale;       // device pixels per world unit
  uniform float uGrow;        // how much a particle swells over its life

  varying float vLife;
  varying float vSeed;
  varying vec3  vColor;

  void main() {
    vLife  = aLife;
    vSeed  = aSeed;
    vColor = aColor;
    float t = 1.0 - aLife;
    gl_PointSize = aSize * uScale * (1.0 + uGrow * t);
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uMap;
  uniform float uSpin;
  uniform float uTime;
  uniform float uOpacity;

  varying float vLife;
  varying float vSeed;
  varying vec3  vColor;

  void main() {
    // Rotate the sprite around its centre — kills the "identical stamps" look
    float ang = (vSeed - 0.5) * 6.283 + uSpin * uTime * (vSeed - 0.5);
    float c = cos(ang), s = sin(ang);
    vec2 uv = gl_PointCoord - 0.5;
    uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;

    vec4 tex = texture2D(uMap, uv);
    float t = 1.0 - vLife;
    // quick fade-in, long smooth fade-out
    float fade = smoothstep(0.0, 0.09, t) * pow(vLife, 0.6);
    float a = tex.a * fade * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(tex.rgb * vColor, a);
  }
`;

export interface SpawnOpts {
  x: number;
  y: number;
  count: number;
  color: THREE.Color;
  /** Second colour — each particle picks a random mix of color..color2. */
  color2?: THREE.Color;
  speedMin: number;
  speedMax: number;
  lifeMin: number;
  lifeMax: number;
  sizeMin: number;
  sizeMax: number;
  /** 1 = falls normally, 0 = floats, negative = rises. */
  gravityScale?: number;
  upwardBias?: number;
  /** Spawn jitter radius. */
  spread?: number;
  /** Restrict emission to an arc (radians): centre + halfWidth. */
  dirCenter?: number;
  dirSpread?: number;
  /** How strongly wind pushes this batch. */
  drag?: number;
}

export class ParticleLayer {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;

  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private seed: Float32Array;
  private life: Float32Array;      // normalised, 1 -> 0 (this is the attribute)
  private ttl: Float32Array;       // seconds remaining
  private maxTtl: Float32Array;
  private grav: Float32Array;
  private windMul: Float32Array;
  private count = 0;
  private readonly capacity: number;

  constructor(
    map: THREE.Texture,
    capacity: number,
    opts: { additive?: boolean; grow?: number; spin?: number; opacity?: number; z?: number } = {},
  ) {
    const { additive = false, grow = 0, spin = 0, opacity = 1, z = 5 } = opts;
    this.capacity = capacity;

    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 2);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.ttl = new Float32Array(capacity);
    this.maxTtl = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.windMul = new Float32Array(capacity);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute("aSeed", new THREE.BufferAttribute(this.seed, 1));
    this.geo.setAttribute("aLife", new THREE.BufferAttribute(this.life, 1));
    this.geo.setDrawRange(0, 0);

    this.mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uMap: { value: map },
        uScale: { value: 1 },
        uGrow: { value: grow },
        uSpin: { value: spin },
        uTime: { value: 0 },
        uOpacity: { value: opacity },
      },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.position.z = z;
    this.points.renderOrder = additive ? 12 : 8;
  }

  /** Device pixels per world unit — keeps particle size resolution-independent. */
  setScale(pixelsPerWorldUnit: number): void {
    this.mat.uniforms.uScale.value = pixelsPerWorldUnit;
  }

  spawn(o: SpawnOpts): void {
    const grav = o.gravityScale ?? 1;
    const drag = o.drag ?? 1;
    const spread = o.spread ?? 0;
    for (let i = 0; i < o.count; i++) {
      if (this.count >= this.capacity) return;
      const idx = this.count++;

      const dir = o.dirCenter !== undefined
        ? o.dirCenter + (Math.random() - 0.5) * (o.dirSpread ?? 0)
        : Math.random() * Math.PI * 2;
      const speed = o.speedMin + Math.random() * (o.speedMax - o.speedMin);
      const ttl = o.lifeMin + Math.random() * (o.lifeMax - o.lifeMin);

      this.pos[idx * 3] = o.x + (Math.random() - 0.5) * spread;
      this.pos[idx * 3 + 1] = o.y + (Math.random() - 0.5) * spread;
      this.pos[idx * 3 + 2] = 0;

      this.vel[idx * 2] = Math.cos(dir) * speed;
      this.vel[idx * 2 + 1] = Math.sin(dir) * speed + (o.upwardBias ?? 0);

      const mix = Math.random();
      const r = o.color2 ? o.color.r + (o.color2.r - o.color.r) * mix : o.color.r;
      const g = o.color2 ? o.color.g + (o.color2.g - o.color.g) * mix : o.color.g;
      const b = o.color2 ? o.color.b + (o.color2.b - o.color.b) * mix : o.color.b;
      this.col[idx * 3] = r;
      this.col[idx * 3 + 1] = g;
      this.col[idx * 3 + 2] = b;

      this.size[idx] = o.sizeMin + Math.random() * (o.sizeMax - o.sizeMin);
      this.seed[idx] = Math.random();
      this.ttl[idx] = ttl;
      this.maxTtl[idx] = ttl;
      this.life[idx] = 1;
      this.grav[idx] = grav;
      this.windMul[idx] = drag;
    }
  }

  update(dt: number, wind: number, gravity: number, time: number): void {
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      this.ttl[i] -= dt;
      if (this.ttl[i] <= 0) continue;

      if (i !== w) {
        this.pos[w * 3] = this.pos[i * 3];
        this.pos[w * 3 + 1] = this.pos[i * 3 + 1];
        this.pos[w * 3 + 2] = this.pos[i * 3 + 2];
        this.vel[w * 2] = this.vel[i * 2];
        this.vel[w * 2 + 1] = this.vel[i * 2 + 1];
        this.col[w * 3] = this.col[i * 3];
        this.col[w * 3 + 1] = this.col[i * 3 + 1];
        this.col[w * 3 + 2] = this.col[i * 3 + 2];
        this.size[w] = this.size[i];
        this.seed[w] = this.seed[i];
        this.ttl[w] = this.ttl[i];
        this.maxTtl[w] = this.maxTtl[i];
        this.grav[w] = this.grav[i];
        this.windMul[w] = this.windMul[i];
      }

      this.vel[w * 2] += wind * this.windMul[w] * dt;
      this.vel[w * 2 + 1] -= gravity * this.grav[w] * dt;
      this.pos[w * 3] += this.vel[w * 2] * dt;
      this.pos[w * 3 + 1] += this.vel[w * 2 + 1] * dt;
      this.life[w] = Math.max(0, this.ttl[w] / this.maxTtl[w]);
      w++;
    }
    this.count = w;

    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("aSeed") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("aLife") as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, this.count);
    this.mat.uniforms.uTime.value = time;
  }

  get live(): number {
    return this.count;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
