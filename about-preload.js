// The about box's only way to reach the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("about", {
  info: () => ipcRenderer.invoke("about:info"),
  close: () => ipcRenderer.send("about:close"),
  openWebamp: () => ipcRenderer.send("about:webamp"),
  // The desktop's theme, and any change to it (see theme.js).
  theme: () => ipcRenderer.invoke("theme"),
  onTheme: (callback) => ipcRenderer.on("theme", (_event, palette) => callback(palette)),
});
