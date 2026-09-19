// Whether this desktop has anywhere to put a tray icon.
//
// There is no portable answer from Electron: new Tray() succeeds everywhere
// and draws nothing where nothing is listening. On Linux a tray icon is a
// StatusNotifierItem, and it only appears if something has claimed the
// watcher name on the session bus. GNOME Shell dropped its own support in
// 3.26 and has none without the AppIndicator extension, so on a stock GNOME
// archamp would offer a tray, hide its window, and leave the icon it promised
// nowhere on screen.
//
// So the offer is made only where it can be kept.
const dbus = require("dbus-native");

// KDE's name is the one every tray host takes — GNOME's AppIndicator
// extension, Quickshell, waybar, xfce4-panel alike. freedesktop's own
// org.freedesktop.StatusNotifierWatcher was never settled on.
const WATCHER = "org.kde.StatusNotifierWatcher";

// Split out from the asking so it can be tested without a bus.
function hasTrayHost(names) {
  return Array.isArray(names) && names.indexOf(WATCHER) !== -1;
}

// One bus call, and never an exception: "no" is the right answer whenever the
// question cannot be put, which includes there being no session bus at all.
function trayHostAvailable() {
  return new Promise((resolve) => {
    let bus = null;
    const done = (answer) => {
      try {
        bus?.connection?.end();
      } catch {}
      resolve(answer);
    };
    try {
      bus = dbus.sessionBus();
      // Both objects: a bus that cannot be reached at all reports it on the
      // connection underneath rather than on the bus, and an 'error' with no
      // listener takes the process down. A machine with no session bus is not
      // a machine archamp should refuse to start on.
      bus.on("error", () => done(false));
      bus.connection?.on("error", () => done(false));
      bus.listNames((error, names) => done(!error && hasTrayHost(names)));
    } catch {
      done(false);
    }
  });
}

module.exports = { hasTrayHost, trayHostAvailable, WATCHER };
