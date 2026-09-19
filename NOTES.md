# archamp development notes

What's been built, why it works the way it does, and what to watch for when
picking the project up on another machine or OS. Current as of 2026-09-13.

## Setting up on a new machine

```bash
git clone https://github.com/lancefaul/archamp
cd archamp
npm install
node node_modules/electron/install.js   # see below
npm start
```

**npm 12 and newer skip dependency install scripts**, so `npm install` finishes
without error but never downloads Electron's binary, and `npm start` then fails.
Either run `node node_modules/electron/install.js` after installing (as above),
or allow it once and for all with `npm approve-scripts electron`, which records
an `allowScripts` entry in `package.json` (not done yet).

Versions: Electron 44.3.0 (bundles Node 24.20), webamp 2.3.1, dbus-native 0.15.2
(needs Node 22.12 or newer, which Electron's bundled Node covers). MPRIS needs a
D-Bus session bus; without one archamp still runs, just without media keys.

**Your settings and caches live in `~/.config/archamp/`**, not in the repo:

- Local Storage: the saved size (`archamp.scale`) and museum skin (`archamp.skin`)
- `museum/`: downloaded skins and screenshots from the Skin Museum
- `mpris-art/`: album art handed to media widgets (cleared at every launch)

Copy that folder to carry them over. The playlist isn't saved anywhere yet.

## What's built

### The player window

- A frameless, transparent window that's always exactly the size of the Winamp
  windows. It grows while a context menu is open so the menu isn't cut off.
- Dragged by any title bar. Wayland doesn't let an app position its own window,
  so the title bars are native drag regions (`-webkit-app-region: drag`) and the
  compositor does the moving.
- Main, equalizer and playlist move as one unit. webamp's own in-page window
  dragging and its resize handling are switched off, so it can't rearrange the
  windows inside ours.
- Closing the equalizer or playlist doesn't leave a window-sized gap: webamp
  itself only removes a closed window from the layout and leaves the others at
  their old absolute position, so `moveWindowsToOrigin` restacks whichever
  windows are open, in a fixed order (main, equalizer, playlist), with no
  space between them.
- Menus close when you click away: when the window loses focus, or when you
  press a title bar (title bars stop being drag regions while a menu is open).
- The title bar's options button (the small icon at its left) pins its menu to
  the player's full width, growing upward from the title bar instead of
  wherever webamp would otherwise drop it — Wayland won't let archamp move its
  own window to make room above the title bar's current screen position, so
  in practice this means: the window grows as it always does (from its
  current top-left corner, downward), and the player shifts down to make room
  for the menu at the window's actual top. The title bar visibly shifts down
  on screen while that menu is open. It also acts like an expanded section
  rather than a popover: unlike webamp's other menus, it doesn't close on an
  outside click, only by pressing the options button again. Still webamp's
  plain HTML/CSS menu look. Only this one button's menu gets this treatment
  so far; a right-click elsewhere, and the equalizer's Presets menu, still
  open (and close on outside click) as webamp normally does.
- The options menu's look is custom, not skin-derived: classic Winamp skins
  have no assets for a menu at all (real Winamp never skinned this one
  either). Tried and dropped: reusing skins' "generic window" border
  (GEN.BMP) — webamp extracts it (`state.display.skinImages.GEN_*`) for
  third-party plugin windows but never draws it itself, and it does produce a
  genuinely per-skin-styled panel, but matching its exact fixed-size sprite
  geometry made every skin's menu look different in ways that didn't hold
  together as one system. Went with a fixed, square, dark, JetBrains Mono
  look instead — same structure regardless of skin, echoing Omarchy's own
  system menus — pulling only one accent color from the skin's GenEx colors
  (`display.skinGenExColors`, for checkmarks) for a little per-skin identity.
- Code: `renderer.js` (`keepWindowFitted`, `moveWindowsToOrigin`,
  `blockInPageDragging`, `closeMenusOnClickAway`, `layoutOptionsMenu`,
  `installOptionsMenuTrigger`, `installOptionsMenuStylesheet`,
  `skinAccentColor`), `index.html` (the drag-region CSS), `main.js`
  (`fit-window`).

### Scaling

- The player is sized in whole screen pixels per skin pixel, so skins stay
  sharp. The default is Winamp's double size rounded to whole pixels:
  round(2 × display scale), which is 3 at 145%.
- Ctrl+= / Ctrl+- step the size, Ctrl+0 goes back to the default, and
  Ctrl+scroll works too. It stops at the largest size that fits on screen. The
  size is saved per machine.
- Winamp's own double-size "D" button still works as it always did, on top of
  this.
- Code: the scale section of `renderer.js`; `main.js` answers `work-area`.

### Skin Museum browser

- Alt+S (Winamp's own shortcut) or Skins → Browse Skin Museum… opens a window
  with a search box and a grid that loads more as you scroll. Clicking a skin
  applies it, and the last museum skin comes back at launch.
- Uses the museum's GraphQL API (`api.webamp.org`). Skins and screenshots are
  downloaded once, at most six at a time (like the museum's own site), into the
  cache folder, and served to both windows as `museum://` URLs. NSFW skins are
  always hidden.
- The browser window is sandboxed: no Node, context isolation, a strict content
  security policy.
- Code: `museum.js`, `skin-browser.html`, `skin-browser.js`,
  `skin-browser-preload.js`; `createSkinTracker` in `renderer.js`.

### Updates

- Every colour one of archamp's own windows uses has to be listed in that
  page's `applyTheme`, not just declared in its `:root`. A token that is
  declared but not themed silently keeps its hardcoded fallback — which is how
  the about box ended up with a blue hover on a green theme. Tokens built with
  `calc()` off `--rem` follow on their own.
- The Winamp menu's ARCHAMP section has Check for updates... and About...
  About opens a window of its own — the mark, the name, the tagline, the
  version, and Powered by Webamp at the foot — rather than a drawer in the
  player.
  The check runs in the row: a spinner where the checkmark goes, then the
  answer, then back to resting after five seconds.
- A newer archamp opens a window with the release notes, the exact command
  that will replace the AppImage, a Copy button, and Update/Cancel. The
  command downloads beside the current file and moves over it, so a failed
  download cannot leave a broken archamp behind.
- It reads `https://api.github.com/repos/lancefaul/archamp/releases` — the
  list, not `/releases/latest`, which leaves out prereleases, and every
  archamp so far is one. **This needs the repository to be public**; a private
  one answers 404 to an anonymous check.
- Version comparison is full semver precedence (`releases.js`), because alpha
  builds need it: alpha.9 is older than alpha.10, not newer as a string
  comparison would have it, and 0.2.0 beats every 0.2.0-alpha.
- Tested without a release: `test/releases.test.mjs` covers the reading, and a
  local server standing in for GitHub covers the window and the replace.

### Media keys and MPRIS

- archamp publishes its own MPRIS player, `org.mpris.MediaPlayer2.archamp`, so
  media keys, KDE's media controls and bar widgets (Omarchy's included) can see
  and control it: title, artist, album, length and album art; play, pause,
  stop, next and previous; exact seeking, volume, repeat and shuffle.
- Chromium's built-in MPRIS is turned off
  (`--disable-features=HardwareMediaKeyHandling` in `main.js`). It stopped
  publishing the song title after a Stop and could only seek in 10-second
  jumps.
- Next and Previous are only advertised when there's a track to go to. Next with
  nowhere to go (the last track, repeat off) stops playback; before, webamp only
  looked stopped while the song kept playing.
- The window title follows the track, as Winamp's did: "Artist - Title - archamp".
- The playlist is published too (`org.mpris.MediaPlayer2.TrackList`), and it is
  editable: `Tracks` lists it in play order, `GetTracksMetadata` gives each
  entry's title, artist, album, length, track and disc number, year and art,
  `GoTo` jumps to one (playing it if something is playing, readying it if
  stopped, as a double-click does), `AddTrack` inserts a file, folder or M3U
  after a given track, and `RemoveTrack` takes one out. `CanEditTracks` is
  true. `TrackAdded`, `TrackRemoved` and `TrackMetadataChanged` report single
  changes; `TrackListReplaced` only wholesale ones (open, clear, sort).
  archamp adds `org.archamp.TrackList.MoveTrack` for reordering, which MPRIS
  itself has no call for.
- `OpenUri` takes a `file://` URI of a track, a folder (its audio files, in
  name order) or an M3U playlist, and replaces the playlist with it and plays.
  OMedia Controls' library uses this to hand archamp what to play.
- The window can be hidden: archamp keeps playing with no window at all, and
  the audio, the media keys, MPRIS and OMedia Controls all carry on. It is
  `org.archamp.Window` on the same bus name — `Hidden` for this session,
  `KeepHidden` for the remembered setting — plus "Keep hidden" in archamp's
  own menu. `Raise` always brings the window back without changing the
  setting. "Show in tray" beside it puts archamp's icon in the system tray,
  whose menu holds one entry, Show archamp. On Omarchy an unpinned icon sits
  in the bar's tray drawer behind the chevron; right-click there and Pin puts
  it in the bar for good, which is kept in `~/.config/omarchy/shell.json`
  under the `omarchy.tray` entry. Electron gives archamp a stable tray id
  (`archamp_status_icon_1`), so the pin survives a new build. The chevron
  itself stays whatever you pin — Omarchy draws it whenever there is any tray
  item at all, because it is also the way to the Pin/Hide popup.
  To get a hidden window back without the plugin, just start archamp
  again from your launcher — Wayland has no minimizing and Omarchy no taskbar,
  so a second launch with nothing to play shows the window. Giving a hidden
  archamp files to play does not: that is the plugin or a file manager, and
  the window stays out of the way. `--hidden` and `--show` force either for
  one launch.
- A restarted archamp comes back paused where it left off, with the playlist
  it was playing still named. Launching it with a file that holds nothing to
  play (`archamp notes.txt`) restores the session rather than coming up empty.
- Saved playlists are published too (`org.mpris.MediaPlayer2.Playlists`):
  `GetPlaylists` lists the M3U files in the playlist folder, `ActivatePlaylist`
  loads one, and `ActivePlaylist` names the one playing — which is what puts
  the playlist's name on OMedia Controls' PLAYLIST heading. Which playlist the
  queue is gets worked out by comparing the queue against what each file
  lists, so a playlist renamed or edited while it plays is still recognised,
  and a queue added to or trimmed stops being a saved playlist by itself.
- The playlist folder is the plugin's: archamp reads (and never writes)
  `~/.local/state/omedia-controls/preferences.json` and follows
  `playlistFolder`, else `Playlists` inside `musicFolder`, else the desktop's
  music folder. Save list writes there and Load list opens there, so a list
  made in either archamp or the plugin shows up in both.
- The equalizer comes back as it was left: the bands, and whether it was
  switched on. The bands are kept either way, so switching it back on restores
  the setting rather than a flat one.
- The equalizer is on the bus too (`org.archamp.Equalizer`): ten bands and a
  preamp in decibels, on/off, the preset list with whichever is in effect, and
  apply/reset/load/save. dB rather than webamp's 0..100 sliders — its span is
  exactly -12 to +12, so archamp converts and a panel never has to know.
- Album art is written under a name made from its own bytes, so one cover is
  one file however many tracks carry it — and for that reason it is never
  written twice. Every track on an album asks for the same path while a panel
  is showing it, and `fs.writeFile` truncates before it writes: a reader
  landing in that window gets the top of the picture and grey underneath until
  the write finishes. It is written only when it is not already there, through
  a temp name and a rename.
- `Raise` brings the window back: it restores it if minimized, shows it, then
  asks for focus. On Wayland an app cannot simply take focus — it needs an
  activation token, which Electron requests inside `show()`/`focus()`.
  Hyprland honours it, and will switch to the window's workspace to do so.
- Code: `mpris.js` (main process, via dbus-native); `createMprisBridge` and
  `stopWhenNothingToSkipTo` in `renderer.js`.

## Decisions you made

- Build everything in-house; don't borrow code from similar projects such as
  durasj/webamp-desktop.
- The AppImage has no version in its filename. Updating is replacing that one
  file in place, so a versioned name goes stale the first time it happens —
  1.0.0 on disk, 1.0.2 inside. Keeping the version would mean renaming the
  file on every update, which moves the path the desktop entry, the launcher
  and the restart all point at. A stable name costs nothing: the asset matcher
  looks for `.AppImage`, and About is what knows the version.
- Deferred: the player window's security settings (`nodeIntegration` on,
  `contextIsolation` off, `webSecurity` off) and a test suite.
- Scaling in crisp whole-pixel steps; keep the classic D button.
- Skin Museum browsed online with a local cache rather than a full ~25 GB copy.
  NSFW skins always hidden, with no toggle.
- archamp's own MPRIS player instead of Chromium's.
- Commit straight to `main`.

## When you switch OS or desktop

### Any Wayland compositor

- Moving the window depends on the compositor honouring drag regions (an
  xdg-toplevel move). KWin does; Hyprland should.
- archamp's Wayland app ID is `archamp` (KWin reports it as the window class and
  desktop file).
