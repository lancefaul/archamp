// archamp's MPRIS player (org.mpris.MediaPlayer2.archamp): what media keys,
// KDE's media controls and panel widgets talk to. Chromium has one built in,
// but it stops publishing the track after a Stop and can only seek in fixed
// jumps, so main.js turns it off, the player window reports its state here
// (see createMprisBridge in renderer.js), and MPRIS calls go back to it.
const { app, ipcMain } = require("electron");
const crypto = require("crypto");
const fs = require("fs/promises");
const { watch, readFileSync } = require("fs");
const path = require("path");
const { pathToFileURL, fileURLToPath } = require("url");
const dbus = require("dbus-native");

const { Variant } = dbus;
const BUS_NAME = "org.mpris.MediaPlayer2.archamp";
const OBJECT_PATH = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";
const TRACKLIST_IFACE = "org.mpris.MediaPlayer2.TrackList";
const ARCHAMP_TRACKLIST_IFACE = "org.archamp.TrackList";
const PLAYLISTS_IFACE = "org.mpris.MediaPlayer2.Playlists";
const ARCHAMP_WINDOW_IFACE = "org.archamp.Window";
const ARCHAMP_EQ_IFACE = "org.archamp.Equalizer";
const NO_TRACK = "/org/mpris/MediaPlayer2/TrackList/NoTrack";
const DO_NOT_QUEUE = 4;
const PRIMARY_OWNER = 1;

// What OpenUri accepts: a file, a folder (its audio files, subfolders included) or
// an M3U playlist of files.
const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".ogg", ".oga", ".opus", ".wav", ".m4a", ".aac", ".aif", ".aiff"]);
const PLAYLIST_EXTENSIONS = new Set([".m3u", ".m3u8"]);
const MAX_OPENED_TRACKS = 1000;
// Saved playlists are the M3U files in `Playlists` inside the music folder —
// the same folder OMedia Controls saves to, so a list made in either the
// plugin or archamp shows up in both, and neither owns them.
const PLAYLISTS_FOLDER = "Playlists";
const MAX_PLAYLISTS = 500;

const readOnly = (type) => ({ type, access: "read" });

const ROOT_INTERFACE = {
  name: "org.mpris.MediaPlayer2",
  methods: { Raise: ["", ""], Quit: ["", ""] },
  properties: {
    CanQuit: readOnly("b"),
    CanRaise: readOnly("b"),
    HasTrackList: readOnly("b"),
    Identity: readOnly("s"),
    DesktopEntry: readOnly("s"),
    SupportedUriSchemes: readOnly("as"),
    SupportedMimeTypes: readOnly("as"),
  },
  signals: {},
};

// The playlist, for clients that show a queue (org.mpris.MediaPlayer2.TrackList):
// they can list it, jump to a track, and add and remove tracks.
const TRACKLIST_INTERFACE = {
  name: TRACKLIST_IFACE,
  methods: {
    GetTracksMetadata: ["ao", "aa{sv}", ["TrackIds"], ["Metadata"]],
    AddTrack: ["sob", "", ["Uri", "AfterTrack", "SetAsCurrent"], []],
    RemoveTrack: ["o", "", ["TrackId"], []],
    GoTo: ["o", "", ["TrackId"], []],
  },
  properties: {
    Tracks: readOnly("ao"),
    CanEditTracks: readOnly("b"),
  },
  signals: {
    TrackListReplaced: ["aoo", "Tracks", "CurrentTrack"],
    TrackAdded: ["a{sv}o", "Metadata", "AfterTrack"],
    TrackRemoved: ["o", "TrackId"],
    TrackMetadataChanged: ["oa{sv}", "TrackId", "Metadata"],
  },
};

// Moving a track, which MPRIS has no call for. OMedia Controls uses it when
// CanMoveTracks is true.
const ARCHAMP_TRACKLIST_INTERFACE = {
  name: ARCHAMP_TRACKLIST_IFACE,
  methods: {
    MoveTrack: ["oo", "", ["TrackId", "AfterTrack"], []],
  },
  properties: {
    CanMoveTracks: readOnly("b"),
  },
  signals: {},
};

// Hiding the window, which MPRIS has no call for. Hidden is this session —
// Raise clears it, as the spec says Raise must show the player — and
// KeepHidden is the remembered setting, which turning on hides the window now
// as well as next time. OMedia Controls binds a switch to KeepHidden when
// archamp is the player it is controlling.
const ARCHAMP_WINDOW_INTERFACE = {
  name: ARCHAMP_WINDOW_IFACE,
  methods: {},
  properties: {
    Hidden: "b",
    KeepHidden: "b",
    // The tray icon, which is the other way archamp offers back to a hidden
    // window. It sits here because it is a window setting like the others,
    // and a panel that offers the hide switch can offer this beside it.
    Tray: "b",
  },
  signals: {},
};

// The equalizer, which MPRIS has nothing for. Everything a panel would need to
// draw one of its own: the ten bands and the preamp in dB, on and off, the
// presets with whichever is in effect, and the actions archamp's own drawer
// has. dB rather than webamp's 0..100 sliders, because it is the number
// Winamp's equalizer is labelled in and it needs no explaining; archamp
// converts, since webamp's own span is exactly -12 to +12.
const ARCHAMP_EQ_INTERFACE = {
  name: ARCHAMP_EQ_IFACE,
  methods: {
    ApplyPreset: ["s", "", ["Name"], []],
    Reset: ["", "", [], []],
    LoadPreset: ["s", "", ["Path"], []],
    SavePreset: ["s", "", ["Path"], []],
  },
  properties: {
    Enabled: "b",
    Auto: "b",
    Preamp: "d",
    Bands: "ad",
    Frequencies: readOnly("ad"),
    MinimumGain: readOnly("d"),
    MaximumGain: readOnly("d"),
    Presets: readOnly("as"),
    // The preset the bands are set to, or "" for a setting of one's own.
    Preset: readOnly("s"),
  },
  signals: {},
};

