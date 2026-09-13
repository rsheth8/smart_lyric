import Bar4BarKit
import CoreImage.CIFilterBuiltins
import SwiftUI

/// Pair a phone: scan the code, and the web companion page becomes the remote.
struct RemoteView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let url = Companion.phoneURL(room: model.room)
    HStack(spacing: 110) {
      QRCode(text: url.absoluteString)
        .frame(width: 420, height: 420)
        .padding(34)
        .background(.white, in: RoundedRectangle(cornerRadius: 40, style: .continuous))
        .shadow(color: Theme.accent.opacity(model.phoneSeen ? 0.45 : 0.18), radius: 60)
      VStack(alignment: .leading, spacing: 30) {
        Text("Your phone is the remote")
          .font(.system(size: 64, weight: .bold))
        Text("Scan with your phone’s camera to search with a real keyboard, queue songs and fix the timing. Everyone in the room can join.")
          .font(.title3)
          .foregroundStyle(.secondary)
        RoomCode(code: model.room)
        HStack(spacing: 18) {
          PulseDot(live: model.phoneSeen)
          Text(model.phoneSeen ? "Connected" : "Waiting for a phone…")
            .font(.headline)
            .foregroundStyle(model.phoneSeen ? Theme.accent : .secondary)
            .contentTransition(.opacity)
        }
        if !model.guests.isEmpty {
          HStack(spacing: 16) {
            ForEach(model.guests, id: \.self) { name in
              GuestChip(name: name).transition(.scale(scale: 0.6).combined(with: .opacity))
            }
          }
        }
        if let next = model.queue.first {
          Text("\(model.queue.count) queued · next up: \(next.track)")
            .font(.callout).foregroundStyle(.secondary)
            .transition(.opacity)
        }
      }
      .frame(maxWidth: 900, alignment: .leading)
      .animation(Motion.snappy, value: model.guests)
      .animation(Motion.snappy, value: model.phoneSeen)
      .animation(Motion.glide, value: model.queue.first?.id)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background { Backdrop(url: model.recent.first?.artwork ?? model.chart.first?.artwork) }
  }
}

/// The room code as tiles, split 4 + 4 so it reads aloud easily.
struct RoomCode: View {
  let code: String

  var body: some View {
    let letters = Array(code)
    HStack(spacing: 10) {
      ForEach(letters.indices, id: \.self) { i in
        Text(String(letters[i]))
          .font(.system(size: 46, weight: .semibold, design: .rounded))
          .frame(width: 66, height: 86)
          .glass(RoundedRectangle(cornerRadius: 16, style: .continuous))
          .padding(.leading, i == 4 ? 22 : 0)
      }
    }
  }
}

struct PulseDot: View {
  let live: Bool
  @State private var pulse = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let color = live ? Theme.accent : Color.white.opacity(0.6)
    Circle()
      .fill(color)
      .frame(width: 16, height: 16)
      .background {
        Circle().stroke(color, lineWidth: 2)
          .scaleEffect(pulse ? 2.8 : 1)
          .opacity(pulse ? 0 : 0.7)
      }
      .onAppear {
        guard !reduceMotion else { return }
        withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { pulse = true }
      }
  }
}

struct GuestChip: View {
  let name: String

  var body: some View {
    HStack(spacing: 12) {
      Text(String(name.prefix(1)).uppercased())
        .font(.callout.weight(.bold))
        .foregroundStyle(Theme.ink)
        .frame(width: 44, height: 44)
        .background(Theme.accent, in: Circle())
      Text(name).font(.callout.weight(.semibold))
    }
    .padding(.leading, 8)
    .padding(.trailing, 22)
    .padding(.vertical, 8)
    .glass(Capsule())
  }
}

struct QRCode: View {
  private let image: CGImage?

  init(text: String) {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    image = filter.outputImage.flatMap { CIContext().createCGImage($0, from: $0.extent) }
  }

  var body: some View {
    if let image {
      Image(decorative: image, scale: 1).interpolation(.none).resizable().scaledToFit()
    }
  }
}
