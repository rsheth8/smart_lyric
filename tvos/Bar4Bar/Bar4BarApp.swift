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

  /// What the room mic is doing. `.idle` means manual mode: no mic, the singer
  /// starts the track themselves and nudges with the remote.
  var listening = ListenState.idle

  @ObservationIgnored private let link: RelayLink
  @ObservationIgnored private var lastState: TVState?
  @ObservationIgnored private var lastSent = Date.distantPast
  @ObservationIgnored private var toastID = 0
  /// One playhead for the whole app: sessions read it, the detector writes it.
  @ObservationIgnored let sync = SyncClock()
  @ObservationIgnored private let mic = ContinuityMic()
  @ObservationIgnored private var detector: SongDetector?
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
    await startListening()
    // Heartbeat: roll into the next queued song, keep phones in sync.
    while !Task.isCancelled {
      if let session, session.readyToRollOn, !queue.isEmpty { playNext() }
      // The detector can pause the playhead when the room goes quiet.
      session?.tick()
      pushState()
      try? await Task.sleep(for: .seconds(1))
    }
  }

  /// Turn on the room mic and let the app work out what's playing by itself.
  /// Soft-fails to manual mode: no phone nearby is a normal way to use the TV.
  func startListening() async {
    guard detector == nil else { return }
    let availability = await mic.start()
    guard availability == .ready else {
      listening = .idle
      return
    }
    let next = SongDetector(
      source: mic,
      recognizer: RelayRecognizer(),
      clock: sync,
      onSong: { [weak self] in await self?.heard($0) },
      onState: { [weak self] in self?.listening = $0 }
    )
    detector = next
    next.start()
  }

  func stopListening() {
    detector?.stop()
    detector = nil
    mic.stop()
    listening = .idle
  }

  /// The mic recognised something. If it isn't what's already on stage, put it up
  /// — this is the whole trick: start a song anywhere in the room and the TV
  /// catches it, finds the words and lands on the beat.
  private func heard(_ recognition: Recognition) async {
    let song = recognition.song
    guard session?.song.id != song.id else { return }
    Analytics.track("song_heard", ["surface": "tvos"])
    flash("Heard: \(song.track)")
    sing(song, autoSynced: true)
  }

  func sing(_ song: Song, autoSynced: Bool = false) {
    session?.stop()
    queue.removeAll { $0.id == song.id }
    // Scoring only where there's a mic to score from — see SingSession.roomLevel.
    let mic = self.mic
    var roomLevel: (@MainActor () -> Double)?
    if mic.isRunning { roomLevel = { mic.level } }
    let next = SingSession(song: song, sync: sync, autoSynced: autoSynced, roomLevel: roomLevel)
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
        // Re-rotate on every add so one guest queueing five songs can't lock the room.
        queue = Companion.fairOrder(queue + [song])
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
/// The playhead is a SyncClock, which covers both ways the TV can run. Nobody
/// feeding it observations leaves it free-running at rate 1.0 — exactly the old
/// stopwatch, where the singer starts the track themselves during the count-in
/// and straightens it with the remote. With the room mic on, SongDetector feeds
/// it fingerprint positions every few seconds and it locks onto the music by
/// itself, whatever is playing it.
@MainActor @Observable
final class SingSession: Identifiable {
  enum Status: Equatable {
    case loading, ready
    case failed(String)
  }

  /// Seconds of count-in before the song's 0:00.
  static let leadIn = 3.0
  static var clock: Double { ProcessInfo.processInfo.systemUptime }

  /// How often the room is sampled for scoring. `Score.minFrames` is 40, so a
  /// card needs about four seconds of actual singing before it will appear.
  static let scoreHz = 10.0
  /// How long a finished song holds the stage so its card can be read.
  static let cardSeconds = 8.0

  let id = UUID()
  let song: Song
  var status = Status.loading
  var timeline = Timeline(lines: [])
  var source = ""
  var offset = 0.0
  var playing = false
  /// Updated live while they sing; nil until there's enough to be worth showing.
  var score: ScoreResult?
  /// Mirror of `isFinished`, reconciled by the heartbeat so views can observe it.
  var finished = false

  @ObservationIgnored private let sync: SyncClock
  @ObservationIgnored private let loadStart = SingSession.clock
  @ObservationIgnored private var stopped = false
  @ObservationIgnored private let keeper = ScoreKeeper()
  @ObservationIgnored private let voice = RoomVoice()
  @ObservationIgnored private var scoring: Task<Void, Never>?

  /// `autoSynced` means the room mic put this song on stage and already owns the
  /// playhead — loading must not reset it back to a count-in.
  private let autoSynced: Bool
  /// The room's current RMS, or nil when there's no mic. No mic, no scoring:
  /// a card built from nothing is worse than no card.
  @ObservationIgnored private let roomLevel: (@MainActor () -> Double)?

  init(
    song: Song,
    sync: SyncClock,
    autoSynced: Bool = false,
    roomLevel: (@MainActor () -> Double)? = nil
  ) {
    self.song = song
    self.sync = sync
    self.autoSynced = autoSynced
    self.roomLevel = roomLevel
  }

  var position: Double { sync.now() }

  /// Both of these are read off the clock, which isn't observable, so the
  /// heartbeat reconciles them once a second rather than the view polling time.
  /// The pause badge also has to be reconciled because the detector can pause
  /// the clock on its own when the room goes quiet, not only `toggle()`.
  func tick() {
    #if DEBUG
    // `-fakeScore 72`: the score card needs a mic, a finished song and an Apple
    // TV before it will ever appear, which means nothing in the Simulator can
    // see it. This puts one on screen for RemoteFlowTests to screenshot.
    // Launch arguments arrive as strings, the same as `-room` above.
    if status == .ready,
       let raw = UserDefaults.standard.string(forKey: "fakeScore"),
       let fake = Int(raw) {
      score = ScoreResult(
        score: fake,
        grade: Score.gradeFor(fake),
        coverage: Double(fake) / 100,
        pitch: nil,
        bestStreak: Int(Self.scoreHz * 14),
        frames: 900,
        scored: false
      )
      finished = true
      return
    }
    #endif
    if playing != sync.isPlaying { playing = sync.isPlaying }
    if finished != isFinished { finished = isFinished }
  }
  /// Where the highlight is: song position plus the singer's timing nudge.
  var cueTime: Double { position + offset }
  var isFinished: Bool { status == .ready && timeline.isFinished(at: position) }

  /// Finished *and* done being looked at. A song with a score card lingers so
  /// the room can read it before the next one takes the stage.
  var readyToRollOn: Bool {
    guard status == .ready else { return false }
    return timeline.isFinished(at: position, grace: 6 + (score == nil ? 0 : Self.cardSeconds))
  }

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
    // Count in from before 0:00. Skipped when the mic put this song up: the song
    // is already halfway through the room and the detector holds the real position.
    if !autoSynced { sync.start(at: -Self.leadIn) }
    playing = true
    status = .ready
    startScoring()
  }

  /// Score the room while the song runs.
  ///
  /// The mic hears the music as well as the singer, so `RoomVoice` measures what
  /// the track sounds like during the gaps between lines and subtracts it back
  /// out. There is no melody reference to compare against — the TV never owns
  /// the track's samples — so this scores whether you sang, not whether you were
  /// in tune, and the card says so.
  private func startScoring() {
    guard let roomLevel else { return }
    scoring = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1 / SingSession.scoreHz))
        guard let self, !self.stopped else { return }
        guard self.status == .ready, self.sync.isPlaying else { continue }
        let expected = self.timeline.activeLine(at: self.cueTime) >= 0
        let level = self.voice.voiceLevel(level: roomLevel(), expected: expected)
        self.keeper.sample(expected: expected, level: level)
        self.score = self.keeper.result()
      }
    }
  }

  func toggle() {
    guard status == .ready else { return }
    if sync.isPlaying { sync.pause() } else { sync.resume() }
    playing = sync.isPlaying
  }

  func nudge(ms: Int) {
    offset = min(2, max(-2, ((offset * 1000).rounded() + Double(ms)) / 1000))
  }

  func stop() {
    if status == .ready, timeline.duration > 0 {
      Analytics.track("song_exit", ["surface": "tvos", "sung": Analytics.sungBucket(max(0, position) / timeline.duration)])
    }
    if let score {
      Analytics.track("song_scored", ["surface": "tvos", "grade": score.grade])
    }
    stopped = true
    scoring?.cancel()
    scoring = nil
    sync.pause()
    playing = false
  }
}
