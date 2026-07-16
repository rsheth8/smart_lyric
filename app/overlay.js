import { Display } from './display.js';
import { PassiveClock } from './clock.js';
import { createSyncSubscriber } from './sync-bridge.js';

const stage = document.getElementById('stage');
const display = new Display({ stage, lyricsEl: document.getElementById('lyrics'), bgCanvas: document.getElementById('bg') });
const passive = new PassiveClock();
display.setClock(passive);
display.start();

let lastTimelineKey = '';

createSyncSubscriber((state) => {
  if (state.meta?.track) {
    document.title = `${state.meta.track} — Bar4Bar overlay`;
  }
  if (state.palette?.length) display.setPalette(state.palette);

  const key = JSON.stringify(state.timeline);
  if (key !== lastTimelineKey && state.timeline?.length) {
    lastTimelineKey = key;
    display.setLyrics({ lines: state.timeline, duration: state.timeline.at(-1)?.end ?? 0 });
  }

  passive.push(state.position, state.isPlaying);
});
