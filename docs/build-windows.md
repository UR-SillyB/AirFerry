# Windows 端构建指南

> Windows 扫码接收端（C# WPF + Rust DLL）。功能与 Android 端一致，并新增**设备选择**（摄像头或采集卡）。

---

## 1. 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| UI | WPF (.NET 8, C#) | 对标 Android Compose UI |
| 相机/采集卡 | OpenCvSharp4 (DirectShow 后端) | 摄像头与采集卡在 DirectShow 下同类，统一枚举 |
| 设备枚举 | DirectShowLib (DsDevice) | `FilterCategory.VideoInputDevice` 同时覆盖摄像头+采集卡 |
| QR 解码 | ZXing.Net (TryHarder/TryInvert) | 对标 Android ZXing-C++ (`scan_jni.cpp`) |
| 核心引擎 | Rust `transfer-engine` (C ABI, `--features cffi`) | 编解码逻辑与 Android/WASM 共享，编译为 `transfer_engine.dll` |
| MVVM | CommunityToolkit.Mvvm | ObservableObject / RelayCommand 源生成器 |

**关键不变量**：Rust 编解码逻辑（`raptorq-core` / `qr-protocol` / `transfer-engine` 纯逻辑部分）**零改动**——已天然跨平台。Windows 端只新增一个薄 C ABI 适配层（`core/transfer-engine/src/cffi.rs`），对标 Android 的 `jni.rs`。

---

## 2. 环境要求

| 工具 | 版本 | 说明 |
|------|------|------|
| Windows | 10 (10.0.17763+) / 11 | DirectShow/Media Foundation 仅桌面版 Windows 有 |
| .NET SDK | 8.0+ | WPF 需要 `net8.0-windows` TFM |
| Rust | 1.75+ (stable) | 默认 `x86_64-pc-windows-msvc` target（`rustup` 默认安装） |
| CMake | 不需要 | Windows 端不编译 ZXing-C++（改用纯 C# 的 ZXing.Net） |

验证：
```powershell
dotnet --version          # ≥ 8.0
rustc --version           # ≥ 1.75
rustup target list --installed   # 应含 stable-x86_64-pc-windows-msvc（默认即有）
```

---

## 3. 一键构建（PowerShell，首选）

```powershell
# 构建（Debug/Release 配置）
.\scripts\build-windows.ps1

# 构建 + 打包到 dist/（发布用 zip）
.\scripts\build-windows.ps1 -Pack
```

脚本流程：
1. `cargo build -p transfer-engine --features cffi --release` → `target/release/transfer_engine.dll`
2. 拷贝 DLL 到 `apps/windows/AirFerry.Windows/runtime/transfer_engine.dll`
3. `dotnet restore` + `dotnet build -c Release`（或 `-Pack` 时 `dotnet publish`）
4. （`-Pack` 时）压缩发布目录到 `dist/airferry-windows-x64-v{VER}.zip`

> 也可以用 bash 入口（Git Bash/WSL 下）：`./scripts/build-all.sh windows`。逻辑等价，但 PowerShell 是 Windows 上的首选。

---

## 4. 手动分步构建

### 4.1 编译 Rust C ABI DLL

```powershell
cargo build -p transfer-engine --features cffi --release
# 产物: target/release/transfer_engine.dll
```

> **必须先于 C# 构建**：csproj 把 `runtime/transfer_engine.dll` 标为 `CopyToOutputDirectory=PreserveNewest`。若 DLL 缺失，运行时第一个 P/Invoke 调用会抛 `DllNotFoundException`（对标 Android `jniLibs` 缺 `.so` 的 `UnsatisfiedLinkError`）。

### 4.2 构建 C# WPF

```powershell
cd apps\windows
dotnet restore
dotnet build -c Release
# 产物: AirFerry.Windows\bin\x64\Release\net8.0-windows\AirFerry.exe
```

### 4.3 运行

```powershell
dotnet run --project AirFerry.Windows -c Release
# 或直接双击 AirFerry.exe
```

