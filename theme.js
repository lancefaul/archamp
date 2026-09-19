// The desktop's theme, for archamp's own chrome: its menus, its drawers and
// the skin browser. Two desktops are read, in order, and neither is required.
//
// Omarchy keeps the active theme at ~/.local/state/omarchy/current/theme —
// colors.toml holds the palette every app gets, and shell.toml holds the
// surfaces its own shell draws with, of which [menu] is exactly what archamp
// is drawing here.
//
// KDE keeps its colour scheme in ~/.config/kdeglobals, which is the same
// question answered in INI with "r,g,b" triples. It is read where Omarchy's
// files are not there, so archamp's chrome follows Plasma rather than sitting
// in its own dark palette on somebody's light desktop.
//
// Away from both, archamp falls back to its own.
const fs = require("fs");
const os = require("os");
const path = require("path");

const THEME_DIR = path.join(os.homedir(), ".local", "state", "omarchy", "current", "theme");
const KDE_GLOBALS = path.join(os.homedir(), ".config", "kdeglobals");

// archamp's own look, and what every missing key falls back to.
const FALLBACK = {
  background: "#14151a",
  text: "#e2e2e6",
  accent: "#7aa2f7",
  border: "rgba(226, 226, 230, 0.12)",
  rule: "rgba(226, 226, 230, 0.12)",
  fill: "rgba(226, 226, 230, 0.04)",
  hover: "rgba(226, 226, 230, 0.08)",
  selected: "rgba(226, 226, 230, 0.18)",
  dim: "#a1a1a4",
  fontBase: 12,
};

// Enough TOML for these two files: sections, and keys holding a quoted string
// or a number.
function parseToml(text) {
  const sections = {};
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const heading = /^\[([^\]]+)\]$/.exec(trimmed);
    if (heading) {
      section = heading[1];
      sections[section] ??= {};
      continue;
    }
    // A quoted value is taken whole: colours start with #, which outside
    // quotes begins a comment.
    const quoted = /^([\w.-]+)\s*=\s*"([^"]*)"/.exec(trimmed);
    const bare = /^([\w.-]+)\s*=\s*([^#]+?)\s*(?:#.*)?$/.exec(trimmed);
    const pair = quoted ?? bare;
    if (!pair) continue;
    (sections[section] ??= {})[pair[1]] = pair[2];
  }
  return sections;
}

function readFile(name) {
  try {
    return parseToml(fs.readFileSync(path.join(THEME_DIR, name), "utf8"));
  } catch {
    return null;
  }
}

// A colour as CSS sees it. Themes write #rrggbb, Hyprland's rgba(rrggbbaa),
// or the name of another key to follow ("hyprland.active-border"); a border
// may be a gradient, of which the first colour is the one to take.
function cssColor(value, shell, alpha = 1, depth = 0) {
  const token = String(value ?? "")
    .trim()
    .split(/\s+/)
    .find((part) => part !== "" && !/^-?\d+(?:\.\d+)?deg$/.test(part));
  if (token == null) return null;
  const named = /^([\w-]+)\.([\w-]+)$/.exec(token);
  if (named && depth < 4) return cssColor(shell?.[named[1]]?.[named[2]], shell, alpha, depth + 1);
  const hyprland = /^rgba?\(([0-9a-f]{6})([0-9a-f]{2})?\)$/i.exec(token);
  if (hyprland) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hyprland[1].slice(i, i + 2), 16));
    const own = hyprland[2] == null ? 1 : parseInt(hyprland[2], 16) / 255;
    return `rgba(${r}, ${g}, ${b}, ${round(own * alpha)})`;
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(token);
  if (hex) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
    return alpha >= 1 ? `#${hex[1]}` : `rgba(${r}, ${g}, ${b}, ${round(alpha)})`;
  }
  return alpha >= 1 ? token : null;
}

function round(alpha) {
  return Math.round(Math.max(0, Math.min(1, alpha)) * 1000) / 1000;
}

function alphaOf(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

// The same tint-of-the-foreground the shell's own components use: a hairline
// rule at 0.12, and a caption dimmed the way PanelSectionHeader dims it
// (Qt.darker(foreground, 1.4)).
function tint(color, alpha) {
  const rgb = toRgb(color);
  return rgb == null ? null : `rgba(${rgb.join(", ")}, ${alpha})`;
}

// A dimmed caption, as PanelSectionHeader has one. The shell darkens the
// foreground; mixing it into the background instead lands in the same place on
// a dark theme and stays dimmer, rather than louder, on a light one.
function dimmed(text, background) {
  const fg = toRgb(text);
  const bg = toRgb(background);
  if (fg == null) return null;
  if (bg == null) return `rgb(${fg.map((channel) => Math.round(channel / 1.4)).join(", ")})`;
  const mixed = fg.map((channel, index) => Math.round(channel * 0.65 + bg[index] * 0.35));
  return `rgb(${mixed.join(", ")})`;
}

function toRgb(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(color ?? "").trim());
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const rgb = /^rgba?\(([^)]+)\)/i.exec(String(color ?? ""));
  if (!rgb) return null;
  const parts = rgb[1].split(",").map((part) => Number(part.trim()));
  return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? parts.slice(0, 3) : null;
}