- A saved size counts screen pixels, so on a display with a different scale it
  keeps its physical size. Ctrl+0 returns to that display's default.

### KDE Plasma (the current EndeavourOS setup)

- Display scale 1.45 on the 4K monitor, so the default size is 3: the main window
  is 825 screen pixels wide.
- Stock KDE: KDE's own media service sends the media keys to archamp over MPRIS.
  Nothing to configure.
- With the Omarchy shell replacing plasmashell (`~/omarchy-kde`, outside this
  repo): KDE's kded6 keeps answering media and volume keys even with plasmashell
  stopped, so the omarchy-kde key listener (`~/omarchy-kde/kde-keys`) takes those
  keys away from KDE. Without that, every press counted twice: play/pause
  cancelled itself, Next skipped two tracks, volume moved 2%. Changed on
  2026-09-13; the previous version is at
  `~/omarchy-kde/baseline-2026-09-13/kde-keys.before-media-takeover`.

### webamp's unfinished buttons

- **File inf** and **Rem misc** are `alert("Not supported in Webamp")` in
  webamp itself, and an alert in Electron blocks the whole window until it is
  dismissed. File inf is archamp's own drawer now, reading the file with
  music-metadata (the same dependency the MPRIS tags use), and Rem misc
  sweeps the tracks whose files are gone and says how many it took out.
  Neither reaches webamp's alert: the press is caught in the capture phase
  before it does.

