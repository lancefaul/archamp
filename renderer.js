const { ipcRenderer, webFrame } = require("electron");
const { pathToFileURL, fileURLToPath } = require("url");
const path = require("path");
const fs = require("fs/promises");
const webampModule = require("webamp");
const Webamp = webampModule.default || webampModule;

const WINDOW_SELECTOR =
  "#main-window, #equalizer-window, #playlist-window, #playlist-window-shade, #webamp .gen-window";
// Context menus render outside #webamp; submenus are display: none until hovered.
const MENU_SELECTOR = "#webamp-context-menu ul";
const SCALE_STORAGE_KEY = "archamp.scale";
const SKIN_STORAGE_KEY = "archamp.skin";
// The skin the user picked, museum or file, kept even while the built-in one
// is showing so the menu can offer it back; and which of the two is on.
const CHOSEN_SKIN_KEY = "archamp.chosenSkin";
const DEFAULT_SKIN_KEY = "archamp.usingDefaultSkin";
// The equalizer as it was left, and the preset file it was loaded from.
const EQUALIZER_KEY = "archamp.equalizer";

function tracksFromPaths(filePaths) {
  return filePaths.map((filePath) => ({
    url: pathToFileURL(filePath).href,
    defaultName: path.basename(filePath),
  }));
}

// A track webamp can take from any URL, named after its last path segment
// until its tags load.
function tracksFromUrls(urls) {
  return urls.map((url) => ({ url, defaultName: decodeURIComponent(url.split("/").pop() || url) }));
}

// The playlist as an extended M3U: local tracks as absolute paths, as Winamp
// and every other player writes them, so the file is worth something outside
// archamp. Lengths and names are recorded too, for players that read them.
function playlistM3u(webamp) {
  const state = webamp.store.getState();
  const lines = ["#EXTM3U"];
  for (const id of state.playlist.trackOrder) {
    const track = state.tracks[id];
    if (!track?.url) continue;
    const name = track.title || track.defaultName || "";
    const seconds = Math.round(track.duration ?? 0) || -1;
    lines.push(`#EXTINF:${seconds},${track.artist ? `${track.artist} - ${name}` : name}`);
    lines.push(track.url.startsWith("file:") ? fileURLToPath(track.url) : track.url);
  }
  return `${lines.join("\n")}\n`;
}

// What archamp plays, which is what a file dialog should be offering first.
// Only an offer: a file chosen under "All files" is a deliberate choice, and
// Chromium plays more than this list — .m4b and .mp4 among them. The same
// list main.js filters its own dialogs by and the folder walk uses
// (AUDIO_EXTENSIONS in mpris.js).
const AUDIO_EXTENSIONS = [".mp3", ".flac", ".ogg", ".oga", ".opus", ".wav", ".m4a", ".aac", ".aif", ".aiff"];
// webamp opens the playlist's "Add file" with a bare <input type="file"> and
// no accept, so the dialog offers every file on disk — including the .lrc
// sitting beside every track. The input is never in the document, so there is
// nothing to select: it is caught on the way to being clicked, which is the
// one thing every such input does. A directory picker is left alone, since it
// is not choosing files at all.
function filterWebampFilePickers() {
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === "file" && !this.accept && !this.webkitdirectory) {
      this.accept = AUDIO_EXTENSIONS.join(",");
    }
    return click.apply(this, arguments);
  };
}

async function pickFiles() {
  const filePaths = await ipcRenderer.invoke("open-audio-files");
  return tracksFromPaths(filePaths);
}

function museumSkinUrl(md5) {
  return `museum://skins/${md5}.wsz`;
}

function readSavedSkin() {
  try {
    const md5 = localStorage.getItem(SKIN_STORAGE_KEY);
    return /^[0-9a-f]{32}$/.test(md5 ?? "") ? md5 : null;
  } catch {
    return null;
  }
}

function readStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// The skin the user last chose. A version of archamp before this only
// remembered a museum skin's md5, with no name to show, so one of those comes
// back under a generic name until another is picked.
function readChosenSkin() {
  const chosen = readStored(CHOSEN_SKIN_KEY);
  if (chosen?.kind === "museum" && chosen.md5 === BASE_SKIN_MD5) return null;
  if (chosen?.kind === "museum" && /^[0-9a-f]{32}$/.test(chosen.md5 ?? "")) return chosen;
  if (chosen?.kind === "file" && typeof chosen.path === "string") return chosen;
  const md5 = readSavedSkin();
  return md5 == null ? null : { kind: "museum", md5, name: "Museum skin" };
}

function skinUrl(skin) {
  return skin.kind === "museum" ? museumSkinUrl(skin.md5) : pathToFileURL(skin.path).href;
}

// A skin file's own name, tidied the way the museum browser tidies its own.
function skinFileName(file) {
  return path.basename(file).replace(/\.(wsz|zip)$/i, "").replace(/_/g, " ");
}

// Tracks which skin the player shows, so it comes back next launch, the menu
// can offer it beside the built-in one, and the skin browser can highlight
// it. webamp has no skin-change event, so this watches its store actions:
// call `expect` before loading a chosen skin; the built-in skin landing on
// its own clears it.
function createSkinTracker(chosen, startingDefault) {
  let expected = null;
  let usingDefault = startingDefault;
  let current = chosen;
  let landings = [];
  const landed = () => {
    const waiting = landings;
    landings = [];
    for (const resolve of waiting) resolve();
  };
  const report = (skin) => {
    const md5 = skin?.kind === "museum" ? skin.md5 : null;
    try {
      if (md5) localStorage.setItem(SKIN_STORAGE_KEY, md5);
      else localStorage.removeItem(SKIN_STORAGE_KEY);
    } catch {}
    writeStored(DEFAULT_SKIN_KEY, usingDefault);
    if (skin != null) writeStored(CHOSEN_SKIN_KEY, skin);
    // The built-in skin is the museum's base-2.91, so the browser can mark it
    // as the one in effect like any other.
    const shown = usingDefault ? { md5: BASE_SKIN_MD5, name: BASE_SKIN_NAME } : skin;
    ipcRenderer.send(
      "museum:skin-changed",
      shown?.kind === "file" ? null : (shown?.md5 ?? null),
      shown?.name ?? "",
    );
  };
  return {
    expect(skin) {
      expected = skin;
      usingDefault = false;
    },
    isDefault: () => usingDefault,
    chosen: () => current,
    // Starting on the built-in skin is not something webamp announces — there
    // is nothing to load — so the state is said out loud once at startup, or
    // the skin browser opens not knowing what the player is wearing.
    announce() {
      report(usingDefault ? null : current);
    },
    // Resolves when the next skin lands, whether it loaded or failed.
    landed() {
      return new Promise((resolve) => {
        landings.push(resolve);
      });
    },
    middleware: () => (next) => (action) => {
      if (action.type === "SET_SKIN_DATA") {
        if (expected != null) current = expected;
        report(expected);
        expected = null;
        landed();
      } else if (action.type === "LOAD_DEFAULT_SKIN") {
        expected = null;
        usingDefault = true;
        report(null);
      } else if (action.type === "LOADED" && expected) {
        // webamp finishes loading without skin data when a skin fails, and
        // shows its own skin instead.
        ipcRenderer.send("museum:skin-failed", expected.kind === "museum" ? expected.md5 : null);
        expected = null;
        usingDefault = true;
        report(null);
        landed();
      }
      return next(action);
    },
  };
}

// Winamp skins are pixel art, so the player's size is a whole number of screen
// pixels per skin pixel (its "scale"), which keeps every skin pixel the same
// size. Chromium already applies the desktop's UI scaling; the page zoom makes
// up the rest.

// devicePixelRatio / getZoomFactor() would normally recover this, but on a
// fractional-scale Wayland output (Hyprland included) the compositor can
// deliver the display's real scale in more than one step (an initial integer
// buffer_scale, then a fractional-scale-v1 correction). Each step fires our
// own zoom change, which briefly makes devicePixelRatio and getZoomFactor()
// mutually consistent at a *wrong* value — self-consistent, so nothing ever
// corrects it again, and the window settles at the right pixel density but
// the wrong physical size (clipping the equalizer/playlist on this monitor's
// 1.333x scale: computed ~522px wide instead of the ~619px actually needed).
// Asking the main process for the display's scale factor directly sidesteps
// that race entirely.
let trueScale = 1;

async function refreshTrueScale() {
  trueScale = await ipcRenderer.invoke("display-scale-factor");
}

function systemScale() {
  return trueScale;
}

// About Winamp's own double size, snapped to whole screen pixels.
function defaultScaleLevel() {
  return Math.max(1, Math.round(2 * systemScale()));
}

function readSavedScaleLevel() {
  try {
    const level = Number(localStorage.getItem(SCALE_STORAGE_KEY));
    return Number.isInteger(level) && level >= 1 ? level : null;
  } catch {
    return null;
  }
}

// null means "follow the default", which tracks the display's UI scaling.
let savedScaleLevel = readSavedScaleLevel();

function scaleLevel() {
  return savedScaleLevel ?? defaultScaleLevel();
}

function applyScale() {
  const zoom = scaleLevel() / systemScale();
  // Skip float-noise changes, which would otherwise re-trigger watchDisplayScale.
  if (Math.abs(zoom - webFrame.getZoomFactor()) > 1e-3) {
    webFrame.setZoomFactor(zoom);
  }
}

function setScaleLevel(level) {
  savedScaleLevel = level;
  try {
    if (level == null) {
      localStorage.removeItem(SCALE_STORAGE_KEY);
    } else {
      localStorage.setItem(SCALE_STORAGE_KEY, String(level));
    }
  } catch {}
  applyScale();
}

// The largest scale at which the player, as currently laid out, fits on screen.
async function maxScaleLevel() {
  const content = farEdges(document.querySelectorAll(WINDOW_SELECTOR));
  if (content == null) return scaleLevel();
  const area = await ipcRenderer.invoke("work-area");
  const pixels = systemScale();
  const fit = Math.min((area.width * pixels) / content.right, (area.height * pixels) / content.bottom);
  // The tolerance keeps float noise from rejecting an exact fit.
  return Math.floor(fit + 1e-6);
}

async function stepScale(delta) {
  const next = scaleLevel() + delta;
  if (next < 1) return;
  if (delta > 0 && next > (await maxScaleLevel())) return;
  setScaleLevel(next);
}

// The window can move to a display with a different scale. devicePixelRatio
// includes our own zoom, so this also fires for scale changes we caused
// ourselves, where re-fetching trueScale and re-applying is a no-op.
function watchDisplayScale() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    "change",
    async () => {
      await refreshTrueScale();
      applyScale();
      watchDisplayScale();
    },
    { once: true },
  );
}

function installScaleControls() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === "=" || e.key === "+") stepScale(1);
      else if (e.key === "-" || e.key === "_") stepScale(-1);
      else if (e.key === "0") setScaleLevel(null);
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  let wheelDelta = 0;
  window.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      // Without this, scrolling over the main window would also change the volume.
      e.preventDefault();
      e.stopPropagation();
      // deltaY is in CSS pixels, which shrink as the zoom grows; undo that so a
      // wheel notch counts the same at every scale.
      wheelDelta += e.deltaY * webFrame.getZoomFactor();
      if (Math.abs(wheelDelta) < 50) return;
      stepScale(wheelDelta < 0 ? 1 : -1);
      wheelDelta = 0;
    },
    { capture: true, passive: false },
  );
}

function farEdges(elements) {
  let edges = null;
  for (const el of elements) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    edges = {
      right: Math.max(edges?.right ?? 0, r.right),
      bottom: Math.max(edges?.bottom ?? 0, r.bottom),
    };
  }
  return edges;
}

// The fixed vertical order archamp shows its windows in. In-page dragging and
// resizing are both switched off (see blockInPageDragging), so this is the
// only arrangement they're ever in.
const WINDOW_ORDER = ["main", "equalizer", "playlist"];

