import SwiftUI
import Bar4BarCore

struct LiveListeningPanel: View {
  @EnvironmentObject private var listening: TVListeningService
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    ZStack {
      Tokens.surface0.ignoresSafeArea()
      HStack(alignment: .center, spacing: 80) {
        VStack(alignment: .leading, spacing: 24) {
          Text("IN GOOD TIME").font(Tokens.caption(20)).tracking(4).foregroundStyle(Tokens.accentSoft)
          Text("Let the room\nfind its rhythm.").font(Tokens.editorial(68)).foregroundStyle(Tokens.text1)
          Text(listening.status.title).font(Tokens.display(28, .semibold)).foregroundStyle(Tokens.accentStatic)
            .accessibilityIdentifier("listenerStatus")
          Text(listening.detail).font(Tokens.display(24, .regular)).foregroundStyle(Tokens.text2)
          Text("Place your iPhone near the speaker. A short recording-only pass helps check the words. Singing never becomes verified recording timing.")
            .font(Tokens.display(23, .regular)).foregroundStyle(Tokens.text2).fixedSize(horizontal: false, vertical: true)
          HStack(spacing: 20) {
            Button(listening.invitation == nil ? "Connect an iPhone" : "New connection code") { listening.pair() }
            Button("Stop") { listening.stop() }
          }.buttonStyle(TVPillStyle())
          Button(listening.automatic ? "Automatic correction · On" : "Automatic correction · Off") { listening.automatic.toggle() }
            .buttonStyle(TVPillStyle()).accessibilityIdentifier("listenerAutomatic")
          HStack(spacing: 12) {
            ForEach([("en", "English"), ("hi", "Hindi"), ("es", "Spanish")], id: \.0) { code, title in
              Button(title + (listening.language == code ? " ✓" : "")) { listening.language = code }
            }
          }.buttonStyle(TVPillStyle())
          HStack(spacing: 20) {
            Button("Reset learned timings") { listening.resetLearned() }
            Button("Done") { dismiss() }
          }.buttonStyle(TVPillStyle())
        }.frame(maxWidth: 1020, alignment: .leading)
        if let value = listening.invitation {
          VStack(spacing: 24) {
            QRCode(text: value.url, side: 330)
            Text("Scan in the Bar4Bar iPhone app").font(Tokens.caption(20)).foregroundStyle(Tokens.text1)
            Text(listening.connected ? "IPHONE CONNECTED" : "CODE EXPIRES IN 10 MINUTES")
              .font(Tokens.caption(16)).tracking(2).foregroundStyle(Tokens.accentSoft)
          }.accessibilityIdentifier("listenerInvitation")
        }
      }.padding(70)
    }.onExitCommand { dismiss() }
  }
}
