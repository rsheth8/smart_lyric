import SwiftUI
import MusicKit
import Bar4BarCore

/// A lyric-first home: experience, music source, then discovery.
/// Focus starts on a playable experience without opening the keyboard.
struct HubView: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var session: LyricsSession
  @EnvironmentObject private var spotify: SpotifyService
  @Binding var path: NavigationPath
  @State private var dominant: RGB? = nil

  private enum HubFocus: Hashable {
    case demoTile
    case card(String)
  }
  @FocusState private var focus: HubFocus?

  private var showStrip: Bool {
    guard let track = music.nowPlaying else { return false }
    return !track.isDemo
  }

  var body: some View {
    ZStack {
      HubAmbient(dominant: dominant)

      ScrollView(.vertical) {
        VStack(alignment: .leading, spacing: 42) {
          header
          hero
          sources
          messages
          recommended
        }
        .padding(.horizontal, Tokens.safeX)
        .padding(.vertical, Tokens.safeY)
        .padding(.bottom, showStrip ? 108 : 0)
        .animation(Tokens.Motion.page, value: music.nowPlaying?.id)
        .animation(Tokens.Motion.page, value: music.chartSongs.count)
      }

      if showStrip, let track = music.nowPlaying {
        NowPlayingStrip(track: track, isPlaying: music.isPlaying)
          .transition(.move(edge: .bottom).combined(with: .opacity))
          .zIndex(1)
      }
    }
    .ignoresSafeArea()
    .animation(Tokens.Motion.page, value: showStrip)
    .task {
      if let mode = DemoLaunch.fakeResults {
        music.forceBrowseState(mode, term: "gold")
      }
      // One turn after the focus engine has made its own assignment, so ours is
      // the one that sticks. A returning viewer opens on what they played last;
      // a first-time viewer opens on the demo, which is the only thing on this
      // screen guaranteed to work before anything is connected.
      try? await Task.sleep(for: .milliseconds(120))
      focus = .demoTile
    }
    .task(id: music.nowPlaying?.artworkURL) {
      guard let url = music.nowPlaying?.artworkURL else { dominant = nil; return }
      dominant = await ArtworkAccent.dominantColor(of: url)
    }
  }

  // MARK: - Header

  private var header: some View {
    HStack(spacing: 36) {
      BrandLockup(size: 38)
      Rectangle().fill(Tokens.line2).frame(width: 1, height: 28)
      Text("THE STAGE IS DARK. YOU'RE ON.")
        .font(Tokens.display(17, .semibold)).tracking(3.5).foregroundStyle(Tokens.text2)
      Spacer()
      Button { path.append(Route.search) } label: { Label("Search", systemImage: "magnifyingglass") }
        .buttonStyle(RoomButtonStyle())
      Button { path.append(Route.settings) } label: { Label("Settings", systemImage: "slider.horizontal.3") }
        .buttonStyle(RoomButtonStyle())
    }
  }

  private var hero: some View {
    VStack(alignment: .leading, spacing: 24) {
      Text("LIVE · WORD FOR WORD · EVERY NIGHT")
        .font(Tokens.caption(18)).tracking(3).foregroundStyle(Tokens.lilac)
      Text("Your voice,\nin good company.")
        .font(Tokens.editorial(86, italic: true)).tracking(-2)
        .foregroundStyle(Tokens.text1).fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 22) {
        Button {
          if music.nowPlaying == nil { music.startDemo() }
          path.append(Route.karaoke)
        } label: {
          Label(music.nowPlaying == nil ? "Experience Bar4Bar" : "Back to the stage", systemImage: "play.fill")
        }.buttonStyle(RoomButtonStyle(prominent: true)).focused($focus, equals: .demoTile)
        Button("Find a song") { path.append(Route.search) }.buttonStyle(RoomButtonStyle())
      }.padding(.top, 12)
    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 40)
  }

  // MARK: - Sources

  private var sources: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s3) {
      ShelfHeader("Bring your music")
      HStack(spacing: Tokens.Space.s3) {
        SourceTile(
          icon: "music.note",
          title: appleMusicTitle,
          subtitle: appleMusicSubtitle,
          tint: Tokens.ember,
          connected: music.authStatus == .authorized
        ) {
          switch music.authStatus {
          case .authorized: path.append(Route.search)
          // Re-offering "Connect" after a denial is a button that cannot work:
          // tvOS returns the stored answer without prompting. Settings is the
          // only place that decision can actually change.
          case .denied, .restricted: path.append(Route.settings)
          default: Task { await music.requestAccess() }
          }
        }

        if AppConfig.spotifyFollowEnabled {
          SourceTile(
            icon: "dot.radiowaves.left.and.right",
            title: spotify.isConnected ? "Spotify" : "Connect Spotify",
            subtitle: spotifySubtitle,
            tint: Tokens.ok,
            connected: spotify.isConnected
          ) {
            path.append(Route.spotify)
          }
        }
      }
    }
  }

  private var spotifySubtitle: String {
    guard spotify.isConnected else { return "Play on your phone. See the words here." }
    guard let track = spotify.track else { return "Nothing playing right now" }
    if let next = spotify.nextUp {
      return "\(track.title) — next \(next.title)"
    }
    return "\(track.title) — \(track.artist)"
  }

  private var appleMusicTitle: String {
    switch music.authStatus {
    case .authorized: return "Apple Music"
    case .denied, .restricted: return "Apple Music is off"
    default: return "Connect Apple Music"
    }
  }

  private var appleMusicSubtitle: String {
    switch music.authStatus {
    case .authorized:
      if let track = music.nowPlaying, !track.isDemo, !music.isFollowing {
        return "\(track.title) — \(track.artist)"
      }
      return "Play here or follow the Music app"
    case .denied, .restricted: return "Turn it on in tvOS Settings"
    default: return "Play music directly on this Apple TV"
    }
  }

  // MARK: - Shelves

  private var recommended: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s3) {
      ShelfHeader("Find your next favorite", subtitle: "Apple Music")
      ScrollView(.horizontal) {
        HStack(spacing: Tokens.Space.s3) {
          if music.isLoadingCharts {
            // Six is what fits across 1080p, so the reserved space matches the
            // space the real cards will occupy and nothing shifts on arrival.
            ForEach(0..<6, id: \.self) { _ in SkeletonCard() }
          } else if music.chartSongs.isEmpty {
            Button("Reload songs") { Task { await music.loadCharts() } }
              .buttonStyle(TVPillStyle())
          } else {
            ForEach(music.chartSongs) { item in
              EditorialSongEntry(item: item, selected: focus == .card(item.id), compact: true) { start(item) }
            }
          }
        }
        .padding(.vertical, Tokens.Space.s3)
        .padding(.horizontal, 4)
      }
    }
  }

  /// Only navigate when playback actually started. Pushing the karaoke screen
  /// over silence — which is what happens when the song will not resolve, or
  /// Apple Music is not connected — is the dead end this guards.
  private func start(_ item: CatalogItem) {
    Task {
      if await music.play(item) {
        path.append(Route.karaoke)
      }
    }
  }

  // MARK: - Messages

  @ViewBuilder
  private var messages: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s2) {
      if let err = music.errorMessage {
        Label(err, systemImage: "exclamationmark.triangle.fill")
          .font(Tokens.display(Tokens.FontSize.sm, .medium))
          .foregroundStyle(Tokens.error)
      }
      if let status = music.statusMessage {
        Text(status)
          .font(Tokens.display(Tokens.FontSize.sm, .medium))
          .foregroundStyle(Tokens.text3)
      }
    }
  }
}

