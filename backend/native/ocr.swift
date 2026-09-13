// OCR only. No screen capture, network, temporary files, or logging of input.
import Foundation
import Vision
import ImageIO

struct TextObservation: Codable {
    let text: String
    let confidence: Float
    let box: [Double]
}
struct Result: Codable {
    let model_id: String
    let revision: Int
    let system_version: String
    let observations: [TextObservation]
}
do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty && data.count <= 20 * 1024 * 1024,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width <= 8192, height <= 8192, width * height <= 32 * 1024 * 1024 else { exit(2) }
    let request = VNRecognizeTextRequest()
    request.revision = VNRecognizeTextRequestRevision3
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US", "zh-Hans"]
    try VNImageRequestHandler(data: data).perform([request])
    var observations = (request.results ?? []).prefix(224).compactMap { r -> TextObservation? in
        guard let text = r.topCandidates(1).first else { return nil }
        let box = r.boundingBox
        return TextObservation(text: String(text.string.prefix(256)), confidence: text.confidence,
            box: [box.minX, 1 - box.maxY, box.width, box.height])
    }
    // Short Chinese toolbar labels disappear in the full-image English-first pass.
    // Use a Chinese-first pass, retaining only explicit period tokens near the top.
    if let full = CGImageSourceCreateImageAtIndex(source, 0, nil) {
        let periods = VNRecognizeTextRequest()
        periods.revision = VNRecognizeTextRequestRevision3
        periods.recognitionLevel = .accurate
        periods.usesLanguageCorrection = false
        periods.recognitionLanguages = ["zh-Hans", "en-US"]
        // Supplemental recognition must not discard a successful primary read.
        try? VNImageRequestHandler(cgImage: full).perform([periods])
        let pattern = try NSRegularExpression(pattern: #"(?<![A-Za-z0-9\p{Han}])(?:\d+\s*(?:分钟|小時|小时|分|时|時|日|天|周|週|月|[mMhHdDwW])|[日天周週月])(?![A-Za-z\p{Han}])"#)
        func appendPeriods(_ results: [VNRecognizedTextObservation], top: Double = 0, extent: Double = 1) {
            for result in results {
                guard let text = result.topCandidates(1).first else { continue }
                for match in pattern.matches(in: text.string, range: NSRange(text.string.startIndex..., in: text.string)) {
                    guard let range = Range(match.range, in: text.string),
                          let region = try? text.boundingBox(for: range) else { continue }
                    let box = region.boundingBox
                    let y = top + (1 - box.maxY) * extent
                    guard y < 0.4 else { continue }
                    observations.append(TextObservation(text: String(text.string[range]), confidence: text.confidence,
                        box: [box.minX, y, box.width, box.height * extent]))
                }
            }
        }
        appendPeriods(periods.results ?? [])
        // Discover toolbar rows from explicit period labels, then enlarge only those
        // rows. A single tiny highlighted Chinese glyph is often omitted at full size.
        let labels = observations.filter { o in
            o.box[1] < 0.4 && pattern.firstMatch(in: o.text, range: NSRange(o.text.startIndex..., in: o.text))?.range.length == (o.text as NSString).length
        }
        var processed: [Double] = []
        for label in labels {
            let center = label.box[1] + label.box[3] / 2
            let peers = labels.filter { abs($0.box[1] + $0.box[3] / 2 - center) < max($0.box[3], label.box[3]) }
            guard Set(peers.map { $0.text }).count >= 3,
                  !processed.contains(where: { abs($0 - center) < label.box[3] * 2 }) else { continue }
            processed.append(center)
            guard processed.count <= 3 else { break }
            let top = max(0, peers.map { $0.box[1] - $0.box[3] }.min() ?? 0)
            let bottom = min(0.4, peers.map { $0.box[1] + $0.box[3] * 2 }.max() ?? 0.4)
            let y = Int(top * Double(height)), end = Int(ceil(bottom * Double(height)))
            guard let crop = full.cropping(to: CGRect(x: 0, y: y, width: width, height: end - y)),
                  let context = CGContext(data: nil, width: width * 3, height: (end - y) * 3,
                    bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
            context.interpolationQuality = .high
            context.draw(crop, in: CGRect(x: 0, y: 0, width: width * 3, height: (end - y) * 3))
            guard let enlarged = context.makeImage() else { continue }
            let row = VNRecognizeTextRequest()
            row.revision = VNRecognizeTextRequestRevision3
            row.recognitionLevel = .accurate
            row.usesLanguageCorrection = false
            row.recognitionLanguages = ["zh-Hans", "en-US"]
            try? VNImageRequestHandler(cgImage: enlarged).perform([row])
            appendPeriods(row.results ?? [], top: Double(y) / Double(height), extent: Double(end - y) / Double(height))
        }

    }
    let value = Result(model_id: "apple-vision-text-r3", revision: 3,
        system_version: ProcessInfo.processInfo.operatingSystemVersionString, observations: Array(observations.prefix(256)))
    FileHandle.standardOutput.write(try JSONEncoder().encode(value))
} catch { exit(3) }
