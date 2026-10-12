// ═══════════════════════════════════════════════════════════
//  Tank model.
//
//  The old tank was literal 3D geometry — BoxGeometry hull, SphereGeometry
//  turret, CylinderGeometry wheels — lit by a directional light inside a scene
//  where nothing else was lit at all. Through an orthographic camera that reads
//  as a shaded 3D toy glued onto a flat backdrop, which is most of why the game
//  "felt weird".
//
//  This is built the way a 2D arcade game builds a tank: authored SILHOUETTES
//  (THREE.Shape) with a dark outline plate behind them, a vertical gradient
//  fill, and a lit top edge. Every part is drawn on its own Z layer, so the
//  read is always shape-first.
//
//  Outlines are authored by hand as a second, larger polygon per part rather
//  than a uniformly scaled copy — scaling a wide, short shape gives a fat
//  outline on the sides and almost none on top.
// ═══════════════════════════════════════════════════════════

import * as THREE from "three";
import { WORLD } from "../engine/constants";
import type { Art } from "./assets";
import type { ThemePalette } from "./themes";

const TURRET_PIVOT_Y = WORLD.TANK_HEIGHT + 2;
const OUTLINE = "#0a0d14";

// ─── flat gradient + rim-lit material ───

const partVertex = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const partFragment = /* glsl */ `
  precision highp float;
  uniform vec3  uTop;
  uniform vec3  uBottom;
  uniform vec3  uRim;
  uniform float uMinY;
  uniform float uMaxY;
  uniform float uRimPower;
  uniform float uGlow;
  varying vec2 vLocal;

  void main() {
    float t = clamp((vLocal.y - uMinY) / max(0.0001, uMaxY - uMinY), 0.0, 1.0);
    vec3 col = mix(uBottom, uTop, t * t * (3.0 - 2.0 * t));
    // lit top edge
    col += uRim * pow(t, uRimPower) * 0.55;
    // active-player glow rides on the whole part
    col += uTop * uGlow * 0.5;
    gl_FragColor = vec4(col, 1.0);
  }
`;

function partMaterial(top: string, bottom: string, rim: string, minY: number, maxY: number, rimPower = 6): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: partVertex,
    fragmentShader: partFragment,
    uniforms: {
      uTop: { value: new THREE.Color(top) },
      uBottom: { value: new THREE.Color(bottom) },
      uRim: { value: new THREE.Color(rim) },
      uMinY: { value: minY },
      uMaxY: { value: maxY },
      uRimPower: { value: rimPower },
      uGlow: { value: 0 },
    },
  });
}