// MARK: - Ambient background

/// Animated backdrop for the hub. Isolated into its own view so the 30 fps
/// TimelineView loop never forces the scroll content to re-evaluate.
private struct HubAmbient: View {
  let dominant: RGB?
  @State private var epoch = Date()

  var body: some View {
    ZStack {
      TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: false)) { ctx in
        let t = ctx.date.timeIntervalSince(epoch)
        ZStack {
          // Drifting letter silhouettes — intensity: .live unlocks the sine drift
          // that intensity: .focus (the default) suppresses.
          PosterEnvironment(
            state: {
              var s = StagePresentation()
              s.motionTime = t
              return s
            }(),
            intensity: .live,
            letters: "B4",
            browsing: true
          )

          // Per-song color bloom: soft radial pulse driven by artwork accent.
          if let dom = dominant {
            let pulse = 0.5 + 0.5 * sin(t * 0.41)
            RadialGradient(
              colors: [
                Color(red: dom.r, green: dom.g, blue: dom.b)
                  .opacity(0.24 + 0.10 * pulse),
                .clear,
              ],
              center: .center,
              startRadius: 0,
              endRadius: 740
            )
          }

          // Sweeping stage spotlights — violet left, teal right.
          HubSpotlights(t: t)

          // Rising ember particles — golden-ratio distributed, some accent-tinted.
          HubParticles(t: t, dominant: dominant)
        }
      }

