import Foundation
import Bar4BarCore

/// Availability describes saved evidence, not a promise about the recording.
enum SongGuidance: Equatable, Sendable {
  case unchecked, estimated, words, mixed
  init(timeline: Timeline?) {
    guard let timeline, !timeline.isEmpty else { self = .unchecked; return }
    var estimated = 0
    var reliable = 0
    for (index, line) in timeline.lines.enumerated() {
      for word in line.words.indices {
        if timeline.quality(line: index, word: word) == .estimated { estimated += 1 }
        else { reliable += 1 }
      }
    }
    self = reliable == 0 ? .estimated : estimated == 0 ? .words : .mixed
  }
  var label: String {
    switch self {
    case .unchecked: return "Timing checked on selection"
    case .estimated: return "Approximate word guidance saved"
    case .words: return "Word timing saved"
    case .mixed: return "Word timing + estimates saved"
    }
  }
}

/// An incoming turn has its own advance caption, without moving active lyrics.
struct SingerTurnPreview: Equatable {
  let role: String
  let seconds: Int
  init?(timeline: Timeline, state: StagePresentation, cueTime: Double, preview: Double, mode: String) {
    guard mode == "Take turns", cueTime.isFinite, !state.ending,
      let target = state.countdown != nil ? Optional(state.line) : state.next,
      timeline.lines.indices.contains(target) else { return nil }
    let eta = timeline.lines[target].start - cueTime
    guard eta > 0, eta <= max(3, preview + (state.dense ? 1 : 0)) else { return nil }
    role = target.isMultiple(of: 2) ? "SIDE A" : "SIDE B"
    seconds = Int(ceil(eta))
  }
}