---

## 5. 关键依赖顺序（坑）

1. **Rust DLL 必须先于 C# 构建**：见 §4.1 注释。走 `build-windows.ps1` 会自动先跑 cargo。
2. **WPF 只能在 Windows 上构建**：`net8.0-windows` TFM 依赖 Windows SDK，无法在 macOS/Linux 上编译 C# 主项目。**协议层单元测试**（`AirFerry.Windows.Tests`）用纯 `net8.0` TFM，可在任何 OS 上跑（不依赖 P/Invoke，只测 IngestStatus 位域、FrameHeader 解析、BundleParser 等纯逻辑）。
3. **版本号四同步**：改版本时同时改 `apps/sender/package.json`（→ 文件名）+ `apps/scanner/app/build.gradle.kts` versionName（→ APK 内嵌）+ `Cargo.toml`（→ 核心库）+ `apps/windows/AirFerry.Windows/AirFerry.Windows.csproj` `<Version>`（→ exe 内嵌）。

---

## 6. 设备选择（摄像头 / 采集卡）

Windows 端的核心新增功能。启动后进入**设备选择页**：

- 自动枚举所有 DirectShow 视频输入设备（`FilterCategory.VideoInputDevice`）
- 摄像头（USB 摄像头、内置摄像头）与采集卡（USB HDMI 采集卡、专业 SDI 采集卡）在 DirectShow API 下是**同类设备**，统一列出
- 通过设备名启发式标注（含 "capture"/"采集"/"HDMI"/"Magewell"/"Elgato" 等关键字 → 标为「采集卡」，仅显示用，行为无差别）
- 下拉选择 + 刷新按钮，确认后点「开始扫码」进入扫码页

---

## 7. 产物

| 产物 | 路径 | 说明 |
|------|------|------|
| 可执行文件 | `apps/windows/AirFerry.Windows/bin/x64/Release/net8.0-windows/AirFerry.exe` | 依赖同目录下的 `transfer_engine.dll` + OpenCV native DLLs |
| 发布 zip | `dist/airferry-windows-x64-v{VER}.zip` | `dotnet publish` 产物打包；单文件发布 + 框架依赖（需目标机装 .NET 8 运行时） |

> 所有产物均 git-ignored（见 `.gitignore`）。分发走 GitHub Release。

---

## 8. 测试

```powershell
cd apps\windows
dotnet test
```

测试覆盖纯协议层（不依赖 P/Invoke，跨平台可跑）：
- `IngestStatusTests`：packed 位域解析（对标 Rust `cffi::tests`）
- `FrameHeaderTests`：60B 大端帧头解析
- `BundleParserTests`：ETBUNDL1 多文件包解包
- `FileNameUtilTests`：文件名 sanitize + Windows 保留名处理
- `ProgressSnapshotTests`：进度 JSON 解析

> Rust 侧的 C ABI 端到端测试：`cargo test -p transfer-engine --features cffi --test cffi_e2e`（用真实 sender 帧喂 cffi receiver，验证完整恢复）。

---

## 9. 与 Android 端的对照

| 维度 | Android | Windows |
|------|---------|---------|
| UI | Compose | WPF XAML |
| 相机 | CameraX (Y plane) | OpenCvSharp VideoCapture (BGR→Gray) |
| 设备枚举 | CameraX 自动 | DirectShow DsDevice（★新增设备选择） |
| QR 解码 | ZXing-C++ (JNI) | ZXing.Net (P/Invoke 风格) |
| 核心引擎 | Rust `jni.rs` (JNI) | Rust `cffi.rs` (C ABI) |
| 并行解码 | QrDecodePool (N workers + ingestLock) | QrDecodePool (N workers + lock) |
| 落盘 | `getExternalFilesDir/received/` | `%USERPROFILE%\Documents\AirFerry\received\` |
| 多文件包 | BundleParser.kt | BundleParser.cs |
| 签名 | keystore.properties | （暂无 Authenticode 签名） |
