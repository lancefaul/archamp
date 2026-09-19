// Starting the new version after an update has put it in place.
//
// No Electron here: this is a plain process question, and it is the part of
// updating that cannot be tried out by reading it, so it is kept where a test
// can run it for real (test/restart.test.mjs).
const { spawn } = require("child_process");

// Starting the new version cannot be Electron's own app.relaunch(): it starts
// the new process as this one is going down, and archamp holds a
// single-instance lock. The new copy finds the old one still holding it, hands
// over its arguments and exits — and the old one is quitting anyway, so
// nothing is left running at all. Measured: archamp went away and did not come
// back.
//
// So the waiting happens outside archamp. A detached shell watches this
// process go and then execs the file the update wrote, with no arguments —
// what was open is in the saved session, and passing the files again would
// put them in it twice. It gives up after twenty seconds rather than start a
// second copy alongside a player that would not quit.
const RESTART_SCRIPT =
  'n=0; while kill -0 "$1" 2>/dev/null && [ "$n" -lt 100 ]; do sleep 0.2; n=$((n+1)); done; ' +
  'kill -0 "$1" 2>/dev/null || exec "$2"';

function restartArgs(pid, target) {
  return ["-c", RESTART_SCRIPT, "archamp-restart", String(pid), target];
}

function scheduleRestart(pid, target) {
  if (typeof target !== "string" || target === "") return false;
  try {
    spawn("/bin/sh", restartArgs(pid, target), { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch (error) {
    console.error(`[archamp] restart: ${error.message}`);
    return false;
  }
}

module.exports = { restartArgs, scheduleRestart, RESTART_SCRIPT };
