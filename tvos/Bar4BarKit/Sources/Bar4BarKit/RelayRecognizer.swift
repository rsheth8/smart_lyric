// The SongRecognizer the Apple TV actually uses: post room audio to the relay's
// /api/identify and let it talk to ACRCloud.
//
// The app deliberately holds no recognition credentials. Anything inside an app
// bundle is readable, so the signing happens server-side (lib/acrcloud.mjs) and
// this only ever sees WAV in, match out.

import Foundation

public struct RelayRecognizer: SongRecognizer {
  public enum Failure: Error, Equatable {
    /// The relay has no ACRCloud credentials — listening can't work at all, as
    /// opposed to a match simply not being found.
    case notConfigured
    case service(Int)
  }

  private let endpoint: URL
  private let timeout: TimeInterval
  private let session: URLSession

  public init(base: URL = Companion.base, timeout: TimeInterval = 10, session: URLSession = .shared) {
    self.endpoint = URL(string: "\(base.absoluteString)/api/identify")!
    self.timeout = timeout
    self.session = session
  }

  public func identify(_ wav: Data) async throws -> Recognition? {
    var req = URLRequest(url: endpoint, timeoutInterval: timeout)
    req.httpMethod = "POST"
    req.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
    req.setValue("Bar4Bar tvOS (https://smartlyric.vercel.app)", forHTTPHeaderField: "User-Agent")
    req.httpBody = wav

    let (data, response) = try await session.upload(for: req, from: wav)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 503 { throw Failure.notConfigured }
    guard status == 200 else { throw Failure.service(status) }
    return Self.decode(data)
  }

  /// `{"match": {...}}` → Recognition, `{"match": null}` → nil (a clean miss).
  /// Kept separate from the request so it can be tested without a network.
  static func decode(_ data: Data) -> Recognition? {
    guard
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let m = root["match"] as? [String: Any],
      let id = m["recordingId"] as? String
    else { return nil }

    return Recognition(
      recordingId: id,
      title: m["title"] as? String ?? "",
      artist: m["artist"] as? String ?? "",
      album: m["album"] as? String,
      durationSec: m["durationSec"] as? Double,
      offsetSec: m["offsetSec"] as? Double,
      score: m["score"] as? Double
    )
  }
}
