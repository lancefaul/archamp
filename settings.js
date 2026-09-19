// The settings main has to know before the player has drawn anything. The
// rest of archamp's preferences — the skin, the equalizer, the zoom — belong
// to the renderer and live in its own storage; these cannot, because they
// decide whether there is a window to draw in at all.
const { app } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULTS = { keepHidden: false, tray: false };

const file = () => path.join(app.getPath("userData"), "settings.json");

let settings = null;

function read() {
  if (settings != null) return settings;
  settings = { ...DEFAULTS };
  try {
    const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof saved?.[key] === typeof DEFAULTS[key]) settings[key] = saved[key];
    }
  } catch {}
  return settings;
}

function write() {
  // Temp file and rename, as the session file does: a player killed mid-write
  // should come back to the last whole answer rather than half of one.
  const target = file();
  const temp = `${target}.tmp`;
  fsp
    .writeFile(temp, JSON.stringify({ version: 1, ...read() }))
    .then(() => fsp.rename(temp, target))
    .catch((error) => console.error(`[archamp] settings: ${error.message}`));
}

const keepHidden = () => read().keepHidden;
const tray = () => read().tray;

function set(key, value) {
  const next = Boolean(value);
  if (read()[key] === next) return false;
  settings[key] = next;
  write();
  return true;
}

const setKeepHidden = (value) => set("keepHidden", value);
const setTray = (value) => set("tray", value);

module.exports = { keepHidden, setKeepHidden, tray, setTray };