// Stacks the open windows directly on top of one another, in WINDOW_ORDER,
// starting topOffset pixels down from the page's top-left corner (0 normally;
// see layoutMenu for the one case that isn't). Returns whether
// anything moved. webamp has no public API for window positions, so this
// dispatches the same action its own drag code uses.
//
// webamp only ever removes a closed window from the layout; it leaves the
// others exactly where they were, which is fine for its own free-floating
// windows but leaves a closed window's worth of empty space in archamp's one
// fitted frame (e.g. closing the equalizer but not the playlist). Closed
// windows are simply skipped here, so the rest always sit gap-free.
function moveWindowsToOrigin(webamp, topOffset = 0) {
  const { genWindows } = webamp.store.getState().windows;
  const open = WINDOW_ORDER.filter((id) => genWindows[id]?.open);
  if (open.length === 0) return false;
  const positions = {};
  let y = topOffset;
  for (const id of open) {
    positions[id] = { x: 0, y };
    y += document.getElementById(`${id}-window`)?.getBoundingClientRect().height ?? 0;
  }
  const unchanged = open.every((id) => {
    const { x, y } = genWindows[id].position;
    return x === positions[id].x && y === positions[id].y;
  });
  if (unchanged) return false;
  webamp.store.dispatch({ type: "UPDATE_WINDOW_POSITIONS", positions, absolute: true });
  return true;
}

// The title bar's button (the small icon at its far left) opens the Winamp
// menu. webamp's own is a browser menu of submenus, and most of it repeats
// buttons the player already shows — the window toggles, repeat and shuffle,
// the transport — while burying files and skins two levels down. archamp
// replaces it with its own: files, skins, and the way out, flattened.
//
// It is pinned to the player's full width and grows upward from the title
// bar. Wayland won't let archamp move its own window to make room above the
// title bar's current screen position (see keepWindowFitted), so "upward"
// means: the window grows as it always does (from its current top-left
// corner, downward), and the player itself shifts down by the menu's height
// to make room for the menu at the window's actual top. The title bar visibly
// shifts down on screen while the menu is open; there's no way around that.
// ------------------------------------------------------------- equalizer
// Winamp's own presets, as webamp carries them: a value per band in the
// order the equalizer's sliders run, with the preamp last, on the scale
// Winamp's .eqf files use — 1 at the bottom of the slider, 64 at the top.
const EQ_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
const EQ_PRESETS = [
  { name: "Classical", bands: [33, 33, 33, 33, 33, 33, 20, 20, 20, 16, 33] },
  { name: "Club", bands: [33, 33, 38, 42, 42, 42, 38, 33, 33, 33, 33] },
  { name: "Dance", bands: [48, 44, 36, 32, 32, 22, 20, 20, 32, 32, 33] },
  { name: "Laptop speakers/headphones", bands: [40, 50, 41, 26, 28, 35, 40, 48, 53, 56, 33] },
  { name: "Large hall", bands: [49, 49, 42, 42, 33, 24, 24, 24, 33, 33, 33] },
  { name: "Party", bands: [44, 44, 33, 33, 33, 33, 33, 33, 44, 44, 33] },
  { name: "Pop", bands: [29, 40, 44, 45, 41, 30, 28, 28, 29, 29, 33] },
  { name: "Reggae", bands: [33, 33, 31, 22, 33, 43, 43, 33, 33, 33, 33] },
  { name: "Rock", bands: [45, 40, 23, 19, 26, 39, 47, 50, 50, 50, 33] },
  { name: "Soft", bands: [40, 35, 30, 28, 30, 39, 46, 48, 50, 52, 33] },
  { name: "Ska", bands: [28, 24, 25, 31, 39, 42, 47, 48, 50, 48, 33] },
  { name: "Full Bass", bands: [48, 48, 48, 42, 35, 25, 18, 15, 14, 14, 33] },
  { name: "Soft Rock", bands: [39, 39, 36, 31, 25, 23, 26, 31, 37, 47, 33] },
  { name: "Full Treble", bands: [16, 16, 16, 25, 37, 50, 58, 58, 58, 60, 33] },
  { name: "Full Bass & Treble", bands: [44, 42, 33, 20, 24, 35, 46, 50, 52, 52, 33] },
  { name: "Live", bands: [24, 33, 39, 41, 42, 42, 39, 37, 37, 36, 33] },
  { name: "Techno", bands: [45, 42, 33, 23, 24, 33, 45, 48, 48, 47, 33] },
];
// What Winamp writes at the head of an .eqf, and the name it gives the one
// preset saving the equalizer produces.
const EQF_HEADER = "Winamp EQ library file v1.1";
const EQF_ENTRY_NAME = "Entry1";
const EQF_NAME_BYTES = 257;

// eqf 1..64 to the slider's own 0..100 and back, the way webamp converts
// them, including its snap of anything near the middle to dead centre.
function fromEqf(value) {
  const slider = ((value - 1) / 63) * 100;
  const clamped = Math.max(0, Math.min(100, slider));
  return clamped > 45 && clamped < 55 ? 50 : clamped;
}

function toEqf(slider) {
  return Math.max(1, Math.min(64, Math.round(1 + (slider / 100) * 63)));
}

// The equalizer as it stands, in eqf values, for writing to a file or keeping
// between sessions.
function currentEqf(webamp) {
  return currentSliders(webamp).map(toEqf);
}

// And as the sliders themselves, which is where presets are compared: webamp
// snaps any band near the middle to dead centre, so two different file values
// can be the very same setting, and only the sliders say so.
function currentSliders(webamp) {
  const sliders = webamp.store.getState().equalizer.sliders;
  return [...EQ_BANDS.map((band) => sliders[band]), sliders.preamp];
}

function isCurrentEq(sliders, bands) {
  return (
    bands.length === sliders.length &&
    bands.every((value, index) => Math.abs(fromEqf(value) - sliders[index]) < 0.5)
  );
}

// Every band and the preamp at dead centre: no boost, no cut.
function resetEq(webamp) {
  for (const band of [...EQ_BANDS, "preamp"]) {
    webamp.store.dispatch({ type: "SET_BAND_VALUE", band, value: 50 });
  }
}

function applyEqf(webamp, values) {
  EQ_BANDS.forEach((band, index) => {
    webamp.store.dispatch({ type: "SET_BAND_VALUE", band, value: fromEqf(values[index]) });
  });
  webamp.store.dispatch({ type: "SET_BAND_VALUE", band: "preamp", value: fromEqf(values[EQ_BANDS.length]) });
}

// An .eqf holds one or more named presets; loading one takes the first, as
// Winamp does when a file is dropped on the equalizer. A byte is 64 minus the
// value, since the file counts down from the top of the slider.
function eqfValues(bytes) {
  const header = EQF_HEADER.length + 1 + 3;
  if (bytes.length < header + EQF_NAME_BYTES + EQ_BANDS.length + 1) return null;
  if (new TextDecoder().decode(bytes.slice(0, EQF_HEADER.length)) !== EQF_HEADER) return null;
  const start = header + EQF_NAME_BYTES;
  return [...bytes.slice(start, start + EQ_BANDS.length + 1)].map((byte) => 64 - byte);
}

function eqfFile(name, values) {
  const bytes = [...`${EQF_HEADER}\u001a!--`].map((character) => character.charCodeAt(0));
  for (let i = 0; i < EQF_NAME_BYTES; i++) bytes.push(i < name.length ? name.charCodeAt(i) : 0);
  for (const value of values) bytes.push(64 - value);
  return Buffer.from(bytes);
}

// The equalizer runs -12dB to +12dB, and webamp's sliders run 0 to 100 over
// exactly that span (its own conversion is `db = value / 100 * 24 - 12`), so
// the two are one multiplication apart. dB is what goes on the bus: it is the
// number Winamp's own equalizer is labelled in, and it needs no explaining.
const EQ_MIN_DB = -12;
const EQ_MAX_DB = 12;
const sliderToDb = (slider) => (slider / 100) * 24 - 12;
const dbToSlider = (db) => Math.max(0, Math.min(100, ((Number(db) || 0) + 12) / 24 * 100));

async function loadEqfFile(webamp, file) {
  let values = null;
  try {
    values = eqfValues(await fs.readFile(file));
  } catch (error) {
    console.error(`equalizer file: ${error.message}`);
  }
  if (values == null) return false;
  // The file joins the presets, at the top where Winamp's own list ends up
  // below it, and comes back next launch.
  writeStored(EQUALIZER_KEY, {
    ...(readStored(EQUALIZER_KEY) ?? {}),
    eqf: { name: path.basename(file).replace(/\.[^.]+$/, ""), bands: values },
  });
  applyEqf(webamp, values);
  return true;
}

async function loadEqf(webamp) {
  const file = await ipcRenderer.invoke("open-equalizer");
  if (file == null) return;
  if (!(await loadEqfFile(webamp, file))) {
    ipcRenderer.send("show-error", "Load equalizer file", `${file} is not a Winamp equalizer file.`);
  }
}

// The equalizer as the user left it, restored on the next launch, along with
// the preset file they loaded, so the menu still offers it.
function readLoadedEqf() {
  const eqf = readStored(EQUALIZER_KEY)?.eqf;
  return typeof eqf?.name === "string" && Array.isArray(eqf.bands) && eqf.bands.length === EQ_BANDS.length + 1
    ? eqf
    : null;
}

// What archamp was playing, so it comes back to it. Saved as the player runs
// and restored at launch, paused: a player that forgets everything it was
// doing is no use after a reboot, and the plugin has nothing to show until
// something is loaded.
function sessionSnapshot(webamp) {
  const state = webamp.store.getState();
  const { trackOrder, currentTrack } = state.playlist;
  const tracks = trackOrder.map((id) => state.tracks[id]?.url).filter(Boolean);
  if (tracks.length === 0) return null;
  return {
    version: 1,
    tracks,
    current: Math.max(0, trackOrder.indexOf(currentTrack)),
    position: Math.max(0, Math.round(state.media.timeElapsed ?? 0)),
    volume: Math.round(state.media.volume ?? 100),
    shuffle: Boolean(state.media.shuffle),
    repeat: Boolean(state.media.repeat),
  };
}

// Kept in a file of its own rather than in localStorage: the browser flushes
// that when it feels like it, and a player killed rather than closed — a
// reboot, a crash — would come back to whatever had last reached the disk,
// which in testing was twenty minutes stale.
async function readSession() {
  const saved = await ipcRenderer.invoke("session:load");
  if (saved?.version !== 1 || !Array.isArray(saved.tracks) || saved.tracks.length === 0) return null;
  return saved.tracks.every((url) => typeof url === "string") ? saved : null;
}

function watchSession(webamp) {
  let last = null;
  let changed = false;
  const save = () => {
    changed = false;
    const snapshot = sessionSnapshot(webamp);
    const json = JSON.stringify(snapshot);
    if (json === last) return;
    last = json;
    ipcRenderer.send("session:save", snapshot);
  };
  // On a timer rather than after the last change: the time elapsed lands in
  // the store every few frames while a track plays, so waiting for the
  // changes to stop means waiting for the music to stop.
  webamp.store.subscribe(() => {
    changed = true;
  });
  setInterval(() => {
    if (changed) save();
  }, 2000);
  // Quitting saves first, however little has happened since the last write.
  window.addEventListener("beforeunload", save);
}

// Waits for a track to say how long it is, which is when it can be seeked.
function trackLength(webamp, id, within = 5000) {
  const deadline = performance.now() + within;
  return new Promise((resolve) => {
    const check = () => {
      const length = webamp.store.getState().tracks[id]?.duration ?? 0;
      if (length > 0 || performance.now() > deadline) resolve(length);
      else setTimeout(check, 100);
    };
    check();
  });
}

// A restored session is a player paused where it left off: the track is
// loaded at its old position and one press carries on from there. webamp has
// no such state — it readies a track without playing it, and calls that
// stopped — so archamp says which it is, until the player leaves it.
let resumable = false;

async function restoreSession(webamp) {
  const saved = await readSession();
  if (saved == null) return;
  webamp.appendTracks(tracksFromUrls(saved.tracks));
  webamp.setVolume(Math.min(100, Math.max(0, saved.volume)));
  if (webamp.isShuffleEnabled() !== saved.shuffle) webamp.toggleShuffle();
  if (webamp.isRepeatEnabled() !== saved.repeat) webamp.toggleRepeat();

  const { trackOrder } = webamp.store.getState().playlist;
  const id = trackOrder[Math.min(saved.current, trackOrder.length - 1)];
  if (id == null) return;
  // Readied rather than played: archamp comes back showing what it was on,
  // and one press carries on from where it stopped.
  webamp.store.dispatch({ type: "BUFFER_TRACK", id });
  if (saved.position <= 0) return;
  const length = await trackLength(webamp, id);
  if (length > saved.position) {
    webamp.seekToTime(saved.position);
    resumable = true;
  }
}

