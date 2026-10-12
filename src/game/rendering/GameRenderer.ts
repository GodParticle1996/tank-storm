// ═══════════════════════════════════════════════════════════
//  GameRenderer — Three.js scene manager (§2.2)
//  Reads engine state directly every frame. NO React in the render path.
//
//  This file is now an ORCHESTRATOR. The heavy visual work lives in focused
//  modules so each piece can be reasoned about (and replaced) on its own:
//
//    themes.ts          per-mode palette, lighting and grade
//    assets.ts          CC0 textures + procedural fallbacks
//    TerrainMaterial.ts world-space strata shader
//    TerrainMesh.ts     2-row geometry + carve-heat attribute
//    TankModel.ts       authored 2D silhouettes with outlines
//    ParticleSystem.ts  textured points, per-particle size/spin
//    Explosions.ts      atlas fireball + shockwave + core flash
//    Backdrop.ts        sky, parallax ridges, clouds, weather
//    PostFX.ts          bloom + colour grade + vignette
//
//  Camera: fixed orthographic, symmetric frustum, positioned at the battlefield
//  centre. The frustum is NEVER offset by world coordinates — only
//  camera.position moves, and that is what screen shake modifies.
// ═══════════════════════════════════════════════════════════

import * as THREE from "three";
import { WORLD } from "../engine/constants";
import { getWeapon } from "../engine/weapons";
import { sfx } from "../audio/Sfx";
import type { GameEngine } from "../engine/GameEngine";
import type { TankState, ProjectileState, VisualEffect, ScorePopup, ZoneEffect } from "../engine/types";
import type { TerrainTheme } from "../engine/modes";

import { createArt, type Art } from "./assets";
import { THEMES, type ThemePalette } from "./themes";
import { createTerrainMaterial, applyThemeToTerrain } from "./TerrainMaterial";
import { TerrainMesh } from "./TerrainMesh";
import { TankModel } from "./TankModel";
import { ParticleLayer } from "./ParticleSystem";
import { ExplosionField } from "./Explosions";
import { Backdrop } from "./Backdrop";
import { PostFX } from "./PostFX";

const CAM_X = WORLD.WIDTH / 2;
const CAM_Y = WORLD.HEIGHT / 2;
const VIEW_MARGIN = 30;
const TURRET_PIVOT_Y = WORLD.TANK_HEIGHT + 2;