// The saved playlists, and which of them is playing. This is what puts the
// playlist's own name on the plugin's PLAYLIST heading.
const PLAYLISTS_INTERFACE = {
  name: PLAYLISTS_IFACE,
  methods: {
    ActivatePlaylist: ["o", "", ["PlaylistId"], []],
    GetPlaylists: ["uusb", "a(oss)", ["Index", "MaxCount", "Order", "ReverseOrder"], ["Playlists"]],
  },
  properties: {
    PlaylistCount: readOnly("u"),
    Orderings: readOnly("as"),
    ActivePlaylist: readOnly("(b(oss))"),
  },
  signals: {
    PlaylistChanged: ["(oss)", "Playlist"],
  },
};

const PLAYER_INTERFACE = {
  name: PLAYER_IFACE,
  methods: {
    Next: ["", ""],
    Previous: ["", ""],
    Pause: ["", ""],
    PlayPause: ["", ""],
    Stop: ["", ""],
    Play: ["", ""],
    Seek: ["x", "", ["Offset"], []],
    SetPosition: ["ox", "", ["TrackId", "Position"], []],
    OpenUri: ["s", "", ["Uri"], []],
  },
  properties: {
    PlaybackStatus: readOnly("s"),
    LoopStatus: "s",
    Rate: "d",
    Shuffle: "b",
    Metadata: readOnly("a{sv}"),
    Volume: "d",
    Position: readOnly("x"),
    MinimumRate: readOnly("d"),
    MaximumRate: readOnly("d"),
    CanGoNext: readOnly("b"),
    CanGoPrevious: readOnly("b"),
    CanPlay: readOnly("b"),
    CanPause: readOnly("b"),
    CanSeek: readOnly("b"),
    CanControl: readOnly("b"),
  },
  signals: { Seeked: ["x", "Position"] },
};

// Properties announced with PropertiesChanged. Position isn't: clients read it
// when they need it, and a jump is announced with Seeked instead.
const ANNOUNCED = [
  "PlaybackStatus", "LoopStatus", "Rate", "Shuffle", "Metadata", "Volume",
  "CanGoNext", "CanGoPrevious", "CanPlay", "CanPause", "CanSeek",
];

// What the player will play at. Winamp had no speed control, so archamp's own
// window has none either — this is for clients that offer one.
const MINIMUM_RATE = 0.25;
const MAXIMUM_RATE = 4;

// The player's last reported state, and where playback stood at that moment.
let state = {
  status: "Stopped",
  track: null,
  canGoNext: false,
  canGoPrevious: false,
  repeat: false,
  shuffle: false,
  volume: 1,
};
let position = { seconds: 0, at: Date.now() };

// The equalizer as the player last reported it. The frequencies and the span
// are webamp's own and do not change, so they are constants here rather than
// something to keep in step.
const EQ_FREQUENCIES = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
const EQ_MIN_GAIN = -12;
const EQ_MAX_GAIN = 12;
// Winamp's own equalizer files: .eqf for a library, .q1 for a single preset.
const isPresetFile = (file) => typeof file === "string" && /\.(eqf|q1)$/i.test(file);
const clampGain = (value) => Math.max(EQ_MIN_GAIN, Math.min(EQ_MAX_GAIN, Number(value) || 0));
let eq = {
  enabled: false,
  auto: false,
  preamp: 0,
  bands: EQ_FREQUENCIES.map(() => 0),
  presets: [],
  preset: "",
};

// Tags read from the files themselves. webamp reads only what its display
// needs — title, artist, album, length — so the year, the track number and
// the album art of a track that isn't playing yet have to come from here.
// Read once per file, in the background, current track first; a client asking
// for a track archamp hasn't got to yet gets what webamp knew, and the rest
// when it arrives.
const tags = new Map();
const tagQueue = [];
let readingTags = false;
let onTagsRead = () => {};
let artDirectory = null;

function tagsFor(url) {
  if (typeof url !== "string" || !url.startsWith("file:")) return null;
  try {
    return tags.get(fileURLToPath(url)) ?? null;
  } catch {
    return null;
  }
}

function queueTags(urls) {
  for (const url of urls) {
    if (typeof url !== "string" || !url.startsWith("file:")) continue;
    let file;
    try {
      file = fileURLToPath(url);
    } catch {
      continue;
    }
    if (tags.has(file) || tagQueue.includes(file)) continue;
    tagQueue.push(file);
  }
  readTagQueue();
}

// The current track jumps the queue: it is the one a client is asking about.
function queueTagsFirst(url) {
  if (typeof url !== "string" || !url.startsWith("file:")) return;
  try {
    const file = fileURLToPath(url);
    if (tags.has(file)) return;
    const waiting = tagQueue.indexOf(file);
    if (waiting > 0) tagQueue.splice(waiting, 1);
    if (waiting !== 0) tagQueue.unshift(file);
  } catch {}
  readTagQueue();
}

async function readTagQueue() {
  if (readingTags) return;
  readingTags = true;
  try {
    while (tagQueue.length > 0) {
      const file = tagQueue.shift();
      if (tags.has(file)) continue;
      tags.set(file, await readTags(file));
      onTagsRead(file);
    }
  } finally {
    readingTags = false;
  }
}

