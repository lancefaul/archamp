// The desktop's colours, for archamp's own chrome.
//
// archamp was written on Omarchy and read only Omarchy's theme files, so
// everywhere else it drew its own dark palette — including on somebody's
// light Plasma desktop, where dark menus on a light desktop is not a fallback
// so much as a mistake. KDE is read second, and this is what that reading has
// to get right.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { kdeColor, kdeFontBase } = require("../theme.js");
const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;

test("KDE writes colours as r,g,b and archamp wants hex", () => {
  assert.equal(kdeColor("35,38,41"), "#232629");
  assert.equal(kdeColor("61,174,233"), "#3daee9");
  assert.equal(kdeColor("255,255,255"), "#ffffff");
  assert.equal(kdeColor("0,0,0"), "#000000");
  // Plasma writes a fourth value on some keys; the first three are the colour.
  assert.equal(kdeColor("35,38,41,128"), "#232629");
  assert.equal(kdeColor(" 35 , 38 , 41 "), "#232629");
});

test("anything that is not three channels in range is no colour at all", () => {
  assert.equal(kdeColor("35,38"), null);
  assert.equal(kdeColor("300,0,0"), null);
  assert.equal(kdeColor("-1,0,0"), null);
  assert.equal(kdeColor("red"), null);
  assert.equal(kdeColor(""), null);
  assert.equal(kdeColor(null), null);
  assert.equal(kdeColor(undefined), null);
});

test("KDE sizes its font in points and archamp's chrome in pixels", () => {
  // 96dpi CSS reference: points times 4/3.
  assert.equal(kdeFontBase("Noto Sans,10,-1,5,400,0,0,0,0,0"), 13);
  assert.equal(kdeFontBase("Noto Sans,12,-1,5,50,0,0,0,0,0"), 16);
  assert.equal(kdeFontBase("Noto Sans,9,-1,5,50"), 12);
  assert.equal(kdeFontBase("Noto Sans"), null);
  assert.equal(kdeFontBase("Noto Sans,0,-1"), null);
  assert.equal(kdeFontBase(""), null);
});

// readTheme reads the home directory it was loaded with, so the desktop it
// believes in is set by $HOME.
async function themeWith(files) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "archamp-theme-"));
  try {
    for (const [where, what] of Object.entries(files)) {
      const target = path.join(home, where);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, what);
    }
    const { stdout } = await run(
      process.execPath,
      ["-e", 'console.log(JSON.stringify(require("./theme.js").readTheme()));'],
      { cwd: root, env: { ...process.env, HOME: home } },
    );
    return JSON.parse(stdout);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

const PLASMA_DARK = `[Colors:Window]
BackgroundNormal=35,38,41
ForegroundNormal=252,252,252

[Colors:Selection]
BackgroundNormal=61,174,233

[General]
AccentColor=61,174,233
font=Noto Sans,10,-1,5,400,0,0,0,0,0,0,0,0,0,0,1
`;

const PLASMA_LIGHT = `[Colors:Window]
BackgroundNormal=239,240,241
ForegroundNormal=35,38,41

[General]
AccentColor=61,174,233
font=Noto Sans,11,-1,5,400
`;

test("on Plasma, archamp's chrome is Plasma's colours", async () => {
  const theme = await themeWith({ ".config/kdeglobals": PLASMA_DARK });
  assert.equal(theme.background, "#232629");
  assert.equal(theme.text, "#fcfcfc");
  assert.equal(theme.accent, "#3daee9");
  assert.equal(theme.fontBase, 13);
});

test("a light Plasma theme gives a light archamp, not a dark one", async () => {
  const theme = await themeWith({ ".config/kdeglobals": PLASMA_LIGHT });
  assert.equal(theme.background, "#eff0f1");
  assert.equal(theme.text, "#232629");
  // The dimmed caption has to stay dimmer than the text on a light theme
  // rather than turning into a brighter one.
  const channels = /rgb\((\d+), (\d+), (\d+)\)/.exec(theme.dim);
  assert.ok(channels, `dim was ${theme.dim}`);
  assert.ok(Number(channels[1]) > 0x23, "dim went darker than the text on a light theme");
  assert.ok(Number(channels[1]) < 0xef, "dim reached the background");
});

test("Plasma without an AccentColor falls back on the selection colour", async () => {
  const theme = await themeWith({
    ".config/kdeglobals": `[Colors:Window]
BackgroundNormal=35,38,41
ForegroundNormal=252,252,252

[Colors:Selection]
BackgroundNormal=146,151,156
`,
  });
  assert.equal(theme.accent, "#92979c");
});

test("a kdeglobals with no colours in it is not a theme", async () => {
  const theme = await themeWith({ ".config/kdeglobals": "[General]\nwidgetStyle=Breeze\n" });
  // archamp's own palette, unchanged.
  assert.equal(theme.background, "#14151a");
  assert.equal(theme.text, "#e2e2e6");
});

test("no desktop theme at all is still a theme", async () => {
  const theme = await themeWith({});
  assert.equal(theme.background, "#14151a");
  assert.equal(theme.text, "#e2e2e6");
  assert.equal(theme.accent, "#7aa2f7");
  assert.equal(theme.fontBase, 12);
});

test("Omarchy is answered first where both are there", async () => {
  const theme = await themeWith({
    ".config/kdeglobals": PLASMA_DARK,
    ".local/state/omarchy/current/theme/colors.toml": 'background = "#101010"\nforeground = "#e0e0e0"\naccent = "#ff00ff"\n',
  });
  assert.equal(theme.background, "#101010");
  assert.equal(theme.accent, "#ff00ff");
});
