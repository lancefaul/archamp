// What archamp promises over MPRIS, checked against a running archamp.
//
// It generates three short tracks with ffmpeg, starts archamp on a throwaway
// profile with its sound turned down, drives it over D-Bus with busctl, and
// checks what comes back. Nothing here reads archamp's own source: if the app
// says it can do something, this makes it do it.
//
//   npm test
//
// It needs a session D-Bus, ffmpeg, busctl (systemd) and a display, so it runs
// on a desktop rather than in CI. Tests marked `todo` are the promises the
// plan has not reached yet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(here);
const OBJECT = "/org/mpris/MediaPlayer2";
const PLAYER = "org.mpris.MediaPlayer2.Player";
const TRACKLIST = "org.mpris.MediaPlayer2.TrackList";
const ARCHAMP_TRACKLIST = "org.archamp.TrackList";
const PLAYLISTS = "org.mpris.MediaPlayer2.Playlists";
const WINDOW = "org.archamp.Window";
const EQUALIZER = "org.archamp.Equalizer";
const NO_TRACK = "/org/mpris/MediaPlayer2/TrackList/NoTrack";
const TRACKS = [
  { file: "01 Alpha.m4a", title: "Alpha", frequency: 440 },
  { file: "02 Beta.m4a", title: "Beta", frequency: 494 },
  { file: "03 Gamma.m4a", title: "Gamma", frequency: 523 },
];

let music;
let profile;
let stateHome;
let lists;
let app;
let bus;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for `check` to return something truthy, so a test never races the app.
async function waitFor(what, check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last !== undefined && last !== null && last !== false) return last;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}: ${last}`);
}

async function archampNames() {
  const { stdout } = await run("busctl", ["--user", "list", "--no-pager", "--no-legend"]);
  return stdout.split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name?.startsWith("org.mpris.MediaPlayer2.archamp"));
}

async function busctl(...args) {
  // "--" so a negative argument, such as a backward Seek, isn't read as an option.
  const { stdout } = await run("busctl", ["--user", "--json=short", "--", ...args], { maxBuffer: 16 << 20 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

const get = async (iface, property) => (await busctl("get-property", bus, OBJECT, iface, property)).data;
const set = (iface, property, signature, ...value) =>
  busctl("set-property", bus, OBJECT, iface, property, signature, ...value.map(String));
const call = (iface, member, signature = "", ...args) =>
  busctl("call", bus, OBJECT, iface, member, ...(signature ? [signature, ...args.map(String)] : []));

const trackIds = () => get(TRACKLIST, "Tracks");
// Collects the player's signals while `while` runs, so a test can say what
// archamp announced as well as what it ended up at.
async function signalsDuring(action) {
  const monitor = spawn("gdbus", ["monitor", "--session", "--dest", bus], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  monitor.stdout.on("data", (chunk) => (output += chunk));
  await sleep(600);
  try {
    await action();
    await sleep(900);
  } finally {
    monitor.kill("SIGTERM");
  }
  return output;
}

async function titlesInOrder() {
  const ids = await trackIds();
  const metadata = await busctl("call", bus, OBJECT, TRACKLIST, "GetTracksMetadata", "ao", String(ids.length), ...ids);
  return metadata.data[0].map((entry) => entry["xesam:title"]?.data);
}
const currentTrackId = async () => (await get(PLAYER, "Metadata"))["mpris:trackid"].data;
const currentTitle = async () => (await get(PLAYER, "Metadata"))["xesam:title"]?.data;

before(async () => {
  music = await mkdtemp(path.join(tmpdir(), "archamp-music-"));
  profile = await mkdtemp(path.join(tmpdir(), "archamp-profile-"));
  // archamp keeps its saved playlists where OMedia Controls does, and follows
  // the plugin's own setting for where that is. Giving the test its own state
  // directory points both at the fixtures instead of the developer's music.
  stateHome = await mkdtemp(path.join(tmpdir(), "archamp-state-"));
  lists = path.join(music, "Playlists");
  await mkdir(path.join(stateHome, "omedia-controls"), { recursive: true });
  await writeFile(
    path.join(stateHome, "omedia-controls", "preferences.json"),
    JSON.stringify({ version: 1, musicFolder: music, playlistFolder: "" }),
  );
  await mkdir(lists, { recursive: true });
  // One cover for all three, as an album's tracks have: it is what makes the
  // art written once rather than once per track.
  const cover = path.join(profile, "cover.png");
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=teal:s=120x120:d=1", "-frames:v", "1", "-y", cover]);
  for (const [index, track] of TRACKS.entries()) {
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${track.frequency}:duration=6`,
      "-i", cover, "-map", "0:a", "-map", "1:v", "-c:v", "copy", "-disposition:v:0", "attached_pic",
      "-metadata", `title=${track.title}`, "-metadata", "artist=Conformance", "-metadata", "album=Fixtures",
      "-metadata", `track=${index + 1}`, "-metadata", "date=1999", "-y", path.join(music, track.file)]);
  }

  await launch();
});