      // Teal floor glow — static gradient, outside the animation loop.
      LinearGradient(
        colors: [.clear, Tokens.Glass.meter.opacity(0.06)],
        startPoint: UnitPoint(x: 0.5, y: 0.6),
        endPoint: .bottom
      )
    }
    .ignoresSafeArea()
    .allowsHitTesting(false)
    .accessibilityHidden(true)
    .animation(.easeInOut(duration: 1.8), value: dominant != nil)
  }
}

// MARK: - Now-playing strip

/// Ambient bottom bar: album art, title, artist, and animated EQ bars.
/// Makes the hub a screen worth leaving on between songs.
private struct NowPlayingStrip: View {
  let track: NowPlayingTrack
  let isPlaying: Bool
  @State private var epoch = Date()

  var body: some View {
    VStack(spacing: 0) {
      Spacer()
      Rectangle().fill(Tokens.line1).frame(height: 1)
      HStack(spacing: Tokens.Space.s3) {
        CoverArt(url: track.artworkURL, side: 68, corner: Tokens.Radius.sm,
                 fallbackTint: Tokens.Glass.fieldFallback)
        VStack(alignment: .leading, spacing: 3) {
          Text(track.title)
            .font(Tokens.display(Tokens.FontSize.sm, .semibold))
            .foregroundStyle(Tokens.text1)
            .lineLimit(1)
          Text(track.artist)
            .font(Tokens.caption(18))
            .foregroundStyle(Tokens.text3)
            .lineLimit(1)
        }
        Spacer()
        TimelineView(.animation(minimumInterval: 1.0 / 20.0, paused: !isPlaying)) { ctx in
          StripEQBars(t: ctx.date.timeIntervalSince(epoch), isPlaying: isPlaying)
        }
        Image(systemName: isPlaying ? "pause.fill" : "play.fill")
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(Tokens.text3)
          .frame(width: 28)
      }
      .padding(.horizontal, Tokens.safeX)
      .padding(.vertical, 18)
      .background(Tokens.surfaceSolid1.opacity(0.92))
    }
  }
}

private struct StripEQBars: View {
  let t: Double
  let isPlaying: Bool

  private let freqs:  [Double] = [0.11, 0.23, 0.37, 0.53, 0.71]
  private let phases: [Double] = [0.00, 1.30, 2.60, 3.90, 5.20]
  private let scales: [Double] = [1.00, 0.78, 0.60, 0.48, 0.38]

  var body: some View {
    Canvas { ctx, size in
      let bW: CGFloat = 4
      let gap: CGFloat = 4
      var x = (size.width - (bW + gap) * 5 - gap) / 2
      for b in 0..<5 {
        let frac = isPlaying
          ? (0.25 + 0.75 * (0.5 + 0.5 * sin(t * freqs[b] * .pi * 2 + phases[b])) * scales[b])
          : 0.18
        let h = max(3, size.height * frac)
        ctx.fill(
          Path(roundedRect: CGRect(x: x, y: size.height - h, width: bW, height: h),
               cornerRadius: 2),
          with: .color(Tokens.accentSoft.opacity(isPlaying ? 0.80 : 0.24))
        )
        x += bW + gap
      }
    }
    .frame(width: 52, height: 34)
  }
}

// MARK: - Stage spotlights

/// Two slow-sweeping trapezoidal beams from the top — violet (brand) on the
/// left, teal (icon accent) on the right. Same technique as CinematicStageFX
/// but at lower opacity so they sit behind readable hub content.
private struct HubSpotlights: View {
  let t: Double