function restoreEqualizer(webamp) {
  const saved = readStored(EQUALIZER_KEY);
  if (Array.isArray(saved?.bands) && saved.bands.length === EQ_BANDS.length + 1) applyEqf(webamp, saved.bands);
  // Whether the equalizer is on is as much a setting as where its bands are:
  // turning it off and finding it on again next time is nobody's intent. The
  // bands are remembered either way, so switching it back on brings back what
  // was set rather than a flat one.
  if (typeof saved?.on === "boolean") {
    webamp.store.dispatch({ type: saved.on ? "SET_EQ_ON" : "SET_EQ_OFF" });
  }
  if (typeof saved?.auto === "boolean") {
    webamp.store.dispatch({ type: "SET_EQ_AUTO", value: saved.auto });
  }
  let last = null;
  let pending = null;
  webamp.store.subscribe(() => {
    const { on, auto } = webamp.store.getState().equalizer;
    const json = JSON.stringify({ bands: currentEqf(webamp), on: Boolean(on), auto: Boolean(auto) });
    if (json === last) return;
    last = json;
    // A slider being dragged fires all the way; write once it settles.
    clearTimeout(pending);
    pending = setTimeout(() => {
      writeStored(EQUALIZER_KEY, { ...(readStored(EQUALIZER_KEY) ?? {}), ...JSON.parse(json) });
    }, 400);
  });
}

async function saveEqf(webamp) {
  const file = await ipcRenderer.invoke("save-equalizer");
  if (file == null) return;
  try {
    await fs.writeFile(file, eqfFile(EQF_ENTRY_NAME, currentEqf(webamp)));
  } catch (error) {
    ipcRenderer.send("show-error", "Save equalizer", `${file} could not be written: ${error.message}`);
  }
}

const MENU_ID = "archamp-menu";
const PRESETS_ID = "archamp-presets";
const FILE_INFO_ID = "archamp-file-info";
const NOTICE_ID = "archamp-notice";
// webamp's built-in skin, which is Winamp's own last classic one. The museum
// carries it too, as base-2.91.wsz — picking it there is picking the built-in
// skin, not a skin of one's own.
const BASE_SKIN_NAME = "Winamp 2.91";
const BASE_SKIN_MD5 = "5e4f10275dcb1fb211d4a8b4f1bda236";

// ------------------------------------------------------------------ updates
//
// The one row in any of archamp's menus that changes while the menu is open:
// it spins while it asks GitHub, then says what it found and goes back to
// resting. A newer archamp opens a window of its own (see updater.js).
const UPDATE_RESULT_MS = 5000;

let updateRow = { phase: "idle", checkedAt: 0, installed: "", error: null };
let updateRowTimer = null;

