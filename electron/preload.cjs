const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bar4bar', {
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  identify: (wavArrayBuffer) => ipcRenderer.invoke('identify', wavArrayBuffer),
  identifyAmbient: (wavArrayBuffer) => ipcRenderer.invoke('identify-ambient', wavArrayBuffer),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  openProjector: (displayId) => ipcRenderer.invoke('open-projector', displayId),
  closeProjector: () => ipcRenderer.invoke('close-projector'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  spotifyLogin: () => ipcRenderer.invoke('spotify-login'),
  wordLyrics: (query) => ipcRenderer.invoke('word-lyrics', query),
  geniusLyrics: (query) => ipcRenderer.invoke('genius-lyrics', query),
  richsync: (query) => ipcRenderer.invoke('richsync', query),
  alignSong: (payload) => ipcRenderer.invoke('align-song', payload),
  alignAvailable: () => ipcRenderer.invoke('align-available'),
  alignModelLoaded: () => ipcRenderer.invoke('align-model-loaded'),
});
