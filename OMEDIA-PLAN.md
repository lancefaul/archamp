# archamp as OMedia Controls' first-class player

Goal: every feature of OMedia Controls works with archamp, fully, with nothing
dimmed or explained away, and archamp is a complete MPRIS citizen by the spec
(MPRIS 2.2: root, Player, TrackList, Playlists), not just by what the plugin
happens to read. Written 2026-09-16 against archamp `mpris-tracklist`
(4c53c50) and OMedia Controls 1.2 (private `84ce863`).

## Where things stand

What already works with the plugin, from `mpris.js` and on-screen testing:

| Plugin feature | archamp today |
| --- | --- |
| Now playing: title, artist, album, art, length | Works |
| Play, pause, stop, next, previous, seek bar | Works (exact `SetPosition`) |
| Shuffle | Works |
| Repeat button | Works, all three positions: the plugin's cycle reads None → Playlist → Track → None, and Winamp's own button shows repeat as on for either kind (pressing it turns both off) |
| Playlist bar and column, "Song x/x", click to play | Works (TrackList: `Tracks`, `GetTracksMetadata`, `GoTo`) |
| Library: play a track, a selection or a folder | Works while archamp is running (`OpenUri`) |
| Close player (X in the players list) | Works (`Quit`) |
| Lyrics, format chips | Work (both read the file from `xesam:url`) |
| Visualiser | Worked in testing; the stream match needs confirming (see 5.1) |

What doesn't:

