#!/usr/bin/env bash
# Capture Nirvana via BlackHole loopback, then run align-check --both.
# Prereqs: brew install --cask blackhole-2ch  (reboot after install)
#
# Usage (from repo root, in Terminal.app — needs mic permission):
#   ./scripts/capture-nirvana-loopback.sh
#
# Default captures ~130s from song start so we cover the dense first chorus
# (where studio raw-mix fallback was 14%). Override: CAPTURE_SECS=90 ./scripts/...

set -euo pipefail
cd "$(dirname "$0")/.."

MP3="Nirvana - Smells Like Teen Spirit.mp3"
FULL_LRC="Nirvana_Smells_Like_Teen_Spirit.lrc"
OUT="nirvana-loopback.wav"
CLIP_LRC="nirvana-loopback.lrc"
SECS="${CAPTURE_SECS:-130}"

if [[ ! -f "$MP3" || ! -f "$FULL_LRC" ]]; then
  echo "Missing $MP3 or $FULL_LRC in $(pwd)" >&2
  exit 1
fi

# Optional helper for switching output device
HAS_SAS=0
if command -v SwitchAudioSource >/dev/null 2>&1; then
  HAS_SAS=1
elif brew list switchaudio-osx >/dev/null 2>&1; then
  HAS_SAS=1
  PATH="$(brew --prefix)/bin:$PATH"
fi

echo "==> Audio input devices (ffmpeg avfoundation):"
ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | sed -n '/AVFoundation audio devices/,/Error opening/p' || true

# Find BlackHole audio device index: lines look like  [AVFoundation indev @ ...] [0] BlackHole 2ch
BH_IDX=$(ffmpeg -f avfoundation -list_devices true -i "" 2>&1 \
  | grep -i 'BlackHole' \
  | head -1 \
  | sed -E 's/.*\[([0-9]+)\].*/\1/' || true)

if [[ -z "${BH_IDX}" ]]; then
  echo ""
  echo "✗ No BlackHole input found. Install + reboot:"
  echo "    brew install --cask blackhole-2ch"
  echo "    # then reboot"
  echo "Then re-run this script. If ffmpeg still cannot see devices, grant"
  echo "Microphone access to Terminal in System Settings → Privacy & Security."
  exit 1
fi
echo "==> Using BlackHole as audio input index: $BH_IDX"

PREV_OUT=""
if [[ "$HAS_SAS" -eq 1 ]]; then
  PREV_OUT=$(SwitchAudioSource -c || true)
  echo "==> Current output: ${PREV_OUT:-unknown}"
  if SwitchAudioSource -a -t output | grep -qi 'BlackHole'; then
    SwitchAudioSource -t output -s "BlackHole 2ch" 2>/dev/null \
      || SwitchAudioSource -t output -s "$(SwitchAudioSource -a -t output | grep -i BlackHole | head -1)"
    echo "==> Output switched to BlackHole (you won't hear playback — that's OK)"
  else
    echo "⚠ BlackHole not listed as output yet — set System Settings → Sound → Output → BlackHole 2ch manually,"
    echo "  then press Enter to continue."
    read -r _
  fi
else
  echo "⚠ switchaudio-osx not installed. Manually set:"
  echo "    System Settings → Sound → Output → BlackHole 2ch"
  echo "  (install helper anytime: brew install switchaudio-osx)"
  echo "Press Enter once output is BlackHole…"
  read -r _
fi

cleanup() {
  if [[ "$HAS_SAS" -eq 1 && -n "$PREV_OUT" ]]; then
    SwitchAudioSource -t output -s "$PREV_OUT" 2>/dev/null || true
    echo "==> Restored output to: $PREV_OUT"
  fi
}
trap cleanup EXIT

rm -f "$OUT"
echo "==> Recording ${SECS}s → $OUT  (playing $MP3 from the start)"
# Start capture first, then play (small head for ffmpeg open latency)
ffmpeg -y -f avfoundation -i ":${BH_IDX}" -t "$SECS" -ac 2 -ar 44100 "$OUT" >/tmp/nirvana-capture-ffmpeg.log 2>&1 &
FFPID=$!
sleep 1.2
afplay -t "$SECS" "$MP3" &
AFPID=$!
wait "$FFPID" || true
kill "$AFPID" 2>/dev/null || true
wait "$AFPID" 2>/dev/null || true

if [[ ! -s "$OUT" ]]; then
  echo "✗ Capture failed. ffmpeg log:" >&2
  cat /tmp/nirvana-capture-ffmpeg.log >&2
  exit 1
fi

echo "==> Captured:"
ffprobe -hide_banner "$OUT" 2>&1 | head -12

# Sanity: not silence (don't abort the run if this probe fails)
RMS=$(node --input-type=module -e "
import { readFileSync } from 'fs';
import { decodeWAV, rms } from './app/wav.js';
const buf = readFileSync('$OUT');
const { channels } = decodeWAV(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const n = channels[0].length;
const mix = new Float32Array(n);
for (let i=0;i<n;i++){ let s=0; for (const c of channels) s+=c[i]; mix[i]=s/channels.length; }
console.log(rms(mix).toFixed(4));
" 2>/dev/null || echo "err")
echo "    mix RMS=$RMS  (expect ~0.05–0.4; near 0.0 means silent / wrong device)"

# Trim LRC to lines whose timestamps fall inside the captured audio
# (scoring the full song LRC against a short clip invents a fake ~90%+ fallback).
python3 - "$OUT" "$FULL_LRC" "$CLIP_LRC" <<'PY'
import re, struct, sys, wave
wav_path, full_lrc, clip_lrc = sys.argv[1:]
with wave.open(wav_path, 'rb') as w:
    dur = w.getnframes() / float(w.getframerate())
pad = 0.5
n = 0
with open(full_lrc) as f, open(clip_lrc, 'w') as out:
    for raw in f:
        m = re.match(r'\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)', raw.strip())
        if not m:
            continue
        t = int(m.group(1)) * 60 + float(m.group(2))
        if t < dur - pad and m.group(3).strip():
            out.write(raw if raw.endswith('\n') else raw + '\n')
            n += 1
print(f"==> Trimmed LRC → {clip_lrc}  ({n} lines inside {dur:.1f}s capture)")
if n < 8:
    print(f"⚠ Only {n} lyric lines in the clip — re-run with CAPTURE_SECS>=130 for a decisive chorus.", file=sys.stderr)
PY

echo ""
echo "==> align-check --both on captured audio + trimmed LRC"
node --env-file=.env scripts/align-check.mjs "$OUT" "$CLIP_LRC" --both
