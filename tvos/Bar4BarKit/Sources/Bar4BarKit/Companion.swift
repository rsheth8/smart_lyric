// Phone ⇄ TV remote, the TV end. Same protocol and hosted relay as the web app
// (app/companion.js, api/companion.js): SSE to listen, text/plain POST to send,
// addressed by an 8-character room code. The phone page is the existing
// companion.html, so a phone can't tell a native TV from the web one.
//
// Phone messages are untrusted: parseCommand is the only way one reaches the app.

import Foundation

public enum PhoneCommand: Equatable, Sendable {
  case hello(by: String?)
  case toggle, change, next
  /// The song carries the guest's name in `by`.
  case play(Song), queue(Song)
  case unqueue(Int)
  case nudge(ms: Int)
  case feel(early: Bool)
}

/// TV → phone snapshot of what's on screen.
public struct TVState: Encodable, Equatable, Sendable {
  public struct Queued: Encodable, Equatable, Sendable {
    public var track: String
    public var artist: String
    public var artwork: String?
    public var by: String?
  }

  public var type = "state"
  public var mode: String // "playing" | "setup"
  public var track: String
  public var artist: String
  public var art: String
  public var playing: Bool
  public var offsetMs: Int
  public var queue: [Queued]

  public init(mode: String, track: String, artist: String, art: String, playing: Bool, offsetMs: Int, queue: [Song]) {
    self.mode = mode
    self.track = track
    self.artist = artist
    self.art = art
    self.playing = playing
    self.offsetMs = offsetMs
    self.queue = queue.map { Queued(track: $0.track, artist: $0.artist, artwork: $0.artwork, by: $0.by) }
  }
}

public enum Companion {
  public static let base = URL(string: "https://smartlyric.vercel.app")!
  public static let queueMax = 30
  public static let nameMax = 24
  static let nudgesMs: Set<Double> = [-100, -25, 25, 100]
  // No I/O/0/1 — a code read off a TV shouldn't be ambiguous.
  static let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")

  public static func newRoomCode() -> String {
    String((0..<8).map { _ in alphabet.randomElement()! }) // SystemRandomNumberGenerator: CSPRNG
  }

  public static func phoneURL(room: String, base: URL = base) -> URL {
    URL(string: "\(base.absoluteString)/companion.html?room=\(room)")!
  }

  /// The rotation: round-robin the queue by whoever added each song, the way a
  /// karaoke host runs a room — three songs from one guest don't lock everyone
  /// else out. Stable inside each singer's own list, and a no-op when every entry
  /// came from the same phone (or from the TV, where `by` is nil).
  /// Port of `fairOrder` in app/companion.js.
  public static func fairOrder(_ queue: [Song]) -> [Song] {
    var lanes: [String: [Song]] = [:]
    var order: [String] = [] // first-seen order, so the rotation is deterministic
    for song in queue {
      let who = song.by ?? ""
      if lanes[who] == nil {
        lanes[who] = []
        order.append(who)
      }
      lanes[who]?.append(song)
    }
    guard order.count > 1 else { return queue }

    var out: [Song] = []
    out.reserveCapacity(queue.count)
    var i = 0
    while out.count < queue.count {
      let who = order[i % order.count]
      if var lane = lanes[who], !lane.isEmpty {
        out.append(lane.removeFirst())
        lanes[who] = lane
      }
      i += 1
    }
    return out
  }

  static func relayURL(room: String, base: URL = base) -> URL {
    URL(string: "\(base.absoluteString)/api/companion?room=\(room)&role=tv")!
  }

  /// Display name: control characters removed, trimmed, capped. "" if none.
  public static func parseName(_ v: Any?) -> String {
    guard let s = v as? String else { return "" }
    let kept = s.unicodeScalars.filter { $0.value > 0x1f && $0.value != 0x7f }
    return String(String(String.UnicodeScalarView(kept)).trimmingCharacters(in: .whitespacesAndNewlines).prefix(nameMax))
  }

  static func text(_ v: Any?, max: Int = 200) -> String {
    String(((v as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(max))
  }

  /// A JSON number that isn't a boolean (NSNumber bridges both).
  static func number(_ v: Any?) -> Double? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    return n.doubleValue
  }

  public static func parseSong(_ v: Any?) -> Song? {
    guard let s = v as? [String: Any] else { return nil }
    let track = text(s["track"])
    guard !track.isEmpty else { return nil }
    var song = Song(track: track, artist: text(s["artist"]))
    if let d = number(s["duration"]), d.isFinite, d > 0, d < 3600 { song.duration = d }
    let art = text(s["artwork"], max: 500)
    if art.hasPrefix("https://") { song.artwork = art }
    return song
  }

  public static func parseCommand(_ data: Data) -> PhoneCommand? {
    guard let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
    let by = parseName(msg["by"])
    switch msg["type"] as? String {
    case "hello":
      return .hello(by: by.isEmpty ? nil : by)
    case "toggle": return .toggle
    case "change": return .change
    case "next": return .next
    case let type? where type == "play" || type == "queue":
      guard var song = parseSong(msg["song"]) else { return nil }
      if !by.isEmpty { song.by = by }
      return type == "play" ? .play(song) : .queue(song)
    case "unqueue":
      guard let i = number(msg["index"]), i >= 0, i == i.rounded(), i < 1e9 else { return nil }
      return .unqueue(Int(i))
    case "nudge":
      guard let ms = number(msg["ms"]), nudgesMs.contains(ms) else { return nil }
      return .nudge(ms: Int(ms))
    case "feel":
      let sense = msg["sense"] as? String
      return sense == "early" || sense == "late" ? .feel(early: sense == "early") : nil
    default:
      return nil
    }
  }
}

/// The TV's open end of a room. Listens until stopped, reconnecting through the
/// relay's 4-minute stream limit and network drops.
public final class RelayLink: @unchecked Sendable {
  public let room: String
  private let url: URL
  private var task: Task<Void, Never>?

  public init(room: String, base: URL = Companion.base) {
    self.room = room
    url = Companion.relayURL(room: room, base: base)
  }

  public func start(onCommand: @escaping @MainActor (PhoneCommand) -> Void) {
    task?.cancel()
    let url = url
    task = Task.detached {
      while !Task.isCancelled {
        do {
          var req = URLRequest(url: url, timeoutInterval: 60) // idle timeout; the relay pings every 20s
          req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
          let (bytes, _) = try await URLSession.shared.bytes(for: req)
          for try await line in bytes.lines where line.hasPrefix("data:") {
            let payload = line.dropFirst(5).drop(while: { $0 == " " })
            if let cmd = Companion.parseCommand(Data(payload.utf8)) { await onCommand(cmd) }
          }
        } catch {
          try? await Task.sleep(nanoseconds: 2_000_000_000) // offline — back off before retrying
        }
      }
    }
  }

  public func send<T: Encodable>(_ message: T) {
    guard let body = try? JSONEncoder().encode(message) else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("text/plain", forHTTPHeaderField: "Content-Type")
    req.httpBody = body
    URLSession.shared.dataTask(with: req).resume()
  }

  public func stop() {
    task?.cancel()
  }
}
