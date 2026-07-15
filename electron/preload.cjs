// Minimal, safe bridge from the sandboxed renderer to the Electron main process.
// Grows as we add native capabilities (mic capture, fingerprint bridge, etc.).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smartLyric', {
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  // Returns match metadata, null (no match), or { error } on failure.
  identify: (wavArrayBuffer) => ipcRenderer.invoke('identify', wavArrayBuffer),
});
