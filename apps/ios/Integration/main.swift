import Foundation
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let expected = try Data(contentsOf: root.appendingPathComponent("expected.bin"))
for algorithm in 0...2 {
    let receiver = Receiver(outputDirectory: root)
    let frames = [UInt8](try Data(contentsOf: root.appendingPathComponent("\(algorithm).frames")))
    var offset = 0
    var recovered: URL?
    while offset < frames.count && recovered == nil {
        let length = frames[offset..<offset+4].reduce(0) { ($0 << 8) | Int($1) }
        offset += 4
        let frame = Data(frames[offset..<offset+length]); offset += length
        let (_, url) = try receiver.ingest(frame)
        recovered = url
    }
    precondition(recovered != nil)
    let actual = try Data(contentsOf: recovered!)
    precondition(actual == expected)
    precondition(recovered!.deletingLastPathComponent().deletingLastPathComponent() == root)
    print("Swift → Rust → recovery + length/CRC + safe export passed: algorithm \(algorithm)")
}
