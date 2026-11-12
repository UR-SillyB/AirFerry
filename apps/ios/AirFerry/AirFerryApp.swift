import SwiftUI

@main
struct AirFerryApp: App {
    var body: some Scene { WindowGroup { ReceiveView() } }
}

struct ReceiveView: View {
    @StateObject private var camera = Camera()
    @Environment(\.scenePhase) private var phase
    var body: some View {
        NavigationStack {
            List {
                Section {
                    CameraPreview(session: camera.session)
                        .frame(height: 300).listRowInsets(EdgeInsets())
                        .accessibilityLabel("二维码摄像头预览")
                    Label(camera.message, systemImage: camera.running ? "qrcode.viewfinder" : "info.circle")
                        .accessibilityIdentifier("receiveStatus")
                    HStack {
                        Button(camera.running ? "暂停" : "开始接收") {
                            if camera.running { camera.stop() } else { camera.start() }
                        }.buttonStyle(.borderedProminent)
                        Button("重置") { camera.stop(reset: true) }.buttonStyle(.bordered)
                    }
                } header: { Text("离线接收") } footer: {
                    Text("在电脑上播放 AirFerry 二维码视频，将后置摄像头对准屏幕。暂停后可继续；切换文件请重置。当前支持单会话文件，原始文件限 64 MiB，暂不支持分段传输。")
                }
                Section("已接收文件（\(camera.files.count)）") {
                    if camera.files.isEmpty { Text("接收完成的文件会保存在这里").foregroundStyle(.secondary) }
                    ForEach(camera.files, id: \.self) { url in
                        ShareLink(item: url) {
                            Label(url.lastPathComponent, systemImage: "square.and.arrow.up")
                        }
                    }
                }
            }
            .navigationTitle("AirFerry")
            .onChange(of: phase) { value in
                if value != .active { camera.stop() }
            }
            .onChange(of: camera.running) { value in UIApplication.shared.isIdleTimerDisabled = value }
        }
    }
}
