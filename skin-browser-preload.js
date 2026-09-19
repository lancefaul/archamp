// The skin browser's only way to reach the main process (see museum.js).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("museum", {
  findSkins: (text, offset) => ipcRenderer.invoke("museum:find", text, offset),
  currentSkin: () => ipcRenderer.invoke("museum:current-skin"),
  applySkin: (md5, name) => ipcRenderer.send("museum:apply", md5, name),
  // Keep the skin that is on, or put back the one that was.
  apply: () => ipcRenderer.send("museum:close"),
  cancel: () => ipcRenderer.send("museum:cancel"),
  onSkinChanged: (callback) => ipcRenderer.on("museum:skin-changed", (_event, skin) => callback(skin)),
  onSkinFailed: (callback) => ipcRenderer.on("museum:skin-failed", (_event, md5) => callback(md5)),
  // The desktop's theme, and any change to it (see theme.js).
  theme: () => ipcRenderer.invoke("theme"),
  onTheme: (callback) => ipcRenderer.on("theme", (_event, palette) => callback(palette)),
});
