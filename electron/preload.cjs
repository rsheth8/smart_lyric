const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bar4bar', {
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  // Native menu → renderer. The listener is wrapped so the raw IpcRendererEvent
  // never reaches app code across the context bridge.
  onMenu: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('menu', handler);
    return () => ipcRenderer.off('menu', handler);
  },
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
  transcribeAudio: (payload) => ipcRenderer.invoke('transcribe-audio', payload),
  transcribeAvailable: () => ipcRenderer.invoke('transcribe-available'),
  cleanLyrics: (payload) => ipcRenderer.invoke('clean-lyrics', payload),
  cleanLyricsAvailable: () => ipcRenderer.invoke('clean-lyrics-available'),
  guessLanguage: (payload) => ipcRenderer.invoke('guess-language', payload),
  alignSong: (payload) => ipcRenderer.invoke('align-song', payload),
  alignAvailable: () => ipcRenderer.invoke('align-available'),
  alignModelLoaded: () => ipcRenderer.invoke('align-model-loaded'),
  alignWarm: () => ipcRenderer.invoke('align-warm'),
  separateVocals: (payload) => ipcRenderer.invoke('separate-vocals', payload),
  separateAvailable: () => ipcRenderer.invoke('separate-available'),
  separateWarm: () => ipcRenderer.invoke('separate-warm'),
});
