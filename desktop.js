// Desktop integration, written by archamp itself. An AppImage installs
// nothing — it is one file the user downloaded — but a player has to be an
// installed app to be any use: the plugin's Music Player list is built from
// desktop entries (`gio mime audio/mpeg`), launching archamp to play a track
// is `gtk-launch archamp track.mp3`, and a client knows which app a player is
// by the DesktopEntry it names over MPRIS. So archamp writes its own entry
// and icon under ~/.local/share, after asking once, and keeps the entry
// pointing at wherever its AppImage has been moved to.
const { app, dialog } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs/promises");
const path = require("path");

const ENTRY_NAME = "archamp.desktop";
const ICON_NAME = "archamp";

// The audio types archamp can open, plus the aliases desktops register for
// the same things — a file manager may know an .m4a as audio/x-m4a only.
const MIME_TYPES = [
  "audio/mpeg",
  "audio/flac",
  "audio/x-flac",
  "audio/ogg",
  "audio/x-vorbis+ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/aiff",
  "audio/x-aiff",
  "audio/x-mpegurl",
  "audio/mpegurl",
];

const applicationsDir = () => path.join(app.getPath("home"), ".local", "share", "applications");
const entryPath = () => path.join(applicationsDir(), ENTRY_NAME);
const iconPath = (size) =>
  path.join(
    app.getPath("home"),
    ".local",
    "share",
    "icons",
    "hicolor",
    size,
    "apps",
    `${ICON_NAME}.${size === "scalable" ? "svg" : "png"}`,
  );
// Remembers that the question has been asked, so it is asked once and not
// once per launch.
const askedPath = () => path.join(app.getPath("userData"), "desktop-integration-asked");

// Only an AppImage integrates itself. A checkout is a checkout.
function appImage() {
  return process.env.APPIMAGE ?? null;
}

function entryText(command) {
  return `[Desktop Entry]
Type=Application
Name=archamp
GenericName=Music Player
Comment=A real Winamp, as a native desktop app
Exec=${command} %F
Icon=${ICON_NAME}
Terminal=false
Categories=AudioVideo;Audio;Player;
MimeType=${MIME_TYPES.join(";")};
StartupWMClass=archamp
StartupNotify=true
`;
}

async function readEntry() {
  try {
    return await fs.readFile(entryPath(), "utf8");
  } catch {
    return null;
  }
}

// AppImageLauncher and Gear Lever integrate AppImages themselves. If one of
// them has already written an entry for this file, archamp leaves the desktop
// alone rather than putting a second copy of itself in the menu.
async function integratedElsewhere(command) {
  let names;
  try {
    names = await fs.readdir(applicationsDir());
  } catch {
    return false;
  }
  for (const name of names) {
    if (name === ENTRY_NAME || !name.endsWith(".desktop")) continue;
    try {
      const text = await fs.readFile(path.join(applicationsDir(), name), "utf8");
      if (text.includes(command)) return true;
    } catch {}
  }
  return false;
}

function refreshDatabase() {
  return new Promise((resolve) => {
    execFile("update-desktop-database", [applicationsDir()], () => resolve());
  });
}

async function write(command) {
  await fs.mkdir(applicationsDir(), { recursive: true });
  await fs.writeFile(entryPath(), entryText(command));
  for (const [size, source] of [
    ["256x256", "icon.png"],
    ["scalable", "icon.svg"],
  ]) {
    try {
      await fs.mkdir(path.dirname(iconPath(size)), { recursive: true });
      await fs.copyFile(path.join(__dirname, "build", source), iconPath(size));
      // Copied out of the asar, where the mode is the packer's business.
      await fs.chmod(iconPath(size), 0o644);
    } catch {}
  }
  await refreshDatabase();
}

async function remove() {
  for (const file of [entryPath(), iconPath("256x256"), iconPath("scalable")]) {
    await fs.rm(file, { force: true });
  }
  await refreshDatabase();
}

// Asked once, the first time an AppImage runs. The Hyprland rule goes in the
// same breath, since archamp cannot apply it itself (see OMEDIA-PLAN.md).
async function ask(command) {
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "archamp",
    message: "Add archamp to your applications?",
    detail:
      "Writes a desktop entry and icon under ~/.local/share, so archamp shows up in your launcher, can be chosen as your music player, and can be started to play a file.\n\n" +
      "On Hyprland, archamp also wants this window rule, which it cannot set itself:\n\n" +
      '    o.window("archamp", { float = true })\n\n' +
      "Undo the rest any time with: archamp --remove-desktop-integration",
    buttons: ["Add", "Not now"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  await fs.writeFile(askedPath(), command).catch(() => {});
  if (response === 0) await write(command);
}

async function asked() {
  try {
    await fs.access(askedPath());
    return true;
  } catch {
    return false;
  }
}

// Called at every launch. Keeps an entry that exists pointing at the AppImage
// it was written for, and asks about writing one if there is none.
async function integrate() {
  const command = appImage();
  if (command == null) return;
  const existing = await readEntry();
  if (existing != null) {
    // The AppImage has been moved or replaced: an entry pointing at a file
    // that is gone is worse than no entry at all.
    if (!existing.includes(`Exec=${command} `)) await write(command);
    return;
  }
  if (await asked()) return;
  if (await integratedElsewhere(command)) return;
  await ask(command);
}

// From archamp's own menu, so the answer to "not now" isn't final.
async function addFromMenu() {
  const command = appImage();
  if (command == null) {
    await dialog.showMessageBox({
      type: "info",
      title: "archamp",
      message: "archamp is running from a checkout.",
      detail: "Desktop integration is for the AppImage, which is the copy a launcher would start.",
      buttons: ["OK"],
      noLink: true,
    });
    return;
  }
  await write(command);
  await dialog.showMessageBox({
    type: "info",
    title: "archamp",
    message: "archamp is in your applications.",
    detail: `Its entry is at ${entryPath()}.`,
    buttons: ["OK"],
    noLink: true,
  });
}

// What the player's menu needs to know: whether there is anything to offer.
async function status() {
  return { appImage: appImage() != null, integrated: (await readEntry()) != null };
}

module.exports = { integrate, addFromMenu, remove, status };
