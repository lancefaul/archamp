const { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, dialog, nativeImage, screen, shell } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const { pathToFileURL } = require("url");
const { readTheme, watchTheme } = require("./theme");
const { registerMuseumScheme, installMuseum } = require("./museum");
const { startMpris, tracksForUri, tracksForUris, writeEmbeddedArt, playlistOpened, playlistsFolder, musicFolder, openedPlaylistUri } = require("./mpris");
const desktop = require("./desktop");
const settings = require("./settings");
const updater = require("./updater");
const restart = require("./restart");
const trayhost = require("./trayhost");
const hyprland = require("./hyprland");

// Undoing the desktop entry is the only thing archamp does without starting:
// it is what an uninstall looks like for an AppImage, which is a file the
// user is about to delete.
if (process.argv.includes("--remove-desktop-integration")) {
  app.whenReady().then(async () => {
    await desktop.remove();
    console.log("[archamp] desktop entry and icon removed");
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// One archamp at a time. A second launch hands its files to the one already
// running and stops — the plugin starts archamp by its desktop entry to play
// something, and that has to land in the player the user is looking at.
registerMuseumScheme();
// archamp publishes its own MPRIS player (mpris.js); Chromium's would show up
// as a second, less capable one.
app.commandLine.appendSwitch("disable-features", "HardwareMediaKeyHandling");

let win;

// Files, folders and playlists named on the command line, as file:// URIs.
// Anything that isn't a path is left alone: Chromium's own switches, and the
// "." that runs the app from a checkout. Unpackaged, the first argument is
// the app directory Electron was pointed at rather than anything to play —
// without dropping it, `electron .` reads the checkout as a folder of music.
function urisFromArgv(argv) {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((argument) => !argument.startsWith("-") && argument !== ".")
    .map((argument) => {
      try {
        return pathToFileURL(path.resolve(argument)).href;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// What the plugin's `gtk-launch archamp a.mp3 b.mp3` means, and what a second
// launch hands over: play these, in place of whatever is loaded.
async function play(uris, urls) {
  if (urls.length === 0) return false;
  // One folder or one playlist names the queue; a handful of files does not.
  await playlistOpened(uris.length === 1 ? uris[0] : "", urls);
  win?.webContents.send("mpris:command", "openTracks", urls);
  return true;
}

async function playFrom(argv) {
  const uris = urisFromArgv(argv);
  return uris.length > 0 && play(uris, await tracksForUris(uris));
}

// What this launch was asked to play, worked out once and kept: the player
// asks whether there is anything before it restores its last session, and is
// handed the same list when it is ready. The arguments alone won't do —
// `archamp notes.txt` would count as a launch with files, and the session
// would be thrown away for nothing to play.
let launched = null;
const launchUrls = () => (launched ??= tracksForUris(urisFromArgv(process.argv)));
const playLaunch = async () => play(urisFromArgv(process.argv), await launchUrls());

// The size the player ended up last time. A window can only learn how big it
// needs to be once it is on screen — the compositor doesn't say what scale it
// draws at before that — so opening at the size it ended up with is what
// keeps it from appearing at one size and resizing to another.
function sizeFile() {
  return path.join(app.getPath("userData"), "window-size.json");
}

function rememberedSize() {
  try {
    const { width, height } = JSON.parse(fsSync.readFileSync(sizeFile(), "utf8"));
    if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
      return { width, height };
    }
  } catch {}
  // webamp's own layout: main, equalizer and playlist stacked, 275x116 each.
  return { width: 275, height: 348 };
}

function rememberSize(size) {
  fs.writeFile(sizeFile(), JSON.stringify(size)).catch(() => {});
}

// Whether there is meant to be a window. Hidden means no window at all, with
// the audio, MPRIS, the media keys and the plugin all carrying on — for when
// something else is doing the controlling and Winamp's window is in the way.
// `--hidden` hides this launch alone; `--show` overrides a remembered
// "keep hidden", which is the way back for anyone without the plugin.
let hidden = process.argv.includes("--hidden") || (settings.keepHidden() && !process.argv.includes("--show"));
// The window is held back until the player has drawn itself, so "not visible"
// on the way up is not the same as hidden.
let drawn = false;
let everShown = false;
let mpris = null;

function showWindow() {
  if (win == null) return;
  if (win.isMinimized()) win.restore();
  win.show();
  // Every show, first or not: a window that has just been mapped has not
  // changed since Chromium last worked out where its drag regions are, so the
  // first press on a title bar went nowhere. See refreshDragRegions in
  // renderer.js.
  win.webContents.send("window-reshown");
  if (everShown) return;
  everShown = true;
  // Only now can the page measure itself for real (see keepWindowFitted).
  win.webContents.send("window-shown");
}

// Whether this desktop has anywhere to put a tray icon (see trayhost.js).
// Asked once at startup and again whenever the answer would be acted on, since
// a tray host can be turned on — a GNOME extension enabled — while archamp is
// running.
let trayHost = false;
async function checkTrayHost() {
  trayHost = await trayhost.trayHostAvailable();
  return trayHost;
}

const windowStatus = () => ({
  hidden,
  keepHidden: settings.keepHidden(),
  tray: settings.tray(),
  trayHost,
});

// A tray icon, for the desktops that have one: the fourth way to a hidden
// window, and the only one that is there whether or not the player is hidden.
// Its menu holds the one thing anyone would open it for.
let trayIcon = null;

function showFromTray() {
  setHidden(false);
  win?.focus();
}

function updateTray() {
  // Nowhere to put it: Electron's Tray succeeds anyway and draws nothing, so
  // asking first is the only way not to promise an icon that never appears.
  //
  // Wanted but no host known: ask, and come back if the answer is yes. The
  // answer starts out no — the question takes a round trip to the bus — so
  // anything that turns the tray on before that has come back would otherwise
  // be told there is nowhere to put it. It also picks up a host that appeared
  // since, which is what enabling GNOME's AppIndicator extension looks like
  // from here.
  if (settings.tray() && !trayHost) {
    checkTrayHost().then((hosted) => {
      if (hosted) updateTray();
    });
  }
  const wanted = settings.tray() && trayHost;
  if (wanted === (trayIcon != null)) return;
  if (trayIcon != null) {
    trayIcon.destroy();
    trayIcon = null;
    return;
  }
  // The small mark, not the app icon: a tray draws this at about 18 pixels,
  // where the full seven bars and their peaks close into a blob. See
  // build/icon-tray.svg.
  const icon = nativeImage
    .createFromPath(path.join(__dirname, "build", "icon-tray.png"))
    .resize({ width: 128, height: 128 });
  trayIcon = new Tray(icon);
  trayIcon.setToolTip("archamp");
  trayIcon.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show archamp", click: showFromTray },
      { type: "separator" },
      // With a tray icon, closing the player's own window only puts it away.
      // This is the way out, and it has to be here: someone who closed the
      // window to the tray has no window to quit from.
      { label: "Close archamp", click: () => app.quit() },
    ]),
  );
  // Where a click on the icon is reported at all, it does the same thing.
  trayIcon.on("click", showFromTray);
}

// Clients hear about it over the bus; archamp's own menu is told directly, so
// the switch in it says what the plugin last set.
function announceWindow() {
  mpris?.windowChanged();
  win?.webContents.send("window-status", windowStatus());
}

function setHidden(next) {
  const want = Boolean(next);
  if (hidden !== want) {
    hidden = want;
    // Before the player has drawn, this only decides what happens when it has.
    if (drawn) {
      if (hidden) win?.hide();
      else showWindow();
    }
  }
  announceWindow();
}

function createWindow() {
  const size = rememberedSize();
  win = new BrowserWindow({
    ...size,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    // Shown once the player has drawn itself and the window has been fitted
    // to it (see the player-ready handler below).
    show: false,
    // The window's size follows its contents, and double-clicking a title bar
    // (a native drag region) must not maximize it.
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false, // needed so Webamp can fetch local file:// tracks/skins
      // A hidden window is a background window, and Chromium throttles those
      // down to a timer a minute. The position archamp reports, the session it
      // saves and the tags it reads all run on timers, so a hidden player has
      // to keep its own clock.
      backgroundThrottling: false,
    },
  });

  win.loadFile("index.html");
  // Should the player somehow never say it is ready, show the window anyway
  // rather than leave the user with nothing at all.
  const failsafe = setTimeout(() => {
    drawn = true;
    if (!hidden) showWindow();
  }, 5000);
  ipcMain.once("player-ready", (_event, milliseconds) => {
    clearTimeout(failsafe);
    console.log(`[archamp] drawn in ${milliseconds}ms${hidden ? ", hidden" : ""}`);
    drawn = true;
    if (!hidden) showWindow();
    // And only now is there a player to hand this launch's files to.
    playLaunch();
    // Asked once, with the player on screen behind the question rather than
    // an empty desktop.
    desktop.integrate();
  });
  win.webContents.on("console-message", (_event, _level, message) => {
    console.log("[renderer]", message);
  });
  // Whoever did it — archamp, the plugin, the compositor — clients are told.
  win.on("show", () => mpris?.windowChanged());
  win.on("hide", () => mpris?.windowChanged());
  // The skin browser can outlive the player; closing the player quits the app.
  win.on("closed", () => app.quit());
}

ipcMain.handle("open-audio-files", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Open audio files",
    properties: ["openFile", "multiSelections"],
    filters: [
      // Everything archamp can play, and nothing else — the .lrc beside every
      // track is not a file to open.
      { name: "Audio", extensions: ["mp3", "flac", "ogg", "oga", "opus", "wav", "m4a", "aac", "aif", "aiff"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

// Load list. An M3U's own tracks, read the same way as a playlist opened over
// MPRIS: absolute paths, or paths relative to the playlist.
ipcMain.handle("open-playlist", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Load playlist",
    // The folder archamp and OMedia Controls both save to, so Winamp's Load
    // list opens on the lists the plugin made.
    defaultPath: playlistsFolder(),
    properties: ["openFile"],
    filters: [
      { name: "Playlists", extensions: ["m3u", "m3u8"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const uri = pathToFileURL(result.filePaths[0]).href;
  const urls = await tracksForUri(uri);
  await playlistOpened(uri, urls);
  return urls;
});

// Save list. The renderer writes the M3U, since it holds the playlist.
ipcMain.handle("save-playlist", async (_event, text) => {
  // Saving into the folder OMedia Controls reads is what makes a list saved
  // here show up there, so the dialog opens on it and makes it if it has to.
  const folder = playlistsFolder();
  await fs.mkdir(folder, { recursive: true }).catch(() => {});
  const result = await dialog.showSaveDialog(win, {
    title: "Save playlist",
    defaultPath: path.join(folder, "playlist.m3u"),
    filters: [{ name: "Playlists", extensions: ["m3u", "m3u8"] }],
  });
  if (result.canceled || !result.filePath) return false;
  const file = path.extname(result.filePath) ? result.filePath : `${result.filePath}.m3u`;
  try {
    await fs.writeFile(file, text, "utf8");
  } catch (error) {
    dialog.showErrorBox("Save playlist", `${file} could not be written: ${error.message}`);
    return false;
  }
  // The queue is that playlist now — it is what was just written — so the
  // player names it without the list having to be loaded again.
  const uri = pathToFileURL(file).href;
  await playlistOpened(uri, await tracksForUri(uri));
  return true;
});

// Open Folder: every audio file under it, the same walk as opening a folder
// over MPRIS.
ipcMain.handle("open-folder", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Open folder",
    // Where the user's music is, which they may have told the plugin.
    defaultPath: musicFolder(),
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const uri = pathToFileURL(result.filePaths[0]).href;
  const urls = await tracksForUri(uri);
  await playlistOpened(uri, urls);
  return urls;
});

// Load Custom Skin: a .wsz (or .zip) of the user's own, from anywhere.
ipcMain.handle("open-skin", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Load skin",
    properties: ["openFile"],
    filters: [
      { name: "Winamp skins", extensions: ["wsz", "zip"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// The equalizer's own file format, which the renderer reads and writes.
ipcMain.handle("open-equalizer", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Load equalizer file",
    properties: ["openFile"],
    filters: [
      { name: "Winamp equalizer files", extensions: ["eqf", "q1"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle("save-equalizer", async () => {
  const result = await dialog.showSaveDialog(win, {
    title: "Save equalizer",
    defaultPath: path.join(app.getPath("music"), "equalizer.eqf"),
    filters: [{ name: "Winamp equalizer files", extensions: ["eqf"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return path.extname(result.filePath) ? result.filePath : `${result.filePath}.eqf`;
});

// What the player was playing, kept beside its other settings. Written
// through a temporary file so a session is never half-written, and read back
// at launch (see restoreSession in renderer.js).
function sessionFile() {
  return path.join(app.getPath("userData"), "session.json");
}

ipcMain.handle("session:load", async () => {
  try {
    const saved = JSON.parse(await fs.readFile(sessionFile(), "utf8"));
    // The queue is about to come back as it was, so where it was opened from
    // names it again — a folder the player was playing keeps its name across
    // a restart. If the folder has gone, nothing matches and nothing is named.
    if (typeof saved?.source === "string" && Array.isArray(saved?.tracks)) {
      await playlistOpened(saved.source, saved.tracks);
    }
    return saved;
  } catch {
    return null;
  }
});

ipcMain.on("session:save", async (_event, session) => {
  const file = sessionFile();
  try {
    if (session == null) {
      await fs.rm(file, { force: true });
      return;
    }
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ ...session, source: openedPlaylistUri() }));
    await fs.rename(`${file}.tmp`, file);
  } catch (error) {
    console.error(`[archamp] session: ${error.message}`);
  }
});

// Which of these files are no longer there, for the playlist's "remove
// missing" — a playlist outlives the files in it.
ipcMain.handle("missing-files", async (_event, files) => {
  const paths = Array.isArray(files) ? files.filter((file) => typeof file === "string") : [];
  const checked = await Promise.all(
    paths.map(async (file) => {
      try {
        await fs.access(file);
        return null;
      } catch {
        return file;
      }
    }),
  );
  return checked.filter(Boolean);
});

// What the playlist's File Info shows: what the file is, and what it says
// about itself. Read fresh rather than from the tag cache in mpris.js, which
// keeps only what MPRIS needs.
ipcMain.handle("file-info", async (_event, file) => {
  try {
    const { parseFile } = await import("music-metadata");
    const [{ common, format }, stat] = await Promise.all([
      parseFile(file, { duration: true }),
      fs.stat(file),
    ]);
    return {
      name: path.basename(file),
      folder: path.dirname(file),
      size: stat.size,
      // The cover as a file the page can load, written out of the track the
      // same way the art MPRIS hands out is (see mpris.js).
      art: await writeEmbeddedArt(common.picture?.[0]),
      format: {
        codec: format.codec ?? format.container ?? "",
        bitrate: format.bitrate ?? 0,
        sampleRate: format.sampleRate ?? 0,
        channels: format.numberOfChannels ?? 0,
        lossless: Boolean(format.lossless),
        duration: format.duration ?? 0,
      },
      tags: {
        title: common.title ?? "",
        artist: common.artist ?? "",
        album: common.album ?? "",
        albumArtist: common.albumartist ?? "",
        year: common.year ?? 0,
        track: common.track?.no ?? 0,
        disc: common.disk?.no ?? 0,
        genre: (common.genre ?? []).join(", "),
        comment: (common.comment ?? []).map((one) => one?.text ?? one).filter(Boolean).join(" "),
      },
    };
  } catch (error) {
    return { error: error.message };
  }
});

// Whether this launch was given anything to play, which the player asks
// before restoring what it was playing last time.
ipcMain.handle("startup-files", async () => (await launchUrls()).length > 0);

// ------------------------------------------------------------------ updates
//
// The check is the menu's; the window is opened only when there is something
// to show, and it holds the release it was opened for so the page and the
// command cannot drift apart.
let updateWindow = null;
let pendingUpdate = null;

function openUpdateWindow() {
  if (updateWindow != null) {
    updateWindow.show();
    updateWindow.focus();
    return;
  }
  updateWindow = new BrowserWindow({
    width: 720,
    height: 620,
    minWidth: 420,
    minHeight: 360,
    // Matches the page, so the window doesn't flash while loading.
    backgroundColor: "#14151a",
    webPreferences: {
      preload: path.join(__dirname, "update-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  updateWindow.removeMenu();
  updateWindow.loadFile("update.html");
  updateWindow.on("closed", () => {
    updateWindow = null;
  });
}

ipcMain.handle("update:check", async () => {
  const found = await updater.check();
  pendingUpdate = found.release ? found : null;
  if (pendingUpdate != null) openUpdateWindow();
  return { installed: found.installed, checkedAt: found.checkedAt, error: found.error, available: found.release != null };
});
ipcMain.handle("update:last-checked", async () => (await updater.readCache()).checkedAt);
ipcMain.handle("update:release", () => pendingUpdate);
ipcMain.handle("update:run", () => updater.runUpdate(pendingUpdate?.release?.command));
ipcMain.on("update:copy", (_event, text) => {
  if (typeof text === "string" && text !== "") clipboard.writeText(text);
});
ipcMain.on("update:close", () => updateWindow?.close());
// Restarting into what the update just wrote starts the AppImage, not this
// process's own executable: inside an AppImage that is a binary on a mount
// that goes away when the process does, so relaunching it would either fail or
// bring back the very version that was replaced. APPIMAGE is the file the
// command wrote to. The waiting for this process to go is done outside it —
// see updater.js, which explains why Electron's own relaunch cannot be used.
ipcMain.on("update:restart", () => {
  const appImage = process.env.APPIMAGE;
  if (appImage) restart.scheduleRestart(process.pid, appImage);
  else app.relaunch();
  app.quit();
});

// The about box: a window of its own, like the skin browser and the update
// window, rather than a drawer in the player.
let aboutWindow = null;

function openAboutWindow() {
  if (aboutWindow != null) {
    aboutWindow.show();
    aboutWindow.focus();
    return;
  }
  aboutWindow = new BrowserWindow({
    // The same window as the skin browser and the update window, so archamp's
    // three windows are one shape rather than three.
    width: 1100,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    // Matches the page, so the window doesn't flash while loading.
    backgroundColor: "#14151a",
    webPreferences: {
      preload: path.join(__dirname, "about-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  aboutWindow.removeMenu();
  // An about box is not somewhere to browse: the one link it has opens in the
  // desktop's browser, and nothing else may take the window anywhere.
  aboutWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  aboutWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  aboutWindow.loadFile("about.html");
  aboutWindow.on("closed", () => {
    aboutWindow = null;
  });
}

ipcMain.on("about:open", () => openAboutWindow());
ipcMain.on("about:close", () => aboutWindow?.close());
ipcMain.on("about:webamp", () => shell.openExternal("https://webamp.org/"));
ipcMain.handle("about:info", () => ({
  version: app.getVersion(),
  // The app icon itself, so the page needs no file access of its own and
  // there is one copy of the artwork rather than two.
  icon: aboutIcon(),
}));

// Read once: it is a 2KB file and the window may be opened again. The bare
// mark, not the app icon: the about page draws it on the panel's own
// background, where the icon's dark tile would sit on the page as a patch of
// some other theme.
let iconUri = null;
function aboutIcon() {
  if (iconUri != null) return iconUri;
  try {
    const svg = fsSync.readFileSync(path.join(__dirname, "build", "icon-bare.svg"));
    iconUri = `data:image/svg+xml;base64,${svg.toString("base64")}`;
  } catch (error) {
    console.error(`[archamp] about icon: ${error.message}`);
    iconUri = "";
  }
  return iconUri;
}

// archamp's own menu offers the same choice as the plugin's switch, so it
// works the same way without the plugin.
ipcMain.handle("window-status", () => windowStatus());
// The player's close button, when there is a tray to put it in: puts archamp
// away for now without touching the "keep hidden" setting, which is about
// where it starts rather than where it is.
ipcMain.on("hide-window", () => setHidden(true));
// The one way out that is always a way out: the menu's Close archamp, and the
// tray's. Closing the window is no longer it (see the close button above).
ipcMain.on("quit-app", () => app.quit());
ipcMain.handle("run-in-tray", async (_event, value) => {
  // Asked again here rather than trusted from startup: enabling GNOME's
  // AppIndicator extension is exactly the thing someone does between opening
  // archamp and reaching for this switch.
  if (value) await checkTrayHost();
  settings.setTray(value);
  updateTray();
  announceWindow();
  return windowStatus();
});
ipcMain.handle("keep-hidden", async (_event, value) => {
  const want = Boolean(value);
  if (want) {
    // The window is about to go, and nothing in archamp can bring it back.
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      title: "archamp",
      message: "Keep archamp's window hidden?",
      detail:
        "archamp keeps playing with no window: the audio, the media keys and OMedia Controls all carry on.\n\n" +
        (settings.tray() && trayHost
          ? "To bring the window back, use Show archamp in the system tray, start archamp again from your launcher, or use OMedia Controls, which has the same switch."
          : trayHost
            ? "To bring the window back, start archamp again from your launcher — or from OMedia Controls, which has the same switch. Show in tray puts it a click away."
            // Nothing on this desktop is listening for tray icons, so there is
            // no point sending anyone to look for one.
            : "To bring the window back, start archamp again from your launcher — or from OMedia Controls, which has the same switch."),
      buttons: ["Hide", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return windowStatus();
  }
  settings.setKeepHidden(want);
  setHidden(want);
  announceWindow();
  return windowStatus();
});

// The player's own menu offers it too, for anyone who said "not now", and
// asks first whether there is anything to offer.
ipcMain.handle("desktop-status", () => desktop.status());
ipcMain.handle("add-to-applications", async () => {
  await desktop.addFromMenu();
  return desktop.status();
});

ipcMain.on("show-error", (_event, title, message) => {
  dialog.showErrorBox(String(title), String(message));
});

ipcMain.on("fit-window", (_event, { width, height }) => {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return;
  if (width < 1 || height < 1) return;
  const [currentWidth, currentHeight] = win.getContentSize();
  if (width === currentWidth && height === currentHeight) return;
  win.setContentSize(width, height);
  rememberSize({ width, height });
});

ipcMain.handle("work-area", () => screen.getDisplayMatching(win.getBounds()).workAreaSize);

// The renderer used to derive this from devicePixelRatio / webFrame.getZoomFactor(),
// but on a fractional-scale Wayland output that pair can settle at a self-consistent
// but wrong value (see the comment on trueScale in renderer.js) — asking the display
// directly is the reliable source.
ipcMain.handle("display-scale-factor", () => screen.getDisplayMatching(win.getBounds()).scaleFactor);

// archamp's own chrome follows the desktop's theme (see theme.js): the
// palette goes to every window as it loads, and again whenever it changes.
let theme = readTheme();

ipcMain.handle("theme", () => theme);

function sendTheme() {
  for (const target of BrowserWindow.getAllWindows()) {
    target.webContents.send("theme", theme);
  }
}

app.on("second-instance", async (_event, argv) => {
  if (win == null) return;
  const played = await playFrom(argv);
  // Starting archamp again with nothing to play is someone looking for the
  // window. There is no minimizing on Wayland and no taskbar to click, so the
  // launcher is where anyone would go to get a hidden player back — and this
  // is what the launcher does. Handing it files is the plugin or a file
  // manager at work, and that should not put the window in the way.
  if (argv.includes("--hidden")) setHidden(true);
  else if (argv.includes("--show") || !played) setHidden(false);
  if (hidden) return;
  showWindow();
  win.focus();
});

app.whenReady().then(async () => {
  // Before the window exists, because a window rule applies when a window is
  // mapped and not retroactively. It costs a few milliseconds of a launch that
  // takes about a second and a half, and does nothing off Hyprland.
  await hyprland.floatWindow();
  watchTheme((next) => {
    theme = next;
    sendTheme();
  });
  installMuseum(() => win);
  updateTray();
  mpris = startMpris(() => win, {
    hidden: () => hidden,
    setHidden,
    keepHidden: settings.keepHidden,
    tray: settings.tray,
    setTray: (value) => {
      settings.setTray(value);
      updateTray();
      announceWindow();
    },
    // Turning it on hides the player now as well as next time, which is what
    // anyone flipping a switch called "keep the window hidden" means by it.
    setKeepHidden: (value) => {
      settings.setKeepHidden(value);
      setHidden(Boolean(value));
      announceWindow();
    },
  });
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
