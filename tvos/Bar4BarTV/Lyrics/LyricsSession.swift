import Foundation
import Combine
import Bar4BarCore

@MainActor
final class LyricsSession: ObservableObject {
  @Published var timeline: Timeline = Timeline(lines: []) {
    // A `didSet` rather than a call at each assignment site: the timeline is set
    // from five places (demo, cache hit, fetch, fetch-failure, clear) and a
    // rail left over from the previous song is worse than no rail at all.
    didSet {
      guard timeline != oldValue else { return }
      sections = Sections.derive(timeline)
      timingRevision += 1
      lyricRevision = timeline.lyricRevision
      choreography = automaticDemo ? nil : stageSidecar?.validated(recording: stageRecording, timeline: timeline)
    }
  }
  @Published private(set) var timingRevision = 0
  @Published private(set) var lyricRevision = ""
  @Published private(set) var choreography: Choreography?
  private var stageRecording: RecordingIdentity?
  private var stageSidecar: Choreography?
  @Published var intensity: StageIntensity = StageIntensity(rawValue: UserDefaults.standard.string(forKey: "bar4bar.stage.intensity") ?? "live") ?? .live {
    didSet { UserDefaults.standard.set(intensity.rawValue, forKey: "bar4bar.stage.intensity") }
  }
  @Published var previewSeconds: Double = UserDefaults.standard.object(forKey: "bar4bar.stage.preview").map { _ in UserDefaults.standard.double(forKey: "bar4bar.stage.preview") } ?? 1.5 {
    didSet { UserDefaults.standard.set(previewSeconds, forKey: "bar4bar.stage.preview") }
  }
  @Published private(set) var audienceAccent = AudienceAccent()
  private var audienceTask: Task<Void, Never>?
  func cheer() {
    guard audienceAccent.cheer(at: Date().timeIntervalSinceReferenceDate) else { return }
    audienceTask?.cancel()
    audienceTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(1200))
      guard !Task.isCancelled else { return }
      self?.audienceAccent.clear()
    }
  }
  @Published var partyMode = UserDefaults.standard.string(forKey: "bar4bar.stage.partyMode") ?? "Solo" {
    didSet { UserDefaults.standard.set(partyMode, forKey: "bar4bar.stage.partyMode") }
  }
  @Published var automaticDemo = false
  @Published var blankNthWord: Int = 0   // 0 = off, 2 = every 2nd, 3 = every 3rd, 4 = every 4th
  @Published var loopSection: Bool = false

  func savedGuidance(for item: CatalogItem) async -> SongGuidance {
    let key = TimelineCache.cacheKey(artist: item.artist, track: item.title,
      duration: item.duration, album: item.album, recording: item.recording)
    if key == currentCacheKey { return SongGuidance(timeline: timeline) }
    let store = cache
    return await Task.detached(priority: .utility) {
      SongGuidance(timeline: store.load(key: key))
    }.value
  }

  func setAutomaticDemo(_ enabled: Bool) {
    automaticDemo = enabled
    timeline = enabled ? DemoSong.automaticTimeline() : DemoSong.timeline()
    if enabled { choreography = nil }
  }

  private func prepareStage(for track: NowPlayingTrack) {
    stageRecording = track.isDemo ? DemoSong.stageRecording : track.recording
    stageSidecar = nil
    automaticDemo = false
    for url in Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? [] where url.lastPathComponent.hasSuffix(".choreography.json") {
      if let data = try? Data(contentsOf: url), let candidate = try? JSONDecoder().decode(Choreography.self, from: data), candidate.recording.matches(stageRecording) {
        stageSidecar = candidate
        break
      }
    }
  }
  @Published var isLoading = false
  @Published var errorMessage: String?
  @Published var statusMessage: String?
  /// Upcoming catalog title, when the TV is lining up the next song.
  @Published private(set) var nextPrepTitle: String?
  @Published private(set) var nextPrepReady = false
  /// Word count / source for the buffered next song — proof the fetch returned a timeline.
  @Published private(set) var nextPrepDetail: String?
  /// True when the current on-screen lyrics were installed from that buffer.
  @Published private(set) var installedFromPrep = false
  private var lastPrepKey: String?
  @Published var syncOffset: Double = 0
  /// Presentation consumes manual offset and heard-audio alignment separately.
  @Published private(set) var listenerAlignment: Double = 0
  var totalAlignment: Double { syncOffset + listenerAlignment }
  var onManualTimingAdjustment: (() -> Void)?
  func setListenerAlignment(_ value: Double) {
    guard value.isFinite, abs(value) <= 10, abs(listenerAlignment - value) > 0.001 else { return }
    listenerAlignment = value
  }
  var listeningRecording: RecordingIdentity? { stageRecording }
  /// What's on screen now: off / pronunciation / English.
  @Published var aidMode: LanguageAidMode = .off
  /// Last mode the viewer chose. Restored for the next song when it applies.
  @Published var preferredAidMode: LanguageAidMode
  @Published var aidMessage: String?
  @Published var aidBusy = false
  @Published var singerLead: Double = UserDefaults.standard.object(forKey: "bar4bar.tv.singerLead").map { _ in
    DisplayMath.clampSingerLead(UserDefaults.standard.double(forKey: "bar4bar.tv.singerLead"))
  } ?? DisplayMath.singerLead
  /// Per-song accent, rebuilt from the artwork's hue. Views must read this
  /// rather than the brand gold — see `AccentPalette`.
  @Published var accent: AccentPalette = .brand

  /// Derived song structure for the rail. Recomputed once per timeline rather
  /// than per frame — `derive` walks every line and every word.
  @Published private(set) var sections: [Sections.Section] = []

  private var client: LyricsClient
  private var officialOnly: Bool
  private let cache: TimelineCache
  private var languageAid: any LanguageAiding
  private let aidModeKey = "bar4bar.tv.languageAid"

  init(
    client: LyricsClient = LyricsClient(
      apiBaseURL: AppConfig.lyricsAPIBase,
      officialOnly: AppConfig.officialLyricsOnly
    ),
    cache: TimelineCache = DemoLaunch.browseFixture ? DemoBrowseFixture.cache() : TimelineCache(),
    languageAid: any LanguageAiding = LanguageAidClient(),
    officialOnly: Bool = AppConfig.officialLyricsOnly
  ) {
    self.client = client
    self.officialOnly = officialOnly
    self.cache = cache
    self.languageAid = languageAid
    let stored = UserDefaults.standard.string(forKey: aidModeKey).flatMap(LanguageAidMode.init(rawValue:))
    self.preferredAidMode = stored ?? .off
  }
  private var offsetsKey = "bar4bar.tv.syncOffsets"

  func configure(apiBase: URL?, officialOnly: Bool = AppConfig.officialLyricsOnly) {
    self.officialOnly = officialOnly
    client = LyricsClient(apiBaseURL: apiBase, officialOnly: officialOnly)
  }

  private var loadID = UUID()
  private var accentTask: Task<Void, Never>?
  private var aidMessageTask: Task<Void, Never>?
  private var aidGeneration = 0
  private var nextPrepTrack: NowPlayingTrack?
  private var nextPrepTask: Task<LyricsResult?, Never>?
  private var nextPrepResult: LyricsResult?

  /// Catalog-fetch the upcoming track while the current one is still playing.
  /// Same work `load` would do on change — just earlier. Never alignment.
  func prepareNext(_ track: NowPlayingTrack, skipIf current: NowPlayingTrack? = nil) {
    guard !track.isDemo, !track.title.isEmpty else { return }
    if let current, Self.sameUpcoming(track, current) { return }
    if let nextPrepTrack, Self.sameUpcoming(nextPrepTrack, track) { return }
    nextPrepTask?.cancel()
    nextPrepResult = nil
    nextPrepTrack = track
    nextPrepTitle = track.title
    nextPrepReady = false
    nextPrepDetail = nil
    TVLog.prep("lining up “\(track.title)” by \(track.artist)")
    let client = self.client
    nextPrepTask = Task { @MainActor [weak self] in
      let query = LyricsClient.Query(
        artist: track.artist,
        track: track.title,
        duration: track.duration,
        album: track.album.isEmpty ? nil : track.album,
        recording: track.recording
      )
      let result = await client.fetch(query)
      guard let self, !Task.isCancelled, Self.sameUpcoming(self.nextPrepTrack, track) else { return nil }
      if let result, result.cacheable, !result.timeline.isEmpty {
        let key = TimelineCache.cacheKey(
          artist: track.artist,
          track: track.title,
          duration: track.duration,
          album: track.album,
          recording: track.recording
        )
        self.cache.save(result.timeline, key: key)
      }
      self.nextPrepResult = result
      self.nextPrepReady = result.map { !$0.timeline.isEmpty } ?? false
      self.nextPrepDetail = result.flatMap(Self.prepDetail(for:))
      if let detail = self.nextPrepDetail {
        TVLog.prep("lined up “\(track.title)” — \(detail)")
      } else {
        TVLog.prep("no catalog timeline for “\(track.title)”")
      }
      return result
    }
  }

  func load(for track: NowPlayingTrack) async {
    prepareStage(for: track)
    let id = UUID()
    loadID = id
    accentTask?.cancel()
    aidGeneration += 1
    let aidGen = aidGeneration
    timeline = Timeline(lines: [])
    currentCacheKey = nil
    syncOffset = 0
    isLoading = true
    errorMessage = nil
    statusMessage = "Finding the words…"
    aidMode = .off
    aidBusy = false
    aidMessage = nil
    accent = .brand
    accentTask = Task { [weak self] in
      let color: RGB?
      if let dominant = track.dominantColor { color = dominant }
      else if let url = track.artworkURL { color = await ArtworkAccent.dominantColor(of: url) }
      else { color = nil }
      guard let self, self.loadID == id, !Task.isCancelled else { return }
      self.accent = color.map { AccentPalette.from(dominant: $0) } ?? .brand
    }
    // The demo ships its timeline in the binary — no fetch, no cache, and it
    // must never be persisted under a cache key a real track could collide with.

    if track.isDemo {
      let fixture = ProcessInfo.processInfo.environment["BAR4BAR_STAGE_FIXTURE"]
      if fixture != "no-lyrics" {
        timeline = fixture == "long" ? DemoSong.layoutFixture() : DemoSong.timeline()
        if fixture == "long" { aidMode = .english }
        statusMessage = "Demo · word-level"
      }
      currentCacheKey = nil
      syncOffset = 0
      isLoading = false
      errorMessage = nil
      await restorePreferredAid(id: id, generation: aidGen)
      if fixture == "long" { aidMode = .english }
      return
    }

    let key = TimelineCache.cacheKey(
      artist: track.artist,
      track: track.title,
      duration: track.duration,
      album: track.album,
      recording: track.recording
    )
    if lastPrepKey != key { installedFromPrep = false }
    if let prepared = await takeNextPrep(for: track) {
      timeline = prepared.timeline
      currentCacheKey = key
      isLoading = false
      installedFromPrep = true
      lastPrepKey = key
      syncOffset = storedOffset(for: key)
      statusMessage = timingLabel(for: prepared.timeline)
      errorMessage = nil
      if prepared.cacheable { cache.save(prepared.timeline, key: key) }
      TVLog.prep("installed prep for “\(track.title)” — \(Self.prepDetail(for: prepared) ?? "empty")")
      adoptCachedAid()
    } else if let cached = cache.load(key: key), !cached.isEmpty,
              (!officialOnly || cached.source == "aligned") {
      timeline = cached
      isLoading = false
      installedFromPrep = lastPrepKey == key
      syncOffset = storedOffset(for: key)
      statusMessage = timingLabel(for: cached)
      errorMessage = nil
      if installedFromPrep {
        TVLog.prep("reloaded prefetched cache for “\(track.title)”")
      }
      // Render immediately, then check for newly reviewed timings on every load.
      adoptCachedAid()
    } else {
      installedFromPrep = false
      TVLog.prep("live fetch for “\(track.title)” — no prep buffer")
    }

    isLoading = timeline.isEmpty
    errorMessage = nil
    statusMessage = timeline.isEmpty ? "Fetching lyrics…" : timingLabel(for: timeline)
    defer { if loadID == id { isLoading = false } }

    let query = LyricsClient.Query(
      artist: track.artist,
      track: track.title,
      duration: track.duration,
      album: track.album,
      recording: track.recording
    )
    let result = await client.fetch(query)
    guard loadID == id, !Task.isCancelled else { return }
    guard let result else {
      if !timeline.isEmpty {
        await restorePreferredAid(id: id, generation: aidGen)
        return
      }
      timeline = Timeline(lines: [])
      errorMessage = "No synced lyrics found for “\(track.title)”."
      statusMessage = nil
      return
    }
    // A temporary provider failure must not replace saved word timing with guesses.
    if timeline.hasWordTiming && (!result.timeline.hasWordTiming
      || (timeline.source == "aligned" && result.timeline.source != "aligned")) {
      await restorePreferredAid(id: id, generation: aidGen)
      return
    }
    timeline = result.timeline
    if result.cacheable { cache.save(result.timeline, key: key) }
    syncOffset = storedOffset(for: key)
    statusMessage = timingLabel(for: result.timeline)
    await restorePreferredAid(id: id, generation: aidGen)
  }

  /// Drop the loaded song.
  ///
  /// Without this, stopping the demo left its timeline on screen: the app only
  /// reloads lyrics when `nowPlaying` becomes non-nil, so clearing the track
  /// alone left the karaoke ladder scrolling words for a song that was no
  /// longer playing.
  /// Claim a finished (or nearly finished) prep for the track that just started.
  func takeNextPrep(for track: NowPlayingTrack, waitNs: UInt64 = 2_000_000_000) async -> LyricsResult? {
    guard let prepared = nextPrepTrack, Self.sameUpcoming(prepared, track) else { return nil }
    if let ready = nextPrepResult {
      clearNextPrep()
      return ready.timeline.isEmpty ? nil : ready
    }
    guard let task = nextPrepTask else {
      clearNextPrep()
      return nil
    }
    let result = await withTaskGroup(of: LyricsResult?.self) { group in
      group.addTask { await task.value }
      group.addTask {
        try? await Task.sleep(nanoseconds: waitNs)
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first ?? nil
    }
    guard let result, !result.timeline.isEmpty else { return nil }
    clearNextPrep()
    return result
  }

  func clearNextPrep() {
    nextPrepTask?.cancel()
    nextPrepTask = nil
    nextPrepTrack = nil
    nextPrepResult = nil
    nextPrepTitle = nil
    nextPrepReady = false
    nextPrepDetail = nil
  }

  static func prepDetail(for result: LyricsResult) -> String? {
    guard !result.timeline.isEmpty else { return nil }
    let words = result.timeline.lines.reduce(0) { $0 + $1.words.count }
    let kind = result.timeline.hasWordTiming ? "Word-synced" : "Line-synced"
    let source = result.timeline.source.map { " · \($0)" } ?? ""
    return "\(kind) · \(words) words\(source)"
  }

  static func sameUpcoming(_ left: NowPlayingTrack?, _ right: NowPlayingTrack?) -> Bool {
    guard let left, let right else { return false }
    return NextPrep.sameTrack(
      leftID: left.id,
      leftRecording: left.recording,
      leftArtist: left.artist,
      leftTitle: left.title,
      rightID: right.id,
      rightRecording: right.recording,
      rightArtist: right.artist,
      rightTitle: right.title
    )
  }

  func clear() {
    loadID = UUID()
    accentTask?.cancel()
    accentTask = nil
    aidMessageTask?.cancel()
    aidGeneration += 1
    timeline = Timeline(lines: [])
    currentCacheKey = nil
    syncOffset = 0
    isLoading = false
    errorMessage = nil
    installedFromPrep = false
    lastPrepKey = nil
    statusMessage = nil
    aidMode = .off
    aidBusy = false
    aidMessage = nil
    accent = .brand
  }

  private func timingLabel(for timeline: Timeline) -> String {
    if timeline.source == "aligned" {
      return timeline.estimated ? "Audio-refined · some words estimated" : "Audio-refined word timing"
    }
    return timeline.hasWordTiming ? "Word-synced lyrics" : "Line-synced lyrics"
  }

  // MARK: - Structure

  /// Called from a view body, so it stays a pure read — `Sections.index` takes
  /// a hint for callers that track one, but a song has a dozen sections at most
  /// and the unhinted scan is not worth caching state for.
  func sectionIndex(at playbackTime: Double) -> Int? {
    Sections.index(in: sections, at: cueTime(playbackTime: playbackTime))
  }

  func sectionLabel(at playbackTime: Double) -> String? {
    guard let idx = sectionIndex(at: playbackTime) else { return nil }
    return sections[idx].part.rawValue
  }

  func cueTime(playbackTime: Double) -> Double {
    playbackTime + totalAlignment + singerLead
  }

  func nudgeSync(by delta: Double) {
    onManualTimingAdjustment?()
    syncOffset = ((syncOffset + delta) * 1000).rounded() / 1000
    persistCurrentOffset()
  }

  func resetSync() {
    onManualTimingAdjustment?()
    syncOffset = 0
    persistCurrentOffset()
  }

  func setSingerLead(_ value: Double) {
    singerLead = DisplayMath.clampSingerLead(value)
    UserDefaults.standard.set(singerLead, forKey: "bar4bar.tv.singerLead")
  }

  var performanceMode: PerformanceMode {
    PerformanceMode.from(lead: singerLead)
  }

  func togglePerformanceMode() {
    setSingerLead(performanceMode.toggled.lead)
  }

  // MARK: - Language aid

  var romanApplies: Bool {
    timeline.hasRoman || LanguageAid.needsRomanization(timeline.lines.map(\.text))
  }

  /// Off → Pronunciation (when it applies) → English → Off. Same order as desktop `T`.
  func cycleAid() async {
    aidGeneration += 1
    let gen = aidGeneration
    let next = LanguageAidMode.next(
      from: timeline.isEmpty ? preferredAidMode : aidMode,
      romanApplies: timeline.isEmpty || romanApplies
    )
    if timeline.isEmpty {
      preferredAidMode = next
      persistPreferredAid()
      showAidMessage(next.label)
      return
    }
    let ok = await applyAid(next, announce: true, generation: gen)
    guard aidGeneration == gen else { return }
    if ok || next == .off {
      preferredAidMode = next
      persistPreferredAid()
    }
  }

  private func adoptCachedAid() {
    switch preferredAidMode {
    case .off:
      aidMode = .off
    case .roman:
      if timeline.hasRoman { aidMode = .roman }
    case .english:
      if timeline.hasEnglish { aidMode = .english }
    }
  }

  private func restorePreferredAid(id: UUID, generation: Int) async {
    guard loadID == id else { return }
    _ = await applyAid(preferredAidMode, announce: false, generation: generation)
  }

  @discardableResult
  private func applyAid(_ mode: LanguageAidMode, announce: Bool, generation: Int) async -> Bool {
    guard aidGeneration == generation else { return false }
    switch mode {
    case .off:
      aidMode = .off
      if announce { showAidMessage(LanguageAidMode.off.label) }
      return true
    case .roman:
      let ok = await ensureRoman(announce: announce, generation: generation)
      guard aidGeneration == generation else { return false }
      if ok { aidMode = .roman }
      if announce { showAidMessage(ok ? LanguageAidMode.roman.label : "No pronunciation available") }
      return ok
    case .english:
      let ok = await ensureEnglish(announce: announce, generation: generation)
      guard aidGeneration == generation else { return false }
      if ok { aidMode = .english }
      if announce { showAidMessage(ok ? LanguageAidMode.english.label : "Couldn’t translate right now") }
      return ok
    }
  }

  @discardableResult
  private func ensureEnglish(announce: Bool, generation: Int) async -> Bool {
    let id = loadID
    let lines = timeline.lines
    if lines.isEmpty { return false }
    if timeline.hasEnglish { return true }
    aidBusy = true
    if announce { showAidMessage("Translating…") }
    let out = await languageAid.translateLines(lines.map(\.text), to: "en")
    if loadID == id { aidBusy = false }
    guard loadID == id, aidGeneration == generation, !Task.isCancelled else { return false }
    guard let out, out.contains(where: { !$0.isEmpty }) else { return false }
    writeOverlay(\.english, values: out)
    persistCurrentTimeline()
    return timeline.hasEnglish
  }

  @discardableResult
  private func ensureRoman(announce: Bool, generation: Int) async -> Bool {
    let id = loadID
    let lines = timeline.lines
    if lines.isEmpty { return false }
    if timeline.hasRoman { return true }
    aidBusy = true
    if announce { showAidMessage("Romanizing…") }
    let texts = lines.map(\.text)
    let remote = await languageAid.romanizeLines(texts)
    var values = remote ?? []
    if !values.contains(where: { !$0.isEmpty }) {
      values = texts.map { LanguageAid.localRomanize($0) ?? "" }
    }
    if loadID == id { aidBusy = false }
    guard loadID == id, aidGeneration == generation, !Task.isCancelled else { return false }
    guard values.contains(where: { !$0.isEmpty }) else { return false }
    writeOverlay(\.roman, values: values)
    persistCurrentTimeline()
    return timeline.hasRoman
  }

  private func writeOverlay(_ keyPath: WritableKeyPath<LyricLine, String?>, values: [String]) {
    var lines = timeline.lines
    for i in lines.indices {
      let value = i < values.count ? values[i].trimmingCharacters(in: .whitespacesAndNewlines) : ""
      if !value.isEmpty { lines[i][keyPath: keyPath] = value }
    }
    timeline = timeline.withLines(lines)
  }

  private func persistCurrentTimeline() {
    guard let key = currentCacheKey, !timeline.isEmpty else { return }
    cache.save(timeline, key: key)
  }

  private func persistPreferredAid() {
    UserDefaults.standard.set(preferredAidMode.rawValue, forKey: aidModeKey)
  }

  private func showAidMessage(_ text: String) {
    aidMessage = text
    aidMessageTask?.cancel()
    aidMessageTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(2.2))
      guard let self, !Task.isCancelled else { return }
      if self.aidMessage == text { self.aidMessage = nil }
    }
  }

  // MARK: - Per-track offset store

  private var currentCacheKey: String?

  private func storedOffset(for key: String) -> Double {
    currentCacheKey = key
    let map = UserDefaults.standard.dictionary(forKey: offsetsKey) as? [String: Double] ?? [:]
    return map[key] ?? 0
  }

  private func persistCurrentOffset() {
    guard let key = currentCacheKey else { return }
    var map = UserDefaults.standard.dictionary(forKey: offsetsKey) as? [String: Double] ?? [:]
    map[key] = syncOffset
    UserDefaults.standard.set(map, forKey: offsetsKey)
  }
}
