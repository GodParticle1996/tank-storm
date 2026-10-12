// ═══════════════════════════════════════════════════════════
//  Terrain mesh — geometry + per-column attributes for TerrainMaterial.
//
//  Only TWO rows per column: the surface vertex and a deep skirt vertex. All
//  colour is computed per-fragment from world position, so the mesh's only job
//  is describing the silhouette. (The old renderer used six rows purely to fake
//  colour bands — those are now real world-space strata in the shader.)
//
//  aDisturb tracks how recently each column was carved. It spikes to 1 when a
//  crater lands and decays over ~1.2 s, which is what makes fresh craters glow
//  hot and then cool.
// ═══════════════════════════════════════════════════════════

import * as THREE from "three";
import type { Terrain } from "../engine/Terrain";

const SKIRT_Y = -700;
const DISTURB_DECAY = 0.85; // per second, exponential

export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private terrain: Terrain;
  private disturb: Float32Array;
  private prevSurface: Float32Array;
  private disturbAttr: THREE.BufferAttribute;
  private wasHot = false;

  constructor(terrain: Terrain, material: THREE.ShaderMaterial) {
    this.terrain = terrain;
    const cols = terrain.cols;

    this.disturb = new Float32Array(cols);
    this.prevSurface = new Float32Array(terrain.surfaceY);

    const positions = new Float32Array(cols * 2 * 3);
    const surfaceAttr = new Float32Array(cols * 2);
    const slopeAttr = new Float32Array(cols * 2);
    const disturbAttr = new Float32Array(cols * 2);

    const indices: number[] = [];
    for (let i = 0; i < cols - 1; i++) {
      const a = i * 2;       // surface, column i
      const b = i * 2 + 1;   // skirt,   column i
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      indices.push(a, b, c, c, b, d);
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geo.setAttribute("aSurfaceY", new THREE.BufferAttribute(surfaceAttr, 1));
    this.geo.setAttribute("aSlope", new THREE.BufferAttribute(slopeAttr, 1));
    this.disturbAttr = new THREE.BufferAttribute(disturbAttr, 1);
    this.geo.setAttribute("aDisturb", this.disturbAttr);
    this.geo.setIndex(indices);

    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.name = "terrain";
    this.mesh.frustumCulled = false;
    this.rebuild();
  }

  /** Rewrite position/surface/slope from the heightmap. Call when terrain.dirty. */
  rebuild(): void {
    const t = this.terrain;
    const cols = t.cols;
    const pos = this.geo.getAttribute("position") as THREE.BufferAttribute;
    const sur = this.geo.getAttribute("aSurfaceY") as THREE.BufferAttribute;
    const slo = this.geo.getAttribute("aSlope") as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    const s = sur.array as Float32Array;
    const sl = slo.array as Float32Array;

    for (let i = 0; i < cols; i++) {
      const x = i * t.step;
      const y = t.surfaceY[i];

      // Central-difference slope in world units (dy per unit x)
      const yl = t.surfaceY[Math.max(0, i - 1)];
      const yr = t.surfaceY[Math.min(cols - 1, i + 1)];
      const slope = (yr - yl) / (2 * t.step);

      // Carving this column since the last rebuild lights it up
      const moved = Math.abs(y - this.prevSurface[i]);
      if (moved > 0.5) this.disturb[i] = Math.min(1, this.disturb[i] + Math.min(1, moved / 16));
      this.prevSurface[i] = y;

      const a = i * 2 * 3;
      p[a] = x; p[a + 1] = y; p[a + 2] = 0;
      p[a + 3] = x; p[a + 4] = SKIRT_Y; p[a + 5] = 0;

      s[i * 2] = y; s[i * 2 + 1] = y;
      sl[i * 2] = slope; sl[i * 2 + 1] = slope;
    }

    pos.needsUpdate = true;
    sur.needsUpdate = true;
    slo.needsUpdate = true;
  }

  /** Cool freshly-carved ground back down. Called every frame. */
  update(dt: number): void {
    const d = this.disturbAttr.array as Float32Array;
    const decay = Math.exp(-dt / DISTURB_DECAY);
    let anyHot = false;
    for (let i = 0; i < this.disturb.length; i++) {
      if (this.disturb[i] > 0.001) {
        this.disturb[i] *= decay;
        anyHot = true;
      } else if (this.disturb[i] !== 0) {
        this.disturb[i] = 0;
      }
      d[i * 2] = this.disturb[i];
      d[i * 2 + 1] = this.disturb[i];
    }
    // Upload one extra frame after the last hot column cools, otherwise the
    // final "everything is 0" state never reaches the GPU and a sliver of heat
    // stays baked into the terrain for the rest of the match.
    if (anyHot || this.wasHot) this.disturbAttr.needsUpdate = true;
    this.wasHot = anyHot;
  }

  dispose(): void {
    this.geo.dispose();
  }
}
