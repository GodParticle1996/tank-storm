// ═══════════════════════════════════════════════════════════
//  Art assets — every texture the renderer uses.
//
//  Files live in ./art and are IMPORTED (not referenced by an absolute
//  "/assets/..." URL) on purpose: vite.config sets `base: "./"` and Electron
//  loads the production build through `loadFile` (file:// protocol), where an
//  absolute path resolves to the filesystem root and 404s. Importing lets Vite
//  emit a correct relative URL for both dev and the packaged app.
//
//  Every texture has a procedural fallback. If a file ever fails to decode the
//  game still renders something sensible instead of black or invisible quads.
//
//  Licenses: see ./art/LICENSES.md — everything bundled is CC0.
// ═══════════════════════════════════════════════════════════

import * as THREE from "three";

import particleUrl from "./art/particle.webp";
import smokeUrl from "./art/smoke.webp";
import sparkUrl from "./art/spark.webp";
import flashUrl from "./art/flash.webp";
import ringUrl from "./art/ring.webp";
import cloudUrl from "./art/cloud.webp";
import explosionUrl from "./art/explosion-atlas.webp";
import noiseUrl from "./art/noise.jpg";
import soilUrl from "./art/detail-soil.jpg";
import rockUrl from "./art/detail-rock.jpg";
import grassUrl from "./art/detail-grass.jpg";

/** The explosion atlas is an 8×8 grid of 64 frames. */
export const EXPLOSION_ATLAS = { cols: 8, rows: 8, frames: 62 } as const;

export interface Art {
  /** Resolves once every texture has decoded (or fallen back). The game does
   *  not await it — textures stream in — but the visual harness must, or it
   *  screenshots untextured terrain and every tuning decision is made blind. */
  ready: Promise<void>;
  particle: THREE.Texture;
  smoke: THREE.Texture;
  spark: THREE.Texture;
  flash: THREE.Texture;
  ring: THREE.Texture;
  cloud: THREE.Texture;
  explosion: THREE.Texture;
  noise: THREE.Texture;
  soil: THREE.Texture;
  rock: THREE.Texture;
  grass: THREE.Texture;
  dispose(): void;
}

type FallbackKind = "radial" | "streak" | "ring" | "grain";

/** Canvas-drawn stand-in used only if a real file fails to load. */
function fallbackTexture(kind: FallbackKind): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  if (kind === "grain") {
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const v = 110 + Math.floor(Math.random() * 70);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  } else if (kind === "streak") {
    const g = ctx.createLinearGradient(0, size / 2, size, size / 2);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,230,180,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, size / 2 - 4, size, 8);
  } else if (kind === "ring") {
    ctx.strokeStyle = "rgba(255,240,210,0.95)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,220,170,0.75)");
    g.addColorStop(1, "rgba(255,180,120,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface LoadOpts {
  /** Tiling textures repeat; sprites clamp. */
  repeat?: boolean;
  /** Grayscale data (detail/noise) must NOT be sRGB-decoded — it is a multiplier. */
  data?: boolean;
  fallback?: FallbackKind;
}

export function createArt(): Art {
  const loader = new THREE.TextureLoader();
  const owned: THREE.Texture[] = [];
  const pending: Promise<void>[] = [];

  const load = (url: string, opts: LoadOpts = {}): THREE.Texture => {
    const { repeat = false, data = false, fallback = "radial" } = opts;
    let settle!: () => void;
    pending.push(new Promise<void>((res) => { settle = res; }));
    const tex = loader.load(
      url,
      () => settle(),
      undefined,
      () => {
        // Decode failed — swap in a procedural stand-in so nothing renders blank.
        const fb = fallbackTexture(fallback);
        tex.image = fb.image;
        tex.needsUpdate = true;
        fb.dispose();
        settle();
      },
    );
    tex.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    owned.push(tex);
    return tex;
  };

  const art: Art = {
    ready: Promise.resolve(),   // replaced below, once `pending` is complete
    particle: load(particleUrl, { fallback: "radial" }),
    smoke: load(smokeUrl, { fallback: "radial" }),
    spark: load(sparkUrl, { fallback: "streak" }),
    flash: load(flashUrl, { fallback: "radial" }),
    ring: load(ringUrl, { fallback: "ring" }),
    cloud: load(cloudUrl, { fallback: "radial" }),
    // The atlas is sampled frame-by-frame; mipmaps would bleed neighbouring
    // frames into each other at small sizes, so keep it unmipped.
    explosion: load(explosionUrl, { fallback: "radial" }),
    noise: load(noiseUrl, { repeat: true, data: true, fallback: "grain" }),
    soil: load(soilUrl, { repeat: true, data: true, fallback: "grain" }),
    rock: load(rockUrl, { repeat: true, data: true, fallback: "grain" }),
    grass: load(grassUrl, { repeat: true, data: true, fallback: "grain" }),
    dispose() {
      for (const t of owned) t.dispose();
      owned.length = 0;
    },
  };

  // Atlas frames must not bleed into each other — no mipmaps, no wrapping.
  art.explosion.generateMipmaps = false;
  art.explosion.minFilter = THREE.LinearFilter;

  art.ready = Promise.all(pending).then(() => undefined);
  return art;
}