function shapeFrom(pts: [number, number][]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

function outlineMesh(pts: [number, number][], z: number): THREE.Mesh {
  const geo = new THREE.ShapeGeometry(shapeFrom(pts));
  const mat = new THREE.MeshBasicMaterial({ color: OUTLINE });
  const m = new THREE.Mesh(geo, mat);
  m.position.z = z;
  return m;
}

// ─── authored silhouettes (world units, origin = tank bottom-centre) ───

const W = WORLD.TANK_WIDTH;          // 24
const HALF = W / 2;
const O = 2.0;                        // outline thickness (a tank is only ~20px wide on screen — the outline is what makes it findable)

const TRACK: [number, number][] = [
  [-HALF - 3, 0.6], [-HALF - 4.2, 3.4], [-HALF - 3, 6.6],
  [HALF + 3, 6.6], [HALF + 4.2, 3.4], [HALF + 3, 0.6],
];
const TRACK_O: [number, number][] = [
  [-HALF - 3 - O, 0.6 - O], [-HALF - 4.2 - O, 3.4], [-HALF - 3 - O, 6.6 + O],
  [HALF + 3 + O, 6.6 + O], [HALF + 4.2 + O, 3.4], [HALF + 3 + O, 0.6 - O],
];

// Hull with a sloped front glacis — the slope is what makes it read as a tank
const HULL: [number, number][] = [
  [-HALF - 1, 6.2], [-HALF - 1, 11.4], [-HALF + 3, 13.6],
  [HALF - 6, 13.6], [HALF + 1, 10.2], [HALF + 1, 6.2],
];
const HULL_O: [number, number][] = [
  [-HALF - 1 - O, 6.2 - O], [-HALF - 1 - O, 11.4], [-HALF + 3 - O * 0.6, 13.6 + O],
  [HALF - 6, 13.6 + O], [HALF + 1 + O, 10.2], [HALF + 1 + O, 6.2 - O],
];

const TURRET: [number, number][] = [
  [-7.4, 13.0], [-6.0, 19.0], [4.2, 19.0], [6.6, 13.0],
];
const TURRET_O: [number, number][] = [
  [-7.4 - O, 13.0 - O], [-6.0 - O, 19.0 + O], [4.2 + O, 19.0 + O], [6.6 + O, 13.0 - O],
];

export class TankModel {
  readonly group: THREE.Group;
  private barrel: THREE.Group;
  private flash: THREE.Sprite;
  private halo: THREE.Sprite;
  private shadow!: THREE.Sprite;
  private shield: THREE.Mesh;
  private treads: THREE.Mesh[] = [];
  private glowMats: THREE.ShaderMaterial[] = [];
  private owned: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  private flashLife = 0;
  private treadPhase = 0;

  constructor(playerIndex: 0 | 1, art: Art) {
    const base = playerIndex === 0 ? "#3b82f6" : "#f43f5e";
    const light = playerIndex === 0 ? "#8ec2ff" : "#ff97ac";
    const dark = playerIndex === 0 ? "#16386f" : "#7c1f30";

    this.group = new THREE.Group();
    this.group.name = `tank_${playerIndex}`;

    const add = (mesh: THREE.Mesh | THREE.Sprite) => {
      this.group.add(mesh);
      if (mesh instanceof THREE.Mesh) {
        this.owned.push({ geometry: mesh.geometry, material: mesh.material as THREE.Material });
      }
      return mesh;
    };

    // ── contact shadow: a soft dark ellipse under the hull. Without it a
    //    20-px-wide tank sitting on dark terrain has no ground contact and
    //    appears to float.
    const shadow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: art.particle, color: 0x000000, transparent: true, opacity: 0.42,
      depthWrite: false,
    }));
    shadow.scale.set(W * 2.4, 13, 1);
    shadow.position.set(0, 2.2, -0.6);
    this.group.add(shadow);
    this.shadow = shadow;

    // ── tracks (dark, sits lowest) ──
    add(outlineMesh(TRACK_O, -0.3));
    const trackMat = partMaterial("#3a4150", "#12161f", "#7e8fa6", 0.6, 6.6, 4);
    const track = new THREE.Mesh(new THREE.ShapeGeometry(shapeFrom(TRACK)), trackMat);
    track.position.z = 0;
    add(track);

    // tread blocks — animated by sliding their offset when the tank moves
    for (let i = 0; i < 9; i++) {
      const g = new THREE.PlaneGeometry(2.2, 5.4);
      const m = new THREE.MeshBasicMaterial({ color: 0x0b0e14, transparent: true, opacity: 0.55 });
      const block = new THREE.Mesh(g, m);
      block.position.set(-HALF - 2 + i * 3.4, 3.6, 0.05);
      this.treads.push(block);
      add(block);
    }

    // road wheels read as lighter discs behind the tread blocks
    for (const wx of [-8.5, -2.8, 2.8, 8.5]) {
      const g = new THREE.CircleGeometry(2.1, 14);
      const m = new THREE.MeshBasicMaterial({ color: 0x252b36 });
      const wheel = new THREE.Mesh(g, m);
      wheel.position.set(wx, 3.5, 0.02);
      add(wheel);
    }

    // ── hull ──
    add(outlineMesh(HULL_O, 0.4));
    const hullMat = partMaterial(light, base, "#ffffff", 6.2, 13.6, 5);
    const hull = new THREE.Mesh(new THREE.ShapeGeometry(shapeFrom(HULL)), hullMat);
    hull.position.z = 0.6;
    this.glowMats.push(hullMat);
    add(hull);

    // ── turret ──
    add(outlineMesh(TURRET_O, 0.8));
    const turretMat = partMaterial("#ffffff", light, "#ffffff", 13, 19, 3);
    const turret = new THREE.Mesh(new THREE.ShapeGeometry(shapeFrom(TURRET)), turretMat);
    turret.position.z = 1.0;
    this.glowMats.push(turretMat);
    add(turret);

    // hatch detail
    const hatch = new THREE.Mesh(
      new THREE.CircleGeometry(1.7, 12),
      new THREE.MeshBasicMaterial({ color: dark }),
    );

    hatch.position.set(-2.4, 18.2, 1.1);
    add(hatch);

    // ── barrel (own group so it rotates about the turret pivot) ──
    this.barrel = new THREE.Group();
    this.barrel.position.set(0, TURRET_PIVOT_Y, 1.4);
    this.group.add(this.barrel);

    const L = WORLD.TURRET_LENGTH;
    const barrelOutline: [number, number][] = [[-2, -2.6], [L + 3.2, -3.2], [L + 3.2, 3.2], [-2, 2.6]];
    const bo = outlineMesh(barrelOutline, -0.05);
    this.barrel.add(bo);
    this.owned.push({ geometry: bo.geometry, material: bo.material as THREE.Material });

    const barrelMat = partMaterial("#8b95a6", "#39404e", "#ffffff", -1.6, 1.6, 3);
    const barrelShape: [number, number][] = [[-2, -1.6], [L + 2, -2.0], [L + 2, 2.0], [-2, 1.6]];
    const barrel = new THREE.Mesh(new THREE.ShapeGeometry(shapeFrom(barrelShape)), barrelMat);
    this.barrel.add(barrel);
    this.owned.push({ geometry: barrel.geometry, material: barrelMat });

    // ── muzzle flash ──
    const flashMat = new THREE.SpriteMaterial({
      map: art.flash, color: 0xffd9a0, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.flash = new THREE.Sprite(flashMat);
    this.flash.scale.set(30, 30, 1);
    this.flash.position.set(L + 6, 0, 0.2);
    this.barrel.add(this.flash);

    // ── active-player halo (soft glow, not a hard ring) ──
    const haloMat = new THREE.SpriteMaterial({
      map: art.particle, color: base, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.halo = new THREE.Sprite(haloMat);
    this.halo.scale.set(84, 84, 1);
    this.halo.position.set(0, 10, -1);
    this.group.add(this.halo);

    // ── shield bubble ──
    const shieldGeo = new THREE.RingGeometry(W * 0.8, W * 0.95, 48);
    const shieldMat = new THREE.MeshBasicMaterial({
      color: 0x7dd3fc, transparent: true, opacity: 0,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.shield = new THREE.Mesh(shieldGeo, shieldMat);
    this.shield.position.set(0, 10, 3);
    add(this.shield);
  }

  applyTheme(theme: ThemePalette): void {
    for (const m of this.glowMats) m.uniforms.uRim.value.set(theme.rimColor);
  }

  /** localAngle already has hull tilt removed; recoil is 1 → 0 after firing. */
  setAim(localAngle: number, recoil: number): void {
    this.barrel.rotation.z = localAngle;
    this.barrel.position.x = -Math.cos(localAngle) * recoil * recoil * 5;
    this.barrel.position.y = TURRET_PIVOT_Y - Math.sin(localAngle) * recoil * recoil * 5;
  }

  fireFlash(): void {
    this.flashLife = 1;
  }

  /** dx = world units moved since last frame (drives tread scroll). */
  update(dt: number, timeSec: number, isActive: boolean, shielded: boolean, dx: number): void {
    // muzzle flash decays fast and shrinks
    if (this.flashLife > 0) {
      this.flashLife = Math.max(0, this.flashLife - dt * 7);
      const f = this.flashLife;
      const mat = this.flash.material as THREE.SpriteMaterial;
      mat.opacity = f * f;
      const s = 16 + 26 * (1 - f) * f * 4;
      this.flash.scale.set(s, s, 1);
    }

    // treads scroll with movement
    if (Math.abs(dx) > 0.0001) {
      this.treadPhase = (this.treadPhase + dx * 1.4) % 3.4;
      for (let i = 0; i < this.treads.length; i++) {
        let x = -HALF - 2 + i * 3.4 - this.treadPhase;
        while (x < -HALF - 3.5) x += 3.4 * this.treads.length;
        while (x > HALF + 3.5) x -= 3.4 * this.treads.length;
        this.treads[i].position.x = x;
      }
    }

    const haloMat = this.halo.material as THREE.SpriteMaterial;
    haloMat.opacity = isActive ? 0.22 + 0.1 * Math.sin(timeSec * 4.5) : 0;

    const glow = isActive ? 0.16 + 0.08 * Math.sin(timeSec * 4.5) : 0;
    for (const m of this.glowMats) m.uniforms.uGlow.value = glow;

    const shieldMat = this.shield.material as THREE.MeshBasicMaterial;
    shieldMat.opacity = shielded ? 0.5 + 0.22 * Math.sin(timeSec * 7) : 0;
    this.shield.rotation.z = timeSec * 0.6;
  }

  dispose(): void {
    // Everything mesh-shaped (including the barrel's children) is registered in
    // `owned` at construction, so one pass disposes each resource exactly once.
    for (const o of this.owned) {
      o.geometry.dispose();
      o.material.dispose();
    }
    this.owned.length = 0;
    (this.flash.material as THREE.SpriteMaterial).dispose();
    (this.halo.material as THREE.SpriteMaterial).dispose();
    (this.shadow.material as THREE.SpriteMaterial).dispose();
  }
}
