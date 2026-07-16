const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smartLyric', {
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  identify: (wavArrayBuffer) => ipcRenderer.invoke('identify', wavArrayBuffer),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  openProjector: (displayId) => ipcRenderer.invoke('open-projector', displayId),
  closeProjector: () => ipcRenderer.invoke('close-projector'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  spotifyLogin: () => ipcRenderer.invoke('spotify-login'),
  wordLyrics: (query) => ipcRenderer.invoke('word-lyrics', query),
});