| Plugin feature | Gap |
| --- | --- |
| Speed buttons | Works: `Rate` runs 0.25x to 4x, over MPRIS only (Winamp had no speed control, so archamp's own window has none) |
| Repeat one track | Works: `LoopStatus` takes all three, and Track loops the audio itself so the track never ends |
| Album · year line, track numbers | Works: tags are read from the files themselves |
| PLAYLIST heading with the playlist's name | Works: the Playlists interface names the queue, including after the plugin renames or edits the playlist |
| Settings → Music Player: pick archamp | Works: archamp writes its own `.desktop` file and icons on first run (`desktop.js`), so the plugin lists it |
| Library when archamp isn't running | Works: the desktop entry launches it and it takes files, folders and M3Us as arguments |
| Starting a second copy | Works: a single-instance lock hands the files to the copy already running and raises it |
| Hiding archamp's window while the plugin does the controlling | Works: `org.archamp.Window`, with a switch in the plugin's Settings under MUSIC PLAYER |
| Player icon, grouping by desktop entry | Works: `DesktopEntry` is `archamp` |
| After a restart | Works: the playlist, the track, the position, volume, shuffle and repeat come back, paused |

## Parked, to come back to

- **Shipping the Hyprland rule.** `o.window("archamp", { float = true,
  no_anim = true })` is what archamp wants from the compositor: float,
  because Hyprland tiles a transparent skin window into a slot and it looks
  broken; no animation, because the window is held back until the player is
  drawn, so popping it in from 87% reads as the app loading and resizing
  itself. A client cannot ask for either on Wayland. Decide at packaging time
  between showing the rule with the desktop-integration prompt (Phase 1,
  item 9), having an installer offer to append it, and upstreaming
  `default/hypr/apps/archamp.lua` to Omarchy, where its per-app rules live.
  Tried on this machine on 2026-09-17 and switched back off, so the player
  opens with the compositor's animation as everything else does; measured in
  NOTES.md.
- **A splash screen.** Parked with a design in hand. It would not help what it
  was raised for: a splash is a window too, so it pops in the same way, and
  it cannot paint until Chromium is up — which is 0.9s of the 1.25s from
  launch to the player being on screen. Worth building only for the mark
  itself, not to cover a wait.

## Backlog

Wanted, not yet scheduled. Written down with what is already known about
each, so none of it has to be worked out twice.

1. ~~**An updater, like the plugin's.**~~ Done. An ARCHAMP section at the top
   of the Winamp menu, above FILES, with Check for updates... and About...

   About... opens a window of its own, the same size as the skin browser: the
   mark, the name, "An ode to the ~~GOAT~~ LLAMA" and the version, centred,
   with a close button top right and "Powered by Webamp" along the bottom.
   Webamp is a link, and it opens in the desktop's browser — main holds the
   address, so the page cannot ask for any other one, and the window refuses
   to navigate anywhere itself. The icon comes from the app's own
   `build/icon.svg`, handed to the page as a data URI so there is one copy of
   the artwork and the page needs no file access.

   The check happens in the row itself: it spins in the checkmark's column
   while it asks GitHub, then either ticks and says "You are on the latest
   version (x.x.x)" for five seconds before going back to offering another
   look, or says why it could not. The menu stays open throughout — it is the
   one row in archamp that changes while it is being read.

   A newer archamp opens a window built like the skin browser: a pinned
   header, a rule, the release notes scrolling (a section per heading, as the
   plugin lays them out), a rule, the exact command with a Copy button, a
   rule, Update and Cancel.

   Not `electron-updater`: an AppImage is one file and updating is replacing
   it, so the update is a shell command shown in full before it runs — read
   it, copy it, or let Update run it. It downloads beside the file and moves
   over it, so a failed download cannot leave half an archamp in place of a
   working one, and the path is written out rather than left as `$APPIMAGE`,
   which is only set inside a running AppImage and so would break the moment
   it was pasted into a terminal.

   Two things it needs that are not archamp's to give: the repository has to
   be public for the anonymous check to work, and there has to be a release
   with an `.AppImage` asset. Until then the row says GitHub answered 404.

2. **The equalizer, over D-Bus.** ~~archamp's half~~ done:
   `org.archamp.Equalizer` on the same bus name and object path.

   `Bands` (ten) and `Preamp` are read/write **in decibels**, not webamp's
   0..100 sliders: dB is the number Winamp's own equalizer is labelled in, and
   webamp's span is exactly -12 to +12 (`db = value / 100 * 24 - 12`, read off
   its source rather than assumed), so the conversion is exact and archamp
   does it. `Frequencies`, `MinimumGain` and `MaximumGain` come with them so a
   panel can label and bound its sliders without knowing anything about
   webamp. `Enabled` and `Auto` are read/write. `Presets` lists the names, a
   loaded `.eqf` first as the drawer shows it, and `Preset` names whichever
   the bands currently are, or "" for a setting of one's own — decided by
   comparing sliders, not file values, because webamp snaps anything near the
   middle to dead centre and two different files can be the same setting.
   `ApplyPreset`, `Reset`, `LoadPreset` and `SavePreset` are the drawer's own
   actions, the last two taking a path rather than opening archamp's dialogs.
   Everything is announced with PropertiesChanged.

   Five tests cover it, and `.eqf` round-trips through the bus: save Techno to
   a file, reset, load it back, and every band returns.

   **Still to do: the plugin's half** — an equalizer drawn in the popup when
   the active player offers this interface, the way the hide switch appears
   when a player offers `org.archamp.Window`.

3. ~~**Hiding the window, reachable from the plugin.**~~ Done, as Phase 1b.

4. **Picking archamp in the plugin's Settings.** Two halves. archamp's is
   Phase 1: a `.desktop` file is what puts it in the plugin's Music Player
   list at all (that list is built from installed desktop entries). The
   plugin's half is separate — offering to make the chosen player the
   desktop's default for audio (`xdg-mime default`), rather than only using
   it itself.

## Phase 0: groundwork — **done**

1. ~~Merge `mpris-tracklist` into `main`~~ (ddd9cb8 is on `main`; the branch is
   gone).
2. ~~An MPRIS conformance test~~: `test/mpris-conformance.mjs`, run by
   `npm test`. It generates three tagged tracks with ffmpeg, starts archamp on
   a throwaway profile with its volume at zero, and drives it over D-Bus with
   `busctl`: the root interface, an empty player, OpenUri on a folder, a file
   and an M3U, metadata, position and both kinds of seek, play/pause/stop,
   shuffle and repeat, volume, next and previous, GoTo, AddTrack, RemoveTrack
   and MoveTrack. Thirteen checks pass today; the promises still to come are
   in the file as `todo`, one per phase, and each phase turns its own into a
   passing check. It needs a desktop session (D-Bus, a display, ffmpeg,
   busctl), so it isn't a CI suite.
