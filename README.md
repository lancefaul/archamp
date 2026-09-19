# archamp

A real Winamp, as a native desktop app.

archamp is a small Electron shell around [webamp](https://github.com/captbaritone/webamp) —
the open-source reimplementation of Winamp 2.91 (real Web Audio playback, a real
equalizer, a real playlist, real `.wsz` skin support). archamp isn't a fork of
webamp or a copy of its demo site; it's a normal app that depends on the
`webamp` npm package and adds native desktop integration around it.

Not tied to any one distro or window manager — it just needs Electron.

## archamp and OMedia Controls are one thing in two halves

[OMedia Controls](https://github.com/lancefaul/omarchy-omedia-controls) is a
media plugin for the [Omarchy](https://omarchy.org) bar, and archamp is the
player it was built around. They were designed together, and each is better
for the other: the plugin reaches for archamp first when it needs a player,
and archamp answers questions no other player can.

Use either alone and it works — archamp is a Winamp you can run anywhere, and
the plugin controls any MPRIS player there is. Use them together and you get
things neither can do by itself:

- **The equalizer in the bar.** MPRIS has no equalizer, so no plugin can offer
  one. archamp publishes `org.archamp.Equalizer`, and the plugin draws ten
  bands, a preamp and the presets right in the popup — the same equalizer,
  from either end, in step.
- **A player with no window.** WINDOW → Keep hidden takes archamp's window
  away and leaves the music, and the plugin becomes the whole interface. The
  switch for it is in the plugin's own Settings.
- **One playlist, two ways in.** Both read and write M3U files in the same
  `Playlists` folder, and archamp follows the plugin's setting for where that
  folder is, so a list built in either shows up in the other.
- **Reordering, from the bar.** `org.archamp.TrackList` adds the `MoveTrack`
  that MPRIS left out, so the plugin's playlist column can drag a track to a
  new place.
- **Everything the plugin can already do, done exactly.** Seeking is
  sample-exact, not a fixed skip; the playlist is named; album, year and track
  number are read from the files themselves; speed runs 0.25x to 4x; repeat
  has all three positions.

The plugin's Library → Music player is set to Automatic by default, which
means archamp when it is installed and your desktop's own audio app when it
is not.

## Install

Download the AppImage from
[Releases](https://github.com/lancefaul/archamp/releases), make it executable
and run it:

```bash
chmod +x archamp-*-x86_64.AppImage
./archamp-*-x86_64.AppImage
```

On first run it offers to add itself to your applications, which writes a
desktop entry and icon under `~/.local/share`. That entry is what lets a
launcher start archamp, what lets you pick it as your music player, and what
gives panels its name and icon. Undo it any time with
`archamp --remove-desktop-integration`.

archamp takes files on the command line — `archamp track.mp3`, a folder, or an
M3U — and a second launch hands its files to the copy already running rather
than starting another.

## The player

- The classic Winamp main window, equalizer and playlist, skinnable.
- Crisp scaling in whole-pixel steps: Ctrl+= / Ctrl+- / Ctrl+0, or Ctrl+scroll.
- A browser for the [Winamp Skin Museum](https://skins.webamp.org/): search and
  apply any of its ~93,000 skins (Alt+S, or SKINS → Browse Winamp Skin
  Museum…). Skins are cached, and the one you chose comes back next launch.
- Everything Winamp's own menus offered that webamp leaves unimplemented —
  Add URL, Load and Save list, File Info, Remove missing files — archamp
  answers itself, in menus drawn from the desktop's theme.
- The equalizer's presets, with `.eqf` files to load and save, and whichever
  preset is in effect marked.
- Where it left off: the playlist, the track, the position, volume, shuffle and
  repeat come back at launch, paused.

## On the desktop

archamp publishes itself over MPRIS (`org.mpris.MediaPlayer2.archamp`), so
media keys, KDE's media controls and panel widgets see the track, the art, the
playlist and the equalizer, and control all of it. That includes
[OMedia Controls](https://github.com/lancefaul/omarchy-omedia-controls), which
archamp was built alongside — see above.

Three interfaces of archamp's own fill in what MPRIS has no room for:

| Interface | What it carries |
| --- | --- |
| `org.archamp.TrackList` | `MoveTrack`, for reordering a playlist |
| `org.archamp.Window` | `Hidden`, `KeepHidden` and `Tray` — see below |
| `org.archamp.Equalizer` | Ten bands and a preamp in decibels, on/off, the presets, and apply/reset/load/save |

**Playing with no window.** WINDOW → Keep hidden takes archamp's window away
and leaves everything else running: the audio, the media keys, MPRIS, and any
panel controlling it. There are four ways back — start archamp again from your
launcher, the switch in OMedia Controls' Settings, "Show archamp" from the tray
icon (WINDOW → Show in tray), or any MPRIS client's "open the player", which is
`Raise`. `archamp --show` forces one visible launch; `archamp --hidden` one
hidden.

**Playlists** are M3U files in `Playlists` inside your music folder — the same
folder OMedia Controls uses, so a list made in either shows up in both. archamp
follows the plugin's own setting for where that folder is.

## Updates

ARCHAMP → Check for updates asks GitHub for a newer release. An AppImage is one
file and updating is replacing it, so archamp shows you the exact command it
will run before it runs it: you can read it, copy it into a terminal, or press
Update. It downloads beside the current file and moves over it, so a failed
download can't leave half an archamp where a working one was.

## On Hyprland

archamp wants one window rule it cannot set for itself, since a Wayland client
cannot ask to float:

```lua
o.window("archamp", { float = true })
```

Without it the compositor tiles a transparent skin window into a slot, which
looks broken.

## Development

```bash
npm install
node node_modules/electron/install.js   # npm 12+ skips Electron's download
npm start
npm test    # needs a desktop session, ffmpeg and busctl
npm run dist
```

[NOTES.md](NOTES.md) has the development notes: what's built and why, the
decisions behind it, platform differences, and known limitations.
[OMEDIA-PLAN.md](OMEDIA-PLAN.md) is the plan for working with OMedia Controls,
and what is left of it.

## License

MIT — see [LICENSE](LICENSE). webamp itself is also MIT-licensed; see its
[repository](https://github.com/captbaritone/webamp) for details.