  var body: some View {
    Canvas(opaque: false, colorMode: .linear, rendersAsynchronously: true) { ctx, sz in
      // Beams are blurred inside an isolated layer; the horizon line is drawn
      // outside it so it stays crisp.
      ctx.drawLayer { beam in
        beam.addFilter(.blur(radius: 22))
        let sway = sin(t * 0.14) * 52

        // Left beam — violet. Gradient runs along the beam's center axis.
        var L = Path()
        L.move(to: CGPoint(x: sz.width * 0.07 + sway, y: -10))
        L.addLine(to: CGPoint(x: sz.width * 0.20 + sway, y: -10))
        L.addLine(to: CGPoint(x: sz.width * 0.56 + sway, y: sz.height))
        L.addLine(to: CGPoint(x: sz.width * 0.24 + sway, y: sz.height))
        L.closeSubpath()
        beam.fill(L, with: .linearGradient(
          Gradient(colors: [Tokens.accentStatic.opacity(0.18), .clear]),
          startPoint: CGPoint(x: sz.width * 0.13 + sway, y: 0),
          endPoint: CGPoint(x: sz.width * 0.40 + sway, y: sz.height)
        ))

        // Right beam — teal. Mirror axis.
        var R = Path()
        R.move(to: CGPoint(x: sz.width * 0.80 - sway, y: -10))
        R.addLine(to: CGPoint(x: sz.width * 0.93 - sway, y: -10))
        R.addLine(to: CGPoint(x: sz.width * 0.76 - sway, y: sz.height))
        R.addLine(to: CGPoint(x: sz.width * 0.44 - sway, y: sz.height))
        R.closeSubpath()
        beam.fill(R, with: .linearGradient(
          Gradient(colors: [Tokens.Glass.meter.opacity(0.14), .clear]),
          startPoint: CGPoint(x: sz.width * 0.87 - sway, y: 0),
          endPoint: CGPoint(x: sz.width * 0.60 - sway, y: sz.height)
        ))
      }

      // Stage floor horizon — thin teal glow at 72% height, slightly pulsing.
      let hY = sz.height * 0.725
      let horizonAlpha = 0.14 + 0.06 * sin(t * 0.21)
      ctx.drawLayer { h in
        h.addFilter(.blur(radius: 8))
        h.fill(
          Path(CGRect(x: sz.width * 0.06, y: hY - 1, width: sz.width * 0.88, height: 2)),
          with: .linearGradient(
            Gradient(colors: [.clear, Tokens.Glass.meter.opacity(horizonAlpha),
                               Tokens.Glass.meter.opacity(horizonAlpha * 1.3),
                               Tokens.Glass.meter.opacity(horizonAlpha), .clear]),
            startPoint: CGPoint(x: 0, y: hY),
            endPoint: CGPoint(x: sz.width, y: hY)
          )
        )
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

// MARK: - Particle field

/// 90 concert-ember particles rising from the stage floor. Distributed via
/// golden-ratio Halton sequence for uniform coverage without visible pattern.
/// Particles fade in off the floor and fade out as they reach the top.
private struct HubParticles: View {
  let t: Double
  let dominant: RGB?

  var body: some View {
    Canvas { ctx, sz in
      let accent = dominant.map { Color(red: $0.r, green: $0.g, blue: $0.b) }
        ?? Tokens.accentSoft

      for i in 0..<90 {
        let fi = Double(i)
        let baseX    = fmod(fi * 0.618033988749895,  1.0)
        let phase    = fmod(fi * 0.381966011250105,  1.0)
        let speed    = 0.005 + fmod(fi * 0.127,      1.0) * 0.013
        let swayAmp  = fmod(fi * 0.293,              1.0) * 0.028
        let swayFreq = 0.18 + fmod(fi * 0.157,       1.0) * 0.34
        let radius   = CGFloat(1.2 + fmod(fi * 0.235, 1.0) * 2.8)
        let baseAlpha = 0.10 + fmod(fi * 0.179,      1.0) * 0.22

        let yPct = 1.0 - fmod(phase + t * speed, 1.0)
        let xPct = baseX + swayAmp * sin(t * swayFreq + phase * .pi * 2)

        // Fade in from floor, fade out at ceiling — hides the wrap teleport.
        let fadeIn  = min(1.0, (1.0 - yPct) * 9)
        let fadeOut = min(1.0, yPct * 9)
        let alpha   = baseAlpha * fadeIn * fadeOut

        let x = sz.width  * max(0, min(1, xPct))
        let y = sz.height * yPct

        let isAccent = i % 8 == 0
        ctx.fill(
          Path(ellipseIn: CGRect(x: x - radius, y: y - radius,
                                 width: radius * 2, height: radius * 2)),
          with: .color((isAccent ? accent : Tokens.text1).opacity(alpha))
        )
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

// MARK: - Search field

/// Looks like the web hub's search input, behaves like a button.
struct TVSearchFieldStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    FieldBody(configuration: configuration)
  }

  private struct FieldBody: View {
    let configuration: Configuration
    @Environment(\.isFocused) private var focused

    var body: some View {
      configuration.label
        .foregroundStyle(focused ? Tokens.accentStatic : Tokens.text3)
        .padding(.horizontal, Tokens.Space.s4)
        .frame(height: 78)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: Tokens.Radius.lg, style: .continuous)
            .fill(focused ? Tokens.surface3 : Tokens.surface2)
        )
        .overlay(
          RoundedRectangle(cornerRadius: Tokens.Radius.lg, style: .continuous)
            .stroke(focused ? Tokens.accentStatic : Tokens.line2,
                    lineWidth: focused ? 2 : 1)
        )
        .scaleEffect(configuration.isPressed ? 0.995 : 1)
        .animation(Tokens.Motion.easeOut, value: focused)
    }
  }
}
