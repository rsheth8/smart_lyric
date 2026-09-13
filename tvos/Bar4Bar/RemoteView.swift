import Bar4BarKit
import CoreImage.CIFilterBuiltins
import SwiftUI

/// Pair a phone: scan the code, and the web companion page becomes the remote.
struct RemoteView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let url = Companion.phoneURL(room: model.room)
    HStack(spacing: 96) {
      QRCode(text: url.absoluteString)
        .frame(width: 440, height: 440)
        .padding(32)
        .background(.white, in: RoundedRectangle(cornerRadius: 36, style: .continuous))
      VStack(alignment: .leading, spacing: 26) {
        Text("Your phone is the remote")
          .font(.system(size: 64, weight: .bold))
        Text("Scan with your phone’s camera to search with a real keyboard, queue songs and fix the timing. Everyone in the room can join.")
          .font(.title3)
          .foregroundStyle(.secondary)
        HStack(spacing: 20) {
          Text("Room").foregroundStyle(.secondary)
          Text(model.room).font(.system(size: 52, weight: .semibold, design: .monospaced)).tracking(8)
        }
        .padding(.top, 12)
        Label(status, systemImage: model.phoneSeen ? "checkmark.circle.fill" : "iphone")
          .font(.headline)
          .foregroundStyle(model.phoneSeen ? Theme.accent : .secondary)
        if !model.queue.isEmpty {
          Text("\(model.queue.count) song\(model.queue.count == 1 ? "" : "s") queued · next: \(model.queue[0].track)")
            .font(.callout).foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: 900, alignment: .leading)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background { Backdrop(url: model.recent.first?.artwork) }
  }

  private var status: String {
    if model.guests.isEmpty { return model.phoneSeen ? "Phone connected" : "Waiting for a phone…" }
    return "\(model.guests.joined(separator: ", ")) connected"
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