3. ~~`allowScripts` for Electron~~ in `package.json`, so `npm install` alone
   gives a working checkout.

## Phase 1: installed like a real app

1. **An AppImage**, built with `electron-builder` (`npm run dist`), x86_64,
   named `archamp-<version>-x86_64.AppImage`, attached to GitHub releases.
   The app ID stays `archamp`, so the Wayland class and the Hyprland float
   rule don't change.
2. **Desktop integration from the AppImage itself.** An AppImage installs
   nothing, but the plugin's Music Player list is built from installed
   `.desktop` files (`gio mime audio/mpeg`). So archamp writes its own, under
   `~/.local/share/applications/archamp.desktop`, with its icon under
   `~/.local/share/icons/hicolor`:
   - on first launch, after asking once ("Add archamp to your applications?"),
     and from an Options menu entry later;
   - rewritten at every launch when `$APPIMAGE` has moved, so the entry never
     points at a file that's gone;
   - removed with `archamp --remove-desktop-integration`.
   If AppImageLauncher or Gear Lever has already integrated it, archamp
   leaves their entry alone.
3. **`archamp.desktop`**: `Exec=<AppImage path> %F`, `Icon=archamp`,
   `Categories=AudioVideo;Audio;Player;`, `StartupWMClass=archamp`, and a
   `MimeType` list matching `SupportedMimeTypes` plus the aliases desktops
   register (`audio/x-flac`, `audio/x-m4a`, `audio/x-wav`, `audio/x-aiff`,
   `audio/x-mpegurl`). Then `update-desktop-database`.
4. ~~**An app icon**~~ Winamp's lightning bolt (`build/icon.svg`, rendered to
   `build/icon.png`), in the AppImage, installed by 2, and used for the tray.
   archamp is a Winamp player — webamp draws the real thing, skins and all —
   so it wears the mark it is a player for.
5. **`DesktopEntry` = `archamp`** on the MPRIS root interface.
6. **Files on the command line**: `archamp FILE…`, a folder or an M3U replaces
   the playlist and plays, using the same `tracksForUri` as `OpenUri`.
7. **One archamp at a time**: `app.requestSingleInstanceLock()`. A second
   launch hands its files to the running one (`second-instance`) and exits,
   so the plugin's `gtk-launch archamp a.mp3 b.mp3` always lands in the
   player you already have. The "second archamp gets its own bus name" path
   in `mpris.js` stays as a fallback.
8. **Closing quits**, from archamp's own close button or the plugin's X
   (`Quit`), always. Hiding is a separate thing (Phase 1b).
9. **The Hyprland rule** (`float`, and `no_anim` so a finished player isn't
   popped in as though it were still loading): shown once with the desktop
   integration prompt, not written into Hyprland config by archamp. Upstream
   `default/hypr/apps/archamp.lua` to Omarchy if archamp ever ships with it —
   that is where its per-app rules live.

## Phase 1b: hiding the window — **done**

For when the plugin does the controlling and the Winamp window is just in
the way. Hidden means no window at all; audio, MPRIS, media keys and the
plugin all carry on.

1. ~~**archamp remembers "keep the window hidden"**~~ In `settings.json`
   beside its other state, read before the window is made — the renderer's own
   storage cannot hold this, since it decides whether there is a window to
   draw in. The way back without the plugin is to start archamp again from
   the launcher: Wayland has no minimizing and Omarchy no taskbar, so that is
   where anyone would go, and a second launch with nothing to play shows the
   window. Handing a hidden player files — the plugin, a file manager — plays
   them without putting the window in the way. `--hidden` and `--show` force
   either for one launch.
2. ~~**`Raise` always shows it**~~ It clears `Hidden` before showing and
   focusing, and leaves `KeepHidden` alone, so the player is hidden again next
   time.