// When it last looked, in words. A menu is read at a glance, so recent checks
// are relative and older ones are dated.
function lastCheckedLabel(at) {
  if (!at) return "Not checked yet";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "Checked just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Checked ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const when = new Date(at);
  return `Checked ${when.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

function updateItem() {
  if (updateRow.phase === "checking") {
    return { label: "Checking for updates...", note: "Asking GitHub", busy: true };
  }
  if (updateRow.phase === "current") {
    return { label: `You are on the latest version (${updateRow.installed})`, checked: true, wrap: true };
  }
  if (updateRow.phase === "error") {
    return { label: "Could not check for updates", note: updateRow.error, wrap: true };
  }
  return {
    label: "Check for updates...",
    note: lastCheckedLabel(updateRow.checkedAt),
    // The menu stays up: the answer lands in this row.
    keepOpen: true,
    run: checkForUpdates,
  };
}

async function checkForUpdates() {
  if (updateRow.phase !== "idle") return;
  clearTimeout(updateRowTimer);
  updateRow = { ...updateRow, phase: "checking" };
  refreshMenu();
  const found = await ipcRenderer.invoke("update:check");
  updateRow = { ...updateRow, checkedAt: found.checkedAt, installed: found.installed };
  if (found.available) {
    // The window is up and has the whole story; the menu has nothing to add.
    updateRow = { ...updateRow, phase: "idle", error: null };
    closeOverlays();
    return;
  }
  updateRow = found.error
    ? { ...updateRow, phase: "error", error: found.error }
    : { ...updateRow, phase: "current", error: null };
  refreshMenu();
  // Long enough to read, then back to the row that offers another look.
  updateRowTimer = setTimeout(() => {
    updateRow = { ...updateRow, phase: "idle", error: null };
    refreshMenu();
  }, UPDATE_RESULT_MS);
}

function menuSections(webamp, skinTracker) {
  const chosen = skinTracker.chosen();
  return [
    {
      title: "ARCHAMP",
      items: [updateItem(), { label: "About...", run: () => ipcRenderer.send("about:open") }],
    },
    {
      title: "FILES",
      items: [
        {
          label: "Open File...",
          run: async () => {
            const tracks = await pickFiles();
            if (tracks.length > 0) webamp.setTracksToPlay(tracks);
          },
        },
        {
          label: "Open Folder...",
          run: async () => {
            const urls = await ipcRenderer.invoke("open-folder");
            if (urls?.length) webamp.setTracksToPlay(tracksFromUrls(urls));
          },
        },
      ],
    },
    {
      title: "SKINS",
      items: [
        {
          label: `${BASE_SKIN_NAME} (Default)`,
          checked: skinTracker.isDefault(),
          run: () => webamp.store.dispatch({ type: "LOAD_DEFAULT_SKIN" }),
        },
        // The skin the user chose, museum or file, so it is one press away
        // again after a look at the built-in one.
        ...(chosen == null
          ? []
          : [
              {
                label: chosen.name,
                checked: !skinTracker.isDefault(),
                run: () => {
                  skinTracker.expect(chosen);
                  webamp.setSkinFromUrl(skinUrl(chosen));
                },
              },
            ]),
        { label: "Browse Winamp Skin Museum...", run: openSkinBrowser },
        {
          label: "Load Custom Skin...",
          run: async () => {
            const file = await ipcRenderer.invoke("open-skin");
            if (file == null) return;
            skinTracker.expect({ kind: "file", path: file, name: skinFileName(file) });
            webamp.setSkinFromUrl(pathToFileURL(file).href);
          },
        },
      ],
    },
    {
      title: "WINDOW",
      items: [
        {
          // The same choice OMedia Controls offers, so archamp works the same
          // way without it. Turning it on takes the window away now as well as
          // next time; main asks first, since nothing left on screen could
          // bring it back.
          label: "Keep hidden",
          checked: Boolean(windowStatus?.keepHidden),
          run: async () => {
            windowStatus = await ipcRenderer.invoke("keep-hidden", !windowStatus?.keepHidden);
          },
        },
        {
          // Not "run in tray": archamp runs the same either way, and closing
          // it still quits. What this does is put the icon there, and with it
          // a way back to a window that has been hidden.
          //
          // Where the desktop has no tray to put it in — a stock GNOME, which
          // has had no StatusNotifierItem support since Shell 3.26 — the row
          // says so instead of switching on something that would never
          // appear. See trayhost.js.
          label: "Show in tray",
          // No run at all where there is no tray: the row goes inert and says
          // why, rather than offering a switch that could not do anything.
          note: windowStatus?.trayHost === false ? "This desktop has no system tray" : undefined,
          checked: Boolean(windowStatus?.tray) && windowStatus?.trayHost !== false,
          run: windowStatus?.trayHost === false ? undefined : async () => {
            windowStatus = await ipcRenderer.invoke("run-in-tray", !windowStatus?.tray);
          },
        },
      ],
    },
    {
      items: [
        // Only while there is something to add: an AppImage installs nothing
        // of itself, and archamp has to be an installed app for a launcher or
        // the plugin to start it (see desktop.js).
        ...(desktopStatus?.appImage && !desktopStatus.integrated
          ? [
              {
                label: "Add to Applications...",
                run: async () => {
                  desktopStatus = await ipcRenderer.invoke("add-to-applications");
                },
              },
            ]
          : []),
        // Not webamp.close(): that is the player's close button, and with a
        // tray icon that only puts archamp away. This is the way out.
        { label: "Close archamp", run: () => ipcRenderer.send("quit-app") },
      ],
    },
  ];
}

// Whether archamp is an installed app, as the main process last saw it.
let desktopStatus = null;

// Whether the window is meant to be hidden, as the main process last saw it.
let windowStatus = null;

// The equalizer's presets, flat: webamp hides all of them behind a Load
// submenu, and there is nothing else in that menu to hide them from.
function presetSections(webamp) {
  const sliders = currentSliders(webamp);
  const loaded = readLoadedEqf();
  return [
    { title: "EQUALIZER PRESETS", items: [] },
    { items: [{ label: "Reset", run: () => resetEq(webamp) }] },
    {
      // Seventeen presets would make a drawer taller than the player, so the
      // list is the only part that scrolls and the two file entries stay in
      // view at the foot.
      scroll: true,
      items: [...(loaded == null ? [] : [loaded]), ...EQ_PRESETS].map((preset) => ({
        label: preset.name,
        checked: isCurrentEq(sliders, preset.bands),
        run: () => applyEqf(webamp, preset.bands),
      })),
    },
    {
      items: [
        { label: "Load equalizer file (.eqf)...", run: () => loadEqf(webamp) },
        { label: "Save equalizer...", run: () => saveEqf(webamp) },
      ],
    },
  ];
}

// What the playlist's File Info button shows: the track the user has
// selected, or the one playing. webamp's own answer is an alert saying it
// isn't supported.
function fileInfoTrack(webamp) {
  const state = webamp.store.getState();
  const selected = state.playlist.selectedTracks ?? [];
  const id = selected.length > 0 ? selected[0] : state.playlist.currentTrack;
  return state.tracks[id] ?? null;
}

function secondsAsClock(seconds) {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function fileSize(bytes) {
  if (!(bytes > 0)) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function fileInfoSections(track, info, expanded) {
  const facts = (pairs) =>
    pairs
      .filter(([, value]) => value !== "" && value != null && value !== 0)
      // Alphabetical: with this many details and no order of importance
      // between them, the only useful order is the one you can look things up
      // in.
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, value]) => ({ label, value: String(value) }));
  const tags = info?.tags ?? {};
  const format = info?.format ?? {};
  const title = tags.title || track?.title || track?.defaultName || "";
  const heading = {
    heading: [title, tags.artist || track?.artist || "", tags.album || track?.album || ""],
    close: () => closeFileInfo(),
  };
  if (info?.error != null) {
    return [{ items: [heading] }, { items: facts([["Problem", info.error]]) }];
  }
  // The cover gets the width of the drawer. Under it, where the track sits on
  // its record — which is what anyone opening this wants first — and the rest
  // of the file's facts behind a line, until they are asked for.
  const artwork = info?.art ? [{ items: [{ art: info.art }] }] : [];
  const channels = { 1: "mono", 2: "stereo" }[format.channels] ?? (format.channels ? `${format.channels} channels` : "");
  const details = facts([
    ["Bitrate", format.bitrate ? `${Math.round(format.bitrate / 1000)} kbps` : ""],
    ["Channels", channels],
    ["Codec", format.codec ? `${format.codec}${format.lossless ? " (lossless)" : ""}` : ""],
    ["Folder", info?.folder],
    ["Genre", tags.genre],
    ["Length", format.duration ? secondsAsClock(format.duration) : ""],
    ["Sample rate", format.sampleRate ? `${(format.sampleRate / 1000).toFixed(1)} kHz` : ""],
    ["Size", fileSize(info?.size)],
    ["Year", tags.year],
  ]);
  return [
    { items: [heading] },
    ...artwork,
    {
      items: [
        {
          summary: [tags.disc ? `Disc ${tags.disc}` : "", tags.track ? `Track ${tags.track}` : ""].filter(Boolean),
          action: {
            label: expanded ? "Show less" : "Show more",
            run: () => showFileInfo(null, !expanded),
          },
        },
      ],
    },
    ...(expanded ? [{ scroll: 5.5, items: details }] : []),
  ];
}

// The last file asked about, so opening and closing the details doesn't send
// archamp back to the disk for them.
let fileInfoShown = null;

async function showFileInfo(webamp, expanded = false) {
  closeFileInfo();
  if (webamp != null) {
    const track = fileInfoTrack(webamp);
    const url = track?.url ?? "";
    const info = url.startsWith("file:")
      ? await ipcRenderer.invoke("file-info", fileURLToPath(url))
      : { error: url ? "Not a file on this machine." : "Nothing is loaded." };
    fileInfoShown = { track, info };
  }
  if (fileInfoShown == null) return;
  openDrawer(FILE_INFO_ID, fileInfoSections(fileInfoShown.track, fileInfoShown.info, expanded));
}

// A line saying what just happened, for the things that happen out of sight:
// tracks swept out of the playlist because their files are gone.
function showNotice(text) {
  openDrawer(NOTICE_ID, [
    { items: [{ heading: [text], close: () => closeNotice() }] },
  ]);
}

function closeNotice() {
  const notice = document.getElementById(NOTICE_ID);
  if (notice == null) return;
  notice.remove();
  refit();
}

// Winamp's "remove missing files", which webamp answers with an alert saying
// it isn't supported. A playlist outlives the files in it — a disk unplugged,
// a folder moved — and this is how it is tidied.
async function removeMissingTracks(webamp) {
  const state = webamp.store.getState();
  const files = [];
  for (const id of state.playlist.trackOrder) {
    const url = state.tracks[id]?.url ?? "";
    if (!url.startsWith("file:")) continue;
    try {
      files.push({ id, file: fileURLToPath(url) });
    } catch {}
  }
  const missing = new Set(await ipcRenderer.invoke("missing-files", files.map((track) => track.file)));
  const ids = files.filter((track) => missing.has(track.file)).map((track) => track.id);
  if (ids.length === 0) {
    showNotice("Nothing is missing.");
    return;
  }
  webamp.store.dispatch({ type: "REMOVE_TRACKS", ids });
  showNotice(`Removed ${ids.length} missing ${ids.length === 1 ? "track" : "tracks"}.`);
}

function installRemoveMissing(webamp) {
  // Same as File Info: webamp's answer is a blocking alert, so the press is
  // caught before it gets there.
  for (const type of ["mousedown", "click"]) {
    document.addEventListener(
      type,
      (e) => {
        if (!(e.target instanceof Element) || e.target.closest(".remove-misc") == null) return;
        e.stopPropagation();
        e.preventDefault();
        if (type === "mousedown") removeMissingTracks(webamp);
      },
      true,
    );
  }
}

function closeFileInfo() {
  const drawer = document.getElementById(FILE_INFO_ID);
  if (drawer == null) return;
  drawer.remove();
  refit();
}

function installFileInfo(webamp) {
  // webamp answers this button with an alert saying it isn't supported, and
  // an alert in Electron blocks everything until it is dismissed.
  for (const type of ["mousedown", "click"]) {
    document.addEventListener(
      type,
      (e) => {
        if (!(e.target instanceof Element) || e.target.closest(".file-info") == null) return;
        e.stopPropagation();
        e.preventDefault();
        if (type === "mousedown") showFileInfo(webamp);
      },
      true,
    );
  }
}

function renderMenu(id, sections) {
  const root = document.createElement("div");
  root.id = id;
  // The same markup webamp's menus use, so they share one stylesheet.
  const list = document.createElement("ul");
  list.className = "context-menu";
  sections.forEach((section, index) => {
    if (index > 0) list.appendChild(menuRule());
    if (section.title) list.appendChild(menuTitle(section.title));
    let rows = list;
    if (section.scroll) {
      const scroller = document.createElement("li");
      scroller.className = "scroll";
      // Half a row over the ones that fit, so it is plain that there is more
      // below rather than the list looking like it ends there.
      if (typeof section.scroll === "number") {
        // The stylesheet's cap is !important, so this has to be too.
        scroller.style.setProperty("max-height", rem(ROW_HEIGHT * section.scroll), "important");
      }
      rows = document.createElement("ul");
      scroller.appendChild(rows);
      list.appendChild(scroller);
    }
    for (const item of section.items) {
      const li = document.createElement("li");
      if (item.heading != null) {
        li.className = "head";
        const lines = document.createElement("div");
        lines.className = "lines";
        item.heading.filter(Boolean).forEach((text, index) => {
          const line = document.createElement("span");
          if (index === 0) line.className = "first";
          line.textContent = text;
          line.title = text;
          lines.appendChild(line);
        });
        const close = document.createElement("button");
        close.className = "close";
        close.type = "button";
        close.title = "Close";
        // Omarchy's own close glyph, as the plugin uses it.
        close.textContent = String.fromCodePoint(0xf0156);
        close.addEventListener("click", item.close);
        li.append(lines, close);

        rows.appendChild(li);
        continue;
      }
      if (item.summary != null) {
        li.className = "summary";
        const where = document.createElement("span");
        where.className = "where";
        where.textContent = item.summary.join(" · ");
        const more = document.createElement("button");
        more.className = "more";
        more.type = "button";
        more.textContent = item.action.label;
        more.addEventListener("click", item.action.run);
        li.append(where, more);
        rows.appendChild(li);
        continue;
      }
      if (item.art != null) {
        li.className = "artwork";
        const cover = document.createElement("img");
        cover.src = item.art;
        cover.alt = "";
        li.appendChild(cover);
        rows.appendChild(li);
        continue;
      }
      if (item.note != null) {
        // A row that says something about itself under its own name: when the
        // update check last ran, or why it could not.
        li.classList.add("entry");
        const lines = document.createElement("div");
        lines.className = "lines";
        const label = document.createElement("span");
        label.textContent = item.label;
        const note = document.createElement("span");
        note.className = "note";
        note.textContent = item.note;
        lines.append(label, note);
        li.appendChild(lines);
      } else if (item.value == null) {
        li.textContent = item.label;
      } else {
        // A fact about the track rather than something to press: its name on
        // the left, what it says on the right.
        li.classList.add("fact");
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = item.label;
        const value = document.createElement("span");
        value.className = "value";
        value.textContent = item.value;
        value.title = item.value;
        li.append(label, value);
      }
      // A row whose text is not archamp's to keep short — a version string, a
       // reason from GitHub — wraps rather than running past the player's edge.
      if (item.wrap) li.classList.add("wrap");
      if (item.checked) li.classList.add("checked");
      // Working on it: the row says so where its checkmark goes, and stops
      // taking presses until it has an answer.
      if (item.busy) li.classList.add("busy");
      if (item.run != null && !item.busy) {
        li.addEventListener("click", () => {
          // A row that changes in place — the update check — keeps its menu.
          if (!item.keepOpen) closeOverlays();
          item.run();
        });
      } else if (item.run == null) {
        li.classList.add("inert");
      }
      rows.appendChild(li);
    }
  });
  root.appendChild(list);
  return root;
}

function menuRule() {
  const li = document.createElement("li");
  li.className = "hr";
  li.appendChild(document.createElement("hr"));
  return li;
}

function menuTitle(text) {
  const li = document.createElement("li");
  li.className = "title";
  li.textContent = text;
  return li;
}

// Everything archamp puts on screen itself: the Winamp menu, the presets
// drawer and the location prompt. Only one of them is ever up, and none of
// them survives a menu webamp opens.
function closeOverlays(keep = null) {
  let closed = false;
  // Not the file info drawer: that one is read rather than chosen from, and
  // stays until its own close button is pressed.
  for (const id of [MENU_ID, PRESETS_ID, NOTICE_ID, PROMPT_ID]) {
    if (id === keep) continue;
    const element = document.getElementById(id);
    if (element == null) continue;
    if (id === PROMPT_ID) element.cancel();
    else element.remove();
    closed = true;
  }
  // Straight away, not on the next frame: the player moves back up in the
  // same breath, and an unfocused window may not get a frame for a while.
  if (closed) refit();
}

// The menus archamp is showing, as against the prompt and the file info
// drawer, which are not menus and outlive a press elsewhere.
function closeArchampMenus() {
  let closed = false;
  for (const id of [MENU_ID, PRESETS_ID]) {
    const menu = document.getElementById(id);
    if (menu == null) continue;
    menu.remove();
    closed = true;
  }
  if (closed) refit();
}

// A drawer archamp draws itself, in place of the menu webamp would open from
// the same button. It stays up until that button is pressed again, an entry
// is chosen, another menu opens, or the window loses focus — an expanded
// section rather than a popover, since with the window hugging the player
// there is very little "outside" left to click on.
function toggleDrawer(id, sections) {
  if (document.getElementById(id) != null) {
    closeOverlays();
    return;
  }
  openDrawer(id, sections);
}

function openDrawer(id, sections) {
  closeOverlays();
  const drawer = renderMenu(id, sections);
  document.body.appendChild(drawer);
  // A scrolling list opens on the row that is ticked, not at its top.
  drawer.querySelector("li.checked")?.scrollIntoView({ block: "nearest" });
  refit();
}

// Rebuilds the Winamp menu in place, for the one row that changes while the
// menu is open. installMenu is what knows how to build it, so it sets this.
let refreshMenu = () => {};

function installMenu(webamp, skinTracker) {
  refreshMenu = () => {
    const open = document.getElementById(MENU_ID);
    if (open == null) return;
    const fresh = renderMenu(MENU_ID, menuSections(webamp, skinTracker));
    open.replaceChildren(...fresh.childNodes);
    refit();
  };
  const triggers = [
    ["#option-context", () => toggleDrawer(MENU_ID, menuSections(webamp, skinTracker))],
    ["#presets-context", () => toggleDrawer(PRESETS_ID, presetSections(webamp))],
  ];
  const triggerFor = (target) =>
    target instanceof Element ? triggers.find(([selector]) => target.closest(selector) != null) : null;
  // On the press, as Winamp's own menus open: a click needs the press and the
  // release to land on the same thing, and the player moves under the pointer
  // when a drawer opens or closes.
  document.addEventListener(
    "mousedown",
    (e) => {
      const trigger = triggerFor(e.target);
      if (trigger == null) return;
      e.stopPropagation();
      e.preventDefault();
      trigger[1]();
    },
    true,
  );
  // webamp opens its own menu from the click that follows; this swallows it.
  document.addEventListener(
    "click",
    (e) => {
      if (triggerFor(e.target) == null) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  // A press anywhere else closes an open menu, as a menu should: on the
  // player, on a title bar, on another menu's button. The prompt and the file
  // info drawer are not menus — the first is waiting for an answer and the
  // second stays until it is closed — so they are left alone, except that
  // another menu opening still takes the prompt with it.
  // On the window rather than the document: presses on anything webamp drags
  // by are stopped before they reach the document (see blockInPageDragging),
  // and pressing the player is exactly the case that should close a menu.
  window.addEventListener(
    "mousedown",
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(`#${MENU_ID}, #${PRESETS_ID}, #${PROMPT_ID}, #${FILE_INFO_ID}`)) return;
      const onTrigger = target?.closest("#option-context, #presets-context") != null;
      if (!onTrigger) closeArchampMenus();
      if (onTrigger || target?.closest(".playlist-menu, #webamp-context-menu")) {
        document.getElementById(PROMPT_ID)?.cancel();
      }
    },
    true,
  );
  window.addEventListener("blur", () => closeOverlays());
}

// Classic Winamp skins have no assets for menus at all (real Winamp never
// skinned them), so rather than build a per-skin bitmap chrome, archamp's
// menus and dialogs are built from the same components OMedia Controls uses,
// which are Omarchy's own: a PanelSectionHeader for a section's name, a
// PanelSeparator between sections, rows the size of the shell's popup rows,
// and the shell's state fills. The values below are those components' —
// Style.font, Style.spacing and the fill alphas from Style.qml — so a menu
// here reads as one of the desktop's own, and only the accent comes from the
// loaded skin (and only when it is legible against the background).
//
// One catch the shell doesn't have: the player is pixel art the user scales,
// and its menus belong to it, so they scale with it. Sizes are written
// against a single custom property in page pixels — the page zoom takes them
// up and down with the player.
const REM_VAR = "--archamp-rem";
const SHELL_BASE_FONT = 12;
const MENU_REM = 10;
// Style.font: caption 0.833, bodySmall 0.917, body 1.0.
const FONT_CAPTION = 0.833;
const FONT_BODY = 1;
// Style.spacing: xs 3, sm 4, md 6, lg 8, xl 10, and popup-row-height 28,
// control-padding-x 10. A gutter wide enough for the checkmark glyph is 16.
const SPACE_XS = 3 / SHELL_BASE_FONT;
const SPACE_SM = 4 / SHELL_BASE_FONT;
const SPACE_LG = 8 / SHELL_BASE_FONT;
const SPACE_XL = 10 / SHELL_BASE_FONT;
const ROW_HEIGHT = 28 / SHELL_BASE_FONT;
const ROW_INSET = 10 / SHELL_BASE_FONT;
const CHECK_GUTTER = 16 / SHELL_BASE_FONT;
// The spinner, inside the checkmark's column with its own breathing room.
const SPINNER = 10 / SHELL_BASE_FONT;

