// ═══════════════════════════════════════════════════════════
//  Visual harness — boots GameRenderer straight into an interesting frame so
//  the look can be screenshotted headlessly (google-chrome --headless
//  --screenshot). Not shipped: harness.html is only served in dev.
//
//  Query params:
//    ?theme=night|storm|lunar|inferno   which battle mode's palette
//    ?scene=calm|battle|dug             what to stage
//    ?t=1.2                             seconds of simulated render time
// ═══════════════════════════════════════════════════════════

import { GameEngine } from "../src/game/engine/GameEngine";
import { GameRenderer } from "../src/game/rendering/GameRenderer";
import { MODES } from "../src/game/engine/modes";

const statusEl = document.getElementById("status");
const say = (m: string) => { if (statusEl) statusEl.textContent = m; };
window.addEventListener("error", (e) => say("ERROR: " + e.message));
window.addEventListener("unhandledrejection", (e) => say("REJECT: " + String(e.reason)));

const params = new URLSearchParams(location.search);
const themeId = params.get("theme") ?? "night";
const scene = params.get("scene") ?? "battle";
const seconds = Number(params.get("t") ?? "1.1");

const mode = MODES.find((m) => m.theme === themeId) ?? MODES[0];

const engine = new GameEngine();
engine.setMode(mode.id);
engine.initGame(
  ["nuke", "napalm", "dirt_mover", "skipper"],
  ["nuke", "napalm", "dirt_mover", "skipper"],
);

const terrain = engine.terrain;

if (scene === "dug" || scene === "battle") {
  // Craters expose the world-space strata — the thing the old renderer could
  // not show at all, so this is the frame worth looking at.
  terrain.carveCrater(300, terrain.getSurfaceY(300) - 6, 74);
  terrain.carveCrater(360, terrain.getSurfaceY(360) + 4, 52);
  terrain.carveCrater(640, terrain.getSurfaceY(640) - 30, 96);
  terrain.carveShaft(500, terrain.getSurfaceY(500), 150, 34);
  terrain.carveTrench(700, terrain.getSurfaceY(700) - 20, 820, terrain.getSurfaceY(820) - 20, 40);
  terrain.dirty = true;
}

const stage = document.getElementById("stage")!;
// MSAA off: SwiftShader (headless software GL) needs seconds per frame with a
// multisampled float target. Everything else — bloom, grade, shaders — is real.
const renderer = new GameRenderer(stage, engine, { msaaSamples: 0 });

if (scene === "battle") {
  // Stage a volley in flight plus fresh detonations.
  const eff = engine.getVisualEffects() as unknown as Array<Record<string, unknown>>;
  let id = 9000;
  const push = (o: Record<string, unknown>) => eff.push({ id: id++, age: 0, maxAge: 1.4, ...o });
  push({ type: "explosion", x: 640, y: terrain.getSurfaceY(640) + 18, radius: 96, color: "#ff8c3a" });
  push({ type: "explosion", x: 318, y: terrain.getSurfaceY(318) + 10, radius: 58, color: "#ffd24a" });
  push({ type: "fire", x: 500, y: terrain.getSurfaceY(500) + 6, radius: 40, color: "#ff6a1a" });

  const projectiles = engine.getProjectiles() as unknown as Array<Record<string, unknown>>;
  projectiles.push({
    id: 7001, x: 430, y: 372, vx: 260, vy: 120, weaponId: "nuke", ownerId: 0,
    bouncesRemaining: 0, homingTurnRate: 0, homingAcquireDelay: 0, age: 0.4, fuse: 0,
    prevX: 424, prevY: 370, massScale: 1,
  });

  const tanks = engine.getTanks();
  (tanks[0] as { recoil: number }).recoil = 0.8;
  (tanks[0] as { angleDeg: number }).angleDeg = 52;
  (tanks[1] as { angleDeg: number }).angleDeg = 133;
  (tanks[1] as { shieldHp: number }).shieldHp = 40;
}

// Fixed-step the renderer so the screenshot is deterministic regardless of how
// fast the headless GPU actually is.
const STEP = 1 / 60;
const frames = Math.max(1, Math.round(seconds / STEP));
let drawn = 0;

function tick() {
  try {
    renderer.render(STEP);
  } catch (err) {
    say("RENDER THREW: " + String(err));
    return;
  }
  drawn++;
  say(`frame ${drawn}/${frames}`);
  if (drawn >= frames) {
    document.title = "READY";
    (window as unknown as { __harnessReady: boolean }).__harnessReady = true;
    say(`READY (${frames} frames)`);
    return;
  }
  requestAnimationFrame(tick);
}
say("loading textures…");
// Textures decode asynchronously. Rendering before they land gives flat,
// untextured terrain — which is exactly what the first screenshot showed.
renderer.texturesReady.then(() => {
  say("starting");
  tick();
});
