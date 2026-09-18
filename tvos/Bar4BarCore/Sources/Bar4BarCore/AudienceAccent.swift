/// Presentation-only audience input. Repeated inputs during an accent coalesce;
/// neither this clock nor its sequence touches song timing or role assignment.
public struct AudienceAccent: Equatable, Sendable {
  public private(set) var startedAt: Double?
  public private(set) var sequence: UInt64 = 0
  public static let duration = 1.2
  public init() {}
  @discardableResult public mutating func cheer(at time: Double) -> Bool {
    guard time.isFinite, !isActive(at: time) else { return false }
    startedAt = time
    sequence &+= 1
    return true
  }
  public func isActive(at time: Double) -> Bool {
    guard let start = startedAt else { return false }
    return time >= start && time - start < Self.duration
  }
  public func amount(at time: Double) -> Double {
    guard isActive(at: time), let start = startedAt else { return 0 }
    let age = time - start
    return age < 0.2 ? age / 0.2 : max(0, 1 - (age - 0.2))
  }
  public mutating func clear() { startedAt = nil }
}
