import CoreML
import Foundation

public final class WordTimingPredictor: @unchecked Sendable {
    public static let shared = WordTimingPredictor()

    private static let maxWords  = 20
    private static let nFeatures = 16  // must match train.py N_FEATURES

    private let model: WordTimer?

    private init() {
        let config = MLModelConfiguration()
        config.computeUnits = .all
        model = try? WordTimer(configuration: config)
    }

    // MARK: - Public API

    /// - section: 0=verse/intro, 1=chorus, 3=outro (pass 0 if unknown)
    public func wordsAcrossSpan(
        tokens: [String],
        start: Double,
        end: Double,
        section: Int = 0
    ) -> [LyricWord] {
        guard let fracs = predict(tokens: tokens, start: start, end: end, section: section) else {
            return Estimate.wordsAcrossSpan(tokens: tokens, start: start, end: end)
        }
        var words: [LyricWord] = []
        var cursor = start
        let span = end - start
        for (i, text) in tokens.enumerated() {
            let wordStart = cursor
            cursor += fracs[i] * span
            let wordEnd = i + 1 < tokens.count ? cursor : end
            words.append(LyricWord(text: text, start: wordStart, end: wordEnd,
                                   timingQuality: .estimated))
        }
        return words
    }

    // MARK: - Private

    private static let vowels = CharacterSet(charactersIn: "aeiouyàáâäãåèéêëìíîïòóôöõùúûüỳýŷÿ")
    private static let punct  = CharacterSet(charactersIn: ".,!?;:")
    private static let cjkRanges: [(Int, Int)] = [
        (0x3040, 0x9FFF), (0xAC00, 0xD7FF), (0xF900, 0xFAFF)
    ]
    // Devanagari U+0900-U+097F + Gurmukhi (Punjabi) U+0A00-U+0A7F
    private static let indicRange: (Int, Int) = (0x0900, 0x0A7F)

    private static func vowelRatio(_ text: String) -> Double {
        let letters = text.lowercased().unicodeScalars.filter { CharacterSet.letters.contains($0) }
        guard !letters.isEmpty else { return 0 }
        let v = letters.filter { vowels.contains($0) }.count
        return Double(v) / Double(letters.count)
    }

    private static func consonantClusterScore(_ text: String) -> Double {
        let w = text.lowercased()
        var clusterLen = 0
        var totalCluster = 0
        for scalar in w.unicodeScalars {
            let c = Character(scalar)
            if c.isLetter && !vowels.contains(scalar) {
                clusterLen += 1
            } else {
                totalCluster += clusterLen
                clusterLen = 0
            }
        }
        totalCluster += clusterLen
        return min(Double(totalCluster) / 3.0, 1.0)
    }

    private static func isCJK(_ text: String) -> Bool {
        text.unicodeScalars.contains { s in
            let v = Int(s.value)
            return cjkRanges.contains { v >= $0.0 && v <= $0.1 }
        }
    }

    private static func isIndic(_ text: String) -> Bool {
        text.unicodeScalars.contains {
            let v = Int($0.value)
            return v >= indicRange.0 && v <= indicRange.1
        }
    }

    private func predict(tokens: [String], start: Double, end: Double, section: Int) -> [Double]? {
        guard let model, tokens.count >= 2, tokens.count <= Self.maxWords else { return nil }
        let n       = tokens.count
        let lineDur = end - start
        guard lineDur > 0.4 else { return nil }

        let syls     = tokens.map { Estimate.syllableCount($0) }
        let totalSyl = max(1, syls.reduce(0, +))
        let singRate = Double(totalSyl) / lineDur

        let featShape: [NSNumber] = [1, NSNumber(value: Self.maxWords), NSNumber(value: Self.nFeatures)]
        let maskShape: [NSNumber] = [1, NSNumber(value: Self.maxWords)]
        guard let featArr = try? MLMultiArray(shape: featShape, dataType: .float32),
              let maskArr = try? MLMultiArray(shape: maskShape, dataType: .float32) else {
            return nil
        }

        let lowerCounts = tokens.reduce(into: [String: Int]()) { d, t in
            d[t.lowercased(), default: 0] += 1
        }

        for i in 0..<n {
            let syl      = syls[i]
            let text     = tokens[i]
            let posFrac  = n > 1 ? Double(i) / Double(n - 1) : 0.0
            let hasPunct = text.unicodeScalars.last.map { Self.punct.contains($0) } ?? false
            let repeated = (lowerCounts[text.lowercased()] ?? 0) > 1

            let base = i * Self.nFeatures
            featArr[base + 0]  = NSNumber(value: min(Double(syl) / 5.0, 1.0))
            featArr[base + 1]  = NSNumber(value: min(Double(text.count) / 12.0, 1.0))
            featArr[base + 2]  = NSNumber(value: posFrac)
            featArr[base + 3]  = NSNumber(value: Double(syl) / Double(totalSyl))
            featArr[base + 4]  = NSNumber(value: i == 0 ? 1.0 : 0.0)
            featArr[base + 5]  = NSNumber(value: i == n - 1 ? 1.0 : 0.0)
            featArr[base + 6]  = NSNumber(value: hasPunct ? 1.0 : 0.0)
            featArr[base + 7]  = NSNumber(value: min(singRate / 8.0, 1.0))
            featArr[base + 8]  = NSNumber(value: min(Double(n) / 15.0, 1.0))
            featArr[base + 9]  = NSNumber(value: min(lineDur / 8.0, 1.0))
            featArr[base + 10] = NSNumber(value: repeated ? 1.0 : 0.0)
            featArr[base + 11] = NSNumber(value: Double(section) / 3.0)
            featArr[base + 12] = NSNumber(value: Self.vowelRatio(text))
            featArr[base + 13] = NSNumber(value: Self.consonantClusterScore(text))
            featArr[base + 14] = NSNumber(value: posFrac * posFrac)
            featArr[base + 15] = NSNumber(value: Self.isCJK(text) ? 1.0 : 0.0)
            maskArr[i]         = 1.0
        }

        let input = WordTimerInput(features: featArr, mask: maskArr)
        guard let out = try? model.prediction(input: input) else { return nil }

        let fracArr = out.fractions
        var fracs   = (0..<n).map { Double(truncating: fracArr[$0]) }
        let sum     = fracs.reduce(0, +)
        guard sum > 0 else { return nil }
        fracs = fracs.map { $0 / sum }
        return fracs
    }
}
