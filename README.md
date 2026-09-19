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
chmod +x archamp-x86_64.AppImage
./archamp-x86_64.AppImage
```

The file has no version in its name on purpose: updating is replacing that one
file in place, and a name that says 1.0.0 on an archamp that is no longer
1.0.0 is worse than a name that never claimed to know. ARCHAMP → About is what
knows which version you have.

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

**Closing to the tray.** With WINDOW → Show in tray on, the player's close
button puts archamp away rather than ending it, the way it does in anything
else that lives in a tray — the music carries on. **Close archamp** is the way
out, in the player's own menu and in the tray's, and the tray has it because
someone who closed to the tray has no window left to quit from. Without a tray
icon there is nothing to come back from, so closing still quits.

**Playlists** are M3U files in `Playlists` inside your music folder — the same
folder OMedia Controls uses, so a list made in either shows up in both. archamp
follows the plugin's own setting for where that folder is.

## Updates

ARCHAMP → Check for updates asks GitHub for a newer release. An AppImage is one
file and updating is replacing it, so archamp shows you the exact command it
will run before it runs it: you can read it, copy it into a terminal, or press
Update. It downloads beside the current file and moves over it, so a failed
download can't leave half an archamp where a working one was.

When it lands, Update becomes Restart and Cancel becomes Restart Later.
archamp goes down and comes back up on the new version, with the playlist, the
track and where it had got to all as you left them — or leave it, and it will
be the new one next time you start archamp yourself.

The buttons belong to the version that is running, so they are the ones the
*old* archamp shipped: an update is what puts the new window in place, and it
is the update after that which uses it.

## Themes

archamp's own chrome — its menus, the skin browser, About and the update
window — follows the desktop's colours where it can find them. It reads
Omarchy's theme first and otherwise draws its own dark palette. The player
window itself is the skin's, and is not themed by anything but the skin.

## Window rules

The player window is the shape and size of the skin it is drawing, and it
changes size whenever the skin or the scale does. Tiled, a compositor
stretches a transparent, irregularly-shaped window across a slot and the
player reads as broken rather than as small — so it wants to float.

A Wayland client cannot ask for that; the rule has to come from the
compositor. On **Hyprland**, archamp asks for it itself at startup, which is
session-only, writes nothing to your config, and needs nothing from you. On
any other compositor, set the equivalent rule for the window class `archamp`:

```lua
o.window("archamp", { float = true })   -- what archamp asks Hyprland for
```

## Other desktops — alpha

archamp is developed and used on [Omarchy](https://omarchy.org) under
Hyprland. Two pieces of it are written for desktops it has not been run on,
and they ship as alpha: they are verified by mechanism, not on the desktop
they are for.

**The tray is only offered where the desktop has one.** A tray icon is a
StatusNotifierItem, and on a stock GNOME there is nothing listening for one —
Shell has had no support since 3.26, and none without the AppIndicator
extension — so archamp says so rather than hiding its window behind an icon
that would never appear. Bringing a hidden window back does not depend on the
tray: start archamp again from your launcher, or use any MPRIS client's "open
the player".

**KDE's colour scheme is read where Omarchy's theme files are absent** —
`~/.config/kdeglobals` for the window colours, the accent and the font size.

If you run archamp on Plasma, GNOME or anything else, reports are welcome;
treat neither of these as supported yet.

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
