import Bar4BarKit
import Observation
import SwiftUI

@main
struct Bar4BarApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .preferredColorScheme(.dark)
        .task { await model.run() }
    }
  }
}

/// Everything on the TV that outlives a screen: songs to pick, the queue, the
/// phone room, and the song being sung.
@MainActor @Observable
final class AppModel {
  var chart: [Song] = []
  var recent: [Song] = []
  var queue: [Song] = []
  var guests: [String] = []
  var phoneSeen = false
  var session: SingSession?
  var toast: String?
  let room: String

  @ObservationIgnored private let link: RelayLink
  @ObservationIgnored private var lastState: TVState?
  @ObservationIgnored private var lastSent = Date.distantPast
  @ObservationIgnored private var toastID = 0
  private static let recentKey = "bar4bar.recent.v1"

  init() {
    var room = Companion.newRoomCode()
    #if DEBUG
    // `-room ABCDEFGH` launch argument: a known room to drive the app from a test phone.
    if let fixed = UserDefaults.standard.string(forKey: "room"), fixed.range(of: "^[A-HJ-NP-Z2-9]{8}$", options: .regularExpression) != nil {
      room = fixed
    }
    #endif
    self.room = room
    link = RelayLink(room: room)
    if let data = UserDefaults.standard.data(forKey: Self.recentKey) {
      recent = (try? JSONDecoder().decode([Song].self, from: data)) ?? []
    }
  }

  func run() async {
    Analytics.track("app_open", ["surface": "tvos"])
    link.start { [weak self] in self?.handle($0) }
    Task { chart = await Catalog.topSongs() }
    // Heartbeat: roll into the next queued song, keep phones in sync.
    while !Task.isCancelled {
      if let session, session.isFinished, !queue.isEmpty { playNext() }
      pushState()
      try? await Task.sleep(for: .seconds(1))
    }
  }

  func sing(_ song: Song) {
    session?.stop()
    queue.removeAll { $0.id == song.id }
    let next = SingSession(song: song)
    session = next
    var played = song
    played.by = nil
    recent = Array(([played] + recent.filter { $0.id != song.id }).prefix(20))
    UserDefaults.standard.set(try? JSONEncoder().encode(recent), forKey: Self.recentKey)
    Task { await next.load() }
    pushState(force: true)
  }

  func endSing() {
    session?.stop()
    session = nil
    pushState(force: true)
  }

  func playNext() {
    if !queue.isEmpty { sing(queue.removeFirst()) }
  }

  func togglePlay() {
    guard let session, session.status == .ready else { return }
    session.toggle() // the stage shows the pause badge
    pushState(force: true)
  }

  func nudge(ms: Int) {
    guard let session, session.status == .ready else { return }
    session.nudge(ms: ms) // the now-playing bar shows the offset
    pushState(force: true)
  }

  func handle(_ command: PhoneCommand) {
    if !phoneSeen {
      phoneSeen = true
      Analytics.track("remote_paired")
      flash("Phone remote connected")
    }
    switch command {
    case .hello(let by):
      addGuest(by)
    case .play(let song):
      addGuest(song.by)
      sing(song)
    case .queue(let song):
      addGuest(song.by)
      if queue.count >= Companion.queueMax {
        flash("Queue is full")
      } else {
        queue.append(song)
        flash("Up next: \(song.track)\(song.by.map { " · \($0)" } ?? "")")
      }
    case .unqueue(let index):
      if queue.indices.contains(index) { queue.remove(at: index) }
    case .next:
      playNext()
    case .toggle:
      if session == nil { playNext() } else { togglePlay() }
    case .change:
      if session != nil { endSing() }
    case .nudge(let ms):
      nudge(ms: ms)
    case .feel(let early):
      // Lyrics feel early → hold the highlight back a touch, and vice versa.
      nudge(ms: early ? -100 : 100)
    }
    pushState(force: true)
  }

  func flash(_ text: String) {
    toastID += 1
    let id = toastID
    toast = text // ToastView animates its own entrances and exits
    Task {
      try? await Task.sleep(for: .seconds(2.2))
      if toastID == id { toast = nil }
    }
  }

  private func addGuest(_ name: String?) {
    guard let name, !guests.contains(name) else { return }
    guests.append(name)
    flash("\(name) joined")
  }

  /// Tell phones what's on screen; unchanged state goes out as a 3s heartbeat.
  /// Silent until a phone has spoken, so an idle TV costs the relay nothing.
  private func pushState(force: Bool = false) {
    guard phoneSeen else { return }
    let state = TVState(
      mode: session == nil ? "setup" : "playing",
      track: session?.song.track ?? "",
      artist: session?.song.artist ?? "",
      art: session?.song.artwork ?? "",
      playing: session?.playing ?? false,
      offsetMs: Int(((session?.offset ?? 0) * 1000).rounded()),
      queue: queue
    )
    if !force, state == lastState, Date().timeIntervalSince(lastSent) < 3 { return }
    lastState = state
    lastSent = Date()
    link.send(state)
  }
}

/// One song on stage: its lyrics and the playhead the highlight follows.
///
/// ponytail: the playhead is a free-running clock started when the lyrics are
/// ready (the web TV's demo clock) — the singer starts the track on their own
/// speaker during the count-in and nudges timing with the remote. MusicKit
/// playback (exact position) replaces it once the app has a MusicKit entitlement.
@MainActor @Observable
final class SingSession: Identifiable {
  enum Status: Equatable {
    case loading, ready
    case failed(String)
  }

  /// Seconds of count-in before the song's 0:00.
  static let leadIn = 3.0
  static var clock: Double { ProcessInfo.processInfo.systemUptime }

  let id = UUID()
  let song: Song
  var status = Status.loading
  var timeline = Timeline(lines: [])
  var source = ""
  var offset = 0.0
  var playing = false

  @ObservationIgnored private var anchorPosition = -SingSession.leadIn
  @ObservationIgnored private var anchorTime = 0.0
  @ObservationIgnored private let loadStart = SingSession.clock
  @ObservationIgnored private var stopped = false

  init(song: Song) {
    self.song = song
  }

  var position: Double { playing ? anchorPosition + Self.clock - anchorTime : anchorPosition }
  /// Where the highlight is: song position plus the singer's timing nudge.
  var cueTime: Double { position + offset }
  var isFinished: Bool { status == .ready && timeline.isFinished(at: position) }

  func load() async {
    Analytics.track("song_load", ["surface": "tvos"])
    let result = await LyricsService.fetch(song)
    guard !stopped else { return }
    guard let result, !result.timeline.lines.isEmpty else {
      status = .failed("No lyrics found for “\(song.track)”")
      return
    }
    Analytics.track("song_ready", ["surface": "tvos", "wait": Analytics.waitBucket(seconds: Self.clock - loadStart)])
    timeline = result.timeline
    source = result.source
    anchorPosition = -Self.leadIn
    anchorTime = Self.clock
    playing = true
    status = .ready
  }

  func toggle() {
    guard status == .ready else { return }
    anchorPosition = position
    anchorTime = Self.clock
    playing.toggle()
  }

  func nudge(ms: Int) {
    offset = min(2, max(-2, ((offset * 1000).rounded() + Double(ms)) / 1000))
  }

  func stop() {
    if status == .ready, timeline.duration > 0 {
      Analytics.track("song_exit", ["surface": "tvos", "sung": Analytics.sungBucket(max(0, position) / timeline.duration)])
    }
    stopped = true
    playing = false
  }
}
