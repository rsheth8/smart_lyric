import Foundation
import Bar4BarCore

// Run the production TV retrieval/parsing/selection path without playing audio.
// Output contains counts and recording metadata, never lyrics or credentials.
struct Track: Codable, Sendable {
  var position: Int
  var spotifyId: String
  var artist: String
  var track: String
  var duration: Double
  var album: String?
  var explicit: Bool?
  var isrc: String?
}
struct Row: Codable, Sendable {
  var position: Int
  var spotifyId: String
  var artist: String
  var track: String
  var result: String
  var source: String?
  var returnedRecording: LyricsMeta?
  var durationDifference: Double?
  var lineCount: Int
  var wordCount: Int
  var fetchMilliseconds: Int
  var issues: [String]
  var accuracyStatus = "not_measured"
}
struct Report: Codable {
  var checkedAt: Date
  var sampleSize: Int
  var checkedCount: Int
  var complete: Bool
  var counts: [String: Int]
  var warning: String
  var rows: [Row]
}

func audit(_ track: Track, base: URL) async -> Row {
  let started = Date()
  let result = await LyricsClient(apiBaseURL: base).fetch(.init(
    artist: track.artist, track: track.track, duration: track.duration, album: track.album,
    recording: RecordingIdentity(spotifyID: track.spotifyId, isrc: track.isrc, explicit: track.explicit)))
  let timeline = result?.timeline
  let words = timeline?.lines.flatMap(\.words) ?? []
  var issues: [String] = []
  if let timeline {
    var previousLine = -Double.infinity
    for line in timeline.lines {
      if !line.start.isFinite || !line.end.isFinite || line.start < 0
        || line.end < line.start || line.start < previousLine || line.words.isEmpty {
        issues.append("invalid_line_bounds")
      }
      previousLine = line.start
      var previousWord = line.start
      for word in line.words {
        // Weighted estimates can differ from line.start by floating-point epsilon.
        if !word.start.isFinite || !word.end.isFinite || word.start < previousWord - 0.001
          || word.end < word.start - 0.001 || word.end > line.end + 0.001 || word.text.isEmpty {
          issues.append("invalid_word_bounds")
        }
        previousWord = word.start
      }
    }
    if words.contains(where: { $0.end > track.duration + 3 }) {
      issues.append("words_beyond_recording")
    }
  }
  let state = timeline == nil ? "unavailable"
    : timeline!.hasWordTiming ? "word_timestamps"
    : timeline!.source == "aligned" ? "audio_refined_mixed" : "estimated_words_only"
  return Row(position: track.position, spotifyId: track.spotifyId,
    artist: track.artist, track: track.track, result: state, source: timeline?.source,
    returnedRecording: result?.meta,
    durationDifference: result?.meta.duration.map { $0 - track.duration },
    lineCount: timeline?.lines.count ?? 0, wordCount: words.count,
    fetchMilliseconds: Int(Date().timeIntervalSince(started) * 1000),
    issues: Array(Set(issues)).sorted())
}

let args = CommandLine.arguments
guard args.count == 3 else {
  fatalError("Usage: swift run --package-path scripts/tv-coverage --scratch-path /tmp/bar4bar-coverage-build TVCoverage tracks.json report.json")
}
let tracks = try JSONDecoder().decode([Track].self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
guard !tracks.isEmpty, Set(tracks.map(\.spotifyId)).count == tracks.count,
      tracks.allSatisfy({ !$0.artist.isEmpty && !$0.track.isEmpty && $0.duration > 0 }) else {
  fatalError("Inventory must contain unique Spotify recordings with known durations")
}
guard let base = URL(string: ProcessInfo.processInfo.environment["LYRICS_API_BASE"] ?? "https://smartlyric.vercel.app"),
      ["https", "http"].contains(base.scheme ?? "") else { fatalError("Invalid API base") }
let encoder = JSONEncoder()
encoder.dateEncodingStrategy = .iso8601
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
var rows: [Row] = []
func save() throws {
  let counts = Dictionary(grouping: rows, by: \.result).mapValues(\.count)
  let report = Report(checkedAt: Date(), sampleSize: tracks.count, checkedCount: rows.count,
    complete: tracks.count == rows.count, counts: counts,
    warning: "Native TV client availability only; word timing accuracy and exact lyric-recording identity are not verified. Input durations may be rounded display seconds. Unavailable includes transport failures; consult provider diagnostics.",
    rows: rows.sorted { $0.position < $1.position })
  try encoder.encode(report).write(to: URL(fileURLWithPath: args[2]), options: .atomic)
}
// Bound requests to four songs, each using the TV client's parallel providers.
await withTaskGroup(of: Row.self) { group in
  var next = 0
  for _ in 0..<min(4, tracks.count) {
    let track = tracks[next]; next += 1
    group.addTask { await audit(track, base: base) }
  }
  for await row in group {
    rows.append(row)
    FileHandle.standardOutput.write(Data("\(rows.count)/\(tracks.count) \(row.artist) — \(row.track): \(row.result)\n".utf8))
    do { try save() } catch { fatalError("Cannot save coverage report: \(error)") }
    if next < tracks.count {
      let track = tracks[next]; next += 1
      group.addTask { await audit(track, base: base) }
    }
  }
}
try save()
