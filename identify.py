#!/usr/bin/env python3
"""
Step 0 spike: prove that we can recognize a song playing from a record player
through the microphone, using self-hosted Chromaprint fingerprinting + the free
AcoustID public database.

Usage:
    export ACOUSTID_API_KEY=your_key_here     # free from https://acoustid.org/new-application
    python identify.py                        # records ~12s from the default mic and identifies

What it does:
    1. Records a chunk of audio from the default input device.
    2. Writes it to a temp WAV.
    3. Runs Chromaprint (via pyacoustid, which shells out to `fpcalc`) to fingerprint it.
    4. Queries AcoustID, which returns MusicBrainz matches (title / artist / album).

This is a diagnostic, not the app. The goal is a yes/no answer to:
"Can we reliably ID vinyl-through-a-mic?" Run it against a few records and see.
"""

import os
import sys
import tempfile
import wave

import numpy as np
import sounddevice as sd
import acoustid

SAMPLE_RATE = 44100      # AcoustID/Chromaprint expects clean-ish 44.1k
CHANNELS = 1
RECORD_SECONDS = 12      # longer = more robust match; 8-15s is a good range for mic input


def record_to_wav(path: str, seconds: int = RECORD_SECONDS) -> None:
    print(f"🎙️  Listening for {seconds}s — make sure the record is playing…")
    audio = sd.rec(
        int(seconds * SAMPLE_RATE),
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="int16",
    )
    sd.wait()

    # Quick level check so we know the mic actually heard something.
    peak = np.abs(audio).max()
    level_pct = peak / 32767 * 100
    print(f"   Captured. Peak level: {level_pct:.0f}% of full scale.")
    if level_pct < 2:
        print("   ⚠️  Very quiet — is the mic picking up the speakers? Move it closer / raise volume.")

    with wave.open(path, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)  # int16
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio.tobytes())


def identify(path: str, api_key: str) -> None:
    print("🔎 Fingerprinting + querying AcoustID…")
    try:
        results = list(acoustid.match(api_key, path))
    except acoustid.NoBackendError:
        sys.exit("❌ Chromaprint's `fpcalc` not found. Install it: brew install chromaprint")
    except acoustid.FingerprintGenerationError as e:
        sys.exit(f"❌ Could not fingerprint the audio: {e}")
    except acoustid.WebServiceError as e:
        sys.exit(f"❌ AcoustID query failed (bad key or network?): {e}")

    if not results:
        print("\n😕 No match. That's useful data — try: longer recording, mic closer to the")
        print("   speaker, less room noise, or a more mainstream pressing to sanity-check.")
        return

    print("\n✅ Top matches (score / title / artist):\n")
    for score, recording_id, title, artist in results[:5]:
        print(f"   {score*100:5.1f}%  {title or '(unknown)'} — {artist or '(unknown)'}")
        print(f"          MusicBrainz recording id: {recording_id}")


def main() -> None:
    api_key = os.environ.get("ACOUSTID_API_KEY")
    if not api_key:
        sys.exit(
            "❌ Set ACOUSTID_API_KEY first.\n"
            "   Get a free key at https://acoustid.org/new-application\n"
            "   then: export ACOUSTID_API_KEY=your_key_here"
        )

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name
    try:
        record_to_wav(wav_path)
        identify(wav_path, api_key)
    finally:
        os.unlink(wav_path)


if __name__ == "__main__":
    main()
