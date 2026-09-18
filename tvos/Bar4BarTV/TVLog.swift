import Foundation
import OSLog
import Combine

/// Last prep / queue lines, for Settings. Also written to the unified log
/// (`subsystem:com.bar4bar.tv`) so Console.app on this Mac can show them:
/// select the Bedroom Apple TV, Action → Include Info Messages, search `bar4bar`.
@MainActor
final class TVLogStore: ObservableObject {
  static let shared = TVLogStore()
  @Published private(set) var lines: [String] = []

  func add(_ message: String) {
    let stamp = Date.now.formatted(date: .omitted, time: .standard)
    lines.append("\(stamp)  \(message)")
    if lines.count > 16 { lines.removeFirst(lines.count - 16) }
  }
}

enum TVLog {
  private static let prepLog = Logger(subsystem: "com.bar4bar.tv", category: "prep")
  private static let spotifyLog = Logger(subsystem: "com.bar4bar.tv", category: "spotify")

  static func prep(_ message: String) {
    prepLog.notice("\(message, privacy: .public)")
    Task { @MainActor in TVLogStore.shared.add(message) }
  }

  static func spotify(_ message: String) {
    spotifyLog.notice("\(message, privacy: .public)")
    Task { @MainActor in TVLogStore.shared.add(message) }
  }
}