### Omarchy / Hyprland

- Confirmed working. Hyprland tiles new windows, but archamp sizes its own
  window, so it needs a window rule that floats class `archamp` (`hyprctl
  clients` shows the class):

  ```lua
  o.window("archamp", { float = true })
  ```

  **archamp issues this itself at startup** (`hyprland.js`, 1.1.0) rather than
  asking anyone to paste it into a config. Hyprland takes a rule at runtime
  over `hyprctl`, so this writes nothing, lasts until Hyprland reloads its
  config, and needs nothing from the user. Two forms, because the two config
  parsers refuse each other's command — `eval` for a Lua config, `keyword
  windowrule` (and the older `windowrulev2`) for a classic hyprland.conf.
  Measured before it was written: a probe window mapped before the rule tiled,
  an identical one mapped after floated. The full account is in
  OMEDIA-PLAN.md.

  **`no_anim` is not part of it.** It was tried and dropped. Hyprland opens a
  window with `windowsIn popin 87%` over 410ms, and archamp's window is fully
  drawn the moment it appears (it is held back until then), so the animation
  scales and fades a finished player — filmed at 40ms intervals, three frames
  of a translucent player growing. Suppressing it made archamp the one window
  on the desktop that does not animate, which is a louder difference than the
  three frames. It opens like everything else.

  **Don't pin a `size` on this rule.** An earlier version of this rule was
  `{ float = true, size = { 420, 700 } }`, which clipped the equalizer and
  playlist: archamp resizes itself dynamically (see Scaling, above), and on
  a monitor at fractional scale (this one's at 1.333×, giving scale level 3)
  the real content is 522×660 — wider than the hardcoded 420, so Hyprland
  clamped it and cut off the right edge. A `size` rule only sets the
  *initial* floating size in Hyprland, so it looks fine for a frame and then
  clips as soon as archamp's own `setContentSize()` call is applied; letting
  the rule omit `size` entirely lets that call win outright.
- **"Pause others" in the plugin will pause archamp, and it looks like a
  broken Play button.** The plugin's audio focus (Settings → Pause others,
  off by default, on here) pauses every other player whenever one *starts*.
  So with a browser or Discord making noise in bursts — a call, a video, a
  notification — archamp is paused within a second of every Play, and
  pressing play in the popup appears to do nothing at all. Reproduced exactly
  with mpv: archamp Playing, start `mpv --no-video file.mp3`, archamp is
  Paused 0.7s later and stays paused after mpv exits. Nothing to fix in
  archamp; `Play` over MPRIS resumes it every time on its own.
- Omarchy binds the media keys to `omarchy-shell media …`, which drives the
  active MPRIS player, so archamp should work as is. If a press ever acts twice,
  look for a second handler, as happened on KDE.

### X11

- Not tried. Drag regions work on X11 too, and nothing in the code is
  Wayland-only.

## Tests

```bash
npm test
```

`test/mpris-conformance.mjs` checks what archamp promises over MPRIS by
driving a real archamp: it generates three tagged tracks with ffmpeg, starts
the app on a throwaway profile (`--user-data-dir`) with its volume at zero,
and asks for everything over `busctl`. It needs a desktop session, so it is
not a CI suite. Set `ARCHAMP_TEST_LOG=/tmp/app.log` to keep the app's own
output from a run. Checks marked `todo` are promises the OMedia Controls plan
has not reached yet (see OMEDIA-PLAN.md).

## Handy commands

```bash
# Inspect or drive the live page over the Chrome DevTools Protocol
npm start -- --remote-debugging-port=9222      # then see http://127.0.0.1:9222/json