// Colours come from the desktop's theme (see theme.js), as custom properties
// so a theme change is a handful of assignments rather than a new stylesheet.
// The values here are what archamp uses away from Omarchy.
const MENU_BACKGROUND = "var(--archamp-bg, #14151a)";
const MENU_FOREGROUND = "var(--archamp-fg, #e2e2e6)";
const MENU_ACCENT_FALLBACK = "#7aa2f7";
const MENU_ACCENT = `var(--archamp-accent, ${MENU_ACCENT_FALLBACK})`;
// The shell's own tints of the foreground: PanelSeparator's rule at 0.12, the
// hover fill at 0.08, the normal fill at 0.04, and a caption dimmed the way
// PanelSectionHeader dims it (Qt.darker(foreground, 1.4)).
const MENU_RULE = "var(--archamp-rule, rgba(226, 226, 230, 0.12))";
const MENU_BORDER = "var(--archamp-border, rgba(226, 226, 230, 0.12))";
const MENU_HOVER_FILL = "var(--archamp-hover, rgba(226, 226, 230, 0.08))";
const MENU_FILL = "var(--archamp-fill, rgba(226, 226, 230, 0.04))";
const MENU_DIM = "var(--archamp-dim, #a1a1a4)";
const MENU_FONT = '"JetBrainsMono Nerd Font", "JetBrains Mono", monospace';

// The desktop's palette, once it arrives from the main process.
let themePalette = null;

function applyTheme(palette) {
  if (palette == null) return;
  themePalette = palette;
  const style = document.documentElement.style;
  style.setProperty("--archamp-bg", palette.background);
  style.setProperty("--archamp-fg", palette.text);
  style.setProperty("--archamp-dim", palette.dim);
  style.setProperty("--archamp-rule", palette.rule);
  style.setProperty("--archamp-border", palette.border);
  style.setProperty("--archamp-fill", palette.fill);
  style.setProperty("--archamp-hover", palette.hover);
  style.setProperty("--archamp-selected", palette.selected);
  // The theme's own type scale, taken relative to the shell's 12px base.
  style.setProperty(REM_VAR, `${(MENU_REM * palette.fontBase) / SHELL_BASE_FONT}px`);
  // The accent is the theme's now, not the loaded skin's.
  menuAccent = null;
}

// A multiple of the shell's base font size, as a CSS length.
function rem(multiple) {
  return `calc(var(${REM_VAR}) * ${Number(multiple.toFixed(4))})`;
}

// Relative luminance, as WCAG defines it.
function luminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseColor(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const rgb = /^rgba?\(([^)]+)\)/i.exec(String(color));
  if (!rgb) return null;
  const parts = rgb[1].split(",").map((part) => Number(part.trim()));
  return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? parts.slice(0, 3) : null;
}

function contrastRatio(a, b) {
  const first = parseColor(a);
  const second = parseColor(b);
  if (!first || !second) return 0;
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

// The skin's own highlight, when it reads clearly on the menu's background
// (WCAG AA for text, 4.5:1); otherwise archamp's own accent. Checked per skin,
// since every skin brings its own.
function skinAccentColor(webamp) {
  const colors = webamp.store.getState().display.skinGenExColors ?? {};
  const accent = colors.listTextHighlightedBackground;
  return accent && contrastRatio(accent, MENU_BACKGROUND) >= 4.5 ? accent : MENU_ACCENT_FALLBACK;
}

// One stylesheet, injected once, for every menu webamp opens. Colors come in
// as custom properties on the menu itself (see styleMenus).
function installMenuStylesheet() {
  const style = document.createElement("style");
  // webamp styles a menu and its submenus with one pair of selectors, so
  // these rules match the same pairs to override them. archamp's own menu
  // uses webamp's markup, so both containers are named throughout.
  const menu = `:is(#webamp-context-menu, #${MENU_ID}, #${PRESETS_ID}, #${FILE_INFO_ID}, #${NOTICE_ID}) .context-menu`;
  // The column a checkmark sits in belongs to menus, where it keeps every row
  // lined up whether it is ticked or not. File Info is a panel of facts with
  // nothing to tick, so it would only indent everything by an empty column.
  const choices = `:is(#webamp-context-menu, #${MENU_ID}, #${PRESETS_ID}) .context-menu`;
  style.textContent = `
    :root {
      ${REM_VAR}: ${MENU_REM}px;
    }
    ${menu},
    ${menu} ul {
      box-sizing: border-box !important;
      /* A bare ul carries the browser's own 1em margin, which shows through
         archamp's own drawers as a gap above and below the menu. */
      margin: 0 !important;
      list-style: none !important;
      background-color: ${MENU_BACKGROUND} !important;
      border: 1px solid ${MENU_BORDER} !important;
      border-radius: 0 !important;
      /* No shadow: these are drawers flush against the player, not popovers. */
      box-shadow: none !important;
      /* A menu opens on a section caption, which brings the space above it
         with it; the last row brings only its own leading. The extra padding
         underneath makes what the eye sees at the two ends the same. */
      padding: ${rem(SPACE_SM)} 0 ${rem(SPACE_LG)} !important;
      font-family: ${MENU_FONT} !important;
      font-size: var(${REM_VAR}) !important;
    }
    /* Every row is a popup row: one height, one inset, label centred in it. */
    ${menu} li {
      cursor: pointer !important;
      display: flex !important;
      align-items: center !important;
      box-sizing: border-box !important;
      height: ${rem(ROW_HEIGHT)} !important;
      padding: 0 ${rem(ROW_INSET)} !important;
      margin: 0 !important;
      font-family: ${MENU_FONT} !important;
      font-size: ${rem(FONT_BODY)} !important;
      color: ${MENU_FOREGROUND} !important;
      white-space: nowrap !important;
    }
    ${menu} li a {
      color: inherit !important;
    }
    ${menu} li:hover,
    ${menu} li:hover a {
      background-color: ${MENU_HOVER_FILL} !important;
      color: ${MENU_FOREGROUND} !important;
    }
    /* PanelSectionHeader: the section's name in caption size, bold, dimmed. */
    ${menu} li.title,
    ${menu} li.title:hover {
      cursor: default !important;
      height: auto !important;
      padding-top: ${rem(SPACE_XL)} !important;
      padding-bottom: ${rem(SPACE_XS)} !important;
      font-size: ${rem(FONT_CAPTION)} !important;
      font-weight: bold !important;
      color: ${MENU_DIM} !important;
      background-color: transparent !important;
    }
    /* PanelSeparator: a hairline the full width of the menu, with the panel
       column's gap above and below it. */
    ${menu} li.hr,
    ${menu} li.hr:hover {
      cursor: default !important;
      display: block !important;
      height: auto !important;
      padding: 0 !important;
      background-color: transparent !important;
    }
    ${menu} li.hr hr {
      border: none !important;
      height: 1px !important;
      background-color: ${MENU_RULE} !important;
      margin: ${rem(SPACE_LG)} 0 !important;
    }
    /* Every row keeps a column for a checkmark, ticked or not, so rows line
       up down a menu and menus line up with each other. */
    ${choices} li:not(.hr):before {
      content: "" !important;
      flex: none !important;
      width: ${rem(CHECK_GUTTER)} !important;
    }
    /* Omarchy's own menus mark a choice with this glyph, not a bare tick. */
    ${choices} li.checked:before {
      content: "\\f012c" !important;
      color: ${MENU_ACCENT} !important;
    }
    /* A row that says something about itself underneath its own name. Two
       lines, so it sets its own height rather than taking the row's. */
    ${menu} li.entry,
    ${menu} li.entry:hover {
      height: auto !important;
      padding-top: ${rem(SPACE_SM)} !important;
      padding-bottom: ${rem(SPACE_SM)} !important;
    }
    ${menu} li.entry .lines {
      display: flex !important;
      flex-direction: column !important;
      gap: ${rem(SPACE_XS)} !important;
      min-width: 0 !important;
    }
    /* Two lines rather than one long one that runs off the player's edge. */
    ${menu} li.wrap,
    ${menu} li.wrap:hover {
      height: auto !important;
      padding-top: ${rem(SPACE_SM)} !important;
      padding-bottom: ${rem(SPACE_SM)} !important;
    }
    ${menu} li.wrap,
    ${menu} li.entry {
      white-space: normal !important;
    }
    ${menu} li.entry .note {
      font-size: ${rem(FONT_CAPTION)} !important;
      color: ${MENU_DIM} !important;
    }
    /* Nothing to press: a row that is only reporting, and one that is busy. */
    ${menu} li.inert,
    ${menu} li.inert:hover,
    ${menu} li.busy,
    ${menu} li.busy:hover {
      cursor: default !important;
      background-color: transparent !important;
    }
    ${menu} li.busy {
      color: ${MENU_DIM} !important;
    }
    /* The spinner takes the checkmark's column, so a row that is working and
       one that has answered say so in the same place. */
    ${choices} li.busy:before {
      content: "" !important;
      box-sizing: border-box !important;
      width: ${rem(SPINNER)} !important;
      height: ${rem(SPINNER)} !important;
      margin-right: ${rem(CHECK_GUTTER - SPINNER)} !important;
      border: 1px solid ${MENU_RULE} !important;
      border-top-color: ${MENU_ACCENT} !important;
      border-radius: 50% !important;
      animation: archamp-spin 0.7s linear infinite !important;
    }
    @keyframes archamp-spin {
      to { transform: rotate(360deg); }
    }
    ${menu} li.parent:after {
      content: "\\203a" !important;
      margin-left: auto !important;
      padding-left: ${rem(SPACE_SM)} !important;
      color: ${MENU_DIM} !important;
    }
    /* What the drawer is about, and the way out of it: the cover, the track
       over who it is by, and a close button of the same square as the rows
       around it. One padding on every side of the row, so the heading sits
       in the block rather than against its edges. */
    ${menu} li.head,
    ${menu} li.head:hover {
      height: auto !important;
      align-items: center !important;
      gap: ${rem(ROW_INSET)} !important;
      /* The same inset as the rows below, so the heading and the details
         start on the same line, with room to the right of the close button,
         and the same space above the first line as below the last. */
      padding: ${rem(SPACE_LG)} ${rem(ROW_INSET * 1.6)} ${rem(SPACE_LG)} ${rem(ROW_INSET)} !important;
      background-color: transparent !important;
      cursor: default !important;
    }
    ${menu} li.head .lines {
      display: flex !important;
      flex: 1 !important;
      flex-direction: column !important;
      gap: ${rem(SPACE_XS)} !important;
      min-width: 0 !important;
    }
    ${menu} li.head .lines span {
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      color: ${MENU_DIM} !important;
    }
    ${menu} li.head .lines .first {
      color: ${MENU_FOREGROUND} !important;
      font-weight: bold !important;
    }
    ${menu} li.head .close {
      cursor: pointer !important;
      flex: none !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: ${rem(ROW_HEIGHT)} !important;
      height: ${rem(ROW_HEIGHT)} !important;
      padding: 0 !important;
      background: ${MENU_FILL} !important;
      border: 1px solid ${MENU_RULE} !important;
      border-radius: 0 !important;
      color: ${MENU_DIM} !important;
      font-family: inherit !important;
      font-size: ${rem(FONT_BODY)} !important;
      line-height: 1 !important;
    }
    ${menu} li.head .close:hover {
      background: ${MENU_HOVER_FILL} !important;
      border-color: ${MENU_ACCENT} !important;
      color: ${MENU_ACCENT} !important;
    }
    /* Where the track sits on its record, and the way to the rest. */
    ${menu} li.summary,
    ${menu} li.summary:hover {
      align-items: center !important;
      gap: ${rem(ROW_INSET)} !important;
      background-color: transparent !important;
      cursor: default !important;
    }
    ${menu} li.summary .where {
      flex: 1 !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }
    ${menu} li.summary .more {
      cursor: pointer !important;
      flex: none !important;
      height: ${rem(ROW_HEIGHT * 0.78)} !important;
      padding: 0 ${rem(SPACE_LG)} !important;
      background: ${MENU_FILL} !important;
      border: 1px solid ${MENU_RULE} !important;
      border-radius: 0 !important;
      color: ${MENU_FOREGROUND} !important;
      font-family: inherit !important;
      font-size: ${rem(FONT_CAPTION)} !important;
    }
    ${menu} li.summary .more:hover {
      background: ${MENU_HOVER_FILL} !important;
      border-color: ${MENU_ACCENT} !important;
      color: ${MENU_ACCENT} !important;
    }
    /* The cover, the width of the drawer, between the heading and the
       details. */
    ${menu} li.artwork,
    ${menu} li.artwork:hover {
      display: block !important;
      height: auto !important;
      padding: 0 !important;
      background-color: transparent !important;
      cursor: default !important;
    }
    /* The heading provides the space at the top of this drawer, so the list
       doesn't add its own on top of it; at the foot it matches what a rule
       would have left, so the last row sits as the summary row does. */
    #${FILE_INFO_ID} .context-menu {
      padding-top: 0 !important;
      padding-bottom: ${rem(SPACE_LG)} !important;
    }
    /* The rule above the cover has space on neither side: the heading's own
       padding is the space above it, and the cover meets it below. The rule
       under the cover meets it too, and keeps its space beneath, so what
       follows isn't pressed against the line. */
    ${menu} li.hr:has(+ li.artwork) hr {
      margin: 0 !important;
    }
    ${menu} li.artwork + li.hr hr {
      margin-top: 0 !important;
    }
    ${menu} li.artwork img {
      display: block !important;
      width: 100% !important;
      height: auto !important;
      background: ${MENU_FILL} !important;
    }
    /* A fact about the track: its name, then what the file says. */
    ${menu} li.fact {
      cursor: default !important;
    }
    ${menu} li.fact .label {
      flex: none !important;
      /* Wide enough for the longest of them ("Album artist"), and clipped
         rather than allowed to run into the value if a longer one appears. */
      width: ${rem(ROW_HEIGHT * 3.4)} !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      color: ${MENU_DIM} !important;
    }
    ${menu} li.fact .value {
      flex: 1 !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
    /* The one part of a drawer that scrolls, capped at eight rows so a long
       list doesn't make a menu taller than the player it hangs off. */
    ${menu} li.scroll,
    ${menu} li.scroll:hover {
      display: block !important;
      height: auto !important;
      max-height: ${rem(ROW_HEIGHT * 8)} !important;
      padding: 0 !important;
      overflow-y: auto !important;
      background-color: transparent !important;
      scrollbar-width: thin;
      scrollbar-color: ${MENU_RULE} transparent;
    }
    ${menu} li.scroll > ul {
      border: none !important;
      padding: 0 !important;
      background-color: transparent !important;
    }
    /* A submenu drills down over its parent rather than flying out to the
       side, since these menus are as wide as the player. */
    ${menu} ul {
      left: 0 !important;
      top: 0 !important;
      width: 100% !important;
      margin-left: 0 !important;
    }
    /* Both of archamp's own drawers are placed by layoutMenu/layoutDrawers. */
    #${MENU_ID},
    #${PRESETS_ID},
    #${FILE_INFO_ID},
    #${NOTICE_ID} {
      position: absolute;
      left: 0;
      top: 0;
      z-index: 60;
    }
  `;
  document.head.appendChild(style);
}

// Electron has no window.prompt(), and Add URL needs one. This is a drawer in
// the menus' style, pinned across the bottom of the player, below the last
// window it has open.
const PROMPT_ID = "archamp-prompt";

function installPromptStylesheet() {
  const style = document.createElement("style");
  style.textContent = `
    #${PROMPT_ID} {
      position: absolute;
      left: 0;
      top: 0;
      z-index: 100;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: ${rem(SPACE_SM)};
      padding: ${rem(SPACE_LG)} ${rem(ROW_INSET)};
      background: ${MENU_BACKGROUND};
      border: 1px solid ${MENU_RULE};
      font-family: ${MENU_FONT};
      font-size: var(${REM_VAR});
      color: ${MENU_FOREGROUND};
    }
    /* Named the way a panel names a section, because that is what it is. */
    #${PROMPT_ID} label {
      font-size: ${rem(FONT_CAPTION)};
      font-weight: bold;
      color: ${MENU_DIM};
    }
    #${PROMPT_ID} input,
    #${PROMPT_ID} button {
      box-sizing: border-box;
      height: ${rem(ROW_HEIGHT)};
      background: ${MENU_FILL};
      border: 1px solid ${MENU_RULE};
      color: ${MENU_FOREGROUND};
      font-family: inherit;
      font-size: ${rem(FONT_BODY)};
      outline: none;
    }
    #${PROMPT_ID} input {
      width: 100%;
      padding: 0 ${rem(SPACE_LG)};
      background: #0e0f13;
    }
    #${PROMPT_ID} input:focus {
      border-color: ${MENU_ACCENT};
    }
    #${PROMPT_ID} input.invalid {
      border-color: #d05c5c;
    }
    #${PROMPT_ID} .buttons {
      display: flex;
      gap: ${rem(SPACE_SM)};
    }
    #${PROMPT_ID} button {
      padding: 0 ${rem(ROW_INSET)};
      cursor: pointer;
    }
    #${PROMPT_ID} button:hover {
      background: ${MENU_HOVER_FILL};
    }
  `;
  document.head.appendChild(style);
}

// A location typed without a scheme is taken for a web address, as browsers
// do; anything that still doesn't parse isn't a location at all.
function parseLocation(text) {
  for (const candidate of [text, `https://${text}`]) {
    try {
      return new URL(candidate).href;
    } catch {}
  }
  return null;
}

// Resolves with the location typed, or null if it was cancelled. Only one
// prompt is open at a time: a second call replaces the first, which cancels.
function askForLocation() {
  document.getElementById(PROMPT_ID)?.cancel();
  return new Promise((resolve) => {
    const prompt = document.createElement("div");
    prompt.id = PROMPT_ID;
    prompt.innerHTML = `
      <label for="${PROMPT_ID}-input">ADD URL</label>
      <input id="${PROMPT_ID}-input" type="text" spellcheck="false" placeholder="https://example.com/stream.mp3">
      <div class="buttons">
        <button data-action="open">Add</button>
        <button data-action="cancel">Cancel</button>
      </div>`;
    const input = prompt.querySelector("input");
    const finish = (value) => {
      prompt.remove();
      resolve(value);
    };
    prompt.cancel = () => finish(null);
    const submit = () => {
      const text = input.value.trim();
      if (text === "") return finish(null);
      const url = parseLocation(text);
      if (url == null) {
        input.classList.add("invalid");
        return;
      }
      finish(url);
    };
    input.addEventListener("input", () => input.classList.remove("invalid"));
    prompt.addEventListener("click", (e) => {
      const action = e.target instanceof Element ? e.target.dataset.action : null;
      if (action === "open") submit();
      else if (action === "cancel") finish(null);
    });
    // webamp listens for keys on the document; none of this is meant for it.
    prompt.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") submit();
      else if (e.key === "Escape") finish(null);
    });
    document.body.appendChild(prompt);
    input.focus();
  });
}