export class GameRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private container: HTMLElement;
  private engine: GameEngine;

  private art: Art;
  private backdrop: Backdrop;
  private terrainMat: THREE.ShaderMaterial;
  private terrain: TerrainMesh;
  private tanks: [TankModel, TankModel];
  private postfx: PostFX;

  private sparks: ParticleLayer;   // additive, hot
  private smoke: ParticleLayer;    // normal, dark
  private debris: ParticleLayer;   // normal, small + heavy
  private explosions: ExplosionField;

  private projectileMeshes = new Map<number, THREE.Sprite>();
  private beamMeshes = new Map<number, THREE.Mesh>();
  private popupSprites = new Map<number, THREE.Sprite>();
  private popupGroup = new THREE.Group();
  private trajectoryLine: THREE.Line;

  private theme: ThemePalette = THEMES.night;
  private activeThemeId: TerrainTheme | null = null;
  private shakeTrauma = 0;
  private lastFrameTime = 0;
  private clock = 0;
  private processedEffectIds = new Set<number>();
  private prevRecoil: [number, number] = [0, 0];
  private tankView = [
    { x: Number.NaN, y: 0, tilt: 0 },
    { x: Number.NaN, y: 0, tilt: 0 },
  ];

  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, engine: GameEngine, opts: { msaaSamples?: number } = {}) {
    this.container = container;
    this.engine = engine;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    const { viewW, viewH } = this.computeView(container.clientWidth, container.clientHeight);
    this.camera = new THREE.OrthographicCamera(-viewW / 2, viewW / 2, viewH / 2, -viewH / 2, -800, 800);
    this.camera.position.set(CAM_X, CAM_Y, 100);

    this.art = createArt();

    this.backdrop = new Backdrop(this.art);
    this.scene.add(this.backdrop.group);

    this.terrainMat = createTerrainMaterial(this.art, WORLD.HEIGHT);
    this.terrain = new TerrainMesh(engine.terrain, this.terrainMat);
    this.scene.add(this.terrain.mesh);

    this.tanks = [new TankModel(0, this.art), new TankModel(1, this.art)];
    this.scene.add(this.tanks[0].group, this.tanks[1].group);

    // Hot sparks and cool smoke must be separate layers: additive blending
    // physically cannot draw anything darker than what is behind it, so a
    // smoke plume in the additive layer would simply be invisible.
    this.sparks = new ParticleLayer(this.art.particle, 3000, { additive: true, grow: 0.35, spin: 0.6, z: 6 });
    this.smoke = new ParticleLayer(this.art.smoke, 1400, { additive: false, grow: 2.6, spin: 0.25, opacity: 0.62, z: 5 });
    this.debris = new ParticleLayer(this.art.particle, 900, { additive: false, grow: 0, spin: 1.4, opacity: 0.95, z: 6 });
    this.scene.add(this.smoke.points, this.sparks.points, this.debris.points);

    this.explosions = new ExplosionField(this.art);
    this.scene.add(this.explosions.group);

    const trajGeo = new THREE.BufferGeometry();
    const trajMat = new THREE.LineDashedMaterial({
      color: 0x7fe6ff, dashSize: 7, gapSize: 6, transparent: true, opacity: 0.6, depthWrite: false,
    });
    this.trajectoryLine = new THREE.Line(trajGeo, trajMat);
    this.trajectoryLine.visible = false;
    this.trajectoryLine.position.z = 3;
    this.scene.add(this.trajectoryLine);

    this.scene.add(this.popupGroup);

    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, buf.x, buf.y, opts.msaaSamples ?? 4);

    this.applyThemeIfChanged();
    this.updateParticleScale();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
  }

  // ═════════════════════════════════════════════
  //  View fitting: show the whole battlefield + margin
  // ═════════════════════════════════════════════

  private computeView(w: number, h: number): { viewW: number; viewH: number } {
    const worldW = WORLD.WIDTH + VIEW_MARGIN * 2;
    const worldH = WORLD.HEIGHT + VIEW_MARGIN * 2;
    const aspect = w > 0 && h > 0 ? w / h : 16 / 9;
    let viewW = worldW;
    let viewH = viewW / aspect;
    if (viewH < worldH) {
      viewH = worldH;
      viewW = viewH * aspect;
    }
    return { viewW, viewH };
  }

  /** Particle sizes are authored in world units — convert once per resize. */
  private updateParticleScale(): void {
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const viewH = this.camera.top - this.camera.bottom;
    const pxPerWorld = viewH > 0 ? buf.y / viewH : 1;
    this.sparks.setScale(pxPerWorld);
    this.smoke.setScale(pxPerWorld);
    this.debris.setScale(pxPerWorld);
    this.backdrop.setScale(pxPerWorld);
  }

  // ═════════════════════════════════════════════
  //  Theme (per battle mode)
  // ═════════════════════════════════════════════

  private applyThemeIfChanged(): void {
    const id = this.engine.getMode().theme;
    if (id === this.activeThemeId) return;
    this.activeThemeId = id;
    this.theme = THEMES[id];

    this.backdrop.applyTheme(this.theme);
    applyThemeToTerrain(this.terrainMat, this.theme);
    this.postfx.applyTheme(this.theme);
    for (const t of this.tanks) t.applyTheme(this.theme);
  }

  // ═════════════════════════════════════════════
  //  Tanks
  // ═════════════════════════════════════════════

  private updateTank(model: TankModel, tank: TankState, isActive: boolean, timeSec: number, dt: number): void {
    const view = this.tankView[tank.id];
    if (Number.isNaN(view.x) || Math.abs(tank.x - view.x) > 80) {
      // Teleport-scale jumps snap; hops and knock-arcs glide.
      view.x = tank.x;
      view.y = tank.y;
    }
    const k = 1 - Math.exp(-12 * dt);
    const prevX = view.x;
    view.x += (tank.x - view.x) * k;
    view.y += (tank.y - view.y) * k;

    const slopeRad = (this.engine.terrain.getSlopeSignedDeg(tank.x) * Math.PI) / 180;
    const targetTilt = Math.max(-0.45, Math.min(0.45, slopeRad));
    view.tilt += (targetTilt - view.tilt) * k;

    model.group.position.set(view.x, view.y, 0);
    model.group.rotation.z = view.tilt;

    // Barrel holds its WORLD aim angle, so the hull tilt is removed here.
    const angleRad = (tank.angleDeg * Math.PI) / 180;
    model.setAim(angleRad - view.tilt, tank.recoil);

    // Rising edge of recoil == the shot just fired
    if (tank.recoil > this.prevRecoil[tank.id] + 0.2) model.fireFlash();
    this.prevRecoil[tank.id] = tank.recoil;

    model.update(dt, timeSec, isActive, tank.shieldHp > 0, view.x - prevX);
  }

  // ═════════════════════════════════════════════
  //  Projectiles
  // ═════════════════════════════════════════════

  private updateProjectiles(projectiles: readonly ProjectileState[], dt: number): void {
    const alive = new Set<number>();

    for (const p of projectiles) {
      alive.add(p.id);
      const weaponColor = getWeapon(p.weaponId)?.color ?? "#ffaa44";
      let sprite = this.projectileMeshes.get(p.id);
      if (!sprite) {
        const mat = new THREE.SpriteMaterial({
          map: this.art.particle, color: new THREE.Color(weaponColor),
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        });
        sprite = new THREE.Sprite(mat);
        sprite.renderOrder = 13;
        this.scene.add(sprite);
        this.projectileMeshes.set(p.id, sprite);
      }
      const speed = Math.hypot(p.vx, p.vy);
      // Stretch along the flight direction — a round dot at 700 u/s reads as a
      // floating ball, a streak reads as a shell.
      const stretch = 1 + Math.min(1.5, speed / 620);
      sprite.position.set(p.x, p.y, 6);
      sprite.scale.set(15 * stretch, 15 / Math.sqrt(stretch), 1);
      sprite.material.rotation = Math.atan2(p.vy, p.vx);

      // Trail: hot core + a little smoke, emitted per second not per frame so
      // the trail density does not change with the monitor's refresh rate.
      const c = new THREE.Color(weaponColor);
      const n = Math.random() < dt * 90 ? 2 : 1;
      this.sparks.spawn({
        x: p.x, y: p.y, count: n, color: c, color2: new THREE.Color(0xffffff),
        speedMin: 0, speedMax: 14, lifeMin: 0.16, lifeMax: 0.34,
        sizeMin: 4, sizeMax: 9, gravityScale: 0, spread: 3, drag: 0.2,
      });
      if (Math.random() < dt * 26) {
        this.smoke.spawn({
          x: p.x, y: p.y, count: 1,
          color: new THREE.Color(0x6d6f78), color2: new THREE.Color(0x3a3c44),
          speedMin: 2, speedMax: 10, lifeMin: 0.5, lifeMax: 1.0,
          sizeMin: 7, sizeMax: 13, gravityScale: -0.02, spread: 3, drag: 0.7,
        });
      }
    }

    for (const [id, sprite] of this.projectileMeshes) {
      if (!alive.has(id)) {
        this.scene.remove(sprite);
        sprite.material.dispose();
        this.projectileMeshes.delete(id);
      }
    }
  }

  // ═════════════════════════════════════════════
  //  Visual effects
  // ═════════════════════════════════════════════

  private processVisualEffects(effects: readonly VisualEffect[]): void {
    for (const eff of effects) {
      if (this.processedEffectIds.has(eff.id)) continue;
      this.processedEffectIds.add(eff.id);
      const color = new THREE.Color(eff.color);

      switch (eff.type) {
        case "explosion": {
          this.explosions.spawn(eff.x, eff.y, eff.radius, color);

          const r = eff.radius;
          this.sparks.spawn({
            x: eff.x, y: eff.y, count: Math.min(90, Math.floor(r * 1.5)),
            color, color2: new THREE.Color(0xfff0c0),
            speedMin: 70, speedMax: 60 + r * 6,
            lifeMin: 0.3, lifeMax: 0.95, sizeMin: 4, sizeMax: 14,
            gravityScale: 0.75, spread: r * 0.25, drag: 0.35,
          });
          this.debris.spawn({
            x: eff.x, y: eff.y, count: Math.min(34, Math.floor(r * 0.55)),
            color: new THREE.Color(this.theme.dirtLight), color2: new THREE.Color(this.theme.dirtDark),
            speedMin: 80, speedMax: 90 + r * 5,
            lifeMin: 0.7, lifeMax: 1.6, sizeMin: 2.5, sizeMax: 6.5,
            gravityScale: 1.25, upwardBias: 55, spread: r * 0.3, drag: 0.5,
          });
          this.smoke.spawn({
            x: eff.x, y: eff.y + r * 0.15, count: Math.min(26, 10 + Math.floor(r * 0.25)),
            color: new THREE.Color(0x5c5e68), color2: new THREE.Color(0x2b2c33),
            speedMin: 10, speedMax: 40 + r,
            lifeMin: 1.2, lifeMax: 2.6, sizeMin: 16, sizeMax: 34,
            gravityScale: -0.04, upwardBias: 30, spread: r * 0.5, drag: 1.1,
          });

          this.shakeTrauma = Math.min(1, this.shakeTrauma + r / 190);
          this.postfx.punch(Math.min(0.3, r / 620), color);
          sfx.boom(r);
          break;
        }
        case "dust": {
          this.smoke.spawn({
            x: eff.x, y: eff.y, count: 12,
            color: new THREE.Color(this.theme.dirtLight), color2: new THREE.Color(this.theme.dirtMid),
            speedMin: 8, speedMax: 46, lifeMin: 0.6, lifeMax: 1.3,
            sizeMin: 10, sizeMax: 22, gravityScale: -0.02, upwardBias: 20, spread: 10, drag: 1.0,
          });
          sfx.thud();
          break;
        }
        case "fire": {
          this.sparks.spawn({
            x: eff.x, y: eff.y, count: 22, color, color2: new THREE.Color(0xffd08a),
            speedMin: 8, speedMax: 55, lifeMin: 0.5, lifeMax: 1.1,
            sizeMin: 5, sizeMax: 13, gravityScale: -0.16, upwardBias: 30, spread: 8, drag: 0.6,
          });
          break;
        }
        case "spark": {
          this.sparks.spawn({
            x: eff.x, y: eff.y, count: 14, color, color2: new THREE.Color(0xffffff),
            speedMin: 70, speedMax: 190, lifeMin: 0.12, lifeMax: 0.36,
            sizeMin: 3, sizeMax: 8, gravityScale: 0.6, drag: 0.3,
          });
          sfx.pop();
          break;
        }
        case "beam": {
          const x2 = eff.x2 ?? eff.x;
          const y2 = eff.y2 ?? eff.y;
          for (let s = 0; s <= 10; s++) {
            const t = s / 10;
            this.sparks.spawn({
              x: eff.x + (x2 - eff.x) * t, y: eff.y + (y2 - eff.y) * t,
              count: 2, color, color2: new THREE.Color(0xffffff),
              speedMin: 8, speedMax: 55, lifeMin: 0.14, lifeMax: 0.4,
              sizeMin: 4, sizeMax: 11, gravityScale: 0.1, spread: 5, drag: 0.2,
            });
          }
          this.shakeTrauma = Math.min(1, this.shakeTrauma + 0.16);
          this.postfx.punch(0.1, color);
          sfx.zap();
          break;
        }
        case "displace": {
          this.sparks.spawn({
            x: eff.x, y: eff.y, count: 26, color, color2: new THREE.Color(0xffffff),
            speedMin: 20, speedMax: 120, lifeMin: 0.3, lifeMax: 0.8,
            sizeMin: 4, sizeMax: 12, gravityScale: -0.1, spread: eff.radius * 0.4, drag: 0.4,
          });
          break;
        }
      }
    }

    if (this.processedEffectIds.size > 300) {
      this.processedEffectIds.clear();
      for (const eff of effects) this.processedEffectIds.add(eff.id);
    }
  }

  /** Beam quads live as long as their effect does. */
  private updateBeams(effects: readonly VisualEffect[]): void {
    const alive = new Set<number>();

    for (const eff of effects) {
      if (eff.type !== "beam") continue;
      alive.add(eff.id);

      let mesh = this.beamMeshes.get(eff.id);
      if (!mesh) {
        const x2 = eff.x2 ?? eff.x;
        const y2 = eff.y2 ?? eff.y;
        const dx = x2 - eff.x;
        const dy = y2 - eff.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        const width = Math.max(4, eff.radius) * 2.2;

        const geo = new THREE.PlaneGeometry(len, width);
        const mat = new THREE.MeshBasicMaterial({
          map: this.art.spark, color: new THREE.Color(eff.color),
          transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(eff.x + dx / 2, eff.y + dy / 2, 7);
        mesh.rotation.z = Math.atan2(dy, dx);
        mesh.renderOrder = 13;
        this.scene.add(mesh);
        this.beamMeshes.set(eff.id, mesh);
      }
      const t = Math.max(0, 1 - eff.age / eff.maxAge);
      (mesh.material as THREE.MeshBasicMaterial).opacity = 0.95 * t;
      mesh.scale.y = 0.55 + 0.45 * t;
    }

    for (const [id, mesh] of this.beamMeshes) {
      if (!alive.has(id)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.beamMeshes.delete(id);
      }
    }
  }

  /** Persistent napalm / radiation zones keep licking flame. */
  private updateZoneParticles(zones: readonly ZoneEffect[], dt: number): void {
    for (const zone of zones) {
      if (Math.random() < dt * 16) {
        const ox = (Math.random() * 2 - 1) * zone.radius * 0.85;
        const surfaceY = this.engine.terrain.getSurfaceY(zone.x + ox);
        const fire = zone.effect === "fire";
        this.sparks.spawn({
          x: zone.x + ox, y: surfaceY + 3, count: 2,
          color: new THREE.Color(fire ? "#ff6a1a" : "#9be31c"),
          color2: new THREE.Color(fire ? "#ffd07a" : "#e6ff9a"),
          speedMin: 3, speedMax: 22, lifeMin: 0.5, lifeMax: 1.15,
          sizeMin: 5, sizeMax: 13, gravityScale: -0.22, upwardBias: 32, spread: 6, drag: 0.5,
        });
      }
      if (Math.random() < dt * 5) {
        const ox = (Math.random() * 2 - 1) * zone.radius * 0.7;
        const surfaceY = this.engine.terrain.getSurfaceY(zone.x + ox);
        this.smoke.spawn({
          x: zone.x + ox, y: surfaceY + 8, count: 1,
          color: new THREE.Color(0x4a4b53), color2: new THREE.Color(0x26272d),
          speedMin: 3, speedMax: 14, lifeMin: 1.1, lifeMax: 2.2,
          sizeMin: 12, sizeMax: 24, gravityScale: -0.05, upwardBias: 24, drag: 1.2,
        });
      }
    }
  }

  // ═════════════════════════════════════════════
  //  Aim preview + score popups
  // ═════════════════════════════════════════════

  private updateTrajectory(): void {
    const readout = this.engine.aimReadout;
    if (readout.trajectory.length < 2) {
      this.trajectoryLine.visible = false;
      return;
    }
    this.trajectoryLine.visible = true;
    const points = readout.trajectory.map((p) => new THREE.Vector3(p.x, p.y, 0));
    (this.trajectoryLine.geometry as THREE.BufferGeometry).setFromPoints(points);
    this.trajectoryLine.computeLineDistances();
  }

  private updatePopups(popups: readonly ScorePopup[]): void {
    const alive = new Set<number>();

    for (const pop of popups) {
      alive.add(pop.id);
      let sprite = this.popupSprites.get(pop.id);
      if (!sprite) {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 112;
        const ctx = canvas.getContext("2d")!;
        ctx.font = "900 56px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // Heavy outline + shadow so the number survives being drawn over a
        // fireball, which is exactly when it matters most.
        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = 12;
        ctx.lineWidth = 11;
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.strokeText(pop.text, 160, 56);
        ctx.shadowBlur = 0;
        ctx.fillStyle = pop.color;
        ctx.fillText(pop.text, 160, 56);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
        sprite = new THREE.Sprite(mat);
        sprite.scale.set(76, 27, 1);
        sprite.renderOrder = 30;
        this.popupGroup.add(sprite);
        this.popupSprites.set(pop.id, sprite);
      }

      const t = pop.age / pop.maxAge;
      sprite.position.set(pop.x, pop.y, 12);
      // little pop-in, then drift and fade
      const s = 1 + 0.22 * Math.exp(-t * 14) - 0.1 * t;
      sprite.scale.set(76 * s, 27 * s, 1);
      (sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - t * t);
    }

    for (const [id, sprite] of this.popupSprites) {
      if (!alive.has(id)) {
        this.popupGroup.remove(sprite);
        (sprite.material as THREE.SpriteMaterial).map?.dispose();
        (sprite.material as THREE.SpriteMaterial).dispose();
        this.popupSprites.delete(id);
      }
    }
  }

  // ═════════════════════════════════════════════
  //  Main render frame
  // ═════════════════════════════════════════════

  /**
   * @param dtOverride fixed timestep in seconds. The game passes nothing and
   *   gets wall-clock delta; the headless visual harness passes a fixed value
   *   so a screenshot lands on the same animation frame every run (on software
   *   GL a single frame costs over a second of real time, which would otherwise
   *   fast-forward every effect past its lifetime).
   */
  /** Resolves when every texture has decoded. Only the harness awaits this. */
  get texturesReady(): Promise<void> {
    return this.art.ready;
  }

  render(dtOverride?: number): void {
    const now = performance.now();
    const dt = dtOverride ?? (this.lastFrameTime > 0 ? Math.min((now - this.lastFrameTime) / 1000, 0.1) : 0.016);
    this.lastFrameTime = now;
    this.clock += dt;
    const timeSec = this.clock;

    const tanks = this.engine.getTanks();
    const projectiles = this.engine.getProjectiles();
    const effects = this.engine.getVisualEffects();
    const popups = this.engine.getPopups();
    const zones = this.engine.getZones();
    const snapshot = this.engine.getSnapshot();
    const wind = snapshot.wind;

    this.applyThemeIfChanged();

    if (this.engine.terrain.dirty) {
      this.terrain.rebuild();
      this.engine.terrain.dirty = false;
    }
    this.terrain.update(dt);

    const aiming = snapshot.phase === "AIMING";
    this.updateTank(this.tanks[0], tanks[0], aiming && snapshot.currentPlayer === 0, timeSec, dt);
    this.updateTank(this.tanks[1], tanks[1], aiming && snapshot.currentPlayer === 1, timeSec, dt);

    this.updateProjectiles(projectiles, dt);

    this.processVisualEffects(effects);
    this.updateBeams(effects);
    this.updateZoneParticles(zones, dt);
    this.explosions.update(dt);

    // Wind pushes smoke hard, sparks barely, debris somewhere between.
    this.sparks.update(dt, wind * 0.4, 300, timeSec);
    this.smoke.update(dt, wind * 1.5, 300, timeSec);
    this.debris.update(dt, wind * 0.6, 300, timeSec);

    this.backdrop.update(dt, wind, timeSec);

    this.updateTrajectory();
    this.updatePopups(popups);

    // Screen shake: trauma², decaying — squaring keeps small hits subtle and
    // big ones violent instead of everything feeling the same.
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 2);
    const shake = this.shakeTrauma * this.shakeTrauma;
    if (shake > 0.01) {
      this.camera.position.x = CAM_X + (Math.random() - 0.5) * shake * 20;
      this.camera.position.y = CAM_Y + (Math.random() - 0.5) * shake * 12;
      this.camera.rotation.z = (Math.random() - 0.5) * shake * 0.012;
    } else {
      this.camera.position.x = CAM_X;
      this.camera.position.y = CAM_Y;
      this.camera.rotation.z = 0;
    }

    this.postfx.update(dt, timeSec);
    this.postfx.render();
  }

  // ═════════════════════════════════════════════
  //  Resize
  // ═════════════════════════════════════════════

  private handleResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;

    this.renderer.setSize(w, h);

    const { viewW, viewH } = this.computeView(w, h);
    this.camera.left = -viewW / 2;
    this.camera.right = viewW / 2;
    this.camera.top = viewH / 2;
    this.camera.bottom = -viewH / 2;
    this.camera.updateProjectionMatrix();

    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.postfx.setSize(buf.x, buf.y);
    this.updateParticleScale();
  }

  // ═════════════════════════════════════════════
  //  Dispose (§Part 4 item 11 — prevent GPU leaks)
  // ═════════════════════════════════════════════

  dispose(): void {
    this.resizeObserver.disconnect();

    for (const [, sprite] of this.projectileMeshes) {
      this.scene.remove(sprite);
      sprite.material.dispose();
    }
    this.projectileMeshes.clear();

    for (const [, mesh] of this.beamMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.beamMeshes.clear();

    for (const [, sprite] of this.popupSprites) {
      this.popupGroup.remove(sprite);
      (sprite.material as THREE.SpriteMaterial).map?.dispose();
      (sprite.material as THREE.SpriteMaterial).dispose();
    }
    this.popupSprites.clear();

    this.terrain.dispose();
    this.terrainMat.dispose();
    for (const t of this.tanks) t.dispose();
    this.sparks.dispose();
    this.smoke.dispose();
    this.debris.dispose();
    this.explosions.dispose();
    this.backdrop.dispose();
    this.postfx.dispose();

    (this.trajectoryLine.geometry as THREE.BufferGeometry).dispose();
    (this.trajectoryLine.material as THREE.Material).dispose();

    this.art.dispose();

    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