async function readTags(file) {
  try {
    const { parseFile } = await import("music-metadata");
    const { common } = await parseFile(file, { duration: false, skipPostHeaders: true });
    return {
      trackNumber: common.track?.no ?? 0,
      discNumber: common.disk?.no ?? 0,
      year: common.year ?? 0,
      albumArtist: common.albumartist ?? "",
      genre: common.genre ?? [],
      composer: common.composer ?? [],
      artUrl: await writeEmbeddedArt(common.picture?.[0]),
    };
  } catch {
    // An unreadable or tagless file is still a file: remember that there is
    // nothing to find, so it isn't read again.
    return {};
  }
}

// Art is written under a name made from its own bytes, so one cover comes out
// at one path however many tracks carry it. Which is exactly why it must not
// simply be written again: every track on an album asks for the same file
// while a panel is already showing it, and fs.writeFile truncates before it
// writes — a reader landing in that moment gets the top of the picture and
// grey underneath, until the write finishes and it rights itself. So it is
// written only when it is not already there, through a temp name and a
// rename, which within one folder is atomic: a reader sees the whole file or
// the old one, never half of either.
async function writeArt(bytes) {
  if (artDirectory == null) return "";
  const name = crypto.createHash("sha256").update(bytes).digest("hex");
  const file = path.join(artDirectory, name);
  try {
    const already = await fs.stat(file).catch(() => null);
    if (already?.size === bytes.length) return pathToFileURL(file).href;
    await fs.mkdir(artDirectory, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, bytes);
    await fs.rename(temp, file);
    return pathToFileURL(file).href;
  } catch {
    return "";
  }
}

// The embedded picture, written out once per distinct image, so panels have a
// file to load for every track rather than only the playing one — webamp has
// a blob: URL, and only for what it has loaded.
async function writeEmbeddedArt(picture) {
  if (picture?.data == null || artDirectory == null) return "";
  try {
    return await writeArt(Buffer.from(picture.data));
  } catch {
    return "";
  }
}

// Where playback has got to, worked out from the last report rather than
// asked for: a track played faster covers more of itself per second, so the
// rate is part of the sum.
function currentSeconds() {
  const rate = state.rate ?? 1;
  const elapsed = state.status === "Playing" ? ((Date.now() - position.at) / 1000) * rate : 0;
  const seconds = position.seconds + elapsed;
  return state.track?.length ? Math.min(seconds, state.track.length) : seconds;
}

const pathFor = (id) => `/org/archamp/track/${id}`;

function trackPath() {
  return state.track ? pathFor(state.track.id) : NO_TRACK;
}

// The playlist as last reported: [{ id, title, artist, album, length, url }].
let playlist = [];

function metadata() {
  return trackMetadata(state.track, state.track?.artUrl);
}

function trackMetadata(track, artUrl) {
  const result = { "mpris:trackid": new Variant("o", track ? pathFor(track.id) : NO_TRACK) };
  if (!track) return result;
  if (track.length > 0) result["mpris:length"] = new Variant("x", Math.round(track.length * 1e6));
  if (track.title) result["xesam:title"] = track.title;
  if (track.artist) result["xesam:artist"] = [track.artist];
  if (track.album) result["xesam:album"] = track.album;
  // What the file says beyond what the player displays (see readTags).
  const tags = tagsFor(track.url);
  if (tags?.trackNumber) result["xesam:trackNumber"] = new Variant("i", tags.trackNumber);
  if (tags?.discNumber) result["xesam:discNumber"] = new Variant("i", tags.discNumber);
  if (tags?.year) result["xesam:contentCreated"] = `${tags.year}-01-01T00:00:00Z`;
  if (tags?.albumArtist) result["xesam:albumArtist"] = [tags.albumArtist];
  if (tags?.genre?.length) result["xesam:genre"] = tags.genre;
  if (tags?.composer?.length) result["xesam:composer"] = tags.composer;
  const art = tags?.artUrl ?? artUrl;
  if (art) result["mpris:artUrl"] = art;
  if (track.url.startsWith("file:")) result["xesam:url"] = track.url;
  return result;
}

// A folder's audio files, including those in its subfolders: each folder's
// own files in name order, then its subfolders in name order, so an artist's
// folder plays album by album. Hidden entries and symlinked folders are
// skipped (a link can loop), and it stops at MAX_OPENED_TRACKS.
async function folderTracks(folder, found) {
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return found;
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const visible = entries.filter((entry) => !entry.name.startsWith(".")).sort(byName);
  for (const entry of visible) {
    if (found.length >= MAX_OPENED_TRACKS) return found;
    if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      found.push(path.join(folder, entry.name));
    }
  }
  for (const entry of visible) {
    if (found.length >= MAX_OPENED_TRACKS) return found;
    if (entry.isDirectory()) await folderTracks(path.join(folder, entry.name), found);
  }
  return found;
}

// The tracks a URI stands for, as file:// URLs: the file itself, a folder's
// audio files (subfolders included, see folderTracks), or the files an M3U
// lists (absolute paths or paths relative to the playlist). Anything else, or
// anything unreadable, is no tracks.
async function tracksForUri(uri) {
  let file;
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return [];
    file = fileURLToPath(url);
  } catch {
    return [];
  }
  let info;
  try {
    info = await fs.stat(file);
  } catch {
    return [];
  }
  if (info.isDirectory()) return (await folderTracks(file, [])).map((track) => pathToFileURL(track).href);
  const ext = path.extname(file).toLowerCase();
  if (PLAYLIST_EXTENSIONS.has(ext)) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        // A line is a path or a file: URL. One that is neither — a stream, a
        // typo, a URL that will not parse — is dropped on its own rather than
        // taking the rest of the playlist down with it.
        // A scheme that is not file: is a stream, and archamp has no way to
        // play one from a playlist yet. Skipped rather than resolved as a
        // path, which would turn http://host/song.mp3 into a local file that
        // has never existed.
        // Two characters and a // before it counts as a scheme, so a relative
        // path like "Bowie:Low/01.mp3" is still a path.
        if (/^[a-z][a-z0-9+.-]+:\/\//i.test(line) && !/^file:/i.test(line)) return null;
        try {
          const href = line.startsWith("file:")
            ? line
            : pathToFileURL(path.resolve(path.dirname(file), line)).href;
          return AUDIO_EXTENSIONS.has(path.extname(new URL(href).pathname).toLowerCase()) ? href : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(0, MAX_OPENED_TRACKS);
  }
  return AUDIO_EXTENSIONS.has(ext) ? [pathToFileURL(file).href] : [];
}

