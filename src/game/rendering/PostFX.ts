// ═══════════════════════════════════════════════════════════
//  Post-processing stack.
//
//  The scene had none, which is why every additive effect read as a flat bright
//  colour instead of a glow: without bloom there is nothing to bleed light into
//  neighbouring pixels, so "glowing" and "just bright" look identical.
//
//  Chain:  scene ─▶ bloom ─▶ grade (saturation/contrast/tint/vignette/
//                                   chromatic aberration/grain) ─▶ output
//
//  The composer's render target is MULTISAMPLED. EffectComposer normally throws
//  away the renderer's MSAA (it draws into an offscreen target), and losing it
//  would shred the tank outlines and the terrain silhouette — the two things the
//  whole art direction leans on.
// ═══════════════════════════════════════════════════════════

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { ThemePalette } from "./themes";

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSaturation: { value: 1.15 },
    uContrast: { value: 1.08 },
    uGain: { value: 1.05 },
    uTint: { value: new THREE.Color("#5f7ec4") },
    uTintAmount: { value: 0.06 },
    uVignette: { value: 0.35 },
    uAberration: { value: 0.0016 },
    uGrain: { value: 0.035 },
    uTime: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color("#ffffff") },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uGain;
    uniform vec3  uTint;
    uniform float uTintAmount;
    uniform float uVignette;
    uniform float uAberration;
    uniform float uGrain;
    uniform float uTime;
    uniform float uFlash;
    uniform vec3  uFlashColor;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // Chromatic aberration grows toward the edges (lens-like, not uniform)
      vec2 off = c * uAberration * (0.35 + r2 * 2.4);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      // Saturation around luminance
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, uSaturation);

      // Contrast as a GAMMA curve, not (col - 0.5) * c + 0.5.
      // The linear form drives everything below ~0.06 negative, and this pass
      // runs before tone mapping where the night sky legitimately sits at
      // ~0.007 — so every theme's upper sky was being clamped to pure black.
      // pow() preserves 0 and 1 and never clips the HDR highlights bloom needs.
      col = pow(max(col, 0.0), vec3(uContrast)) * uGain;

      // Gentle theme tint, weighted toward the shadows so highlights stay clean
      col = mix(col, col * uTint * 2.0, uTintAmount * (1.0 - lum));

      // Impact flash (explosions punch the whole frame for a few frames)
      col += uFlashColor * uFlash;

      // Vignette
      col *= 1.0 - uVignette * smoothstep(0.15, 0.78, r2);

      // Fine grain — breaks up flat gradients, especially the sky
      float g = hash(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export class PostFX {
  readonly composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  private flash = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number,
    /** MSAA samples for the offscreen target. 0 disables it — used only by the
     *  headless visual harness, where software rasterisation makes multisampled
     *  float targets pathologically slow. */
    samples = 4,
  ) {
    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,   // bloom needs headroom above 1.0
      samples,                     // keep MSAA — the tank outlines depend on it
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.72, 0.55, 0.62);
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.composer.addPass(new OutputPass());
  }

  applyTheme(theme: ThemePalette): void {
    this.bloom.strength = theme.bloom.strength;
    this.bloom.radius = theme.bloom.radius;
    this.bloom.threshold = theme.bloom.threshold;
    const u = this.grade.uniforms;
    u.uSaturation.value = theme.grade.saturation;
    u.uContrast.value = theme.grade.contrast;
    // gamma contrast darkens mids, so lift proportionally to keep exposure
    u.uGain.value = 1 + (theme.grade.contrast - 1) * 0.62;
    u.uTint.value.set(theme.grade.tint);
    u.uTintAmount.value = theme.grade.tintAmount;
    u.uVignette.value = theme.grade.vignette;
  }

  /** Punch the frame — called on big impacts, decays on its own. */
  punch(amount: number, color: THREE.Color): void {
    this.flash = Math.min(0.5, this.flash + amount);
    this.grade.uniforms.uFlashColor.value.copy(color);
  }

  update(dt: number, time: number): void {
    this.flash = Math.max(0, this.flash - dt * 3.2);
    this.grade.uniforms.uFlash.value = this.flash;
    this.grade.uniforms.uTime.value = time;
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.bloom.dispose();
    this.grade.dispose?.();
    this.composer.dispose();
  }
}