// Called once per fit cycle, after the windows have been stacked. Everything
// that isn't the player is a drawer the width of the player: archamp's menu
// above it, and below it any menu webamp opens — the equalizer's presets, the
// playlist's sort and misc menus, a right-click menu — and the location
// prompt. webamp would drop each of those wherever the pointer happened to
// be; here they stack under the player, and the window grows to take them in.
function layoutDrawers(bottom) {
  const width = document.getElementById("main-window")?.getBoundingClientRect().width ?? 0;
  let top = Math.floor(bottom);
  const place = (element) => {
    element.style.top = `${top}px`;
    element.style.width = `${width}px`;
    top += Math.ceil(element.getBoundingClientRect().height);
  };
  const webampMenus = document.querySelectorAll("#webamp-context-menu > div > ul.context-menu");
  // Whatever webamp opens takes the drawer space back from the prompt.
  if (webampMenus.length > 0) document.getElementById(PROMPT_ID)?.cancel();
  for (const menu of webampMenus) {
    nameMenu(menu);
    const wrapper = menu.parentElement;
    wrapper.style.left = "0px";
    wrapper.style.top = `${top}px`;
    // webamp insets the menu from its wrapper by the gap it would leave below
    // a click; there is no click point here to clear.
    menu.style.top = "0px";
    menu.style.width = `${width}px`;
    top += Math.ceil(menu.getBoundingClientRect().height);
  }
  for (const id of [PRESETS_ID, FILE_INFO_ID, NOTICE_ID, PROMPT_ID]) {
    const drawer = document.getElementById(id);
    if (drawer != null) place(drawer);
  }
}

// The menus webamp still draws have no names of their own; archamp gives them
// the name of the button they came from, so a drawer always says what it is.
const MENU_NAMES = [
  [".sort-list", "SORT LIST"],
  [".misc-options", "MISC OPTIONS"],
];
let openedMenuName = null;

function watchMenuNames() {
  document.addEventListener(
    "mousedown",
    (e) => {
      const named =
        e.target instanceof Element
          ? MENU_NAMES.find(([selector]) => e.target.closest(selector) != null)
          : null;
      const name = named ? named[1] : null;
      // These menus sit side by side under one button and each opens on its
      // own, so webamp will happily stack both. One at a time: reaching for
      // another closes the one that is up, before this press opens the next.
      // These menus sit side by side under one button, and webamp stops the
      // click that opens one from reaching the other — whose only way of
      // knowing to close is a click landing outside it. So they stack. One at
      // a time: reaching for another presses the open one's handle, which is
      // how webamp closes that menu itself, and this press then opens the
      // one it was aimed at.
      if (name != null && openedMenuName != null && name !== openedMenuName) {
        closeNamedMenu(openedMenuName);
      }
      openedMenuName = name;
    },
    true,
  );
}

// Presses the handle of a menu webamp draws, the way clicking it again would.
function closeNamedMenu(title) {
  const named = MENU_NAMES.find(([, name]) => name === title);
  if (named == null) return;
  const handle = document.querySelector(`${named[0]} .handle`);
  if (handle == null || document.querySelector("#webamp-context-menu ul") == null) return;
  handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function nameMenu(menu) {
  if (openedMenuName == null || menu.querySelector("li.title") != null) return;
  menu.insertBefore(menuTitle(openedMenuName), menu.firstChild);
}

// The menu accent lives on the document, so a menu is styled the moment it is
// portalled in, whether or not anything else happened that frame. Called once
// per fit cycle, which is often enough to catch a skin change.
let menuAccent = null;
function styleMenus(webamp) {
  const accent = themePalette?.accent ?? skinAccentColor(webamp);
  if (accent === menuAccent) return;
  menuAccent = accent;
  document.documentElement.style.setProperty("--archamp-accent", accent);
}

// Called once per fit cycle. Returns how much vertical space, if any, the
// player should leave at the top for the menu.
function layoutMenu() {
  const menu = document.getElementById(MENU_ID);
  if (menu == null) return 0;
  menu.style.width = `${document.getElementById("main-window")?.getBoundingClientRect().width ?? 0}px`;
  // Down, not up: a fraction of a pixel rounded the other way leaves a line of
  // background between the menu and the title bar below it.
  return Math.floor(menu.getBoundingClientRect().bottom);
}

// Re-measures the player and everything pinned to it, and resizes the window
// to match. Set by keepWindowFitted; called directly by whatever opens or
// closes a drawer, so the layout never lags a frame behind.
let refit = () => {};

// Wayland doesn't let an app position its own window, so the player can only
// move through the compositor: title bars are native drag regions (see
// index.html), and the Electron window is kept exactly the size of what webamp
// is showing, so dragging a title bar moves the whole player.
function keepWindowFitted(webamp) {
  let lastSize = null;
  let scheduled = false;
  let onScreen = false;

  const fit = () => {
    scheduled = false;
    // Until the window is on screen the compositor hasn't said what scale it
    // draws at, and devicePixelRatio is a guess — sizing the window by it is
    // what made the player open at one size and jump to another.
    if (!onScreen) return;
    // Page measurements are in CSS pixels; the window is sized in DIPs
    // (setContentSize's units). CSS px * devicePixelRatio / trueScale gets
    // there directly — webFrame.getZoomFactor() looks like it should too
    // (devicePixelRatio is meant to equal trueScale * zoomFactor), but on
    // this platform's fractional-scale Wayland output the two disagree, and
    // it is devicePixelRatio, what is actually being composited, that says
    // how much room the page needs.
    const zoom = window.devicePixelRatio / trueScale;
    styleMenus(webamp);
    const topOffset = layoutMenu();
    // The store update this causes schedules the next fit.
    if (moveWindowsToOrigin(webamp, topOffset)) return;
    const windows = farEdges(document.querySelectorAll(WINDOW_SELECTOR));
    if (windows == null) return;
    layoutDrawers(windows.bottom);
    // The drawers hang past the windows' edges; grow to keep them visible.
    const menus = farEdges(
      document.querySelectorAll(
        `${MENU_SELECTOR}, #${PRESETS_ID}, #${FILE_INFO_ID}, #${NOTICE_ID}, #${PROMPT_ID}`,
      ),
    );
    const width = Math.ceil(Math.max(windows.right, menus?.right ?? 0) * zoom);
    const height = Math.ceil(Math.max(windows.bottom, menus?.bottom ?? 0) * zoom);
    if (lastSize?.width === width && lastSize?.height === height) return;
    lastSize = { width, height };
    ipcRenderer.send("fit-window", { width, height });
  };

  const scheduleFit = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(fit);
  };

  refit = fit;
  // The main process shows the window once the player has drawn, at the size
  // it ended up last time (see main.js); from then on the page's own
  // measurements are worth something.
  ipcRenderer.on("window-shown", () => {
    onScreen = true;
    scheduleFit();
  });
  // Every show, including the ones after the first: see refreshDragRegions.
  ipcRenderer.on("window-reshown", refreshDragRegions);
  webamp.store.subscribe(scheduleFit);
  // Context menus mount directly onto <body>, and their submenus open on hover.
  new MutationObserver(scheduleFit).observe(document.body, { childList: true });
  document.addEventListener("mouseover", scheduleFit);
  // webamp answers page resizes by pushing windows back on screen, and resets
  // the whole layout when they don't fit. Here the window follows its contents
  // instead, and a scale change shrinks the page before the window catches up,
  // so keep resizes away from webamp and just re-fit.
  window.addEventListener(
    "resize",
    (e) => {
      e.stopImmediatePropagation();
      scheduleFit();
    },
    true,
  );
  scheduleFit();
}

