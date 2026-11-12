import Foundation

/// Vision supplies corrected QR codewords, not the original binary message.
/// AirFerry uses byte mode; never round-trip arbitrary bytes through a String.
enum QRBytes {
    static func decode(_ data: Data, version: Int) -> Data? {
        guard (1...40).contains(version) else { return nil }
        let bytes = Array(data)
        var position = 0
        func read(_ count: Int) -> Int? {
            guard position + count <= bytes.count * 8 else { return nil }
            var result = 0
            for _ in 0..<count {
                result = (result << 1) | Int((bytes[position / 8] >> (7 - position % 8)) & 1)
                position += 1
            }
            return result
        }
        var output = Data()
        while let mode = read(4) {
            if mode == 0 { return output.isEmpty ? nil : output }
            if mode == 7 { // ECI assignment does not alter binary byte segments.
                guard let first = read(8) else { return nil }
                if first & 0x80 == 0 { continue }
                if first & 0xc0 == 0x80 { guard read(8) != nil else { return nil } }
                else if first & 0xe0 == 0xc0 { guard read(16) != nil else { return nil } }
                else { return nil }
                continue
            }
            guard mode == 4, let count = read(version < 10 ? 8 : 16),
                  count <= (bytes.count * 8 - position) / 8 else { return nil }
            for _ in 0..<count {
                guard let byte = read(8) else { return nil }
                output.append(UInt8(byte))
            }
        }
        return output.isEmpty ? nil : output
    }

    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xffffffff
        for byte in data {
            crc ^= UInt32(byte)
            for _ in 0..<8 { crc = (crc >> 1) ^ (crc & 1 == 1 ? 0xedb88320 : 0) }
        }
        return ~crc
    }
}
