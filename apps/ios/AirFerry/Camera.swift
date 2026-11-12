import AVFoundation
import Vision
import CoreImage
import SwiftUI

final class Camera: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "airferry.capture")
    private var receiver = Receiver()
    private var configured = false
    private var enabled = false
    @Published var message = "点击开始，对准发送端二维码"
    @Published var running = false
    @Published var files: [URL] = []

    override init() { super.init(); refreshFiles() }

    func refreshFiles() {
        let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey])
        files = (enumerator?.allObjects as? [URL] ?? []).filter {
            (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
        }.sorted { $0.path < $1.path }
    }

    func start() {
        AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
            guard let self else { return }
            guard allowed else {
                self.update("无法访问摄像头，请在系统设置中允许 AirFerry 使用摄像头。", running: false)
                return
            }
            self.queue.async {
                do {
                    guard !self.receiver.finished else {
                        self.update("文件已接收，请先重置以接收新文件。", running: false)
                        return
                    }
                    if !self.configured { try self.configure() }
                    self.enabled = true
                    self.session.startRunning()
                    self.update("正在扫描，请保持屏幕清晰并循环播放", running: true)
                } catch { self.update(error.localizedDescription, running: false) }
            }
        }
    }

    func stop(reset: Bool = false) {
        queue.async {
            self.enabled = false
            self.session.stopRunning()
            if reset { self.receiver = Receiver() }
            self.update(reset ? "已重置，可以接收新文件" : "已暂停，进度保留", running: false)
        }
    }

    private func configure() throws {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw ReceiveError.invalid("未找到后置摄像头；模拟器请使用真机测试扫码。")
        }
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .hd1920x1080
        guard session.canAddInput(input), session.canAddOutput(output) else {
            throw ReceiveError.invalid("无法配置摄像头。")
        }
        session.addInput(input)
        session.addOutput(output)
        configured = true
    }

    private func update(_ text: String, running: Bool? = nil) {
        DispatchQueue.main.async {
            self.message = text
            if let running { self.running = running }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard enabled, !receiver.finished, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        do {
            try VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:]).perform([request])
            for result in request.results ?? [] {
                guard let descriptor = result.barcodeDescriptor as? CIQRCodeDescriptor,
                      let bytes = QRBytes.decode(descriptor.errorCorrectedPayload, version: descriptor.symbolVersion) else { continue }
                let (text, url) = try receiver.ingest(bytes)
                update(text)
                if url != nil {
                    enabled = false
                    session.stopRunning()
                    update(text, running: false)
                    DispatchQueue.main.async { self.refreshFiles() }
                    break
                }
            }
        } catch {
            enabled = false
            session.stopRunning()
            update(error.localizedDescription, running: false)
        }
    }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    final class Preview: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    }
    func makeUIView(context: Context) -> Preview {
        let view = Preview()
        let layer = view.layer as! AVCaptureVideoPreviewLayer
        layer.session = session
        layer.videoGravity = .resizeAspect
        return view
    }
    func updateUIView(_ uiView: Preview, context: Context) {}
}
