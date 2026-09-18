import Foundation
import Combine
import Bar4BarCore

private actor LearningFiles {
  private let store = RecordingLearningStore()
  func load(_ context: ListeningContext) -> RecordingLearningProfile? { store.load(context) }
  func save(_ profile: RecordingLearningProfile, _ context: ListeningContext) { try? store.save(profile, context: context) }
  func reset(_ context: ListeningContext) { try? store.reset(context) }
}

@MainActor final class TVListeningService: ObservableObject {
  @Published private(set) var invitation: ListeningInvitation?
  @Published private(set) var connected = false
  @Published private(set) var status: ListeningStatus = .stopped
  @Published private(set) var detail = "Connect an iPhone near your speaker."
  @Published var automatic = true {
    didSet { engine.automatic = automatic; if !automatic { session?.setListenerAlignment(0) } }
  }
  @Published var language = "en" { didSet { key = "" } }
  private let wire = ListeningConnection()
  private let files = LearningFiles()
  private var engine = AdaptiveListeningEngine()
  private weak var session: LyricsSession?
  private weak var music: MusicPlayerService?
  private var task: Task<Void, Never>?
  private var key = ""
  private var sessionID = UUID()
  private var playID = UUID()
  private var previousPosition: Double = 0
  private var previousSeek = -1
  private var base = Timeline(lines: [])
  private var lastSent: Double = -.infinity
  private var loading = false
  private var reference: AcousticReference?

  func configure(session: LyricsSession, music: MusicPlayerService) {
    self.session = session; self.music = music
    session.onManualTimingAdjustment = { [weak self] in self?.engine.manualAdjustment(at: ProcessInfo.processInfo.systemUptime) }
    wire.onInvitation = { [weak self] value in Task { @MainActor in self?.invitation = value } }
    wire.onConnected = { [weak self] in Task { @MainActor in
      self?.connected = true; self?.status = .listening; self?.lastSent = -.infinity
    }}
    wire.onDisconnected = { [weak self] in Task { @MainActor in
      self?.connected = false; self?.status = .stopped
    }}
    wire.onMessage = { [weak self] message in Task { @MainActor in self?.receive(message) } }
    task?.cancel()
    task = Task { [weak self] in
      while !Task.isCancelled {
        self?.tick()
        try? await Task.sleep(for: .milliseconds(200))
      }
    }
  }
  func pair() { invitation = nil; sessionID = UUID(); key = ""; wire.host() }
  func stop() { wire.stop(); invitation = nil; connected = false; status = .stopped }
  func resetLearned() {
    guard let context = engine.context else { return }
    engine.resetLearning(); session?.timeline = base
    Task { await files.reset(context) }
    detail = "Learned guidance reset for this recording."
  }
  private func tick() {
    guard let session, let music else { return }
    let host = ProcessInfo.processInfo.systemUptime
    guard let recording = session.listeningRecording, !session.timeline.isEmpty,
      let track = music.nowPlaying else { session.setListenerAlignment(0); return }
    let nextKey = TimelineCache.cacheKey(artist: track.artist, track: track.title, duration: track.duration,
      album: track.album, recording: recording) + ":" + session.lyricRevision + ":" + language
    if nextKey != key {
      key = nextKey; base = session.timeline; reference = nil; playID = UUID(); previousSeek = -1
      for url in Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? [] where url.lastPathComponent.hasSuffix(".acoustic-reference.json") {
        if let data = try? Data(contentsOf: url), let value = try? JSONDecoder().decode(AcousticReference.self, from: data),
          value.recording == recording, value.lyricRevision == session.lyricRevision { reference = value; break }
      }
      session.setListenerAlignment(0); lastSent = -.infinity
    }
    let position = music.liveTime
    if position < 0.5 && previousPosition > 10 { playID = UUID() }
    previousPosition = position
    let context = ListeningContext(session: sessionID, play: playID, recording: recording,
      cacheKey: nextKey, duration: base.duration, lyricRevision: base.lyricRevision,
      seekEpoch: music.stageSeekRevision, playing: music.isPlaying, position: position,
      hostTime: host, language: language, referenceVersion: reference?.referenceVersion)
    let packet = ListeningPacket(context: context, timeline: base, reference: reference)
    if engine.context?.cacheKey != context.cacheKey || engine.context?.play != context.play {
      engine.install(packet); loading = true
      let expected = key
      Task { [weak self] in
        guard let self else { return }
        let saved = await files.load(context)
        guard self.key == expected, self.engine.context?.play == context.play else { return }
        self.engine.install(packet, saved: saved)
        // install is a continuous update; explicitly seed a loaded durable profile.
        if let saved { self.engine.restore(saved) }
        self.loading = false
        self.applyGuidance()
      }
    } else { engine.install(packet) }
    if !loading, automatic { session.setListenerAlignment(engine.tick(at: host, playback: position, playing: music.isPlaying)) }
    if connected {
      if engine.status != status, status != .stopped { status = engine.status }
      if host - lastSent >= 1 || previousSeek != context.seekEpoch {
        wire.send(.context(packet)); lastSent = host; previousSeek = context.seekEpoch
      }
    }
  }
  private func receive(_ message: ListeningMessage) {
    switch message {
    case let .ping(id, sent):
      let now = ProcessInfo.processInfo.systemUptime
      wire.send(.pong(id: id, sent: sent, received: now, replied: ProcessInfo.processInfo.systemUptime))
    case let .status(value): status = value
    case let .observation(value):
      guard !loading, connected, engine.observe(value, at: ProcessInfo.processInfo.systemUptime) else { return }
      if let profile = engine.profile, let context = engine.context {
        Task { await files.save(profile, context) }
      }
      applyGuidance()
    default: break
    }
  }
  private func applyGuidance() {
    guard automatic, let session, let music else { return }
    let cue = music.liveTime + session.totalAlignment + session.singerLead + session.previewSeconds
    let active = base.lines.lastIndex(where: { $0.start <= cue }) ?? -1
    let guided = engine.guidedTimeline(afterLine: music.isPlaying ? active : -1)
    if guided != session.timeline { session.timeline = guided }
    if engine.profile?.accepted.isEmpty == false { detail = "Saved approximate word guidance for this exact recording." }
  }
}