3. ~~**A small D-Bus interface of archamp's own**~~ `org.archamp.Window` on
   the same bus name and object path: `Hidden` (this session) and `KeepHidden`
   (the setting, and turning it on hides the window now as well as next time),
   both read/write and both announced with PropertiesChanged — including when
   the compositor is what changed it.
4. ~~**In the plugin**~~ Done (OMedia Controls #43): a switch under MUSIC
   PLAYER in Settings, bound to `KeepHidden`. It appears when any running
   player answers that property rather than when it is called archamp, and is
   named after the player, so anything else that grows the same interface gets
   it too. Every player is asked, not only the active one: which player is
   active is whatever last made a sound, and the switch should not come and go
   because a browser tab started playing.
5. ~~**In archamp**: the same choice in its Options menu~~ A WINDOW section
   with "Keep hidden". It asks first, because once the window has gone nothing
   left on screen can bring it back, and the question says how to.
6. ~~**A tray icon**~~ "Show in tray" beside it, off by default, exposed as
   `Tray` on the same interface so a panel can offer it with the hide switch.
   The icon is the app icon, and its menu holds one entry, Show archamp, which
   is the only thing anyone opens a tray menu for. Not "run in tray": archamp
   runs the same either way and closing it still quits — what this does is put
   the icon there, and with it a fourth way back to a hidden window.

   On Omarchy the icon lands in the bar's tray drawer, behind the chevron,
   because nothing is pinned by default; right-click there and Pin keeps it in
   the bar. Electron's tray item carries a stable id (`archamp_status_icon_1`),
   so a pin sticks between launches. The chevron stays whatever is pinned:
   Omarchy draws it whenever there is any tray item, since it is also how the
   Pin/Hide popup is reached.

A hidden window is a background window, and Chromium throttles those to a
timer a minute — which would have stalled the position archamp reports, the
session it saves and the tags it reads. `backgroundThrottling` is off.

Two tests, which ask Hyprland whether there is really a window rather than
taking archamp's word for it: one hides the player, checks it keeps playing
with no window and that `Raise` brings it back without changing the setting;
one turns `KeepHidden` on, restarts archamp twice and checks it comes up
playing with no window, and that `--show` brings the window back with the
setting still on.

## Phase 2: the Player interface, complete

1. ~~**Playback speed, over MPRIS only**~~ Done. webamp plays through an
   `<audio>` element it never puts in the page, reached through its media
   object, so `playbackRate` (and `defaultPlaybackRate`, for the tracks that
   follow) does the work with `preservesPitch` on. `MinimumRate` 0.25,
   `MaximumRate` 4, `Rate` readable, writable, clamped and announced, and the
   `Position` archamp extrapolates counts at the rate: measured, 8.02s of
   track in 4s at 2x and 2.01s at 0.5x. The plugin drives it —
   `omarchy-shell lancefaul.omedia-controls speed 1.5` lands as 1.5.
2. ~~**Repeat one track.**~~ Done. `LoopStatus` takes all three. webamp knows
   only playlist repeat, so `Track` is the audio element's own loop: the track
   never ends, rather than ending and being chased back — measured, playback
   ran to 221.7s of a 221.7s track and carried on from 0.7s on the same track
   id. Winamp's own button shows as on for either kind of repeat, and pressing
   it turns both off. The plugin's cycle reads None → Playlist → Track →
   None.
3. ~~**Full metadata.**~~ Done. Tags are read in the main process with
   `music-metadata`, once per file, in the background with the playing track
   first: `xesam:trackNumber`, `xesam:discNumber`, `xesam:contentCreated`,
   `xesam:albumArtist`, `xesam:genre`, `xesam:composer`, and embedded art
   written to `mpris-art/` straight from the file, so art is there for every
   track in `GetTracksMetadata` rather than only the playing one. Tags
   arriving are announced: PropertiesChanged for the playing track,
   TrackListReplaced for the rest, batched.
4. ~~**Status edge cases**~~ Done, each with a test in the conformance suite:
   the end of the playlist leaves the last track current and `Stopped` with
   `Play` starting it again; an emptied playlist reports `Stopped`, the
   NoTrack id and false for every `Can*`; a track change resets `Position`
   without claiming a `Seeked`, while a jump announces one; and a volume
   change is announced rather than only made. The emptied-playlist test found
   a real one: removing the tracks out from under playback — over MPRIS or
   with Rem all — left webamp's status as it was and the audio element still
   going, so archamp claimed to be playing nothing, audibly. A player with an
   empty playlist now stops.
   Still untested: `Volume` set from inside archamp (the slider, the wheel),
   which needs the window driven rather than the bus.
5. ~~**`Raise` on Wayland**~~ Done. A Wayland client cannot take focus by
   asking: it needs an activation token, which Electron requests for us inside
   `show()`/`focus()`. Hyprland honours it, measured end to end — with archamp
   alone on a workspace nothing was looking at, `Raise` pulled that workspace
   onto the focused monitor and gave archamp the keyboard. `Raise` now also
   restores a minimized window first and calls `app.focus({ steal: true })`
   before the window's own `focus()`. The conformance suite proves it by
   asking Hyprland who has focus rather than by trusting the call to return,
   and skips itself where there is no compositor to ask. A compositor that
   refuses the token still shows the window, which is all MPRIS promises.

## Phase 3: the TrackList interface, complete — **done**

1. ~~**`CanEditTracks` true.**~~
2. ~~**`AddTrack(Uri, AfterTrack, SetAsCurrent)`**~~: inserts what the URI stands
   for (file, folder or M3U) after the given track, or at the start for
   NoTrack, and optionally plays it.
3. ~~**`RemoveTrack(TrackId)`**~~: removes it; removing the current track moves
   on as Winamp does.
4. ~~**Signals by the spec**~~: `TrackAdded`, `TrackRemoved` and
   `TrackMetadataChanged` for single changes (tags arriving included), and
   `TrackListReplaced` only for wholesale changes (open, clear, sort).
   `Tracks` is announced as invalidated, as the spec requires.

   This was claimed here before it was true: only `TrackListReplaced` was ever
   sent, `TrackMetadataChanged` was declared on the interface and never
   emitted, and the other two were not declared at all. Found by checking every
   declared member against the suite. Adding a track needed one more fix to be
   honest — the renderer appends and then moves into place, which is two
   changes to webamp and one to anybody watching, so the list is reported once
   at the end rather than as an add followed by a wholesale replace.
5. ~~**Stable track ids**~~ across reorders. webamp's numeric ids already are;
   the test pins it.

## Phase 4: the Playlists interface, done

1. ~~**`org.mpris.MediaPlayer2.Playlists`**~~ All of it: `PlaylistCount`,
   `Orderings` (Alphabetical, CreationDate, ModifiedDate — the three archamp
   can answer from the files themselves), `ActivePlaylist`, `GetPlaylists`,
   `ActivatePlaylist` and `PlaylistChanged`.
2. ~~**`ActivePlaylist`**~~ Names what's playing, and it is worked out by
   comparing the queue with what each saved playlist lists rather than by
   remembering what was loaded. That is what makes it survive the plugin: a
   playlist renamed or edited underneath archamp is still recognised (renamed,
   the heading takes the new name), and a queue added to or trimmed stops
   being a saved playlist on its own, with no bookkeeping to fall out of step.
   A folder or an M3U opened from outside the playlist folder names the queue
   the same way, from where it was opened.
3. ~~**Saved playlists**~~ The M3U files in the playlist folder, watched, so
   `PlaylistCount` and `GetPlaylists` stay current; `ActivatePlaylist` loads
   one. The folder is the plugin's own: archamp reads (never writes)
   `~/.local/state/omedia-controls/preferences.json` and follows
   `playlistFolder`, else `Playlists` inside `musicFolder`, else the desktop's
   music folder — the same resolution the plugin makes. Without that, moving
   the folder in the plugin's settings would quietly unshare the playlists.
4. ~~**Winamp's own playlist buttons**~~ List Opts → Save list writes its M3U
   into that folder (making it if it has to) and the saved list becomes the
   named one straight away; Load list opens on it. Open folder starts at the
   music folder the plugin knows.

Checked by six tests in the conformance suite, which points archamp at a
throwaway state directory and writes plugin preferences into it, so a run
never touches the developer's own music or playlists.

## Phase 5: what the plugin relies on outside MPRIS

1. ~~**The audio stream's identity.**~~ Nothing to do: the packaged app's
   stream already reports `application.name = archamp`, which is what the
   plugin matches against the MPRIS `Identity` (`pw-dump`, 2026-09-18). Worth
   re-checking if the product name ever changes.
2. ~~**Restoring the session.**~~ Done, bar speed (which archamp has no way
   to change yet — Phase 2). The playlist, current track, position, volume,
   shuffle, repeat and where the queue was opened from are saved every two
   seconds while anything changes and restored at launch, paused — really
   paused: webamp readies a track without playing it and calls that stopped,
   and a client shows no position for a stopped player, so archamp says which
   it is until the player leaves that state, so the plugin shows what was playing and one
   press resumes it. Kept in `session.json` beside archamp's other settings
   rather than in localStorage, which is flushed when the browser feels like
   it: a player killed rather than closed came back twenty minutes stale.
   Files named on the command line replace the session rather than adding to
   it.
3. ~~**Quit** saves the session first.~~ Done, and measured: seeked to 97
   seconds and quit at once, the session file had 97 rather than the 2 it had
   been written with two seconds earlier. The renderer saves on `beforeunload`,
   which closing the window runs before the app goes.

## Phase 6: verified on screen

A checklist in the plugin's popup, with archamp as the only player:

- [ ] The AppImage offers desktop integration; Settings → Music Player then lists archamp
- [ ] archamp not running: play a folder from the library, and archamp starts and plays it
- [ ] "Keep archamp's window hidden" hides and shows the window, and survives a restart
- [ ] Clicking the player shows a hidden archamp; closing it from either side quits
- [ ] archamp running: play a track, a selection and a folder; one window only
- [ ] Now playing shows "Album · year"
- [ ] PLAYLIST heading shows the folder or M3U name; "Song x/x · elapsed / total"
- [ ] Playlist column: numbers, lengths, click to play, current highlighted
- [ ] Shuffle; repeat cycles off → playlist → track, with the repeat-one icon
- [ ] Speed: all five buttons enabled; pitch held; seek bar stays in time
- [ ] Volume slider moves archamp's, and archamp's slider moves the plugin's
- [ ] Visualiser follows archamp only, the same at any volume
- [ ] Chips show bitrate, sample rate, channels; lyrics open for a track with a `.lrc`
- [ ] Pause others pauses archamp; the X quits it
- [ ] Restart archamp: the same track comes back, paused, and plays on Play

Then update archamp's README and NOTES.md, and the plugin's README, which can
name archamp as the recommended player.

## Decisions (2026-09-16)

1. Closing archamp, from its own window or the plugin, quits. Hiding the
   window is a separate setting (Phase 1b).
2. Distributed as an AppImage.
3. Saved playlists live in `Playlists` inside the music folder.
4. Where archamp's own window is involved, Winamp's behaviour wins: one
   on/off repeat button.
5. Playback speed is MPRIS only; Winamp had none.

## The plugin's side: building, saving and loading playlists

A gap in OMedia Controls itself, recorded in its ROADMAP as #33. It is
player-neutral: playlists are M3U files in the same `Playlists` folder, so
they work with mpv as well as archamp, and archamp's Playlists interface
(Phase 4) sees the same files.

## Order and size

Phases 0, 1 and 1b first. They make archamp installable and selectable, which is
the plugin's biggest gap, and every later phase is tested through the
launcher they create. Then 2 (speed, repeat-one, metadata: the visible gaps),
5 (session restore), 3 and 4 (spec completeness). The plugin's #33 can
be built alongside Phase 4, since both work on the same folder. Each phase is its own
commit series and is checked against the conformance test before the next
starts.