// The tracks a list of URIs stands for, in the order given: what OpenUri does
// for one, for however many arrive on the command line.
async function tracksForUris(uris) {
  const found = [];
  for (const uri of uris) {
    found.push(...(await tracksForUri(uri)));
    if (found.length >= MAX_OPENED_TRACKS) break;
  }
  return found.slice(0, MAX_OPENED_TRACKS);
}

// ------------------------------------------------------------------ playlists
//
// A saved playlist is an M3U file in the music folder's `Playlists` folder.
// Which one is playing is worked out by comparing the queue with what each
// file lists, rather than by remembering what was loaded: a playlist renamed
// or edited underneath archamp (the plugin does both) is still recognised,
// and a queue the user has added to or trimmed stops being a saved playlist
// on its own, with nothing to keep in step.
let saved = [];
// Where the queue was opened from when that was not a saved playlist: a
// folder, or an M3U somewhere else. It names the queue for as long as the
// queue is still what it gave.
let openedFrom = null;
let onPlaylistsChanged = () => {};

// Where OMedia Controls keeps its settings. archamp reads them, never writes
// them: the plugin lets the user move the music and playlist folders, and a
// shared playlist folder only stays shared if archamp follows.
const PLUGIN_PREFERENCES = path.join(
  process.env.XDG_STATE_HOME || path.join(app.getPath("home"), ".local", "state"),
  "omedia-controls",
  "preferences.json",
);
let preferences = { read: 0, value: {} };

function pluginPreferences() {
  // Read at most every few seconds: this is on the path of every dialog and
  // every rescan, and the file is the user changing a setting, not traffic.
  if (Date.now() - preferences.read < 5000) return preferences.value;
  let value = {};
  try {
    const parsed = JSON.parse(readFileSync(PLUGIN_PREFERENCES, "utf8"));
    if (parsed && typeof parsed === "object") value = parsed;
  } catch {}
  preferences = { read: Date.now(), value };
  return value;
}

// A folder the plugin was told to use, if it is one: an absolute path with no
// climbing in it, the same check the plugin makes of its own setting.
const settingFolder = (value) =>
  typeof value === "string" && value.startsWith("/") && !value.split("/").includes("..") ? value : "";

// The same folder OMedia Controls reads and writes: its playlist folder if the
// user set one, else `Playlists` in its music folder, else in the desktop's.
function playlistsFolder() {
  const prefs = pluginPreferences();
  return (
    settingFolder(prefs.playlistFolder) ||
    path.join(settingFolder(prefs.musicFolder) || app.getPath("music"), PLAYLISTS_FOLDER)
  );
}

// Where Open folder and Save list start from, which the plugin can move too.
const musicFolder = () => settingFolder(pluginPreferences().musicFolder) || app.getPath("music");

// An object path a client can hand back to ActivatePlaylist. It is derived
// from the file's path, so it is the same between runs, and a rename makes a
// new one — which is right: it is a different file.
const playlistIdFor = (file) =>
  `/org/archamp/playlist/${crypto.createHash("sha256").update(file).digest("hex").slice(0, 32)}`;

const playlistNameOf = (file) => path.basename(file).replace(/\.m3u8?$/i, "");

const sameTracks = (a, b) => a.length === b.length && a.every((url, index) => url === b[index]);

