import SwiftUI
import Bar4BarCore

/// "Connect Spotify" on a device with no browser and no keyboard worth using.
///
/// The whole screen exists to communicate two strings — a URL and a six
/// character code — to someone holding a phone ten feet away, so those two
/// strings get the type budget and everything else gets out of the way.
struct SpotifyPairingView: View {
  @EnvironmentObject private var music: MusicPlayerService
  @EnvironmentObject private var spotify: SpotifyService
  @EnvironmentObject private var session: LyricsSession
  @Binding var path: NavigationPath

  var body: some View {
    ZStack {
      AmbientBackdrop(accent: session.accent.glow, intensity: 0.5)

      VStack(alignment: .leading, spacing: Tokens.Space.s5) {
        header
        content
        Spacer(minLength: 0)
      }
      .padding(.horizontal, Tokens.safeX)
      .padding(.vertical, Tokens.safeY)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .task {
      if let code = DemoLaunch.fakePairCode {
        spotify.showPlaceholderPairing(code: code)
      } else if !spotify.isConnected {
        await spotify.connect()
      }
    }
    .onDisappear {
      // Leaving the screen abandons an unfinished handshake. Letting the poll
      // loop run on in the background would keep a dead code alive and then
      // "connect" minutes later, on some other screen, with no explanation.
      if !spotify.isConnected { spotify.cancelPairing() }
    }
    .onChange(of: spotify.track?.id) { _, _ in presentFollowKaraokeIfNeeded() }
    .onChange(of: spotify.isPlaying) { _, playing in
      if playing { presentFollowKaraokeIfNeeded() }
    }
  }

  private func presentFollowKaraokeIfNeeded() {
    guard PlaybackNavigation.shouldOpenFollowKaraoke(
      connected: spotify.isConnected,
      hasTrack: spotify.track != nil,
      isPlaying: spotify.isPlaying
    ) else { return }
    if let track = spotify.track, let clock = spotify.followClock {
      music.beginFollowing(clock, track: track, sourceLabel: "Spotify")
    }
    path = NavigationPath()
    path.append(Route.karaoke)
  }

  private var header: some View {
    TVPageHeading(title: "Spotify", subtitle: "Play on your phone or speaker. Pause, skip, and follow every word on this TV.")
  }

  @ViewBuilder
  private var content: some View {
    switch spotify.state {
    case .disconnected:
      idle
    case .connecting:
      HStack(spacing: Tokens.Space.s3) {
        ProgressView().tint(Tokens.accentStatic).scaleEffect(1.4)
        Text("Getting a code…")
          .font(Tokens.display(Tokens.FontSize.md, .medium))
          .foregroundStyle(Tokens.text2)
      }
    case .pairing(let code, let verifyURL):
      pairingSteps(code: code, verifyURL: verifyURL, scanURL: spotify.scanURL)
    case .connected:
      connected
    case .failed(let message):
      failure(message)
    }
  }

  // MARK: - States

  private var idle: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s4) {
      Text("You'll enter a short code on your phone — Spotify's sign-in happens there, not here.")
        .font(Tokens.display(Tokens.FontSize.base, .regular))
        .foregroundStyle(Tokens.text3)
      HStack(spacing: Tokens.Space.s3) {
        Button("Get a code") { spotify.startPairing() }
          .buttonStyle(TVPillStyle())
        Button("Back") { path.removeLast() }
          .buttonStyle(TVPillStyle())
      }
    }
  }

  /// Scan first, type second.
  ///
  /// Reading a URL off a television and typing it into a phone is the step
  /// pairing flows lose people at — it lost the first person who tried this
  /// one. The QR code goes straight to Spotify's consent screen with the code
  /// already applied, so the happy path involves no transcription at all. The
  /// written URL and code stay for anyone without a camera to hand.
  private func pairingSteps(code: String, verifyURL: String, scanURL: String?) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s4) {
      HStack(alignment: .center, spacing: Tokens.Space.s6) {
        if let scanURL {
          HStack(spacing: Tokens.Space.s4) {
            QRCode(text: scanURL, side: 240)
            VStack(alignment: .leading, spacing: Tokens.Space.s2) {
              Text("Point your camera here")
                .font(Tokens.display(Tokens.FontSize.md, .semibold))
                .foregroundStyle(Tokens.text1)
              Text("Takes you straight to Spotify")
                .font(Tokens.display(Tokens.FontSize.base, .regular))
                .foregroundStyle(Tokens.text2)
            }
          }

          Rectangle()
            .fill(Tokens.line1)
            .frame(width: 1, height: 190)

          VStack(alignment: .leading, spacing: Tokens.Space.s3) {
            Text("Or type it")
              .font(Tokens.display(Tokens.FontSize.sm, .semibold))
              .tracking(1.6)
              .foregroundStyle(Tokens.text3)
            Text(verifyURL)
              .font(Tokens.display(Tokens.FontSize.md, .semibold))
              .foregroundStyle(Tokens.accentStatic)
            Text(code)
              // Monospaced so the character cells line up: a proportional face
              // makes a code that has to be transcribed harder to read back.
              .font(.system(size: Tokens.FontSize.xl, weight: .bold, design: .monospaced))
              .tracking(6)
              .foregroundStyle(Tokens.text1)
          }
        } else {
          // A deployment predating `scanURL`. Still pairs, just by typing.
          step(number: 1, title: "On your phone, open") {
            Text(verifyURL)
              .font(Tokens.display(Tokens.FontSize.lg, .semibold))
              .foregroundStyle(Tokens.accentStatic)
          }
          step(number: 2, title: "Enter this code") {
            Text(code)
              .font(.system(size: Tokens.FontSize.xxl, weight: .bold, design: .monospaced))
              .tracking(6)
              .foregroundStyle(Tokens.text1)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(Tokens.Space.s5)
      .frame(maxWidth: 1400, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: Tokens.Radius.xxl, style: .continuous)
          .fill(Tokens.surface1)
      )
      .overlay(
        RoundedRectangle(cornerRadius: Tokens.Radius.xxl, style: .continuous)
          .stroke(Tokens.line1, lineWidth: 1)
      )

      HStack(spacing: Tokens.Space.s3) {
        ProgressView().tint(Tokens.accentStatic)
        Text("Waiting for you to finish on your phone…")
          .font(Tokens.display(Tokens.FontSize.sm, .medium))
          .foregroundStyle(Tokens.text3)
      }

      if let warning = spotify.storeWarning {
        Label(warning, systemImage: "exclamationmark.triangle.fill")
          .font(Tokens.display(Tokens.FontSize.sm, .medium))
          .foregroundStyle(Tokens.warn)
          .frame(maxWidth: 1100, alignment: .leading)
      }

      Button("Cancel") {
        spotify.cancelPairing()
        path.removeLast()
      }
      .buttonStyle(TVPillStyle())
    }
  }

  private func step<Content: View>(
    number: Int,
    title: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    HStack(alignment: .top, spacing: Tokens.Space.s3) {
      Text("\(number)")
        .font(Tokens.display(Tokens.FontSize.md, .bold))
        .foregroundStyle(Tokens.accentInk)
        .frame(width: 52, height: 52)
        .background(Tokens.accentStatic, in: Circle())
      VStack(alignment: .leading, spacing: Tokens.Space.s2) {
        Text(title)
          .font(Tokens.display(Tokens.FontSize.base, .medium))
          .foregroundStyle(Tokens.text2)
        content()
      }
    }
  }

  private var connected: some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s4) {
      HStack(spacing: Tokens.Space.s3) {
        Image(systemName: "checkmark.circle.fill")
          .font(.system(size: Tokens.FontSize.lg))
          .foregroundStyle(Tokens.ok)
        VStack(alignment: .leading, spacing: 2) {
          Text("Spotify connected")
            .font(Tokens.display(Tokens.FontSize.md, .semibold))
            .foregroundStyle(Tokens.text1)
          Text(spotify.track.map { "Following “\($0.title)”" }
               ?? "Start something playing on Spotify and the words will follow.")
            .font(Tokens.display(Tokens.FontSize.base, .regular))
            .foregroundStyle(Tokens.text2)
        }
      }
      if let message = spotify.connectionMessage {
        Text(message).font(Tokens.display(24, .medium)).foregroundStyle(Tokens.warn)
      }
      HStack(spacing: Tokens.Space.s3) {
        if spotify.track != nil {
          Button("Show the lyrics") {
            if let track = spotify.track, let clock = spotify.followClock {
              music.beginFollowing(clock, track: track, sourceLabel: "Spotify")
            }
            path.append(Route.karaoke)
          }
            .buttonStyle(TVPillStyle())
        }
        Button("Back to hub") { path = NavigationPath() }
          .buttonStyle(TVPillStyle())
        Button("Disconnect") { spotify.disconnect() }
          .buttonStyle(TVPillStyle(tint: Tokens.ember))
      }
    }
  }

  private func failure(_ message: String) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Space.s4) {
      Label(message, systemImage: "exclamationmark.triangle.fill")
        .font(Tokens.display(Tokens.FontSize.base, .medium))
        .foregroundStyle(Tokens.ember)
        .frame(maxWidth: 1100, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: Tokens.Space.s3) {
        Button("Try again") { spotify.startPairing() }
          .buttonStyle(TVPillStyle())
        Button("Back") { path.removeLast() }
          .buttonStyle(TVPillStyle())
      }
    }
  }
}
