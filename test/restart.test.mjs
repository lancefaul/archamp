// Starting the new version after an update. This is run for real rather than
// read: a restart that quietly does nothing looks exactly like a restart that
// worked, because either way the window you were looking at has gone.
//
// The thing under test is the waiting. Electron's own app.relaunch() starts
// the new copy as the old one is going down, and archamp holds a
// single-instance lock — so the new copy found the lock held, handed over its
// arguments and exited, and archamp never came back. Here the waiting is a
// detached shell outside the process, and these are the three things it has
// to get right: wait, then start; never start two; give up rather than hang.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { restartArgs, scheduleRestart } = require("../restart.js");

// A process to stand in for the archamp that is quitting, and a script to
// stand in for the archamp that should start once it has.
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archamp-restart-"));
  const marker = path.join(dir, "started");
  const target = path.join(dir, "archamp");
  await fs.writeFile(target, `#!/bin/sh\ndate +%s%N > ${JSON.stringify(marker)}\n`);
  await fs.chmod(target, 0o755);
  const quitting = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
  return { dir, marker, target, quitting };
}

async function started(marker, within) {
  for (let waited = 0; waited < within; waited += 50) {
    try {
      await fs.access(marker);
      return true;
    } catch {
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  return false;
}

test("the new version starts once the old one has gone, and not before", async () => {
  const { dir, marker, target, quitting } = await fixture();
  try {
    assert.ok(scheduleRestart(quitting.pid, target));

    // While the old process is alive nothing may start: two archamps would
    // fight over the single-instance lock and one would lose its session.
    assert.equal(await started(marker, 600), false, "started while the old process was still running");

    quitting.kill("SIGKILL");
    assert.ok(await started(marker, 8000), "never started after the old process had gone");
  } finally {
    quitting.kill("SIGKILL");
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a process that will not quit is left alone rather than doubled", async () => {
  const { dir, marker, target, quitting } = await fixture();
  try {
    // The wait is bounded at twenty seconds; shortened here to the same shape.
    const args = restartArgs(quitting.pid, target).slice();
    args[1] = args[1].replace('"$n" -lt 100', '"$n" -lt 3');
    spawn("/bin/sh", args, { detached: true, stdio: "ignore" }).unref();

    assert.equal(await started(marker, 2500), false, "started alongside a player that had not quit");
  } finally {
    quitting.kill("SIGKILL");
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("there is nothing to start without a file to start", () => {
  assert.equal(scheduleRestart(process.pid, ""), false);
  assert.equal(scheduleRestart(process.pid, undefined), false);
  assert.equal(scheduleRestart(process.pid, null), false);
});

test("a path with a space in it is still one argument", async () => {
  const { dir, marker, quitting } = await fixture();
  const spaced = path.join(dir, "arch amp");
  try {
    await fs.writeFile(spaced, `#!/bin/sh\ndate +%s%N > ${JSON.stringify(marker)}\n`);
    await fs.chmod(spaced, 0o755);
    assert.ok(scheduleRestart(quitting.pid, spaced));
    quitting.kill("SIGKILL");
    assert.ok(await started(marker, 8000), "a path with a space in it did not start");
  } finally {
    quitting.kill("SIGKILL");
    await fs.rm(dir, { recursive: true, force: true });
  }
});
