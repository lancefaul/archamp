// Whether this desktop has anywhere to put a tray icon.
//
// Electron's Tray succeeds on every platform and draws nothing where nothing
// is listening, so the mistake this guards against is silent: archamp offers
// the tray, the window hides, and the icon it promised is nowhere. A stock
// GNOME is exactly that desktop — Shell has had no StatusNotifierItem support
// since 3.26 — so "no" has to be an answer archamp can reach.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { hasTrayHost, WATCHER } = require("../trayhost.js");
const run = promisify(execFile);

test("a tray host is whoever has claimed the watcher name", () => {
  assert.equal(hasTrayHost([WATCHER]), true);
  assert.equal(hasTrayHost(["org.freedesktop.DBus", WATCHER, "org.mpris.MediaPlayer2.archamp"]), true);
});

test("nothing else on the bus counts, however much it looks the part", () => {
  assert.equal(hasTrayHost([]), false);
  assert.equal(hasTrayHost(["org.freedesktop.DBus"]), false);
  // freedesktop's own name was never settled on, and taking it is not a
  // promise to draw anything.
  assert.equal(hasTrayHost(["org.freedesktop.StatusNotifierWatcher"]), false);
  // A near miss is a miss.
  assert.equal(hasTrayHost(["org.kde.StatusNotifierWatcher.Extra"]), false);
});

test("an answer that is not a list of names is no", () => {
  assert.equal(hasTrayHost(null), false);
  assert.equal(hasTrayHost(undefined), false);
  assert.equal(hasTrayHost("org.kde.StatusNotifierWatcher"), false);
  assert.equal(hasTrayHost({ 0: WATCHER }), false);
});

// The asking itself, against real buses. A fresh session bus has no tray host
// on it, which is the GNOME case without needing GNOME; an address that goes
// nowhere is the no-session-bus case, and dbus-native reports that on the
// connection underneath rather than on the bus, where an unhandled 'error'
// would take archamp down on startup.
const ask = 'require("./trayhost.js").trayHostAvailable().then((y) => { console.log(y); process.exit(0); });';

test("a bus with no tray host on it answers no", async () => {
  const { stdout } = await run("dbus-run-session", ["--", process.execPath, "-e", ask], {
    cwd: new URL("..", import.meta.url).pathname,
  });
  assert.equal(stdout.trim(), "false");
});

test("a bus that cannot be reached answers no rather than throwing", async () => {
  const { stdout } = await run(process.execPath, ["-e", ask], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent" },
  });
  assert.equal(stdout.trim(), "false");
});
