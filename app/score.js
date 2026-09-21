// Scoring: did you sing the words, and were you on the note?
//
// Two honest signals, both from the singer's own mic:
//   coverage — how much of the time the lyrics expected a voice, one arrived;
//   pitch    — how close that voice sat to the melody, octaves folded away so a
//              bass singing along to a soprano still counts as in tune.
//
// The melody reference is whatever pitch we can hear in the track itself, which
// is the honest ceiling here: on a dense mix the loudest pitched thing is not
// always the lead vocal, and when we don't own the audio at all (Spotify, a
// record) there's no reference and the score falls back to coverage alone.
// ponytail: no melody extraction — revisit if "it scored me wrong" ever lands.
//
// Pure: no DOM, no audio nodes, so the whole model unit-tests.

/** Perfectly in tune out to here. A semitone is 100 cents. */
export const TOLERANCE_CENTS = 50;
/** Beyond here it's a different note and scores nothing. */
export const CUTOFF_CENTS = 200;
/** Mic RMS above which we call it singing rather than room tone. */
export const SING_LEVEL = 0.02;
/** Fewer expected frames than this and nobody really sang — no score card. */
export const MIN_FRAMES = 40;
/** Pitch's share of the score when we have a reference to compare against. */
export const PITCH_WEIGHT = 0.4;

const GRADES = [
  [90, 'Superstar'],
  [80, 'Headliner'],
  [70, 'Encore'],
  [55, 'Warmed up'],
  [0, 'Keep going'],
];

/** Every grade the card can print. The analytics allowlist mirrors this list. */
export const GRADE_NAMES = GRADES.map(([, name]) => name);

export function gradeFor(score) {
  for (const [min, name] of GRADES) if (score >= min) return name;
  return GRADES.at(-1)[1];
}

/** 1 when dead on, tapering to 0 a whole tone away. */
export function pitchAccuracy(cents, tolerance = TOLERANCE_CENTS, cutoff = CUTOFF_CENTS) {
  if (cents == null || !Number.isFinite(cents)) return null;
  const a = Math.abs(cents);
  if (a <= tolerance) return 1;
  if (a >= cutoff) return 0;
  return 1 - (a - tolerance) / (cutoff - tolerance);
}

/** Blend the two signals. `pitch` is null when there was no reference to hear. */
export function combine(coverage, pitch) {
  const c = Math.max(0, Math.min(1, coverage));
  if (pitch == null) return Math.round(c * 100);
  const p = Math.max(0, Math.min(1, pitch));
  return Math.round((c * (1 - PITCH_WEIGHT) + p * PITCH_WEIGHT) * 100);
}

export class ScoreKeeper {
  constructor({ singLevel = SING_LEVEL, minFrames = MIN_FRAMES } = {}) {
    this.singLevel = singLevel;
    this.minFrames = minFrames;
    this.reset();
  }

  reset() {
    this.expectedFrames = 0;
    this.sungFrames = 0;
    this.pitchFrames = 0;
    this.pitchSum = 0;
    this.streak = 0;
    this.bestStreak = 0;
    return this;
  }

  /**
   * One frame of evidence. `expected` = the timeline says a word is being sung
   * right now; `level` = mic RMS; `cents` = distance to the reference note, or
   * null when either side of that comparison is missing.
   */
  sample({ expected, level = 0, cents = null } = {}) {
    if (!expected) {
      // Instrumental breaks aren't scored — silence there is correct.
      this.streak = 0;
      return this;
    }
    this.expectedFrames++;
    if (level >= this.singLevel) {
      this.sungFrames++;
      this.streak++;
      if (this.streak > this.bestStreak) this.bestStreak = this.streak;
      const acc = pitchAccuracy(cents);
      if (acc != null) {
        this.pitchFrames++;
        this.pitchSum += acc;
      }
    } else {
      this.streak = 0;
    }
    return this;
  }

  /** Null until there's enough evidence to be worth showing. */
  result() {
    if (this.expectedFrames < this.minFrames) return null;
    const coverage = this.sungFrames / this.expectedFrames;
    const pitch = this.pitchFrames > 0 ? this.pitchSum / this.pitchFrames : null;
    const score = combine(coverage, pitch);
    return {
      score,
      grade: gradeFor(score),
      coverage,
      pitch,
      bestStreak: this.bestStreak,
      frames: this.expectedFrames,
      scored: this.pitchFrames > 0,
    };
  }
}
