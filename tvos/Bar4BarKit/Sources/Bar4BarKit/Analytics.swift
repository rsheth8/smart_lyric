// Anonymous funnel counters, same endpoint and allowlist as app/analytics.js.

import Foundation

public enum Analytics {
  /// Fire-and-forget; never blocks or throws into the UI.
  public static func track(_ name: String, _ data: [String: String] = [:]) {
    var req = URLRequest(url: Companion.base.appendingPathComponent("api/event"))
    req.httpMethod = "POST"
    req.setValue("text/plain", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name, "data": data])
    URLSession.shared.dataTask(with: req).resume()
  }

  public static func waitBucket(seconds: Double) -> String {
    seconds < 2 ? "<2s" : seconds < 10 ? "2-10s" : seconds < 30 ? "10-30s" : ">30s"
  }

  public static func sungBucket(_ fraction: Double) -> String {
    fraction < 0.25 ? "<25%" : fraction <= 0.75 ? "25-75%" : ">75%"
  }
}
