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
    let observations = (request.results ?? []).prefix(256).compactMap { r -> TextObservation? in
        guard let text = r.topCandidates(1).first else { return nil }
        let box = r.boundingBox
        return TextObservation(text: String(text.string.prefix(256)), confidence: text.confidence,
            box: [box.minX, 1 - box.maxY, box.width, box.height])
    }
    let value = Result(model_id: "apple-vision-text-r3", revision: 3,
        system_version: ProcessInfo.processInfo.operatingSystemVersionString, observations: observations)
    FileHandle.standardOutput.write(try JSONEncoder().encode(value))
} catch { exit(3) }
