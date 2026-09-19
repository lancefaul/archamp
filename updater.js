// Looking for a newer archamp, and putting it in place.
//
// An AppImage has no package manager behind it: it is one file, and updating
// is replacing that file. So the update is a shell command, shown in full
// before it runs — the user can read it, copy it, and run it themselves
// instead. archamp knows which file it is through $APPIMAGE.
const { app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const { RELEASES_API, RELEASES_PAGE, CHECK_TIMEOUT_MS, parseReleases, updateCommand } = require("./releases");

const cacheFile = () => path.join(app.getPath("userData"), "update.json");

async function readCache() {
  try {
    const saved = JSON.parse(await fs.readFile(cacheFile(), "utf8"));
    const checkedAt = Number(saved?.checkedAt);
    return { checkedAt: Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : 0 };
  } catch {
    return { checkedAt: 0 };
  }
}

async function writeCache(checkedAt) {
  const file = cacheFile();
  try {
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ version: 1, checkedAt }));
    await fs.rename(`${file}.tmp`, file);
  } catch (error) {
    console.error(`[archamp] update cache: ${error.message}`);
  }
}

// What the menu asks. Always answers rather than throwing: "couldn't reach
// GitHub" is something the row has to be able to say.
async function check() {
  const installed = app.getVersion();
  let release = null;
  let error = null;
  try {
    const response = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `archamp/${installed}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    // 404 is what a private repository looks like from outside it.
    if (!response.ok) throw Object.assign(new Error(`GitHub answered ${response.status}.`), { fromGitHub: true });
    release = parseReleases(await response.json(), installed);
  } catch (cause) {
    if (cause.fromGitHub) error = cause.message;
    else if (cause.name === "TimeoutError") error = "GitHub did not answer in time.";
    else error = `Could not reach GitHub (${cause.message}).`;
  }
  const checkedAt = Date.now();
  if (error == null) await writeCache(checkedAt);
  return {
    installed,
    checkedAt: error == null ? checkedAt : (await readCache()).checkedAt,
    release: release && { ...release, command: updateCommand(release) },
    error,
  };
}

// Runs the command shown, and says how it went. The AppImage is replaced
// underneath the running copy, which is safe: the mount holds the old file
// open until archamp quits, so the new one is what starts next time.
function runUpdate(command) {
  return new Promise((resolve) => {
    if (typeof command !== "string" || command === "") {
      resolve({ ok: false, message: "There is nothing to run." });
      return;
    }
    const shell = spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    shell.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    shell.stdout.on("data", () => {});
    shell.on("error", (error) => resolve({ ok: false, message: error.message }));
    shell.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, message: "Updated. Restart archamp to run the new version." });
        return;
      }
      const tail = errors.trim().split("\n").slice(-3).join("\n");
      resolve({ ok: false, message: tail === "" ? `The command failed (exit ${code}).` : tail });
    });
  });
}

module.exports = { check, runUpdate, readCache, RELEASES_PAGE };
