// Apple Music MusicKit JS integration.

import { StreamingClock } from '../clock.js';
import { saveToken, loadToken, clearToken } from './auth.js';

let music = null;
let streamingClock = null;
let onTrackChange = null;
let currentTrack = null;

export function getAppleMusicConfig() {
  return {
    developerToken: window.__SL_CONFIG__?.appleMusicDeveloperToken || '',
    appName: 'smart_lyric',
    appBuild: '0.1.0',
  };
}

export function getStreamingClock() {
  return streamingClock;
}

export function getCurrentTrack() {
  return currentTrack;
}

export async function connectAppleMusic({ onTrack, onError, onStatus }) {
  onTrackChange = onTrack;
  const { developerToken, appName, appBuild } = getAppleMusicConfig();
  if (!developerToken) {
    onError?.('Apple Music developer token not configured. Set APPLE_MUSIC_DEVELOPER_TOKEN in .env.');
    return false;
  }
  if (!window.MusicKit) {
    onError?.('MusicKit JS not loaded.');
    return false;
  }

  try {
    if (!music) {
      await window.MusicKit.configure({
        developerToken,
        app: { name: appName, build: appBuild },
      });
      music = window.MusicKit.getInstance();
    }

    if (!music.isAuthorized) {
      await music.authorize();
      saveToken('appleMusic', { authorized: true });
    }

    music.addEventListener('mediaItemStateDidChange', () => {
      const item = music.nowPlayingItem;
      if (!item) return;
      const meta = {
        artist: item.artistName || '',
        title: item.title || '',
        album: item.albumName || '',
        duration: item.playbackDuration ? Math.round(item.playbackDuration) : undefined,
      };
      if (!currentTrack || currentTrack.title !== meta.title) {
        currentTrack = meta;
        onTrackChange?.(meta);
      }
    });

    if (!streamingClock) {
      streamingClock = new StreamingClock({
        getPosition: () => music.currentPlaybackTime || 0,
        isPlaying: () => music.isPlaying,
      });
    }

    onStatus?.('Apple Music connected.');
    return true;
  } catch (e) {
    clearToken('appleMusic');
    onError?.(e.message || 'Apple Music authorization failed.');
    return false;
  }
}

export function disconnectAppleMusic() {
  music = null;
  streamingClock = null;
  currentTrack = null;
  clearToken('appleMusic');
}
