import Foundation

enum ReceiveError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let text) = self { return text }; return nil }
}

/// All methods are called on the camera's serial processing queue.
final class Receiver {
    private let outputDirectory: URL?
    init(outputDirectory: URL? = nil) { self.outputDirectory = outputDirectory }
    private var handle: UnsafeMutableRawPointer?
    private var sessionID: Data?
    private(set) var finished = false
    deinit { airferry_receiver_destroy(handle) }

    func ingest(_ frame: Data) throws -> (String, URL?) {
        let bytes = Array(frame)
        guard !finished, bytes.count >= 64, bytes[0...2].elementsEqual([0x45, 0x54, 1]),
              QRBytes.crc32(Data(bytes.dropLast(4))) == bytes.suffix(4).reduce(UInt32(0), { ($0 << 8) | UInt32($1) })
        else { return ("等待有效二维码", nil) }
        let id = Data(bytes[4..<20])
        if handle == nil {
            // Lock only to a descriptor; random/data-only QR cannot allocate a decoder.
            guard bytes[3] & 1 != 0 else { return ("等待文件描述帧，请循环播放", nil) }
            let hi = bytes[4..<12].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            let lo = bytes[12..<20].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            handle = airferry_receiver_create(lo, hi)
            sessionID = id
        }
        guard id == sessionID, let handle else { return ("正在接收其他文件；请重置后切换", nil) }
        let status = frame.withUnsafeBytes { airferry_receiver_ingest(handle, $0.bindMemory(to: UInt8.self).baseAddress, frame.count) }
        guard status >> 32 != UInt64(UInt32.max) else { return ("忽略损坏帧", nil) }
        if airferry_receiver_is_segmented(handle) != 0 {
            throw ReceiveError.invalid("此版本暂不支持分段大文件，请在发送端拆成较小的单文件后发送。")
        }
        // Conservative mobile memory ceiling, checked before decompression.
        guard airferry_receiver_file_size(handle) <= 64 * 1024 * 1024 else {
            throw ReceiveError.invalid("原始文件超过 iOS 当前 64 MiB 限额。")
        }
        let received = status >> 32
        guard status & 1 != 0 else { return ("已接收 \(received) 个符号 · 请保持对准", nil) }
        var pointer: UnsafeMutablePointer<UInt8>?
        var count = 0
        guard airferry_receiver_assemble(handle, &pointer, &count) == 1, let pointer else {
            throw ReceiveError.invalid("文件解压失败，请重置后重试。")
        }
        defer { airferry_buffer_free(pointer, count) }
        let data = Data(bytes: pointer, count: count)
        guard UInt64(count) == airferry_receiver_file_size(handle),
              airferry_receiver_crc32_known(handle) == 0 || UInt64(QRBytes.crc32(data)) == airferry_receiver_crc32(handle)
        else { throw ReceiveError.invalid("文件长度或 CRC32 校验失败，未保存文件。") }
        let size = airferry_receiver_file_name(handle, nil, 0)
        var nameBytes = [UInt8](repeating: 0, count: max(1, size))
        _ = airferry_receiver_file_name(handle, &nameBytes, nameBytes.count)
        let name = String(decoding: nameBytes.prefix { $0 != 0 }, as: UTF8.self)
        let safe = name.components(separatedBy: CharacterSet(charactersIn: "/\\:").union(.controlCharacters)).joined(separator: "_")
        let directory = try outputDirectory ?? FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        // Each reception has a unique directory; received names can never overwrite another file.
        let folder = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var shortName = String(safe.prefix(180))
        while shortName.utf8.count > 180 { shortName.removeLast() }
        let url = folder.appendingPathComponent(shortName.isEmpty || shortName == "." || shortName == ".." ? "received.bin" : shortName)
        try data.write(to: url, options: .atomic)
        finished = true
        return ("接收完成，校验通过", url)
    }
}
