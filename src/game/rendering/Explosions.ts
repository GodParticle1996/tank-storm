// ═══════════════════════════════════════════════════════════
//  Explosions — atlas-animated fireballs, shockwave rings, core flash.
//
//  The old explosion was a single expanding wireframe-ish ring plus square
//  sparks. A ring alone has no mass: it reads as a diagram of an explosion
//  rather than an explosion. Three elements stacked fix that:
//
//    1. CORE FLASH   — one bright frame of light, sells the detonation instant
//    2. FIREBALL     — 64-frame CC0 atlas, additive so bloom catches it
//    3. SHOCKWAVE    — thin ring racing ahead of the fireball
//
//  Dark smoke deliberately is NOT part of this (additive blending cannot draw
//  anything darker than its background) — that comes from the normal-blended
//  smoke particle layer, which is why the two systems exist separately.
// ═══════════════════════════════════════════════════════════

import * as THREE from "three";
import { EXPLOSION_ATLAS, type Art } from "./assets";

const FIREBALL_SECONDS = 0.78;

const atlasVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const atlasFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform vec2  uGrid;      // (cols, rows)
  uniform float uFrame;     // continuous frame index
  uniform float uOpacity;
  uniform vec3  uTint;
  varying vec2 vUv;

  vec4 frameAt(float idx) {
    float f = mod(floor(idx), uGrid.x * uGrid.y);
    float col = mod(f, uGrid.x);
    float row = floor(f / uGrid.x);
    // atlas rows run top-to-bottom; UV origin is bottom-left
    vec2 uv = (vUv + vec2(col, uGrid.y - 1.0 - row)) / uGrid;
    return texture2D(uMap, uv);
  }

  void main() {
    // Blend consecutive frames — 64 frames over 0.78 s is ~82 fps of source,
    // and without the crossfade the fireball visibly strobes on a 144 Hz panel.
    float f0 = floor(uFrame);
    float mixT = uFrame - f0;
    vec4 a = frameAt(f0);
    vec4 b = frameAt(f0 + 1.0);
    vec4 tex = mix(a, b, mixT);

    float alpha = tex.a * uOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(tex.rgb * uTint * alpha, alpha);
  }
`;

interface Slot {
  fire: THREE.Mesh;
  fireMat: THREE.ShaderMaterial;
  ring: THREE.Sprite;
  flash: THREE.Sprite;
  age: number;
  life: number;
  radius: number;
  active: boolean;
}

export class ExplosionField {
  readonly group = new THREE.Group();
  private slots: Slot[] = [];
  private quad = new THREE.PlaneGeometry(1, 1);

  constructor(art: Art, capacity = 16) {
    for (let i = 0; i < capacity; i++) {
      const fireMat = new THREE.ShaderMaterial({
        vertexShader: atlasVertex,
        fragmentShader: atlasFragment,
        uniforms: {
          uMap: { value: art.explosion },
          uGrid: { value: new THREE.Vector2(EXPLOSION_ATLAS.cols, EXPLOSION_ATLAS.rows) },
          uFrame: { value: 0 },
          uOpacity: { value: 0 },
          uTint: { value: new THREE.Color(1, 1, 1) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const fire = new THREE.Mesh(this.quad, fireMat);
      fire.visible = false;
      fire.renderOrder = 14;

      const ring = new THREE.Sprite(new THREE.SpriteMaterial({
        map: art.ring, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      ring.visible = false;
      ring.renderOrder = 15;

      const flash = new THREE.Sprite(new THREE.SpriteMaterial({
        map: art.particle, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      flash.visible = false;
      flash.renderOrder = 16;

      this.group.add(fire, ring, flash);
      this.slots.push({ fire, fireMat, ring, flash, age: 0, life: 0, radius: 0, active: false });
    }
  }

  spawn(x: number, y: number, radius: number, color: THREE.Color): void {
    // Reuse the oldest slot if every one is busy — a dropped explosion is worse
    // than a truncated one.
    let slot = this.slots.find((s) => !s.active);
    if (!slot) {
      slot = this.slots.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
    }
    slot.active = true;
    slot.age = 0;
    slot.life = FIREBALL_SECONDS;
    slot.radius = radius;

    const size = radius * 3.4;
    slot.fire.position.set(x, y, 7);
    slot.fire.scale.set(size, size, 1);
    slot.fire.rotation.z = Math.random() * Math.PI * 2;
    slot.fire.visible = true;
    slot.fireMat.uniforms.uFrame.value = 0;
    slot.fireMat.uniforms.uOpacity.value = 1;
    // Only a hint of weapon colour — a fully tinted fireball stops reading as fire
    slot.fireMat.uniforms.uTint.value.setRGB(
      0.72 + color.r * 0.34,
      0.66 + color.g * 0.3,
      0.6 + color.b * 0.3,
    );

    slot.ring.position.set(x, y, 8);
    slot.ring.visible = true;
    (slot.ring.material as THREE.SpriteMaterial).color.copy(color).lerp(new THREE.Color(1, 1, 1), 0.55);

    slot.flash.position.set(x, y, 9);
    slot.flash.visible = true;
    (slot.flash.material as THREE.SpriteMaterial).color.copy(color).lerp(new THREE.Color(1, 1, 1), 0.7);
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.active) continue;
      s.age += dt;
      const t = s.age / s.life;
      if (t >= 1) {
        s.active = false;
        s.fire.visible = false;
        s.ring.visible = false;
        s.flash.visible = false;
        continue;
      }

      // fireball plays the atlas once, fading over the tail
      s.fireMat.uniforms.uFrame.value = t * (EXPLOSION_ATLAS.frames - 1);
      s.fireMat.uniforms.uOpacity.value = 1 - Math.pow(t, 3.2);

      // shockwave races out ahead and thins
      const rt = Math.min(1, s.age / 0.34);
      const ease = 1 - (1 - rt) * (1 - rt);
      const rs = Math.max(1, s.radius * 2.5 * ease);
      s.ring.scale.set(rs, rs, 1);
      (s.ring.material as THREE.SpriteMaterial).opacity = 0.85 * (1 - rt) * (1 - rt);

      // core flash: one hard pop
      const ft = Math.min(1, s.age / 0.13);
      const fs = s.radius * (1.4 + ft * 2.6);
      s.flash.scale.set(fs, fs, 1);
      (s.flash.material as THREE.SpriteMaterial).opacity = (1 - ft) * (1 - ft) * 0.95;
    }
  }

  dispose(): void {
    for (const s of this.slots) {
      s.fireMat.dispose();
      (s.ring.material as THREE.SpriteMaterial).dispose();
      (s.flash.material as THREE.SpriteMaterial).dispose();
    }
    this.quad.dispose();
    this.slots.length = 0;
  }
}