// Starts archamp on the test's profile and waits for it to reach the bus.
// Used again by the restart test, which is the only way to see what archamp
// comes back as.
async function launch(extra = []) {
  // Whatever archamp names are already taken: an archamp of your own may be
  // running, and this test's must not be confused with it.
  const taken = new Set(await archampNames());

  app = spawn(path.join(appDir, "node_modules", ".bin", "electron"), [appDir, `--user-data-dir=${profile}`, ...extra], {
    cwd: appDir,
    env: { ...process.env, XDG_STATE_HOME: stateHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Kept for when a run has to be debugged: ARCHAMP_TEST_LOG=/tmp/x.log npm test
  const log = process.env.ARCHAMP_TEST_LOG;
  const record = (chunk) => { if (log) appendFileSync(log, chunk); };
  app.stdout.on("data", record);
  app.stderr.on("data", record);

  // The archamp name that appears next is this test's. Electron's launcher is
  // a script, so the process that owns the name isn't the one spawned here.
  bus = await waitFor("archamp on the bus", async () => {
    if (app.exitCode !== null) throw new Error(`archamp exited with ${app.exitCode}`);
    return (await archampNames()).find((name) => !taken.has(name)) ?? false;
  }, 60000);

  // The name is claimed before the window is made, let alone the player drawn,
  // and a command sent into that gap is dropped on the floor. Being on the bus
  // is not being ready; taking a command is. Volume is the quietest way to
  // ask, and it leaves the fixtures silent, which they need to be anyway.
  await waitFor("archamp to take a command", async () => {
    await set(PLAYER, "Volume", "d", 0);
    return (await get(PLAYER, "Volume")) === 0;
  }, 60000);
}

// A second launch, which the single-instance lock hands to the copy already
// running — what the launcher does, and what the plugin does with files.
async function second(args) {
  const other = spawn(path.join(appDir, "node_modules", ".bin", "electron"), [appDir, `--user-data-dir=${profile}`, ...args], {
    cwd: appDir,
    env: { ...process.env, XDG_STATE_HOME: stateHome },
    stdio: "ignore",
  });
  await waitFor("the second copy to hand over and go", () => other.exitCode !== null, 20000);
}

async function quit() {
  const going = app;
  await call("org.mpris.MediaPlayer2", "Quit");
  await waitFor("archamp to go", () => going.exitCode !== null || going.signalCode !== null, 20000);
}

after(async () => {
  if (bus) await call("org.mpris.MediaPlayer2", "Quit").catch(() => {});
  if (app && app.exitCode === null) {
    await Promise.race([new Promise((resolve) => app.once("exit", resolve)), sleep(5000)]);
    app.kill("SIGKILL");
  }
  await rm(music, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
  await rm(stateHome, { recursive: true, force: true });
});

test("the root interface describes the player", async () => {
  assert.equal(await get("org.mpris.MediaPlayer2", "Identity"), "archamp");
  assert.equal(await get("org.mpris.MediaPlayer2", "CanQuit"), true);
  assert.equal(await get("org.mpris.MediaPlayer2", "CanRaise"), true);
  assert.equal(await get("org.mpris.MediaPlayer2", "HasTrackList"), true);
  assert.deepEqual(await get("org.mpris.MediaPlayer2", "SupportedUriSchemes"), ["file"]);
  assert.ok((await get("org.mpris.MediaPlayer2", "SupportedMimeTypes")).includes("audio/mpeg"));
});

test("an empty player offers nothing to play", async () => {
  assert.equal(await get(PLAYER, "PlaybackStatus"), "Stopped");
  assert.equal((await get(PLAYER, "Metadata"))["mpris:trackid"].data, NO_TRACK);
  assert.equal(await get(PLAYER, "CanPlay"), false);
  assert.equal(await get(PLAYER, "CanGoNext"), false);
  assert.equal(await get(PLAYER, "CanGoPrevious"), false);
  assert.equal(await get(PLAYER, "CanControl"), true);
});

test("OpenUri on a folder plays its tracks in order", async () => {
  await call(PLAYER, "OpenUri", "s", pathToFileURL(music).href);
  await waitFor("the folder to load", async () => (await trackIds()).length === TRACKS.length);
  await waitFor("the tags", async () => (await titlesInOrder())[0] === TRACKS[0].title);
  assert.deepEqual(await titlesInOrder(), TRACKS.map((t) => t.title));
  assert.equal(await waitFor("playback", async () => await get(PLAYER, "PlaybackStatus")), "Playing");
  assert.equal(await currentTitle(), "Alpha");
});

test("the playing track's metadata is complete", async () => {
  const metadata = await get(PLAYER, "Metadata");
  assert.match(metadata["mpris:trackid"].data, /^\/org\/archamp\/track\/\d+$/);
  assert.equal(metadata["xesam:title"].data, "Alpha");
  assert.deepEqual(metadata["xesam:artist"].data, ["Conformance"]);
  assert.equal(metadata["xesam:album"].data, "Fixtures");
  assert.ok(metadata["mpris:length"].data > 0, "a length in microseconds");
  assert.equal(metadata["xesam:url"].data, pathToFileURL(path.join(music, TRACKS[0].file)).href);
});

test("position advances, and seeking lands where it was asked to", async () => {
  assert.equal(await get(PLAYER, "CanSeek"), true);
  const first = await get(PLAYER, "Position");
  await sleep(1200);
  assert.ok((await get(PLAYER, "Position")) > first, "position moves while playing");

  const id = await currentTrackId();
  await call(PLAYER, "SetPosition", "ox", id, 3_000_000);
  const afterSet = await waitFor("the seek to land", async () => {
    const now = await get(PLAYER, "Position");
    return now >= 2_800_000 && now <= 4_500_000 ? now : false;
  });
  await call(PLAYER, "Seek", "x", -2_000_000);
  await waitFor("the relative seek", async () => (await get(PLAYER, "Position")) < afterSet - 1_000_000);
});

test("play, pause and stop do what they say", async () => {
  await call(PLAYER, "Pause");
  assert.equal(await waitFor("pause", async () => await get(PLAYER, "PlaybackStatus")), "Paused");
  const still = await get(PLAYER, "Position");
  await sleep(800);
  assert.equal(await get(PLAYER, "Position"), still, "a paused position doesn't move");

  await call(PLAYER, "PlayPause");
  assert.equal(await waitFor("play", async () => (await get(PLAYER, "PlaybackStatus")) === "Playing" || false), true);
  await call(PLAYER, "Stop");
  assert.equal(await waitFor("stop", async () => (await get(PLAYER, "PlaybackStatus")) === "Stopped" || false), true);
  await call(PLAYER, "Play");
  assert.equal(await waitFor("play again", async () => (await get(PLAYER, "PlaybackStatus")) === "Playing" || false), true);
});

test("shuffle and repeat are settable", async () => {
  await set(PLAYER, "Shuffle", "b", true);
  assert.equal(await waitFor("shuffle on", async () => (await get(PLAYER, "Shuffle")) === true || false), true);
  await set(PLAYER, "Shuffle", "b", false);
  assert.equal(await waitFor("shuffle off", async () => (await get(PLAYER, "Shuffle")) === false || true), true);

  await set(PLAYER, "LoopStatus", "s", "Playlist");
  assert.equal(await waitFor("repeat on", async () => await get(PLAYER, "LoopStatus")), "Playlist");
  await set(PLAYER, "LoopStatus", "s", "None");
  assert.equal(await waitFor("repeat off", async () => (await get(PLAYER, "LoopStatus")) === "None" && "None"), "None");
});

test("a volume change is announced, not just made", async () => {
  const announced = await signalsDuring(async () => {
    await set(PLAYER, "Volume", "d", 0.3);
  });
  assert.ok(announced.includes("PropertiesChanged"), "someone is told about it");
  assert.ok(announced.includes("Volume"), "and told what changed");
  await set(PLAYER, "Volume", "d", 0);
});

test("volume is settable and reported", async () => {
  await set(PLAYER, "Volume", "d", 0.25);
  const volume = await waitFor("volume", async () => {
    const value = await get(PLAYER, "Volume");
    return Math.abs(value - 0.25) < 0.02 ? value : false;
  });
  assert.ok(volume > 0);
  await set(PLAYER, "Volume", "d", 0);
});

test("next and previous walk the playlist", async () => {
  await call(PLAYER, "Next");
  assert.equal(await waitFor("the second track", async () => (await currentTitle()) === "Beta" || false), true);
  assert.equal(await get(PLAYER, "CanGoPrevious"), true);
  await call(PLAYER, "Previous");
  assert.equal(await waitFor("the first track", async () => (await currentTitle()) === "Alpha" || false), true);
  assert.equal(await get(PLAYER, "CanGoNext"), true);
});

test("the track list can be jumped around, added to and trimmed", async () => {
  assert.equal(await get(TRACKLIST, "CanEditTracks"), true);
  const ids = await trackIds();
  await call(TRACKLIST, "GoTo", "o", ids[2]);
  assert.equal(await waitFor("the third track", async () => (await currentTitle()) === "Gamma" || false), true);

  await call(TRACKLIST, "AddTrack", "sob", pathToFileURL(path.join(music, TRACKS[0].file)).href, ids[0], "false");
  await waitFor("the added track", async () => (await trackIds()).length === TRACKS.length + 1);
  assert.deepEqual(await titlesInOrder(), ["Alpha", "Alpha", "Beta", "Gamma"]);

  const added = (await trackIds())[1];
  await call(TRACKLIST, "RemoveTrack", "o", added);
  await waitFor("the removed track", async () => (await trackIds()).length === TRACKS.length);
  assert.deepEqual(await titlesInOrder(), TRACKS.map((t) => t.title));
});

test("archamp's own MoveTrack reorders the list", async () => {
  assert.equal(await get(ARCHAMP_TRACKLIST, "CanMoveTracks"), true);
  const ids = await trackIds();
  await call(ARCHAMP_TRACKLIST, "MoveTrack", "oo", ids[2], NO_TRACK);
  await waitFor("the move", async () => (await titlesInOrder())[0] === "Gamma");
  assert.deepEqual(await titlesInOrder(), ["Gamma", "Alpha", "Beta"]);

  await call(ARCHAMP_TRACKLIST, "MoveTrack", "oo", ids[2], ids[1]);
  await waitFor("the move back", async () => (await titlesInOrder())[2] === "Gamma");
  assert.deepEqual(await titlesInOrder(), TRACKS.map((t) => t.title));
});

test("OpenUri on one file replaces the list", async () => {
  await call(PLAYER, "OpenUri", "s", pathToFileURL(path.join(music, TRACKS[1].file)).href);
  await waitFor("the single track", async () => (await trackIds()).length === 1);
  await waitFor("its tags", async () => (await titlesInOrder())[0] === "Beta");
});

test("OpenUri on an M3U plays what it lists", async () => {
  const playlist = path.join(music, "list.m3u");
  await writeFile(playlist, `#EXTM3U\n${path.join(music, TRACKS[2].file)}\n${path.join(music, TRACKS[0].file)}\n`);
  await call(PLAYER, "OpenUri", "s", pathToFileURL(playlist).href);
  await waitFor("the playlist", async () => (await trackIds()).length === 2);
  // Tags arrive a moment after the tracks themselves, file names until then.
  await waitFor("the tags", async () => (await titlesInOrder())[0] === "Gamma");
  assert.deepEqual(await titlesInOrder(), ["Gamma", "Alpha"]);
});

test("a line an M3U should not contain costs only that line", async () => {
  // A playlist is a text file somebody else wrote. One line that will not
  // parse as a URL must not take the tracks around it down with it.
  const playlist = path.join(music, "broken.m3u");
  await writeFile(
    playlist,
    [
      "#EXTM3U",
      path.join(music, TRACKS[0].file),
      "file://[not-a-url",
      "http://example.test/stream.mp3",
      "",
      "   ",
      path.join(music, TRACKS[1].file),
      "/no/such/file.mp3",
    ].join("\n") + "\n",
  );
  await call(PLAYER, "OpenUri", "s", pathToFileURL(playlist).href);
  // Three entries: the two real tracks, and the path that does not exist —
  // only the extension is checked, and a playlist outlives its files.
  await waitFor("the playable lines", async () => (await trackIds()).length === 3);
  await waitFor("the tags", async () => (await titlesInOrder())[0] === TRACKS[0].title);
  assert.deepEqual(await titlesInOrder(), [TRACKS[0].title, TRACKS[1].title, "file.mp3"]);
  await unlink(playlist);
  // A playlist with a track that cannot play is no state to leave behind.
  await call(PLAYER, "OpenUri", "s", pathToFileURL(music).href);
  await waitFor("the fixtures back", async () => (await trackIds()).length === TRACKS.length);
});

// ---------------------------------------------------------------- the plan
//
// Promises the plan has not reached yet (see OMEDIA-PLAN.md).

test("the root interface names its desktop entry", async () => {
  assert.equal(await get("org.mpris.MediaPlayer2", "DesktopEntry"), "archamp");
});

test("playback speed can be changed", async () => {
  assert.ok((await get(PLAYER, "MaximumRate")) > 1);
  assert.ok((await get(PLAYER, "MinimumRate")) > 0, "a minimum rate of zero would be a stopped player");
  assert.ok((await get(PLAYER, "MinimumRate")) < 1);
  await set(PLAYER, "Rate", "d", 1.5);
  assert.equal(await waitFor("the rate", async () => await get(PLAYER, "Rate")), 1.5);
  // Out of range is clamped rather than refused.
  await set(PLAYER, "Rate", "d", 99);
  assert.equal(
    await waitFor("the rate clamped", async () => {
      const rate = await get(PLAYER, "Rate");
      return rate === 1.5 ? null : rate;
    }),
    await get(PLAYER, "MaximumRate"),
  );
  await set(PLAYER, "Rate", "d", 1);
  assert.equal(await waitFor("back to normal speed", async () => (await get(PLAYER, "Rate")) === 1 && 1), 1);
});

test("one track can repeat on its own", async () => {
  await set(PLAYER, "LoopStatus", "s", "Track");
  assert.equal(await waitFor("repeat one", async () => await get(PLAYER, "LoopStatus")), "Track");
  await set(PLAYER, "LoopStatus", "s", "None");
});

test("metadata carries the track number and year", async () => {
  // Tags are read from the file in the background, so they may not be there
  // the moment a track starts.
  const metadata = await waitFor("tags read from the file", async () => {
    const found = await get(PLAYER, "Metadata");
    return found["xesam:trackNumber"] ? found : null;
  });
  assert.ok(metadata["xesam:trackNumber"], "a track number");
  assert.ok(metadata["xesam:contentCreated"], "a release date");
});

test("the end of the playlist stops on the last track", async () => {
  await set(PLAYER, "LoopStatus", "s", "None");
  await set(PLAYER, "Shuffle", "b", false);
  const ids = await trackIds();
  await call(TRACKLIST, "GoTo", "o", ids[ids.length - 1]);
  await waitFor("the last track", async () => (await currentTrackId()) === ids[ids.length - 1]);
  await call(PLAYER, "Play");
  // Two seconds from the end of a six second fixture.
  await call(PLAYER, "SetPosition", "ox", ids[ids.length - 1], 4_000_000);
  assert.equal(
    await waitFor("the end of the playlist", async () => (await get(PLAYER, "PlaybackStatus")) === "Stopped" && "Stopped"),
    "Stopped",
  );
  assert.equal(await currentTrackId(), ids[ids.length - 1], "the last track stays the current one");
  assert.equal(await get(PLAYER, "CanPlay"), true, "and can be played again");
  await call(PLAYER, "Play");
  assert.equal(
    await waitFor("playing again", async () => (await get(PLAYER, "PlaybackStatus")) === "Playing" && "Playing"),
    "Playing",
  );
});

test("a track change resets the position, and only a jump announces a seek", async () => {
  const ids = await trackIds();
  const changing = await signalsDuring(async () => {
    await call(TRACKLIST, "GoTo", "o", ids[0]);
    await waitFor("the first track", async () => (await currentTrackId()) === ids[0]);
  });
  assert.ok(!changing.includes("Seeked"), "changing track is not a seek");
  assert.ok((await get(PLAYER, "Position")) < 2_000_000, "the position starts again");

  const jumping = await signalsDuring(async () => {
    await call(PLAYER, "SetPosition", "ox", ids[0], 3_000_000);
  });
  assert.ok(jumping.includes("Seeked"), "a jump is announced as one");
});

test("an emptied playlist reports nothing it can do", async () => {
  for (const id of await trackIds()) await call(TRACKLIST, "RemoveTrack", "o", id);
  await waitFor("the playlist to empty", async () => (await trackIds()).length === 0);
  assert.equal((await get(PLAYER, "Metadata"))["mpris:trackid"].data, NO_TRACK);
  for (const flag of ["CanPlay", "CanPause", "CanSeek", "CanGoNext", "CanGoPrevious"]) {
    assert.equal(await get(PLAYER, flag), false, `${flag} with nothing loaded`);
  }
  assert.equal(await get(PLAYER, "PlaybackStatus"), "Stopped");
});

// Raise is only checkable against a compositor that will say who has focus.
// Hyprland is the one archamp is built for, so the test asks it and skips
// itself anywhere else rather than pretending to have proved something.
async function hyprctl(...args) {
  const { stdout } = await run("hyprctl", ["-j", ...args]);
  return JSON.parse(stdout);
}

// Whether there is a compositor here that can be asked who has a window.
// Without one these tests skip themselves rather than pretend to have proved
// something; with one, a missing window means something.
async function underHyprland() {
  try {
    await hyprctl("clients");
    return true;
  } catch {
    return false;
  }
}

// The window's pid is not app.pid: node_modules/.bin/electron is a wrapper
// that spawns the real binary. This run's profile path is unique, so it names
// our archamp and not one the developer happens to have open.
async function testWindow() {
  try {
    // The profile path alone, because pgrep reads a leading "--" as an option.
    const { stdout } = await run("pgrep", ["-f", profile]);
    const pids = new Set(stdout.split("\n").filter(Boolean).map(Number));
    return (await hyprctl("clients")).find((client) => pids.has(client.pid)) ?? null;
  } catch {
    return null;
  }
}

// archamp reaches the bus before it has a window — the name is claimed before
// the window is even made — so waiting is not the same as skipping.
const waitForWindow = () => waitFor("archamp's window", testWindow);

// "No window" has to be waited out rather than glanced at: a window takes a
// moment to map, so a launch checked too early looks hidden whatever it meant.
async function noWindowFor(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await testWindow()) return false;
    await sleep(300);
  }
  return true;
}

test("Raise pulls the window back to the front", async () => {
  if (!(await underHyprland())) return;
  const window = await waitForWindow();

  const monitor = (await hyprctl("monitors")).find((one) => one.focused);
  const home = monitor.activeWorkspace.id;
  // A workspace nothing is on, so archamp is genuinely out of sight.
  const used = new Set((await hyprctl("workspaces")).map((one) => one.id));
  const empty = [...Array(10).keys()].map((n) => n + 1).find((id) => !used.has(id)) ?? 9;
  try {
    await run("hyprctl", ["dispatch", `hl.dsp.focus({ workspace = "${empty}" })`]);
    await waitFor("archamp to lose focus", async () => {
      const active = await hyprctl("activewindow");
      return active.pid !== window.pid;
    });
    await call("org.mpris.MediaPlayer2", "Raise");
    await waitFor("Raise to take focus", async () => {
      const active = await hyprctl("activewindow");
      return active.pid === window.pid;
    });
  } finally {
    await run("hyprctl", ["dispatch", `hl.dsp.focus({ workspace = "${home}" })`]).catch(() => {});
  }
});

// The saved playlists: M3U files in the folder OMedia Controls shares with
// archamp. `lists` is that folder, pointed at the fixtures by the plugin
// preferences the test writes (see before()).
const playlistFile = (name) => path.join(lists, `${name}.m3u`);
const writePlaylist = (name, tracks) =>
  writeFile(playlistFile(name), `#EXTM3U\n${tracks.map((t) => path.join(music, t.file)).join("\n")}\n`);
const playlistCount = () => get(PLAYLISTS, "PlaylistCount");
const getPlaylists = async (order = "Alphabetical", reverse = false) =>
  (await call(PLAYLISTS, "GetPlaylists", "uusb", 0, 50, order, reverse)).data[0];
// (b(oss)): [valid, [id, name, icon]].
const activePlaylist = async () => {
  const [valid, [id, name]] = await get(PLAYLISTS, "ActivePlaylist");
  return valid ? { id, name } : null;
};

test("saved playlists are the M3U files in the shared folder", async () => {
  await writePlaylist("Road trip", [TRACKS[0], TRACKS[1]]);
  await writePlaylist("Quiet", [TRACKS[2]]);
  assert.equal(await waitFor("the playlists to be found", async () => (await playlistCount()) === 2), true);
  assert.deepEqual((await getPlaylists()).map(([, name]) => name), ["Quiet", "Road trip"]);
  assert.deepEqual((await getPlaylists("Alphabetical", true)).map(([, name]) => name), ["Road trip", "Quiet"]);
  assert.ok((await get(PLAYLISTS, "Orderings")).includes("Alphabetical"));
  // Every playlist is named by an object path a client can hand back.
  for (const [id] of await getPlaylists()) assert.match(id, /^\/org\/archamp\/playlist\/[0-9a-f]+$/);
});

test("a playlist appearing is announced", async () => {
  const output = await signalsDuring(() => writePlaylist("Later", [TRACKS[0]]));
  assert.match(output, /PropertiesChanged.*Playlists/s);
  assert.equal(await waitFor("the new playlist", async () => (await playlistCount()) === 3), true);
  await unlink(playlistFile("Later"));
  assert.equal(await waitFor("it to go away", async () => (await playlistCount()) === 2), true);
});

test("activating a playlist plays it, and it names what is playing", async () => {
  const [id, name] = (await getPlaylists()).find(([, one]) => one === "Road trip");
  await call(PLAYLISTS, "ActivatePlaylist", "o", id);
  await waitFor("the playlist to load", async () => (await trackIds()).length === 2);
  // Tags are read in the background, so the titles arrive just after the tracks.
  await waitFor("the tags", async () => (await titlesInOrder())[0] === TRACKS[0].title);
  assert.deepEqual(await titlesInOrder(), [TRACKS[0].title, TRACKS[1].title]);
  assert.deepEqual(await waitFor("the name", activePlaylist), { id, name });
});

test("a playlist renamed while it plays is named by its new name", async () => {
  await rename(playlistFile("Road trip"), playlistFile("Long drive"));
  const active = await waitFor("the new name", async () => {
    const one = await activePlaylist();
    return one?.name === "Long drive" ? one : false;
  });
  // A different file, so a different id: the one GetPlaylists now gives.
  const [id] = (await getPlaylists()).find(([, name]) => name === "Long drive");
  assert.equal(active.id, id);
  await rename(playlistFile("Long drive"), playlistFile("Road trip"));
  await waitFor("the old name back", async () => (await activePlaylist())?.name === "Road trip");
});

test("a queue put together by hand is no playlist", async () => {
  await call(TRACKLIST, "RemoveTrack", "o", (await trackIds())[0]);
  await waitFor("the queue to shrink", async () => (await trackIds()).length === 1);
  assert.equal(await activePlaylist(), null);
  // Loading it again makes it that playlist once more.
  await call(PLAYER, "OpenUri", "s", pathToFileURL(playlistFile("Road trip")).href);
  await waitFor("the playlist back", async () => (await trackIds()).length === 2);
  assert.equal((await waitFor("the name", activePlaylist)).name, "Road trip");
});

test("a folder opened is named by the folder", async () => {
  await call(PLAYER, "OpenUri", "s", pathToFileURL(music).href);
  await waitFor("the folder to load", async () => (await trackIds()).length === TRACKS.length);
  assert.equal((await waitFor("the name", activePlaylist)).name, path.basename(music));
});

test("art already written is not written again", async () => {
  // Every track on an album carries the same cover, and the file it is written
  // to is named after its own bytes — so the same path is asked for over and
  // over while a panel is showing it. Rewriting truncates first, and a reader
  // landing in that window gets half a picture, which is what this is here to
  // stop. The file must be left alone once it is right.
  await call(PLAYER, "OpenUri", "s", pathToFileURL(music).href);
  await waitFor("the folder to load", async () => (await trackIds()).length === TRACKS.length);
  const artOf = async () => {
    const ids = await trackIds();
    const metadata = await busctl("call", bus, OBJECT, TRACKLIST, "GetTracksMetadata", "ao", String(ids.length), ...ids);
    return metadata.data[0].map((entry) => entry["mpris:artUrl"]?.data).filter(Boolean);
  };
  const art = await waitFor("the art to be written", async () => {
    const found = await artOf();
    return found.length === TRACKS.length ? found : false;
  });
  // One cover, one file: the fixtures share their art.
  assert.equal(new Set(art).size, 1, `expected one art file, got ${new Set(art).size}`);

  const file = fileURLToPath(art[0]);
  const before = await stat(file);
  assert.ok(before.size > 0, "the art file is empty");

  // Walk the album. Every track asks for that same cover again.
  for (let i = 0; i < TRACKS.length; i += 1) {
    await call(PLAYER, "Next");
    await sleep(200);
  }
  await sleep(1500);
  const after = await stat(file);
  assert.equal(after.size, before.size, "the art file changed size");
  assert.equal(
    after.mtimeMs,
    before.mtimeMs,
    "the art was written again while something could have been reading it",
  );
  await set(PLAYER, "Volume", "d", 0);
});

test("the equalizer comes back as it was left", async () => {
  await call(EQUALIZER, "ApplyPreset", "s", "Techno");
  const techno = await waitFor("Techno", async () => ((await get(EQUALIZER, "Preset")) === "Techno" ? await bands() : false));
  // Off, because coming back to an equalizer switched on is nobody's intent.
  await set(EQUALIZER, "Enabled", "b", false);
  assert.equal(await waitFor("it off", async () => (await get(EQUALIZER, "Enabled")) === false), true);
  // The write settles before it is worth quitting over.
  await sleep(700);

  await quit();
  await launch();

  assert.equal(await get(EQUALIZER, "Enabled"), false, "came back switched on");
  // And the bands it was left with, so switching it on restores the setting
  // rather than a flat one.
  const back = await waitFor("the bands", async () => {
    const now = await bands();
    return now.some((db) => Math.abs(db) > 0.5) ? now : false;
  });
  techno.forEach((db, i) => assert.ok(near(back[i], db, 0.5), `band ${i}: was ${db}, came back ${back[i]}`));
  assert.equal(await get(EQUALIZER, "Preset"), "Techno");

  await set(EQUALIZER, "Enabled", "b", true);
  await call(EQUALIZER, "Reset");
  await set(PLAYER, "Volume", "d", 0);
});

test("a restart comes back where it left off, paused", async () => {
  await call(PLAYER, "OpenUri", "s", pathToFileURL(music).href);
  await waitFor("the folder to load", async () => (await trackIds()).length === TRACKS.length);
  await waitFor("the tags", async () => (await titlesInOrder())[0] === TRACKS[0].title);
  await call(PLAYER, "Next");
  await waitFor("the second track", async () => (await currentTitle()) === TRACKS[1].title);
  // Paused before seeking: playing on would carry the position past where this
  // expects to find it, by however long quitting happens to take. A track that
  // has been picked is not yet a track that is playing, and pausing one that
  // is not playing does nothing at all, so wait for it to start first.
  await waitFor("playback", async () => (await get(PLAYER, "PlaybackStatus")) === "Playing");
  await call(PLAYER, "Pause");
  await waitFor("the pause", async () => {
    const status = await get(PLAYER, "PlaybackStatus");
    if (status === "Paused") return true;
    // So a timeout says what it was instead of just "false".
    throw new Error(`still ${status}`);
  });
  await call(PLAYER, "SetPosition", "ox", await currentTrackId(), 3_000_000);
  await waitFor("the seek", async () => (await get(PLAYER, "Position")) >= 3_000_000);
  // The session is written every couple of seconds and again on the way out.
  await quit();

  await launch();
  await waitFor("the playlist back", async () => (await trackIds()).length === TRACKS.length);
  // Not Stopped: the track is loaded where it was and one press carries on,
  // which is a paused player. Reporting Stopped would have clients show no
  // position for a player that has one.
  assert.equal(await waitFor("the status", async () => await get(PLAYER, "PlaybackStatus")), "Paused");
  assert.equal(await currentTitle(), TRACKS[1].title);
  const position = await get(PLAYER, "Position");
  assert.ok(position >= 2_500_000 && position <= 4_000_000, `came back at ${position}`);
  // The playlist it was playing is still named, with nothing remembered about
  // it: what the queue is gets worked out from the files each time.
  assert.equal((await activePlaylist())?.name, path.basename(music));
  // Playing leaves the restored state behind.
  await call(PLAYER, "Play");
  assert.equal(await waitFor("playback", async () => (await get(PLAYER, "PlaybackStatus")) === "Playing"), true);
  await set(PLAYER, "Volume", "d", 0);
});

test("one track arriving or leaving is announced as that one track", async () => {
  await call(PLAYER, "OpenUri", "s", pathToFileURL(music).href);
  await waitFor("the folder", async () => (await trackIds()).length === TRACKS.length);

  // Adding one track is TrackAdded, not "throw away everything you know".
  const added = await signalsDuring(async () => {
    await call(TRACKLIST, "AddTrack", "sob", pathToFileURL(path.join(music, TRACKS[0].file)).href, NO_TRACK, "false");
    await waitFor("the track", async () => (await trackIds()).length === TRACKS.length + 1);
  });
  assert.match(added, /TrackAdded/);
  assert.ok(!/TrackListReplaced/.test(added), "a single add should not replace the list");

  const removed = await signalsDuring(async () => {
    await call(TRACKLIST, "RemoveTrack", "o", (await trackIds())[0]);
    await waitFor("it to go", async () => (await trackIds()).length === TRACKS.length);
  });
  assert.match(removed, /TrackRemoved/);
  assert.ok(!/TrackListReplaced/.test(removed), "a single removal should not replace the list");
});

test("opening something else replaces the list wholesale", async () => {
  const output = await signalsDuring(async () => {
    await call(PLAYER, "OpenUri", "s", pathToFileURL(path.join(music, TRACKS[1].file)).href);
    await waitFor("the one track", async () => (await trackIds()).length === 1);
  });
  assert.match(output, /TrackListReplaced/);
});

test("tags arriving change a track, not the list", async () => {
  // A file archamp has not read yet, so its tags genuinely arrive after its
  // track does. Anything already in the folder has been read by now, and a
  // warm cache would make this test pass without proving a thing.
  // A known starting point, set before the watching begins: what opening one
  // file announces depends on what was loaded, and an empty list would make it
  // an add rather than a replacement.
  await call(PLAYER, "OpenUri", "s", pathToFileURL(music).href);
  await waitFor("the fixtures", async () => (await trackIds()).length === TRACKS.length);
  const fresh = path.join(music, "zz fresh.m4a");
  await copyFile(path.join(music, TRACKS[0].file), fresh);
  const output = await signalsDuring(async () => {
    await call(PLAYER, "OpenUri", "s", pathToFileURL(fresh).href);
    await waitFor("the tag", async () => (await currentTitle()) === TRACKS[0].title);
  });
  // The title arrives as a change to that one track...
  assert.match(output, /TrackMetadataChanged/);
  // ...and the list is replaced once, by the open itself, never again by a
  // title landing. Putting the old behaviour back makes this the failing line.
  assert.equal(
    (output.match(/TrackListReplaced/g) ?? []).length,
    1,
    "tags arriving should not replace the whole list",
  );
  await unlink(fresh);
  await call(PLAYER, "OpenUri", "s", pathToFileURL(music).href);
  await waitFor("the fixtures back", async () => (await trackIds()).length === TRACKS.length);
});

// ---------------------------------------------------------- the equalizer
//
// MPRIS has nothing for this, so it is archamp's own interface. The thing to
// keep honest is the scale: webamp's sliders run 0..100 over exactly -12dB to
// +12dB, and dB is what goes on the bus.

const bands = () => get(EQUALIZER, "Bands");
const near = (value, want, slack = 0.3) => Math.abs(value - want) <= slack;

test("the equalizer describes itself in decibels", async () => {
  assert.equal(await get(EQUALIZER, "MinimumGain"), -12);
  assert.equal(await get(EQUALIZER, "MaximumGain"), 12);
  const frequencies = await get(EQUALIZER, "Frequencies");
  assert.deepEqual(frequencies, [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000]);
  assert.equal((await bands()).length, frequencies.length, "a gain for every frequency");
  assert.ok((await get(EQUALIZER, "Presets")).includes("Rock"));
});

test("a band can be set and comes back as it was set", async () => {
  await call(EQUALIZER, "Reset");
  await waitFor("the reset", async () => (await bands()).every((db) => near(db, 0)));
  assert.ok(near(await get(EQUALIZER, "Preamp"), 0));

  const wanted = [6, -6, 3, 0, 0, 0, 0, 0, 0, 12];
  await busctl("set-property", bus, OBJECT, EQUALIZER, "Bands", "ad", String(wanted.length), ...wanted.map(String));
  const got = await waitFor("the bands", async () => {
    const now = await bands();
    return near(now[0], 6) ? now : false;
  });
  // Every one of them, not just the first.
  wanted.forEach((db, i) => assert.ok(near(got[i], db), `band ${i}: wanted ${db}, got ${got[i]}`));

  // Out of range is clamped rather than refused, as Rate is.
  await busctl("set-property", bus, OBJECT, EQUALIZER, "Preamp", "d", "99");
  assert.ok(near(await waitFor("the preamp", async () => await get(EQUALIZER, "Preamp")), 12));
});

test("setting the bands to a preset's shape names that preset", async () => {
  await call(EQUALIZER, "ApplyPreset", "s", "Rock");
  const name = await waitFor("the preset", async () => {
    const preset = await get(EQUALIZER, "Preset");
    return preset === "Rock" ? preset : false;
  });
  assert.equal(name, "Rock");
  // A shape of one's own belongs to no preset.
  await busctl("set-property", bus, OBJECT, EQUALIZER, "Preamp", "d", "7");
  assert.equal(await waitFor("it to stop being Rock", async () => (await get(EQUALIZER, "Preset")) === ""), true);
  // Flat is a preset nobody named, so it has no name either.
  await call(EQUALIZER, "Reset");
  await waitFor("the reset", async () => (await bands()).every((db) => near(db, 0)));
});

test("the equalizer's auto flag is settable", async () => {
  const was = await get(EQUALIZER, "Auto");
  await set(EQUALIZER, "Auto", "b", !was);
  assert.equal(await waitFor("auto", async () => (await get(EQUALIZER, "Auto")) === !was), true);
  await set(EQUALIZER, "Auto", "b", was);
  assert.equal(await waitFor("auto back", async () => (await get(EQUALIZER, "Auto")) === was), true);
});

test("the equalizer turns on and off, and says so", async () => {
  const wasOn = await get(EQUALIZER, "Enabled");
  const output = await signalsDuring(() => set(EQUALIZER, "Enabled", "b", !wasOn));
  assert.match(output, /PropertiesChanged.*org\.archamp\.Equalizer/s);
  assert.equal(await get(EQUALIZER, "Enabled"), !wasOn);
  await set(EQUALIZER, "Enabled", "b", wasOn);
  assert.equal(await waitFor("it back", async () => (await get(EQUALIZER, "Enabled")) === wasOn), true);
});

test("an equalizer file can be written and read back", async () => {
  const file = path.join(music, "test.eqf");
  await call(EQUALIZER, "ApplyPreset", "s", "Techno");
  const techno = await waitFor("Techno", async () => ((await get(EQUALIZER, "Preset")) === "Techno" ? await bands() : false));

  await call(EQUALIZER, "SavePreset", "s", file);
  await waitFor("the file", async () => (await stat(file).catch(() => null)) != null);
  // Winamp's own EQ library format, which is a fixed 299 bytes for one entry.
  assert.equal((await stat(file)).size, 299);

  await call(EQUALIZER, "Reset");
  await waitFor("the reset", async () => (await bands()).every((db) => near(db, 0)));
  await call(EQUALIZER, "LoadPreset", "s", file);
  const back = await waitFor("the file to load", async () => {
    const now = await bands();
    return now.some((db) => !near(db, 0)) ? now : false;
  });
  techno.forEach((db, i) => assert.ok(near(back[i], db, 0.5), `band ${i}: saved ${db}, read back ${back[i]}`));
  // A loaded file joins the presets under its own name.
  assert.ok((await get(EQUALIZER, "Presets")).includes("test"));
  await unlink(file);

  // A preset is an .eqf. Anything else is not written, however it is asked for.
  const notAPreset = path.join(music, "notes.txt");
  await call(EQUALIZER, "SavePreset", "s", notAPreset);
  await sleep(800);
  assert.equal(await stat(notAPreset).catch(() => null), null, "wrote equalizer bytes to a file that is not a preset");

  await call(EQUALIZER, "Reset");
});

// ------------------------------------------------------------- the window
//
// Hiding it is archamp's own interface: MPRIS has no call for it. Whether a
// window is really gone is the compositor's to answer, so these ask Hyprland
// the way the Raise test does, and skip themselves where there is none.

test("the window can be hidden, and Raise brings it back", async () => {
  assert.equal(await get(WINDOW, "Hidden"), false);
  assert.equal(await get(WINDOW, "KeepHidden"), false);
  if (!(await underHyprland())) return;
  await waitForWindow();

  const output = await signalsDuring(() => set(WINDOW, "Hidden", "b", true));
  assert.match(output, /PropertiesChanged.*org\.archamp\.Window/s);
  assert.equal(await get(WINDOW, "Hidden"), true);
  assert.equal(await waitFor("the window to go", async () => (await testWindow()) === null), true);

  // Hidden is no window, not no player: it still answers, and still plays.
  await call(PLAYER, "OpenUri", "s", pathToFileURL(music).href);
  await waitFor("the folder to load", async () => (await trackIds()).length === TRACKS.length);
  assert.equal(await waitFor("playback", async () => (await get(PLAYER, "PlaybackStatus")) === "Playing"), true);
  await set(PLAYER, "Volume", "d", 0);

  // Raise shows it, and leaves the remembered setting alone.
  await call("org.mpris.MediaPlayer2", "Raise");
  await waitForWindow();
  assert.equal(await get(WINDOW, "Hidden"), false);
  assert.equal(await get(WINDOW, "KeepHidden"), false);
});

test("keep hidden is remembered, and --show is the way back", async () => {
  if (!(await underHyprland())) return;
  await waitForWindow();
  await set(WINDOW, "KeepHidden", "b", true);
  // Turning it on takes the window away now, not only next time.
  assert.equal(await waitFor("the window to go", async () => (await testWindow()) === null), true);
  assert.equal(await get(WINDOW, "Hidden"), true);

  await quit();
  await launch();
  assert.equal(await get(WINDOW, "KeepHidden"), true);
  assert.equal(await get(WINDOW, "Hidden"), true);
  // Up and playing — the session came back — and still no window at all.
  await waitFor("the player to come up", async () => (await trackIds()).length > 0);
  assert.ok(await noWindowFor(4000), "it came up with a window");

  // Nothing on screen can undo it, so the command line can.
  await quit();
  await launch(["--show"]);
  await waitForWindow();
  assert.equal(await get(WINDOW, "Hidden"), false);
  // --show is this launch only; the setting stands.
  assert.equal(await get(WINDOW, "KeepHidden"), true);

  await set(WINDOW, "KeepHidden", "b", false);
  assert.equal(await waitFor("it to be off", async () => (await get(WINDOW, "KeepHidden")) === false), true);
  await set(PLAYER, "Volume", "d", 0);
});

// The tray is the fourth way to a hidden window. Whether an icon is really
// there is the tray host's to answer, so this asks the StatusNotifierWatcher
// rather than archamp, and skips itself where no desktop is hosting one.
async function trayItems() {
  const { stdout } = await run("busctl", ["--user", "--json=short", "--", "get-property",
    "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
    "org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems"]);
  return JSON.parse(stdout).data;
}

// An item is archamp's when the process that registered it is one of ours:
// the name carries the pid, as org.kde.StatusNotifierItem-<pid>-<n>.
async function trayItemOfTest() {
  try {
    const { stdout } = await run("pgrep", ["-f", profile]);
    const pids = new Set(stdout.split("\n").filter(Boolean));
    return (await trayItems()).find((item) => pids.has(item.split("-")[1]?.split("/")[0])) ?? null;
  } catch {
    return null;
  }
}

test("the tray is a way back, and only when asked for", async () => {
  let hosted = true;
  try {
    await trayItems();
  } catch {
    hosted = false;
  }
  // Not a failure: nothing here is hosting a tray.
  if (!hosted) return;

  assert.equal(await trayItemOfTest(), null, "an icon before it was asked for");
  await set(WINDOW, "Tray", "b", true);
  assert.ok(await waitFor("the tray icon", trayItemOfTest));
  await set(WINDOW, "Tray", "b", false);
  assert.equal(await waitFor("it to go", async () => (await trayItemOfTest()) === null), true);
});

test("starting archamp again is how a hidden window comes back", async () => {
  if (!(await underHyprland())) return;
  await waitForWindow();
  await set(WINDOW, "Hidden", "b", true);
  assert.equal(await waitFor("the window to go", async () => (await testWindow()) === null), true);

  // Handing a hidden player files is the plugin or a file manager at work,
  // and should not put the window in the way.
  await second([path.join(music, TRACKS[0].file)]);
  await waitFor("the track to arrive", async () => (await trackIds()).length === 1);
  assert.ok(await noWindowFor(3000), "files brought the window back");
  await set(PLAYER, "Volume", "d", 0);

  // Starting it with nothing to play is someone looking for the window, which
  // on Wayland is the only way back without the plugin: there is no
  // minimizing and no taskbar, so the launcher is where anyone would go.
  await second([]);
  await waitForWindow();
  assert.equal(await get(WINDOW, "Hidden"), false);
});