// Reads the playlist folder. Only a file that has changed is read again: the
// folder is rescanned whenever anything in it moves, and most of the time
// nothing about the files themselves has.
async function scanPlaylists() {
  let entries = [];
  try {
    entries = await fs.readdir(playlistsFolder(), { withFileTypes: true });
  } catch {
    entries = [];
  }
  const known = new Map(saved.map((one) => [one.file, one]));
  const found = [];
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  for (const entry of entries.sort(byName)) {
    if (found.length >= MAX_PLAYLISTS) break;
    if (!PLAYLIST_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const file = path.join(playlistsFolder(), entry.name);
    let info;
    try {
      info = await fs.stat(file);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const before = known.get(file);
    const urls = before?.modified === info.mtimeMs ? before.urls : await tracksForUri(pathToFileURL(file).href);
    found.push({
      id: playlistIdFor(file),
      file,
      name: playlistNameOf(file),
      modified: info.mtimeMs,
      created: info.birthtimeMs || info.ctimeMs,
      urls,
    });
  }
  const before = saved;
  saved = found;
  return before;
}

function orderedPlaylists(order, reverse) {
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const list = [...saved];
  if (order === "CreationDate") list.sort((a, b) => a.created - b.created || byName(a, b));
  else if (order === "ModifiedDate") list.sort((a, b) => a.modified - b.modified || byName(a, b));
  else list.sort(byName);
  return reverse ? list.reverse() : list;
}

// The playlist the queue is, or null for a list put together by hand. A saved
// playlist wins over where the queue was opened from, so a playlist renamed
// while it plays is named by its new name.
function activePlaylist() {
  const urls = playlist.map((track) => track.url);
  if (urls.length === 0) return null;
  const match = saved.find((one) => sameTracks(one.urls, urls));
  if (match) return { id: match.id, name: match.name };
  if (openedFrom && sameTracks(openedFrom.urls, urls)) return openedFrom;
  return null;
}

// Where the queue was opened from, saved with the session so a folder keeps
// naming what it holds across a restart. The comparison still decides: a
// queue that has moved on since is no longer that folder's.
const openedPlaylistUri = () => openedFrom?.uri ?? "";

// Called by whoever loads a whole list at once — OpenUri, the command line,
// Open folder, Load list, Save list — with the URI it came from and the
// tracks it gave. A single audio file is not a playlist.
async function playlistOpened(uri, urls) {
  openedFrom = null;
  if (Array.isArray(urls) && urls.length > 0) {
    try {
      const file = fileURLToPath(new URL(uri));
      const info = await fs.stat(file);
      const isPlaylist = PLAYLIST_EXTENSIONS.has(path.extname(file).toLowerCase());
      if (info.isDirectory() || isPlaylist) {
        openedFrom = {
          id: playlistIdFor(file),
          name: isPlaylist ? playlistNameOf(file) : path.basename(file),
          uri: pathToFileURL(file).href,
          urls: [...urls],
        };
      }
    } catch {}
  }
  onPlaylistsChanged();
}

// `window` is how main lets archamp's window be read and set from the bus:
// { hidden, setHidden, keepHidden, setKeepHidden }. Returns the handle main
// calls when the window shows or hides, so clients hear about it whoever did
// it.
function startMpris(getPlayer, window) {
  const command = (name, value) => getPlayer()?.webContents.send("mpris:command", name, value);
  const artDir = path.join(app.getPath("userData"), "mpris-art");
  artDirectory = artDir;

  const root = {
    CanQuit: true,
    CanRaise: true,
    HasTrackList: true,
    Identity: "archamp",
    // The basename of archamp's desktop entry, which is how a client knows
    // which installed app it is talking to — the plugin shows the player's
    // own icon and name by it (see desktop.js for who writes the file).
    DesktopEntry: "archamp",
    SupportedUriSchemes: ["file"],
    SupportedMimeTypes: ["audio/mpeg", "audio/flac", "audio/ogg", "audio/opus", "audio/wav", "audio/mp4", "audio/aac", "audio/x-mpegurl"],
    // Raise is how the plugin's "open the player" affordance reaches us. On
    // Wayland an app cannot take focus by asking the compositor directly; it
    // needs an activation token, which Electron requests for us inside
    // show()/focus(). Hyprland honours it: a window on a hidden workspace is
    // pulled forward, focused and its workspace switched to. A compositor that
    // refuses the token still shows the window, which is all MPRIS promises.
    Raise() {
      // A hidden player has to come back for this: the spec says Raise shows
      // the player, and it is the plugin's "open archamp". The remembered
      // setting is left alone, so it is hidden again next time.
      window?.setHidden(false);
      const player = getPlayer();
      if (!player) return null;
      if (player.isMinimized()) player.restore();
      player.show();
      app.focus({ steal: true });
      player.focus();
      return null;
    },
    Quit() {
      app.quit();
      return null;
    },
  };

  const player = {
    get PlaybackStatus() { return state.status; },
    get LoopStatus() {
      if (state.loopTrack) return "Track";
      return state.repeat ? "Playlist" : "None";
    },
    set LoopStatus(value) {
      const mode = String(value);
      command("loop", mode === "Track" || mode === "Playlist" ? mode : "None");
    },
    get Rate() { return state.rate ?? 1; },
    set Rate(value) {
      const rate = Number(value);
      if (!Number.isFinite(rate) || rate <= 0) return;
      command("rate", Math.min(Math.max(rate, MINIMUM_RATE), MAXIMUM_RATE));
    },
    get Shuffle() { return state.shuffle; },
    set Shuffle(value) { command("shuffle", Boolean(value)); },
    get Metadata() { return metadata(); },
    get Volume() { return state.volume; },
    set Volume(value) { command("volume", Math.min(Math.max(Number(value) || 0, 0), 1)); },
    get Position() { return Math.round(currentSeconds() * 1e6); },
    MinimumRate: MINIMUM_RATE,
    MaximumRate: MAXIMUM_RATE,
    get CanGoNext() { return state.canGoNext; },
    get CanGoPrevious() { return state.canGoPrevious; },
    get CanPlay() { return state.track != null; },
    get CanPause() { return state.track != null; },
    get CanSeek() { return state.track?.length > 0; },
    CanControl: true,
    Next() { command("next"); return null; },
    Previous() { command("previous"); return null; },
    Pause() { command("pause"); return null; },
    PlayPause() { command("playPause"); return null; },
    Stop() { command("stop"); return null; },
    Play() { command("play"); return null; },
    Seek(offset) { command("seek", Number(offset) / 1e6); return null; },
    SetPosition(trackId, target) {
      // The spec ignores a SetPosition for a track that's no longer current.
      if (trackId === trackPath()) command("seekTo", Number(target) / 1e6);
      return null;
    },
    OpenUri(uri) {
      tracksForUri(String(uri))
        .then(async (urls) => {
          if (urls.length === 0) return;
          // A folder or an M3U names the queue it just made.
          await playlistOpened(String(uri), urls);
          command("openTracks", urls);
        })
        .catch((error) => console.error(`[mpris] OpenUri: ${error.message}`));
      return null;
    },
    emit() {}, // dbus-native wraps this to send signals
  };

  const trackIdOf = (objectPath) => {
    const match = /^\/org\/archamp\/track\/(\d+)$/.exec(String(objectPath));
    return match ? Number(match[1]) : null;
  };

  const tracklist = {
    get Tracks() { return playlist.map((track) => pathFor(track.id)); },
    CanEditTracks: true,
    GetTracksMetadata(ids) {
      const byPath = new Map(playlist.map((track) => [pathFor(track.id), track]));
      const asked = (Array.isArray(ids) ? ids : []).map((id) => byPath.get(String(id))).filter(Boolean);
      // Being asked about a track brings its tags forward in the queue, so a
      // client that asks again has them.
      queueTags(asked.map((track) => track.url));
      return asked.map((track) =>
        trackMetadata(track, state.track?.id === track.id ? state.track.artUrl : null),
      );
    },
    // Added after AfterTrack, or at the start for NoTrack; a URI for a folder
    // or M3U adds all its tracks.
    AddTrack(uri, afterTrack, setAsCurrent) {
      const after = String(afterTrack) === NO_TRACK ? null : trackIdOf(afterTrack);
      if (after == null && String(afterTrack) !== NO_TRACK) return null;
      tracksForUri(String(uri))
        .then((urls) => {
          if (urls.length > 0) command("addTracks", { urls, after, play: Boolean(setAsCurrent) });
        })
        .catch((error) => console.error(`[mpris] AddTrack: ${error.message}`));
      return null;
    },
    RemoveTrack(objectPath) {
      const id = trackIdOf(objectPath);
      if (id != null && playlist.some((track) => track.id === id)) command("removeTrack", id);
      return null;
    },
    GoTo(objectPath) {
      const id = trackIdOf(objectPath);
      if (id != null && playlist.some((track) => track.id === id)) command("goTo", id);
      return null;
    },
    emit() {},
  };

  const archampTracklist = {
    CanMoveTracks: true,
    // To just after AfterTrack, or to the start for NoTrack.
    MoveTrack(objectPath, afterTrack) {
      const id = trackIdOf(objectPath);
      const after = String(afterTrack) === NO_TRACK ? null : trackIdOf(afterTrack);
      if (id == null || (after == null && String(afterTrack) !== NO_TRACK)) return null;
      command("moveTrack", { id, after });
      return null;
    },
    emit() {},
  };

  const playlists = {
    get PlaylistCount() { return saved.length; },
    // LastPlayDate and UserDefined would need archamp to remember an order of
    // its own; these three it can answer from the files.
    Orderings: ["Alphabetical", "CreationDate", "ModifiedDate"],
    get ActivePlaylist() {
      const active = activePlaylist();
      // (b(oss)): valid, then id, name and icon. There is no icon, and the
      // struct still needs a shape when there is no playlist.
      return active ? [true, [active.id, active.name, ""]] : [false, ["/", "", ""]];
    },
    GetPlaylists(index, maxCount, order, reverseOrder) {
      const from = Math.max(0, Math.floor(Number(index) || 0));
      const count = Math.max(0, Math.floor(Number(maxCount) || 0));
      return orderedPlaylists(String(order), Boolean(reverseOrder))
        .slice(from, from + count)
        .map((one) => [one.id, one.name, ""]);
    },
    ActivatePlaylist(id) {
      const wanted = saved.find((one) => one.id === String(id));
      if (!wanted) return null;
      tracksForUri(pathToFileURL(wanted.file).href)
        .then(async (urls) => {
          if (urls.length === 0) return;
          await playlistOpened(pathToFileURL(wanted.file).href, urls);
          command("openTracks", urls);
        })
        .catch((error) => console.error(`[mpris] ActivatePlaylist: ${error.message}`));
      return null;
    },
    emit() {},
  };

  const equalizer = {
    get Enabled() { return eq.enabled; },
    set Enabled(value) { command("eqEnabled", Boolean(value)); },
    get Auto() { return eq.auto; },
    set Auto(value) { command("eqAuto", Boolean(value)); },
    get Preamp() { return eq.preamp; },
    set Preamp(value) { command("eqPreamp", clampGain(value)); },
    get Bands() { return eq.bands; },
    set Bands(value) { command("eqBands", (Array.isArray(value) ? value : []).map(clampGain)); },
    Frequencies: EQ_FREQUENCIES,
    MinimumGain: EQ_MIN_GAIN,
    MaximumGain: EQ_MAX_GAIN,
    get Presets() { return eq.presets; },
    get Preset() { return eq.preset; },
    ApplyPreset(name) { command("eqPreset", String(name)); return null; },
    Reset() { command("eqReset"); return null; },
    // A preset is an .eqf, so that is what these will read and write. The
    // session bus is the user's own, but a method called SavePreset has no
    // business writing equalizer bytes over a file that is not one.
    LoadPreset(file) {
      if (isPresetFile(file)) command("eqLoad", String(file));
      return null;
    },
    SavePreset(file) {
      if (isPresetFile(file)) command("eqSave", String(file));
      return null;
    },
    emit() {},
  };

  const archampWindow = {
    get Hidden() { return Boolean(window?.hidden()); },
    set Hidden(value) { window?.setHidden(Boolean(value)); },
    get KeepHidden() { return Boolean(window?.keepHidden()); },
    set KeepHidden(value) { window?.setKeepHidden(Boolean(value)); },
    get Tray() { return Boolean(window?.tray()); },
    set Tray(value) { window?.setTray(Boolean(value)); },
    emit() {},
  };

  let bus;
  try {
    bus = dbus.sessionBus();
    bus.connection.on("error", (error) => console.error(`[mpris] ${error.message}`));
    bus.exportInterface(root, OBJECT_PATH, ROOT_INTERFACE);
    bus.exportInterface(player, OBJECT_PATH, PLAYER_INTERFACE);
    bus.exportInterface(tracklist, OBJECT_PATH, TRACKLIST_INTERFACE);
    bus.exportInterface(archampTracklist, OBJECT_PATH, ARCHAMP_TRACKLIST_INTERFACE);
    bus.exportInterface(playlists, OBJECT_PATH, PLAYLISTS_INTERFACE);
    bus.exportInterface(archampWindow, OBJECT_PATH, ARCHAMP_WINDOW_INTERFACE);
    bus.exportInterface(equalizer, OBJECT_PATH, ARCHAMP_EQ_INTERFACE);
  } catch (error) {
    console.error(`[mpris] no session bus, media keys won't reach archamp: ${error.message}`);
    return { windowChanged() {} };
  }

  const requestName = (name) =>
    bus.invoke({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "RequestName",
      signature: "su",
      body: [name, DO_NOT_QUEUE],
    });
  // A second archamp gets its own name, as the MPRIS spec suggests.
  requestName(BUS_NAME)
    .then((reply) => (reply === PRIMARY_OWNER ? reply : requestName(`${BUS_NAME}.instance${process.pid}`)))
    .catch((error) => console.error(`[mpris] couldn't claim a bus name: ${error.message}`));

  ipcMain.on("mpris:state", (_event, next) => {
    const before = ANNOUNCED.map((name) => JSON.stringify(player[name]));
    state = next;
    position = { seconds: next.position, at: Date.now() };
    // Whatever is playing is the track a client will ask about first.
    queueTagsFirst(state.track?.url);
    const changed = {};
    ANNOUNCED.forEach((name, i) => {
      const value = player[name];
      if (JSON.stringify(value) !== before[i]) changed[name] = value;
    });
    if (Object.keys(changed).length > 0) bus.emitPropertiesChanged(OBJECT_PATH, PLAYER_IFACE, changed);
  });

  // What changed about the playlist, in the spec's own terms. TrackListReplaced
  // tells a client to throw away everything it knows, so it is for wholesale
  // changes only — opening a folder, sorting, clearing. One track arriving or
  // leaving is the signal for that one track, and a client that listens for it
  // does not have to reread a thousand rows because one of them moved.
  // The art GetTracksMetadata gives for this track, so a client building a row
  // from a signal sees what it would see from the method: webamp extracts art
  // for the playing track that music-metadata sometimes cannot.
  const artFor = (track) => (state.track?.id === track.id ? state.track.artUrl : null);

  function announceTrackList(before, after) {
    const beforeIds = before.map((track) => track.id);
    const afterIds = after.map((track) => track.id);
    // Sets, because this runs once per report and a report lands for every
    // track's tags: over a thousand-track folder, lists would make each pass
    // a million comparisons and hold up the main process while it loads.
    const had = new Set(beforeIds);
    const has = new Set(afterIds);
    const added = afterIds.filter((id) => !had.has(id));
    const removed = beforeIds.filter((id) => !has.has(id));
    const kept = afterIds.filter((id) => had.has(id));
    const keptBefore = beforeIds.filter((id) => has.has(id));
    const reordered = kept.some((id, index) => keptBefore[index] !== id);

    if (added.length === 1 && removed.length === 0 && !reordered) {
      const index = afterIds.indexOf(added[0]);
      const track = after[index];
      // NoTrack means the head of the list, which is what an index of 0 is.
      const afterTrack = index > 0 ? pathFor(afterIds[index - 1]) : NO_TRACK;
      tracklist.emit("TrackAdded", trackMetadata(track, artFor(track)), afterTrack);
    } else if (removed.length === 1 && added.length === 0 && !reordered) {
      tracklist.emit("TrackRemoved", pathFor(removed[0]));
    } else if (added.length > 0 || removed.length > 0 || reordered) {
      tracklist.emit("TrackListReplaced", afterIds.map(pathFor), trackPath());
    }

    // Same tracks in the same order, but something about one of them changed:
    // a title webamp only learned once the file was loaded.
    const was = new Map(before.map((track) => [track.id, JSON.stringify(track)]));
    for (const track of after) {
      const previous = was.get(track.id);
      if (previous != null && previous !== JSON.stringify(track)) {
        tracklist.emit("TrackMetadataChanged", pathFor(track.id), trackMetadata(track, artFor(track)));
      }
    }
  }

  ipcMain.on("mpris:tracks", (_event, tracks) => {
    const before = playlist;
    playlist = Array.isArray(tracks) ? tracks : [];
    announceTrackList(before, playlist);
    queueTags(playlist.map((track) => track.url));
    // The queue changing can make it, or stop it being, a saved playlist.
    announcePlaylists(saved);
  });

  // A file's own tags arriving are a change to what clients have been told:
  // the playing track's metadata, and the list they read the rest from.
  let tagAnnouncement = null;
  const tagged = new Set();
  onTagsRead = (file) => {
    if (state.track?.url && tagsFor(state.track.url) != null) {
      try {
        if (fileURLToPath(state.track.url) === file) {
          bus.emitPropertiesChanged(OBJECT_PATH, PLAYER_IFACE, { Metadata: metadata() });
        }
      } catch {}
    }
    // Tags arriving change what a track says about itself, not which tracks
    // there are: that is TrackMetadataChanged, one per track, rather than
    // telling every client to reread the whole list. Collected over a run of
    // files so a folder's worth of tags is one burst.
    tagged.add(file);
    if (tagAnnouncement != null) return;
    tagAnnouncement = setTimeout(() => {
      tagAnnouncement = null;
      const files = new Set(tagged);
      tagged.clear();
      for (const track of playlist) {
        try {
          if (!files.has(fileURLToPath(track.url))) continue;
        } catch {
          continue;
        }
        tracklist.emit("TrackMetadataChanged", pathFor(track.id), trackMetadata(track, artFor(track)));
      }
    }, 500);
  };

  // What clients have been told about the playlists, so only real changes are
  // announced.
  let announcedPlaylists = { ids: "", count: -1, active: "" };

  function announcePlaylists(previous) {
    const changed = {};
    const ids = saved.map((one) => one.id).join(" ");
    // MPRIS has no signal for a playlist appearing or going away: a client
    // rereads GetPlaylists when PlaylistCount changes. A rename leaves the
    // count alone, so the count is announced whenever the set of playlists
    // changes at all, even when the number is the same.
    if (ids !== announcedPlaylists.ids || saved.length !== announcedPlaylists.count) {
      announcedPlaylists = { ...announcedPlaylists, ids, count: saved.length };
      changed.PlaylistCount = saved.length;
    }
    const active = JSON.stringify(playlists.ActivePlaylist);
    if (active !== announcedPlaylists.active) {
      announcedPlaylists = { ...announcedPlaylists, active };
      changed.ActivePlaylist = playlists.ActivePlaylist;
    }
    if (Object.keys(changed).length > 0) bus.emitPropertiesChanged(OBJECT_PATH, PLAYLISTS_IFACE, changed);
    // A playlist that is still there but lists different tracks: its details
    // changed, which is what PlaylistChanged is for.
    for (const one of saved) {
      const before = (previous ?? []).find((was) => was.id === one.id);
      if (before && !sameTracks(before.urls, one.urls)) {
        playlists.emit("PlaylistChanged", [one.id, one.name, ""]);
      }
    }
  }

  let rescanning = null;
  async function refreshPlaylists() {
    const previous = await scanPlaylists();
    announcePlaylists(previous);
  }
  // The folder is watched rather than polled, and a burst of events (a save is
  // a write and a rename) is one rescan.
  function scheduleRescan() {
    if (rescanning != null) return;
    rescanning = setTimeout(() => {
      rescanning = null;
      refreshPlaylists().catch(() => {});
    }, 300);
  }
  onPlaylistsChanged = () => announcePlaylists(saved);

  // The folder may not exist yet — the plugin or archamp's own Save list makes
  // it — so a failed watch is retried rather than given up on, and it is
  // reopened if the plugin is pointed at a different folder.
  let watcher = null;
  let watched = null;
  function watchPlaylists() {
    const folder = playlistsFolder();
    if (watcher && watched === folder) return;
    watcher?.close();
    watcher = null;
    watched = folder;
    try {
      watcher = watch(folder, () => scheduleRescan());
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }
  refreshPlaylists().catch(() => {});
  watchPlaylists();
  // Also the fallback for a folder that cannot be watched, and the only way
  // archamp hears about the plugin being pointed somewhere else.
  const watchTimer = setInterval(() => {
    const moved = playlistsFolder() !== watched;
    watchPlaylists();
    if (moved || !watcher) scheduleRescan();
  }, 30000);
  app.once("will-quit", () => {
    clearInterval(watchTimer);
    watcher?.close();
  });

  // The equalizer changed: the sliders, the on/off, or which preset they are.
  let announcedEq = JSON.stringify(eq);
  ipcMain.on("mpris:equalizer", (_event, next) => {
    if (next == null) return;
    eq = {
      enabled: Boolean(next.enabled),
      auto: Boolean(next.auto),
      preamp: Number(next.preamp) || 0,
      bands: Array.isArray(next.bands) ? next.bands.map((value) => Number(value) || 0) : eq.bands,
      presets: Array.isArray(next.presets) ? next.presets.map(String) : eq.presets,
      preset: String(next.preset ?? ""),
    };
    const now = JSON.stringify(eq);
    if (now === announcedEq) return;
    announcedEq = now;
    bus.emitPropertiesChanged(OBJECT_PATH, ARCHAMP_EQ_IFACE, {
      Enabled: eq.enabled,
      Auto: eq.auto,
      Preamp: eq.preamp,
      Bands: eq.bands,
      Presets: eq.presets,
      Preset: eq.preset,
    });
  });

  ipcMain.on("mpris:seeked", (_event, seconds) => {
    position = { seconds, at: Date.now() };
    player.emit("Seeked", Math.round(seconds * 1e6));
  });

  // What clients have been told about the window, so only real changes are
  // announced — it is set from two places and the compositor is a third.
  let announcedWindow = "";
  function windowChanged() {
    const now = JSON.stringify([archampWindow.Hidden, archampWindow.KeepHidden, archampWindow.Tray]);
    if (now === announcedWindow) return;
    announcedWindow = now;
    bus.emitPropertiesChanged(OBJECT_PATH, ARCHAMP_WINDOW_IFACE, {
      Hidden: archampWindow.Hidden,
      KeepHidden: archampWindow.KeepHidden,
      Tray: archampWindow.Tray,
    });
  }
  announcedWindow = JSON.stringify([archampWindow.Hidden, archampWindow.KeepHidden, archampWindow.Tray]);

  // Album art arrives as bytes (webamp only has a blob: URL for it), and panels
  // need a file they can load, so it's written out once per distinct image.
  fs.rm(artDir, { recursive: true, force: true }).catch(() => {});
  ipcMain.handle("mpris:art", (_event, bytes) => writeArt(Buffer.from(bytes)));

  return { windowChanged };
}

module.exports = { startMpris, tracksForUri, tracksForUris, writeEmbeddedArt, playlistOpened, playlistsFolder, musicFolder, openedPlaylistUri };