// Title bar presses go to the compositor and never reach webamp, but webamp
// also drags a window by its body, which would slide that one window around
// inside ours. Swallow those presses so the player only moves as a whole.
// Make Chromium look at the drag regions again.
//
// It recomputes them when the elements carrying them change, and a window that
// has just been shown has not changed since it was mapped — so the first drag
// after opening archamp, or after showing it from the tray, did nothing at
// all. Clicking another window first fixed it, because webamp moves its
// `selected` class to the window you clicked and that rewrites the title bar
// this one was trying to drag by.
//
// Two frames: the class has to be on for a frame that is actually committed,
// or the add and the remove collapse into no change and nothing is recomputed.
function refreshDragRegions() {
  const html = document.documentElement;
  html.classList.add("regions-stale");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => html.classList.remove("regions-stale"));
  });
}

// The player's close button, when there is a tray to put archamp in.
//
// This has to stop the press before webamp sees it, not react to
// `webamp.onClose`: by the time that fires webamp has already pulled its own
// main window out of the page, so hiding instead of disposing leaves an empty
// window to come back to. Caught on the way down, webamp never closes anything
// and the player is still there when the tray brings it back.
//
// Only with a tray icon. Without one there would be no way back, so the close
// button keeps meaning what it has always meant.
function closeToTray() {
  const swallow = (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("#title-bar #close") == null) return;
    if (!windowStatus?.tray || windowStatus?.trayHost === false) return;
    e.stopPropagation();
    e.preventDefault();
    ipcRenderer.send("hide-window");
  };
  window.addEventListener("mousedown", swallow, true);
  window.addEventListener("click", swallow, true);
}

function blockInPageDragging() {
  const block = (e) => {
    const { target } = e;
    if (target instanceof Element && target.classList.contains("draggable") && target.closest("#webamp")) {
      e.stopPropagation();
    }
  };
  window.addEventListener("mousedown", block, true);
  window.addEventListener("touchstart", block, true);
}

// webamp closes a menu when you click anywhere else in the page, but with the
// window hugging the player, most of "anywhere else" isn't the page: clicks on
// other windows never arrive here, and title bars hand presses straight to the
// compositor. So close menus when the window loses focus, and make title bars
// ordinary page elements while a menu is open (see index.html).
function closeMenusOnClickAway() {
  window.addEventListener("blur", closeMenus);
  new MutationObserver(() => {
    // Not the file info drawer: that one stays until it is closed, and the
    // player has to stay draggable underneath it (see index.html).
    const open = document.querySelector(`#webamp-context-menu, #${MENU_ID}, #${PRESETS_ID}`) != null;
    document.documentElement.classList.toggle("menu-open", open);
  }).observe(document.body, { childList: true });
}

// Trips webamp's own click-away handlers, as a click on empty page would.
function closeMenus() {
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

// What the player was wearing when the skin browser opened, so Cancel can put
// it back — the browser only knows about museum skins, and this could be the
// built-in one or a file of the user's own.
let skinBeforeBrowsing = null;
let openSkinBrowser = () => {};

// The skin browser opens from the Skins section of archamp's menu, or with
// Alt+S, Winamp's own shortcut for its skin browser.
function installSkinBrowserShortcut() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      e.stopPropagation();
      openSkinBrowser();
    },
    true,
  );
}

// webamp's Next/Previous with no track to go to (the last track, repeat off)
// only marks the player as stopped, and the song keeps playing underneath.
// Stop for real, which is also what MPRIS asks of a Next with nowhere to go.
function stopWhenNothingToSkipTo(store) {
  return (next) => (action) =>
    action.type === "IS_STOPPED" ? store.dispatch({ type: "STOP" }) : next(action);
}

const MPRIS_STATUS = { PLAYING: "Playing", PAUSED: "Paused" };

