// ═══════════════════════════════════════════════════════════
//  Visual themes — one palette per battle mode.
//
//  Art direction: MODERN ARCADE. Saturated, high contrast, bold silhouettes,
//  bloom. Readability beats realism: the terrain surface, the two tanks and the
//  projectile must always be the easiest things on screen to find.
//
//  The bundled terrain textures are grayscale DETAIL, not colour — colour comes
//  from this file. That is what lets one texture set serve all four themes.
// ═══════════════════════════════════════════════════════════

import type { TerrainTheme } from "../engine/modes";

export type Weather = "none" | "rain" | "embers" | "dust";

export interface ThemePalette {
  // ─ sky ─
  skyTop: string;
  skyMid: string;
  skyHorizon: string;
  /** Atmospheric haze that fades distant ridges into the sky. */
  haze: string;

  // ─ parallax ridges (far = most hazed, near = most solid) ─
  ridgeFar: string;
  ridgeMid: string;
  ridgeNear: string;

  // ─ ground ─
  grassLow: string;
  grassHigh: string;
  grassDark: string;
  dirtLight: string;
  dirtMid: string;
  dirtDark: string;
  rockTint: string;
  deep: string;
  /** Thin lit rim tracing the terrain silhouette — the strongest readability cue. */
  surfaceLine: string;
  /** Freshly-carved ground glows briefly in this colour. */
  scorch: string;

  // ─ sky dressing ─
  starOpacity: number;
  clouds: boolean;
  cloudColor: string;
  disc: { color: string; x: number; y: number; r: number; opacity: number } | null;

  // ─ lighting & grade ─
  /** Key-light direction in degrees (0 = from the right, 90 = from above). */
  sunAngleDeg: number;
  sunColor: string;
  rimColor: string;
  ambient: string;
  bloom: { strength: number; radius: number; threshold: number };
  grade: { saturation: number; contrast: number; tint: string; tintAmount: number; vignette: number };

  // ─ weather ─
  weather: Weather;
  weatherColor: string;
  weatherIntensity: number;
}

export const THEMES: Record<TerrainTheme, ThemePalette> = {
  // Classic Battle — deep blue night, warm grass, calm.
  night: {
    skyTop: "#050916", skyMid: "#132048", skyHorizon: "#3b5490", haze: "#4a6aa8",
    ridgeFar: "#2c3f6e", ridgeMid: "#20304f", ridgeNear: "#16223a",
    grassLow: "#43a83c", grassHigh: "#74d24d", grassDark: "#20551f",
    dirtLight: "#b07a45", dirtMid: "#7a5230", dirtDark: "#4a3520", rockTint: "#3f4552",
    deep: "#12151c",
    surfaceLine: "#a9e57a", scorch: "#ff9a3c",
    starOpacity: 0.75, clouds: true, cloudColor: "#8fa8d6",
    disc: { color: "#eef2fb", x: 860, y: 570, r: 26, opacity: 0.55 },
    sunAngleDeg: 118, sunColor: "#cfe0ff", rimColor: "#9fd0ff", ambient: "#2b3a63",
    bloom: { strength: 0.72, radius: 0.55, threshold: 0.62 },
    grade: { saturation: 1.16, contrast: 1.07, tint: "#5f7ec4", tintAmount: 0.06, vignette: 0.34 },
    weather: "none", weatherColor: "#9fb6e0", weatherIntensity: 0,
  },

  // Storm Blitz — bruised sky, hard wind, rain.
  storm: {
    skyTop: "#080b14", skyMid: "#1a2333", skyHorizon: "#46586a", haze: "#5a6d80",
    ridgeFar: "#41525f", ridgeMid: "#2c3742", ridgeNear: "#1b222b",
    grassLow: "#3d8a37", grassHigh: "#5fae42", grassDark: "#1e5220",
    dirtLight: "#96703f", dirtMid: "#67472a", dirtDark: "#3c2a19", rockTint: "#383e49",
    deep: "#0f1116",
    surfaceLine: "#8fc46c", scorch: "#ff8a30",
    starOpacity: 0.12, clouds: true, cloudColor: "#66788c",
    disc: null,
    sunAngleDeg: 105, sunColor: "#c3d4e4", rimColor: "#a9c6e2", ambient: "#39485a",
    bloom: { strength: 0.6, radius: 0.6, threshold: 0.66 },
    grade: { saturation: 0.94, contrast: 1.14, tint: "#5c7488", tintAmount: 0.11, vignette: 0.42 },
    weather: "rain", weatherColor: "#a9c2dd", weatherIntensity: 1,
  },

  // Lunar War — airless, colourless ground, hard black sky, Earth on the horizon.
  lunar: {
    skyTop: "#010208", skyMid: "#04060d", skyHorizon: "#10131f", haze: "#1c2130",
    ridgeFar: "#242838", ridgeMid: "#191d29", ridgeNear: "#0f121b",
    grassLow: "#9aa0b0", grassHigh: "#c6cbd8", grassDark: "#666b7b",
    dirtLight: "#5d6270", dirtMid: "#464a55", dirtDark: "#31343d", rockTint: "#24272f",
    deep: "#0b0c10",
    surfaceLine: "#cdd6ea", scorch: "#8fd0ff",
    starOpacity: 1, clouds: false, cloudColor: "#ffffff",
    disc: { color: "#79a6dd", x: 160, y: 600, r: 36, opacity: 0.9 },
    sunAngleDeg: 60, sunColor: "#ffffff", rimColor: "#bcd6ff", ambient: "#141824",
    // Airless = no scattering, so light is harsh: high contrast, tight bloom.
    bloom: { strength: 0.55, radius: 0.4, threshold: 0.74 },
    grade: { saturation: 0.72, contrast: 1.22, tint: "#8fa8d0", tintAmount: 0.05, vignette: 0.5 },
    weather: "dust", weatherColor: "#c8cfe0", weatherIntensity: 0.35,
  },

  // Heavy Metal — scorched earth under a burning sky, embers on the wind.
  inferno: {
    // Everything here was one register of red — sky, ridges and ground all sat
    // on the same hue and value, so the frame read as a flat red wash. The
    // ground is now scorched brown and the ridges are dark, which is what lets
    // the burning sky actually feel bright.
    skyTop: "#0c0406", skyMid: "#2a0d0c", skyHorizon: "#7a2e14", haze: "#9c4523",
    ridgeFar: "#4a2418", ridgeMid: "#331810", ridgeNear: "#1d0f0b",
    grassLow: "#6e5c2a", grassHigh: "#947d36", grassDark: "#3c3215",
    dirtLight: "#7d4527", dirtMid: "#522d18", dirtDark: "#31190e", rockTint: "#2b1f1b",
    deep: "#0d0503",
    surfaceLine: "#e0ac5c", scorch: "#ff5a1e",
    starOpacity: 0.1, clouds: true, cloudColor: "#c06a44",
    disc: { color: "#ff5a2a", x: 830, y: 590, r: 30, opacity: 0.6 },
    sunAngleDeg: 68, sunColor: "#ffcf9a", rimColor: "#ff9a52", ambient: "#4a2018",
    bloom: { strength: 0.95, radius: 0.62, threshold: 0.54 },
    grade: { saturation: 1.18, contrast: 1.12, tint: "#ff7a3a", tintAmount: 0.05, vignette: 0.42 },
    weather: "embers", weatherColor: "#ff9a44", weatherIntensity: 1,
  },
};
