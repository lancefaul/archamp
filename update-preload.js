// The update window's only way to reach the main process (see updater.js).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updater", {
  // The release this window was opened for: { installed, release, command }.
  release: () => ipcRenderer.invoke("update:release"),
  run: () => ipcRenderer.invoke("update:run"),
  restart: () => ipcRenderer.send("update:restart"),
  copy: (text) => ipcRenderer.send("update:copy", text),
  close: () => ipcRenderer.send("update:close"),
  // The desktop's theme, and any change to it (see theme.js).
  theme: () => ipcRenderer.invoke("theme"),
  onTheme: (callback) => ipcRenderer.on("theme", (_event, palette) => callback(palette)),
});