# MPRIS, from the outside
busctl --user get-property org.mpris.MediaPlayer2.archamp /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player Metadata
busctl --user call org.mpris.MediaPlayer2.archamp /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player PlayPause
busctl --user monitor org.mpris.MediaPlayer2.archamp   # who is sending what
```

Main-process code such as `mpris.js` can be tested in a small Electron script
with no window. If that script also serves D-Bus itself, run `busctl`
asynchronously from it, or it deadlocks waiting on itself.

## Known limitations

- The equalizer and playlist can't be pulled away from the main window.
- Double-clicking a title bar no longer toggles shade mode, and right-clicking a
  title bar opens the compositor's window menu rather than Winamp's (right-click
  anywhere else still gives Winamp's).
- Double size (D) at a large scale can run off the screen.
- The museum cache has no size limit.
- KDE's media widget shows no app icon until there's a `.desktop` launcher;
  archamp offers to write one on first run (see desktop.js).
- webamp opens the playlist's "Add file" with a bare `<input type="file">` and
  no `accept`, so its dialog offered every file on disk — the `.lrc` beside
  every track included. The input is never in the document, so there is
  nothing to select it with; archamp catches it on the way to being clicked,
  which is the one thing every such input does, and gives it the audio list.
  A directory picker is left alone.
- Several features lean on webamp internals, so check these when upgrading it.
  Store actions archamp dispatches: `BUFFER_TRACK`, `LOAD_DEFAULT_SKIN`,
  `PLAY_TRACK`, `REMOVE_TRACKS`, `SET_BAND_VALUE`, `SET_EQ_ON`, `SET_EQ_OFF`,
  `SET_EQ_AUTO`, `SET_TRACK_ORDER`, `STOP` and `UPDATE_WINDOW_POSITIONS`.
  Actions it watches for: `IS_STOPPED`, `LOADED`, `SEEK_TO_PERCENT_COMPLETE`,
  `SET_SKIN_DATA` and `UPDATE_TIME_ELAPSED`. The shape of
  `store.getState().equalizer`, `.playlist`, `.tracks` and `.media`. The
  private `__customMiddlewares` option, and the audio element reached through
  `webamp.media`, which playback speed and repeat-one both set properties on.
- `main.js` uses the deprecated `console-message` arguments, so Electron prints a
  warning at startup.

## Next up

Both of the old entries here — loading a music library folder at startup and a
proper `.desktop` launcher — shipped in 1.0. What is left is the options menu.

### Options menu follow-ups (2026-09-13 session)

The options menu (see The player window, above) works but isn't done:

1. Menu items are too large — font size especially. `installOptionsMenuStylesheet`
   in `renderer.js` currently uses 12px; needs a pass at sizing everything down.
2. Too many menu items, with a lot of overlap against controls already on the
   main window (e.g. Play/Pause/Shuffle/Repeat are both menu entries and
   physical buttons) — trim the menu down; figure out why webamp's default
   menu duplicates so much of the player's own UI before deciding what to cut.
3. Colors don't meet WCAG 2.2 contrast — and since one color (the checkmark
   accent) comes from the loaded skin's `skinGenExColors`, this needs checking
   automatically per skin, not just once: a contrast-ratio evaluator that runs
   against the accent color (and falls back to a safe default when a skin's
   accent fails) rather than a one-time manual check.
4. Find out what icon set/style Omarchy itself uses (its own menus, per the
   reference screenshot from this session) and use a matching checkmark icon
   instead of the current Unicode ✓ glyph.
5. Flatten the submenu structure. Right now opening a submenu (Play, Skins,
   Options, Playback) changes the menu's total height, which — because the
   whole player shifts to make room for this menu (see layoutOptionsMenu) —
   moves the entire window around on screen. Fewer nesting levels (point 2
   should help directly) means less of that movement.

## History

| Commit | What |
| --- | --- |
| `314b5e2` | Sync `package-lock.json` with `package.json` |
| `5b11838` | Fit the window to the player and move it by its title bars (plus scaling and menu click-away) |
| `41db573` | Add a Skin Museum browser |
| `66ffabe` | Update README for the window, scaling and skin browser work |
| `9335d98` | Stop playback when Next/Previous has no track to go to |
| `4103c43` | Publish playback over MPRIS from archamp itself |