// Reports the player's state to archamp's MPRIS player in the main process
// (mpris.js), and carries out what MPRIS clients ask of it. The middleware sees
// seeks, which MPRIS announces with a Seeked signal. The window title follows
// the track, as Winamp's did.
function createMprisBridge() {
  let webamp = null;
  let reported = null;

  const currentTrack = (state) => state.tracks[state.playlist.currentTrack];
  // webamp plays through an <audio> element it never puts in the page, so the
  // only way to it is the media object it keeps. Speed is that element's
  // playbackRate; webamp itself has no idea about it, which is why archamp
  // remembers what it set.
  let rate = 1;
  let loopTrack = false;
  const audioElement = () => {
    // webamp.media._source._audio today; looked for rather than reached for,
    // since it is webamp's business where it keeps it.
    const search = (object, depth) => {
      if (object == null || typeof object !== "object" || depth > 3) return null;
      for (const key of Object.keys(object)) {
        let value;
        try {
          value = object[key];
        } catch {
          continue;
        }
        if (value instanceof HTMLAudioElement) return value;
        const found = search(value, depth + 1);
        if (found != null) return found;
      }
      return null;
    };
    return search(webamp?.media, 0);
  };
  const status = () => webamp.getMediaStatus();
  const commands = {
    play: () => {
      if (status() !== "PLAYING" && webamp.getPlaylistTracks().length > 0) webamp.play();
    },
    pause: () => {
      if (status() === "PLAYING") webamp.pause();
    },
    playPause: () => (status() === "PLAYING" ? commands.pause() : commands.play()),
    stop: () => webamp.stop(),
    next: () => {
      if (reported?.canGoNext) webamp.nextTrack();
    },
    previous: () => {
      if (reported?.canGoPrevious) webamp.previousTrack();
    },
    seek: (offset) => commands.seekTo(webamp.store.getState().media.timeElapsed + offset),
    seekTo: (seconds) => {
      const length = currentTrack(webamp.store.getState())?.duration ?? 0;
      webamp.seekToTime(Math.min(Math.max(seconds, 0), length));
    },
    volume: (level) => webamp.setVolume(Math.round(level * 100)),
    // Kept on the element across tracks: defaultPlaybackRate is what a newly
    // loaded one starts at, playbackRate what the one loaded is playing at.
    rate: (value) => {
      const audio = audioElement();
      if (audio == null) return;
      audio.preservesPitch = true;
      audio.defaultPlaybackRate = value;
      audio.playbackRate = value;
      rate = value;
      report();
    },
    // None, Playlist or Track. webamp knows only the first two — Winamp's
    // repeat button is playlist repeat — so repeating one track is the audio
    // element's own loop, which keeps the track from ending at all rather
    // than letting webamp move on and chasing it back.
    loop: (mode) => {
      const audio = audioElement();
      loopTrack = mode === "Track";
      if (audio != null) audio.loop = loopTrack;
      // Winamp's own button shows as on for either kind of repeat.
      const repeat = mode !== "None";
      if (webamp.isRepeatEnabled() !== repeat) webamp.toggleRepeat();
      report();
    },
    shuffle: (on) => {
      if (webamp.isShuffleEnabled() !== on) webamp.toggleShuffle();
    },
    // A playlist entry chosen by an MPRIS client. Played if something is
    // playing, readied if stopped, as webamp's own double-click does.
    goTo: (id) => {
      const state = webamp.store.getState();
      if (!state.playlist.trackOrder.includes(id)) return;
      webamp.store.dispatch({ type: status() === "STOPPED" ? "BUFFER_TRACK" : "PLAY_TRACK", id });
    },
    // TrackList editing from MPRIS clients. Removing the track being played
    // moves on to the next one, playing if it was playing, as Winamp does;
    // with nothing after it, playback stops.
    removeTrack: (id) => {
      const state = webamp.store.getState();
      const { trackOrder, currentTrack } = state.playlist;
      const index = trackOrder.indexOf(id);
      if (index === -1) return;
      if (id === currentTrack) {
        const next = trackOrder[index + 1];
        if (next == null) webamp.stop();
        else webamp.store.dispatch({ type: status() === "PLAYING" ? "PLAY_TRACK" : "BUFFER_TRACK", id: next });
      }
      webamp.store.dispatch({ type: "REMOVE_TRACKS", ids: [id] });
    },
    // Moves a track to just after another, or to the start for null.
    moveTrack: ({ id, after }) => {
      const { trackOrder } = webamp.store.getState().playlist;
      if (!trackOrder.includes(id) || id === after) return;
      const rest = trackOrder.filter((trackId) => trackId !== id);
      const at = after == null ? 0 : rest.indexOf(after) + 1;
      if (after != null && at === 0) return;
      webamp.store.dispatch({ type: "SET_TRACK_ORDER", trackOrder: [...rest.slice(0, at), id, ...rest.slice(at)] });
    },
    // Adds tracks just after another, or at the start for null, and plays the
    // first of them when asked. webamp only appends, so they're appended and
    // then moved into place.
    addTracks: ({ urls, after, play }) => {
      if (!Array.isArray(urls) || urls.length === 0) return;
      const before = new Set(webamp.store.getState().playlist.trackOrder);
      if (after != null && !before.has(after)) return;
      // Appending and then moving into place is two changes to webamp and one
      // to anybody watching, so the list is reported once at the end: adding a
      // track should announce a track added, not a track added and then the
      // whole list replaced because it moved.
      batching = true;
      try {
        webamp.appendTracks(tracksFromUrls(urls));
        const { trackOrder } = webamp.store.getState().playlist;
        const added = trackOrder.filter((id) => !before.has(id));
        const rest = trackOrder.filter((id) => before.has(id));
        const at = after == null ? 0 : rest.indexOf(after) + 1;
        webamp.store.dispatch({ type: "SET_TRACK_ORDER", trackOrder: [...rest.slice(0, at), ...added, ...rest.slice(at)] });
        if (play && added.length > 0) webamp.store.dispatch({ type: "PLAY_TRACK", id: added[0] });
      } finally {
        // Inside the finally: a throw mid-batch still leaves the tracks in
        // webamp's store, and without this the bus would keep describing the
        // old list until some unrelated action happened to fire the
        // subscription — which, with playback stopped, is never.
        batching = false;
        reportTracks();
      }
    },
    // OpenUri: the main process has already turned the URI into file URLs.
    openTracks: (urls) => {
      if (!Array.isArray(urls) || urls.length === 0) return;
      webamp.setTracksToPlay(tracksFromUrls(urls));
    },
    // ------------------------------------------------------- the equalizer
    // MPRIS has nothing for this, so it is archamp's own interface. Every
    // action the presets drawer has, and the bands themselves.
    eqEnabled: (on) => webamp.store.dispatch({ type: on ? "SET_EQ_ON" : "SET_EQ_OFF" }),
    eqAuto: (on) => webamp.store.dispatch({ type: "SET_EQ_AUTO", value: Boolean(on) }),
    eqPreamp: (db) => webamp.store.dispatch({ type: "SET_BAND_VALUE", band: "preamp", value: dbToSlider(db) }),
    eqBands: (bands) => {
      if (!Array.isArray(bands)) return;
      // Short of ten leaves the rest where they are; longer is ignored past
      // the tenth, so a caller cannot invent bands archamp does not have.
      EQ_BANDS.forEach((band, index) => {
        if (index >= bands.length) return;
        webamp.store.dispatch({ type: "SET_BAND_VALUE", band, value: dbToSlider(bands[index]) });
      });
    },
    eqPreset: (name) => {
      const wanted = String(name);
      const loaded = readLoadedEqf();
      const preset = [...(loaded == null ? [] : [loaded]), ...EQ_PRESETS].find((one) => one.name === wanted);
      if (preset != null) applyEqf(webamp, preset.bands);
    },
    eqReset: () => resetEq(webamp),
    eqLoad: async (file) => {
      if (typeof file !== "string" || file === "") return;
      await loadEqfFile(webamp, file);
    },
    eqSave: async (file) => {
      if (typeof file !== "string" || file === "") return;
      try {
        await fs.writeFile(file, eqfFile(EQF_ENTRY_NAME, currentEqf(webamp)));
      } catch (error) {
        console.error(`equalizer file: ${error.message}`);
      }
    },
  };

  // The equalizer as the bus sees it. The sliders are what say which preset is
  // on, not the file values: webamp snaps anything near the middle to dead
  // centre, so two different files can be the very same setting.
  let reportedEq = null;
  function reportEqualizer() {
    const sliders = currentSliders(webamp);
    const loaded = readLoadedEqf();
    const known = [...(loaded == null ? [] : [loaded]), ...EQ_PRESETS];
    const { on, auto } = webamp.store.getState().equalizer;
    const next = {
      enabled: Boolean(on),
      auto: Boolean(auto),
      bands: sliders.slice(0, EQ_BANDS.length).map(sliderToDb),
      preamp: sliderToDb(sliders[EQ_BANDS.length]),
      presets: known.map((preset) => preset.name),
      preset: known.find((preset) => isCurrentEq(sliders, preset.bands))?.name ?? "",
    };
    const json = JSON.stringify(next);
    if (json === reportedEq) return;
    reportedEq = json;
    ipcRenderer.send("mpris:equalizer", next);
  }

  // The playlist in play order, sent whenever it or a track's tags change.
  let reportedTracks = null;
  // Set while one change to the playlist takes several dispatches to make.
  let batching = false;
  function reportTracks() {
    if (batching) return;
    const state = webamp.store.getState();
    const tracks = state.playlist.trackOrder.map((id) => {
      const track = state.tracks[id] || {};
      return {
        id,
        title: track.title || track.defaultName || "",
        artist: track.artist || "",
        album: track.album || "",
        length: track.duration || 0,
        url: track.url || "",
      };
    });
    const json = JSON.stringify(tracks);
    if (json === reportedTracks) return;
    reportedTracks = json;
    ipcRenderer.send("mpris:tracks", tracks);
  }

  // webamp only has a blob: URL for embedded album art; the main process turns
  // the bytes into a file panels can load.
  let art = { source: null, url: null };
  async function saveArt(source) {
    art = { source, url: null };
    if (!source) return;
    try {
      const bytes = new Uint8Array(await (await fetch(source)).arrayBuffer());
      const url = await ipcRenderer.invoke("mpris:art", bytes);
      if (art.source === source) {
        art.url = url;
        report();
      }
    } catch (error) {
      console.error(`album art: ${error.message}`);
    }
  }

  function report() {
    const state = webamp.store.getState();
    // A player with nothing loaded is not playing. Removing the tracks out
    // from under playback — over MPRIS, or with Rem all — leaves webamp's
    // status as it was and the audio element still going, which is heard as
    // well as reported.
    if (state.playlist.trackOrder.length === 0 && state.media.status !== "STOPPED") {
      webamp.stop();
      return;
    }
    // Turning Winamp's own repeat button off turns off repeating one track
    // with it: the button says repeat is off, so it is.
    if (loopTrack && !state.media.repeat) {
      loopTrack = false;
      const audio = audioElement();
      if (audio != null) audio.loop = false;
    }
    // Playing leaves the restored state behind; so does a Stop, which puts the
    // elapsed time back to zero.
    if (resumable && (state.media.status !== "STOPPED" || state.media.timeElapsed === 0)) resumable = false;
    const { currentTrack: id, trackOrder } = state.playlist;
    const track = currentTrack(state);
    if ((track?.albumArtUrl || null) !== art.source) saveArt(track?.albumArtUrl || null);

    const index = trackOrder.indexOf(id);
    const wraps = state.media.repeat || state.media.shuffle;
    const title = track ? track.title || track.defaultName || "" : "";
    const next = {
      status: resumable ? "Paused" : MPRIS_STATUS[state.media.status] ?? "Stopped",
      track: track && {
        id,
        title,
        artist: track.artist || "",
        album: track.album || "",
        length: track.duration || 0,
        url: track.url,
        artUrl: art.url,
      },
      canGoNext: index !== -1 && (wraps || index < trackOrder.length - 1),
      canGoPrevious: index !== -1 && (wraps || index > 0),
      repeat: state.media.repeat,
      loopTrack,
      shuffle: state.media.shuffle,
      volume: state.media.volume / 100,
      rate,
    };
    // Position changes constantly; the main process works it out from the
    // position sent with each real change.
    if (JSON.stringify(next) === JSON.stringify(reported)) return;
    reported = next;
    ipcRenderer.send("mpris:state", { ...next, position: state.media.timeElapsed });
    document.title = track
      ? `${track.artist ? `${track.artist} - ` : ""}${title} - archamp`
      : "archamp";
  }

  // The elapsed time last seen, to catch a jump back that no seek caused: a
  // track restarting on repeat (a one-track playlist ends and plays again),
  // which changes nothing else MPRIS clients would hear about.
  let lastElapsed = 0;

  return {
    middleware: (store) => (next) => (action) => {
      const playingBefore = store.getState().playlist.currentTrack;
      const result = next(action);
      if (action.type === "SEEK_TO_PERCENT_COMPLETE") {
        const length = currentTrack(store.getState())?.duration ?? 0;
        lastElapsed = (action.percent / 100) * length;
        ipcRenderer.send("mpris:seeked", lastElapsed);
      } else if (action.type === "UPDATE_TIME_ELAPSED") {
        if (action.elapsed < lastElapsed - 1) ipcRenderer.send("mpris:seeked", action.elapsed);
        lastElapsed = action.elapsed;
      } else if (action.type === "PLAY_TRACK" || action.type === "BUFFER_TRACK") {
        // The same track starting over (repeat) is a jump to the start; a
        // different track is announced by the state report instead.
        if (action.id === playingBefore && lastElapsed > 0) ipcRenderer.send("mpris:seeked", 0);
        lastElapsed = 0;
      }
      return result;
    },
    connect(player) {
      webamp = player;
      webamp.store.subscribe(report);
      webamp.store.subscribe(reportTracks);
      webamp.store.subscribe(reportEqualizer);
      ipcRenderer.on("mpris:command", (_event, name, value) => {
        if (Object.hasOwn(commands, name)) commands[name](value);
      });
      report();
      reportTracks();
      reportEqualizer();
    },
  };
}

if (!Webamp.browserIsSupported()) {
  document.getElementById("app").textContent =
    "This browser environment does not support Webamp.";
} else {
  (async () => {
    await refreshTrueScale();
    applyScale();
    watchDisplayScale();
    installScaleControls();

    const chosenSkin = readChosenSkin();
    const startingDefault = chosenSkin == null || readStored(DEFAULT_SKIN_KEY) === true;
    const skinTracker = createSkinTracker(chosenSkin, startingDefault);
    const mpris = createMprisBridge();
    const webamp = new Webamp({
      initialTracks: [],
      filePickers: [
        {
          contextMenuName: "Open files...",
          filePicker: pickFiles,
          requiresNetwork: false,
        },
      ],
      // Without these webamp's Add URL, Load list and Save list only say they
      // aren't supported; archamp answers them itself.
      handleAddUrlEvent: async () => {
        const url = await askForLocation();
        return url ? tracksFromUrls([url]) : null;
      },
      handleLoadListEvent: async () => {
        const urls = await ipcRenderer.invoke("open-playlist");
        return urls?.length ? tracksFromUrls(urls) : null;
      },
      handleSaveListEvent: async () => {
        await ipcRenderer.invoke("save-playlist", playlistM3u(webamp));
        return null;
      },
      // A private webamp option, but the only way to observe skin changes and seeks.
      __customMiddlewares: [skinTracker.middleware, stopWhenNothingToSkipTo, mpris.middleware],
    });

    webamp.onClose(() => {
      webamp.dispose();
      window.close();
    });

    openSkinBrowser = () => {
      skinBeforeBrowsing = { chosen: skinTracker.chosen(), usingDefault: skinTracker.isDefault() };
      ipcRenderer.send("museum:open-browser");
    };

    ipcRenderer.on("museum:restore", () => {
      const before = skinBeforeBrowsing;
      if (before == null) return;
      if (before.usingDefault || before.chosen == null) {
        webamp.store.dispatch({ type: "LOAD_DEFAULT_SKIN" });
        return;
      }
      skinTracker.expect(before.chosen);
      webamp.setSkinFromUrl(skinUrl(before.chosen));
    });

    ipcRenderer.on("museum:apply", (_event, md5, name) => {
      if (md5 === BASE_SKIN_MD5) {
        webamp.store.dispatch({ type: "LOAD_DEFAULT_SKIN" });
        return;
      }
      skinTracker.expect({ kind: "museum", md5, name: name || "Museum skin" });
      webamp.setSkinFromUrl(museumSkinUrl(md5));
    });

    blockInPageDragging();
    closeToTray();
    filterWebampFilePickers();
    closeMenusOnClickAway();
    installSkinBrowserShortcut();
    installMenu(webamp, skinTracker);
    installFileInfo(webamp);
    installRemoveMissing(webamp);
    watchMenuNames();
    installMenuStylesheet();
    installPromptStylesheet();
    applyTheme(await ipcRenderer.invoke("theme"));
    desktopStatus = await ipcRenderer.invoke("desktop-status");
    windowStatus = await ipcRenderer.invoke("window-status");
    updateRow = { ...updateRow, checkedAt: await ipcRenderer.invoke("update:last-checked") };
    // The plugin can hide the window too, and the menu should say so.
    ipcRenderer.on("window-status", (_event, status) => {
      windowStatus = status;
    });
    ipcRenderer.on("theme", (_event, palette) => applyTheme(palette));
    restoreEqualizer(webamp);
    // Files named on the command line are what the user asked for; they
    // replace the session rather than being added to it.
    if (!(await ipcRenderer.invoke("startup-files"))) await restoreSession(webamp);
    watchSession(webamp);
    skinTracker.announce();
    mpris.connect(webamp);
    await webamp.renderWhenReady(document.getElementById("app"));

    // The player draws in webamp's own skin and puts the chosen one on after,
    // rather than waiting on it to draw at all: a skin the museum hasn't been
    // asked for before has to come down the wire first, and a player that
    // isn't there yet is worse than one that changes its clothes. A skin
    // already on disk lands in a moment, so the window waits that moment out
    // (and no longer) to avoid showing the change.
    const wearingChosen =
      startingDefault
        ? Promise.resolve()
        : Promise.race([skinTracker.landed(), new Promise((resolve) => setTimeout(resolve, 500))]);
    if (!startingDefault) {
      skinTracker.expect(chosenSkin);
      webamp.setSkinFromUrl(skinUrl(chosenSkin));
    }

    // The window is hidden until here (see main.js): it is created before
    // webamp has drawn anything, and neither an empty transparent frame nor a
    // player resizing itself into place is worth showing.
    keepWindowFitted(webamp);
    await wearingChosen;
    ipcRenderer.send("player-ready", Math.round(performance.now()));
  })();
}