// Enough INI for kdeglobals: the same shape as the TOML above, so it goes
// through the same parser. What differs is the values — KDE writes colours as
// "r,g,b" rather than as hex.
function kdeColor(value) {
  const parts = String(value ?? "").split(",").map((part) => Number(part.trim()));
  if (parts.length < 3 || !parts.slice(0, 3).every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) return null;
  return `#${parts.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;
}

// KDE's font line is "Family,size,..." with the size in points; archamp's
// chrome is sized in pixels, which at the 96dpi CSS reference is points times
// 4/3.
function kdeFontBase(value) {
  const points = Number(String(value ?? "").split(",")[1]);
  if (!Number.isFinite(points) || points <= 0) return null;
  return Math.round(points * (96 / 72));
}

// Plasma's colour scheme, as the keys archamp's own reader wants. Null where
// there is no kdeglobals to read, so Omarchy stays the first answer and this
// the second.
function readKde() {
  let ini;
  try {
    ini = parseToml(fs.readFileSync(KDE_GLOBALS, "utf8"));
  } catch {
    return null;
  }
  const window = ini["Colors:Window"] ?? {};
  const selection = ini["Colors:Selection"] ?? {};
  const general = ini.General ?? {};
  const background = kdeColor(window.BackgroundNormal);
  const text = kdeColor(window.ForegroundNormal);
  if (background == null || text == null) return null;
  return {
    background,
    text,
    // AccentColor is what Plasma's own settings page calls it; the selection
    // background is what it was before that page existed.
    accent: kdeColor(general.AccentColor) ?? kdeColor(selection.BackgroundNormal),
    fontBase: kdeFontBase(general.font),
  };
}

// The palette archamp draws its own chrome with. Every value falls back on
// its own, so a theme missing a key still themes everything else.
function readTheme() {
  const colors = readFile("colors.toml")?.[""] ?? {};
  const shell = readFile("shell.toml") ?? {};
  // Only where Omarchy has said nothing: its two files are the richer answer,
  // and a machine with both is an Omarchy machine.
  const kde = Object.keys(colors).length === 0 && Object.keys(shell).length === 0 ? readKde() : null;
  if (kde != null) {
    const background = kde.background;
    const text = kde.text;
    const accent = kde.accent ?? FALLBACK.accent;
    return {
      background,
      text,
      accent,
      border: tint(text, 0.12) ?? FALLBACK.rule,
      rule: tint(text, 0.12) ?? FALLBACK.rule,
      fill: tint(text, 0.04) ?? FALLBACK.fill,
      hover: tint(text, 0.08) ?? FALLBACK.hover,
      selected: tint(text, 0.18) ?? FALLBACK.selected,
      dim: dimmed(text, background) ?? FALLBACK.dim,
      fontBase: kde.fontBase ?? FALLBACK.fontBase,
    };
  }
  const menu = shell.menu ?? {};
  const base = colors.background ?? FALLBACK.background;

  const background =
    cssColor(menu.background ?? base, shell, alphaOf(menu["background-alpha"], 1)) ?? FALLBACK.background;
  const text = cssColor(menu.text ?? colors.foreground, shell) ?? FALLBACK.text;
  const accent = cssColor(menu["selected-text"] ?? colors.accent, shell) ?? FALLBACK.accent;
  const selectedFill = cssColor(menu["selected-background"] ?? text, shell, 1);
  const hoverAlpha = alphaOf(menu["selected-background-alpha"], 0.08);

  return {
    background,
    text,
    accent,
    // The card's own edge is the theme's menu border — Omarchy draws it from
    // the Hyprland active-border gradient. Rules inside a menu are
    // PanelSeparator's hairline, which is the foreground at 0.12.
    border: cssColor(menu.border, shell, alphaOf(menu["border-alpha"], 1)) ?? tint(text, 0.12) ?? FALLBACK.rule,
    rule: tint(text, 0.12) ?? FALLBACK.rule,
    fill: tint(selectedFill ?? text, hoverAlpha / 2) ?? FALLBACK.fill,
    hover: tint(selectedFill ?? text, hoverAlpha) ?? FALLBACK.hover,
    selected: tint(selectedFill ?? text, Math.min(1, hoverAlpha * 2.25)) ?? FALLBACK.selected,
    dim: dimmed(text, background) ?? FALLBACK.dim,
    fontBase: Number(shell.font?.["base-size"]) || FALLBACK.fontBase,
  };
}

// Calls back whenever the theme changes. Omarchy swaps themes by repointing
// the `theme` symlink, so the directory holding it is what to watch; a theme
// edited in place shows up as a change to its own files.
function watchTheme(onChange) {
  const debounced = debounce(() => onChange(readTheme()), 150);
  for (const directory of [path.dirname(THEME_DIR), THEME_DIR, path.dirname(KDE_GLOBALS)]) {
    try {
      fs.watch(directory, { persistent: false }, debounced);
    } catch {}
  }
}

function debounce(run, wait) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(run, wait);
  };
}

module.exports = { readTheme, watchTheme, readKde, kdeColor, kdeFontBase };
