import Foundation

func codewords(_ bytes: [UInt8], version: Int, eci: Bool = false) -> Data {
    var bits = eci ? "011100011010" : ""
    func add(_ value: Int, _ width: Int) {
        bits += String(repeating: "0", count: width - String(value, radix: 2).count) + String(value, radix: 2)
    }
    add(4, 4); add(bytes.count, version < 10 ? 8 : 16)
    for byte in bytes { add(Int(byte), 8) }
    bits += "0000"
    while bits.count % 8 != 0 { bits += "0" }
    let chars = Array(bits)
    return Data(stride(from: 0, to: chars.count, by: 8).map { UInt8(String(chars[$0..<$0+8]), radix: 2)! })
}
let binary = Array(UInt8.min...UInt8.max)
for version in [9, 10, 27, 40] {
    let payload = version < 10 ? Array(binary.prefix(255)) : binary
    precondition(QRBytes.decode(codewords(payload, version: version), version: version) == Data(payload))
    precondition(QRBytes.decode(codewords(payload, version: version, eci: true), version: version) == Data(payload))
}
precondition(QRBytes.decode(Data([0x40, 0xff]), version: 1) == nil)
precondition(QRBytes.decode(Data([0x10, 0]), version: 1) == nil)
precondition(QRBytes.decode(Data(), version: 41) == nil)
precondition(QRBytes.crc32(Data("123456789".utf8)) == 0xcbf43926)
print("QR binary, ECI, truncation, unsupported-mode and CRC32 tests passed")

#if canImport(Vision)
import Vision
import CoreImage
import CoreImage.CIFilterBuiltins
let filter = CIFilter.qrCodeGenerator()
let visionPayload = Data(binary.flatMap { [$0, 0x80] }) // Prevent CI numeric/alphanumeric optimization.
filter.message = visionPayload
filter.correctionLevel = "L"
let image = filter.outputImage!.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
let cgImage = CIContext().createCGImage(image, from: image.extent)!
let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
let descriptor = request.results!.first!.barcodeDescriptor as! CIQRCodeDescriptor
precondition(QRBytes.decode(descriptor.errorCorrectedPayload, version: descriptor.symbolVersion) == visionPayload)
print("Core Image → Vision → binary QR round-trip passed")
#endif
