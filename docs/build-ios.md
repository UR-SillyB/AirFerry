# iOS 原生接收端

`apps/ios` 使用 SwiftUI、AVFoundation 与 Vision 扫描后置摄像头中的二维码，
从 `CIQRCodeDescriptor.errorCorrectedPayload` 解析 byte-mode 原始字节，直接交给
同一 Rust `transfer-engine` C ABI。无需服务器、网页或运行期网络。
Apple 描述符 API：https://developer.apple.com/documentation/coreimage/ciqrcodedescriptor

## 构建

需要 macOS、完整 Xcode（iOS SDK）、Rust stable/rustup 和 XcodeGen：

```bash
brew install rustup xcodegen
export PATH="$(brew --prefix rustup)/bin:$HOME/.cargo/bin:$PATH"
rustup toolchain install stable --profile minimal
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
cd apps/ios
xcodegen generate
xcodebuild -project AirFerry.xcodeproj -scheme AirFerry \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Xcode pre-build 自动使用 `build-rust.sh` 编译当前源码的静态库（`--locked`、`cffi`），
分别放入 `Native/iphoneos` 或 `Native/iphonesimulator`，不提交二进制。
设备为 arm64，模拟器支持当前主机 arm64/x86_64；不生成跨架构 universal 模拟器库。
真机安装：打开生成的工程，选择自己的签名 Team 和设备后运行。未提供签名身份时只能构建未签名产物，不能直接分发 IPA。

## 使用和范围

1. 发送端选择单个文件并循环播放二维码；建议先用较低帧率、单码验证对焦。
2. iOS 点击“开始接收”并允许摄像头权限，对准完整二维码区域。
3. 符号数量实时显示；暂停保留当前内存进度，进入后台自动暂停，重置切换文件。
4. 完成后 Rust 解压（Raw/Zstd/XZ），Swift 复核精确长度与已知 CRC32，再原子保存。
5. 列表点击文件打开系统分享面板，可存储到“文件”或发送给其他 App。

当前接收单会话文件，解压后上限 **64 MiB**；分段 descriptor-v5 会明确报错，
不保存残段。多文件 ETBUNDL1 和 ETTEXTv1 容器目前作为原始容器文件保存，未实现解包 UI。
不支持进程退出后的断点恢复、视频导入、发送或后台摄像头接收。
接收文件保存在 Documents，每次接收单独 UUID 目录，不覆盖已有文件；过滤路径分隔符和控制字符。
应用不发起网络请求；用户主动分享以及系统备份受用户系统设置控制。

## 验证

```bash
# 仓库根目录
swiftc apps/ios/AirFerry/QRBytes.swift apps/ios/Tests/main.swift -o /tmp/airferry-ios-tests
/tmp/airferry-ios-tests
cargo test --locked -p transfer-engine --features cffi --test cffi_e2e
bash apps/ios/test-integration.sh
```

Swift 检查 V9/V10/V27/V40 长度位数、0x00–0xff 二进制、ECI、截断、非法模式及 CRC32 标准向量；另以 Core Image 生成 byte-mode 二维码，经 Vision 识别并验证二进制往返。
AirFerry 发送端明确使用 byte-mode；不尝试将任意数字/字母二维码当作协议帧。
`ios_fixture` 生成 Raw/Zstd/XZ 二进制流，Swift Integration 通过实际 C ABI 恢复并比较全部字节，验证长度、CRC 和路径隔离。
CI 执行上述测试并编译未签名模拟器应用。真机验收仍需实际摄像头：权限拒绝/恢复、单码与四码、
Raw/Zstd/XZ、丢帧循环、暂停/后台/恢复、重名接收、导出后比较 SHA256。
模拟器无后置摄像头会显示清晰错误，不能用模拟器编译成功代替扫码验收。
