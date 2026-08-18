# Windows 端构建指南

> Windows 扫码接收端（C# WPF + Rust 引擎 DLL + ZXing-C++ DLL），在同一个互斥的**扫描来源**列表中支持摄像头、采集卡与屏幕区域/窗口捕获。相机解码镜像 Android v1.1.3 模式。

---

## 1. 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| UI | WPF (.NET 8, C#) + **HandyControl 3.5.1**（主题控件库 + AirFerry 品牌层） | 对标 Android Compose UI；浅色/深色/跟随系统三主题，`hc:Window` 单窗口 + Frame 页面流导航，细节见 §7.4 |
| 相机/采集卡 | OpenCvSharp4 (DirectShow 后端) | 单句柄读取；Gray 送解码、池化 BGR24 快照送预览 |
| 设备枚举 | DirectShowLib (DsDevice) | `FilterCategory.VideoInputDevice` 同时覆盖摄像头+采集卡 |
| 屏幕区域/窗口捕获 | GDI（`BitBlt`/`PrintWindow`/`GetDIBits`，P/Invoke） | 零新增 NuGet 依赖；`ScreenCapture.cs` 实现 `IFrameSource`，与设备源同管线（详见 §7.1） |
| QR 解码 | ZXing-C++（全帧/ROI 均 TryHarder + TryInvert） | `core/zxing-decoder/` + Windows 薄 C ABI，选项与 Android v1.1.3 相同 |
| 核心引擎 | Rust `transfer-engine` (C ABI, `--features cffi`) | 编解码逻辑与 Android/WASM 共享，编译为 `transfer_engine.dll` |
| MVVM | CommunityToolkit.Mvvm | ObservableObject / RelayCommand 源生成器 |

**关键不变量**：RaptorQ/帧协议仍由三端共享 Rust 核心实现。Android 锁定 v1.1.3 JNI 解码实现；Windows 通过 `core/zxing-decoder/` 和 `QrDecodePool.cs` 镜像相同解码选项与调度状态机。

---

## 2. 环境要求

| 工具 | 版本 | 说明 |
|------|------|------|
| Windows | 10 (10.0.17763+) / 11 | DirectShow/Media Foundation 仅桌面版 Windows 有 |
| .NET SDK | 8.0+ | WPF 需要 `net8.0-windows` TFM |
| Rust | 1.75+ (stable) | 默认 `x86_64-pc-windows-msvc` target（`rustup` 默认安装） |
| CMake | 3.22+ | 配置/构建 `airferry_zxing.dll`，首次会获取固定 commit 的 zxing-cpp |
| Visual Studio | 2022，Desktop development with C++ | MSVC x64 编译器和 Windows SDK |

验证：
```powershell
dotnet --version          # ≥ 8.0
rustc --version           # ≥ 1.75
rustup target list --installed   # 应含 stable-x86_64-pc-windows-msvc（默认即有）
cmake --version           # ≥ 3.22
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
3. CMake 配置/编译共享 ZXing-C++ → CTest → 拷贝 `airferry_zxing.dll` 到同一 `runtime/`
4. `dotnet restore` + `dotnet build -c Release`（或 `-Pack` 时 `dotnet publish`）
5. （`-Pack` 时）压缩发布目录到 `dist/airferry-receiver-windows-x64-v{VER}.zip`

> 也可以用 bash 入口（Git Bash/WSL 下）：`./scripts/build-all.sh windows`。逻辑等价，但 PowerShell 是 Windows 上的首选。

---

## 4. 手动分步构建

### 4.1 编译 Rust C ABI DLL

```powershell
cargo build -p transfer-engine --features cffi --release
# 产物: target/release/transfer_engine.dll
```

> **必须先于 C# 构建**：csproj 会把两个 `runtime/*.dll` 扁平复制到 build/publish 的 exe 同目录，并明确排除单文件内嵌；发布脚本还会显式复制并核验一次，防止 SDK item glob 变化造成漏包。若 DLL 缺失，运行时第一个 P/Invoke 会抛 `DllNotFoundException`。

### 4.2 编译共享 ZXing-C++ DLL

```powershell
cmake -S apps/windows/native -B apps/windows/native/build `
  -G "Visual Studio 17 2022" -A x64
cmake --build apps/windows/native/build --config Release --parallel
ctest --test-dir apps/windows/native/build -C Release --output-on-failure

$dll = Get-ChildItem apps/windows/native/build -Recurse -Filter airferry_zxing.dll |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item $dll.FullName apps/windows/AirFerry.Windows/runtime/airferry_zxing.dll -Force
```

> CMake 固定 zxing-cpp v3.0.2 对应 commit。Windows 算法位于 `core/zxing-decoder/`，C ABI 负责传参、异常边界和结果内存所有权；C#/C ABI 行为镜像 Android v1.1.3 JNI 模式。

### 4.3 构建 C# WPF

```powershell
cd apps\windows
dotnet restore
dotnet build -c Release
# 产物: AirFerry.Windows\bin\x64\Release\net8.0-windows\win-x64\AirFerry.exe
```

### 4.4 运行

```powershell
dotnet run --project AirFerry.Windows -c Release
# 或直接双击 AirFerry.exe
```

---

## 5. 关键依赖顺序（坑）

1. **两个 native DLL 必须先于 C# 构建**：见 §4.1/§4.2。走 `build-windows.ps1` 会自动跑 cargo、CMake 与 CTest。
2. **WPF 只能在 Windows 上构建**：`net8.0-windows` TFM 依赖 Windows SDK，无法在 macOS/Linux 上编译 C# 主项目。**协议层单元测试**（`AirFerry.Windows.Tests`）用纯 `net8.0` TFM，可在任何 OS 上跑（不依赖 P/Invoke，只测 IngestStatus 位域、FrameHeader 解析、golden vectors 等纯逻辑）。
3. **版本号同步**：改版本时同时改根 `Cargo.toml`（`[workspace.package].version`，→ 核心库）+ `apps/web/package.json` + `apps/scanner/app/build.gradle.kts` versionName（→ APK 内嵌）+ `apps/windows/AirFerry.Windows/AirFerry.Windows.csproj` `<Version>`（→ exe 内嵌）。Windows workflow 不再硬编码版本。同步一致性由 `node scripts/version.mjs check` 门禁保证（见 AGENTS.md「版本事实源」）。

---

## 6. GitHub Actions 发版（推荐，非 Windows 本机）

macOS/Linux 无法编 WPF。正式 Windows 产物用 [`.github/workflows/windows.yml`](../.github/workflows/windows.yml)：

```text
push/PR（core/** 或 apps/windows/**）
  → rust-cffi (ubuntu) + csharp-tests (ubuntu) + windows-build (windows-2022)

workflow_dispatch（手动输入已存在的 `release_tag`）且上述三 job 成功
  → windows-pack：
       cargo build --features cffi --release
       拷贝 transfer_engine.dll → apps/windows/AirFerry.Windows/runtime/
       CMake/MSVC 构建共享 ZXing-C++ + CTest
       拷贝 airferry_zxing.dll → apps/windows/AirFerry.Windows/runtime/
       dotnet publish -c Release -r win-x64 -p:PublishSingleFile=true --self-contained false
       Compress-Archive → airferry-receiver-windows-x64-v${VER}.zip
       gh release upload v${VER} airferry-receiver-windows-x64-v${VER}.zip --clobber
       （tag commit、package/manifest 版本与 release 任一不一致即失败）
```

操作：Actions → **windows** → **Run workflow**，输入已创建的 tag（例如 `v1.2.3`）。workflow 从 tag 派生 `VER`，并验证 checkout 的提交正是该 tag，避免从 `main` 漂移提交生成同名发布资产。手动发布与 push 质量门按事件/tag 分组，不会互相取消。

本地 Windows 仍可用 `.\scripts\build-windows.ps1 -Pack`（产物进 `dist/`）。

---

## 7. 设备选择（摄像头 / 采集卡 / 屏幕捕获）

Windows 端的核心新增功能。启动后进入**设备选择页**：

- 自动枚举所有 DirectShow 视频输入设备（`FilterCategory.VideoInputDevice`）
- 摄像头（USB 摄像头、内置摄像头）与采集卡（USB HDMI 采集卡、专业 SDI 采集卡）在 DirectShow API 下是**同类设备**，统一列出
- 通过设备名启发式标注（含 "capture"/"采集"/"HDMI"/"Magewell"/"Elgato" 等关键字 → 标为「采集卡」，仅显示用，行为无差别）
- 列表选择 + 刷新按钮，确认后点「开始扫码」进入扫码页
- 摄像头、采集卡和「屏幕捕获」作为同一个 `ListBox` 的互斥单选项，底部只有一个统一主按钮；选中屏幕捕获后点击主按钮才打开**截图式选择器**（`RegionPicker`），避免独立快捷按钮误触或与硬件来源产生歧义。选择器每显示器一个半透明覆盖层，**拖动**=自定义矩形区域、**单击**=选中悬停高亮的窗口（EnumWindows 按 Z 序解析，跳过本进程/工具窗/cloaked/过小窗口）、**Esc** 取消；选定后进入扫码页
- 适用场景：同机浏览器播放二维码做端到端测试（无需摄像头对屏）、虚拟机/远程桌面窗口、无摄像头的机器

### 7.1 屏幕区域/窗口捕获（GDI 实现）

- **源抽象**：`Models/ScanSource.cs`（`DeviceSource`/`ScreenRegionSource`/`WindowSource`）从设备选择页贯穿到 `ScanViewModel.StartScan(ScanSource)`；`Scan/IFrameSource.cs` 是拉模式帧源契约（`IsOpen`/`ReadGray()`/`SnapshotBgr()`/`Dispose`），`FrameSourceFactory` 按类型分派，生产线程对源类型无感知
- **区域模式**：每帧 `GetDC(NULL)` → `BitBlt`（虚拟屏幕物理像素，PerMonitorV2 下无需 DPI 换算；负坐标覆盖左侧/上方副屏）
- **窗口模式**：`PrintWindow(PW_RENDERFULLCONTENT)` 优先（被遮挡时多数应用含 Chrome 仍可捕获），失败回退 `BitBlt` 屏幕区域（需窗口可见）；每帧重取 `GetWindowRect`，捕获跟随窗口移动/缩放
- **帧处理**：`GetDIBits`（`biHeight` 负值 = top-down）直写复用的 BGRA Mat → `BGRA2GRAY` 一步到灰度；预览按 15Hz 惰性转 BGR24。MSDN 要求 `GetDIBits` 期间 bitmap 不得选入 DC——用 DC 原始 stock bitmap 换入换出。⚠️ 兼容位图必须对**屏幕 DC** 创建（`CreateCompatibleBitmap(GetDC(NULL), …)`）：内存 DC 默认选着 1×1 单色 stock bitmap，对内存 DC 调 CreateCompatibleBitmap 会得到 1-bit 单色位图，GetDIBits 下来就不是 BGRA32，预览和二维码解码都会退化
- **节流**：GDI 无阻塞，`ReadGray` 内部按 60fps Stopwatch 节流（Sleep(1)+自旋），避免生产线程 CPU 空转
- **终止语义**：窗口销毁或连续 30 帧失败 → `IsOpen=false`；生产线程检测后经 `Task.Run(StopScan)` 停止并提示「视频源已关闭」（不能在 producer 线程同步调 `StopScan`——会自 join 死锁）
- **已知限制**：少数 DirectX 独占全屏/UWP 窗口 `PrintWindow` 渲染黑屏（回退 BitBlt 需窗口可见）；4K 全屏大区域 BitBlt 可能达不到 60fps（二维码流典型窗口尺寸无碍）

### 7.2 单采集源与停止生命周期

- 解码和预览共用一个 DirectShow 句柄；生产线程每次读取只向池化 Gray 缓冲复制一次，并按最高 15fps 发布 BGR24 预览快照，避免独占型驱动因双开设备导致黑屏。
- 2–6 个 worker 调用 Windows 的 ZXing-C++ 核心，队列容量为 `worker+2`，每个 worker 最多累积 4 个符号后进入串行摄入；全帧/ROI 与 miss 计数状态机镜像 Android v1.1.3。
- 预览快照使用 `ArrayPool<byte>`，UI 只把托管像素写入 `WriteableBitmap`，不在 Dispatcher 上调用阻塞式 `VideoCapture.Read()`。
- 扫描页只保留最新预览帧；UI 忙时自动覆盖旧帧，不堆积 Dispatcher 任务或大图像缓冲。
- 停止会先作废旧会话的排队 UI 回调，并启动唯一的有序清理任务：等待生产者、完成后的组装/落盘任务及全部解码 worker 真正结束后，才释放 native handle/camera。前台最多等待 2 秒；慢摄像头超时后资源由后台任务继续持有并安全释放，期间禁止重启扫描，因此既不冻结 WPF Dispatcher，也不会并发 free/Dispose。
- 状态卡以约 7Hz 一致快照显示 3 秒窗口解码速率、有效吞吐、采集/丢帧/已解码计数和源文件/传输大小；不显示容易误判的逐二维码 active/paused 状态。

### 7.3 技术栈取舍

当前阶段保留 WPF，不把一次稳定性改造与 UI 框架迁移绑在一起。WPF 本身只支持 Windows，因此这里的“跨平台”边界是 Rust 协议核心、内容模型和可测试的纯 C# 协议层；WPF 仅作为 Windows 外壳。

若后续确实需要桌面端同时覆盖 macOS/Linux，建议先把扫描编排、文件库和接收结果抽为不依赖 WPF 的 .NET 类库，再用 Avalonia 替换视图层。不要在现有 WPF 上继续叠 MAUI/Electron：这会保留 OpenCV、ZXing、Rust FFI 的全部复杂度，同时再增加一套运行时和打包链。

### 7.4 UI 架构（HandyControl + AirFerry 品牌层）

视图层基于 **HandyControl 3.5.1**（csproj 中唯一 UI 库 PackageReference；纯托管 + 资源字典，PublishSingleFile 无特殊处理；Win10 兼容——不用 Mica）。AirFerry 品牌配色（#2563EB、语义色）以自有字典叠加在库皮肤之上。结构与约定：

- **窗口壳**：`Views/MainWindow.xaml` 是 `hc:Window`（`NonClientAreaHeight=36`；模板自带最小化/最大化/关闭按钮，`ShowIcon`/`ShowTitle` 默认显示 Window.Icon 与标题——勿设 `WindowStyle=None`/`AllowsTransparency`，WindowChrome 由库内部接管），内容直接放内嵌 `Frame`（`NavigationUIVisibility=Hidden`）。7 个视图仍是 Page，导航调用（`NavigationService.Navigate/GoBack`）不变。`App.OnStartup` 手动创建并 Show MainWindow。
- **主题**：`App.xaml` 依次合并 HC 皮肤字典（`SkinDefault.xaml`，皮肤必须在前）→ HC `Theme.xaml`（样式）→ 自有语义 token 字典（`Themes/DesignTokens.{Light,Dark}.xaml`：`SuccessBrush`/`ErrorBrush`/`WarningBrush`/`PreviewBackdropBrush`，合并位置在 Theme.xaml 之后以覆盖 HC 同名渐变刷）→ `Themes/AirFerry.xaml` 品牌层（覆盖 `PrimaryColor`=#2563EB 等 Color 键、纯色 `PrimaryBrush`、WPF-UI 时代画刷键别名、`GlyphIcon`/`GhostButton` 样式、Card 圆角 8px）。`Services/ThemeService.cs` 按 `settings.json` 的 `theme` 键（`light`/`dark`/`system`，设置页可改）切主题：换皮肤字典与 DesignTokens 的 Source；跟随系统模式自订 `SystemEvents.UserPreferenceChanged` + `AppsUseLightTheme` 注册表判定（不用库的 SyncWithSystem——它换不了 DesignTokens）。设置读写由 `Services/AppSettings.cs` 独占（手写 JSON，与 Android 端格式对齐）。**主题画刷一律 `DynamicResource` 引用**。
- **控件约定**：`hc:Card` 卡片（Padding 属性存在但默认模板不绑定，内边距写到子元素 `Margin`；要填满行高须显式 `VerticalAlignment="Stretch"`）、标准 `Button` + keyed Style（`ButtonPrimary` 品牌蓝实心 / 隐式 `ButtonDefault` 中性 / `GhostButton` 透明幽灵；**图标+文字手动堆 StackPanel**——HC 无 `Button.Icon` 属性；**按钮固定高 28px**，大按钮显式 `Height="40"`；满宽按钮须显式 `HorizontalAlignment="Stretch"`）、状态条用自写 `Controls/InfoBanner`（HC 无 InfoBar 控件）、图标用 `GlyphIcon` 样式 TextBlock（系统字体 Segoe MDL2 Assets，Win10/11 自带；库无图标体系）；`ComboBox`/`Slider`/`CheckBox`/`ListBox` 等标准控件由 HC 隐式样式接管，**TextBlock 无隐式样式**（必须显式 `Foreground`）。弹窗统一 `Services/UiMessages.cs`（HC `MessageBox`，同步模态、中文按钮文字、不支持自定义按钮文字）。
- **RegionPickerWindow 例外**：全屏透明覆盖层（`AllowsTransparency=True`），保持普通 Window（HC 的隐式 Window 样式只设置背景/前景，不影响覆盖层），配色固定（主题无关）。
- **接收结果页层级**：`ReceiveDetailView` / `ReceiveTextView` / `ReceiveBundleView` 顶部先单独显示左对齐的「返回」，下一行再显示成功图标与接收完成状态；导航和结果状态不放在同一横排。单文件与文件包结果页原「分享」按钮实际是调用 Explorer 定位导出文件，因此统一按真实行为显示为「打开文件夹」并使用文件夹图标。

---

## 8. 产物

| 产物 | 路径 | 说明 |
|------|------|------|
| 可执行文件 | `apps/windows/AirFerry.Windows/bin/x64/Release/net8.0-windows/win-x64/AirFerry.exe` | 依赖同目录下的 `transfer_engine.dll`、`airferry_zxing.dll` + OpenCV native DLLs |
| Windows 接收端 zip（本地） | `dist/airferry-receiver-windows-x64-v{VER}.zip` | `build-windows.ps1 -Pack` |
| 发布 zip（CI） | GitHub Release asset 同名 | `windows.yml` → `windows-pack` job |

> 所有本地产物均 git-ignored。分发走 GitHub Release；**默认 Windows 发版路径是 workflow**（§6）。

---

## 9. 测试

```powershell
cd apps\windows
dotnet test
```

测试覆盖纯托管逻辑（不实际加载 P/Invoke DLL，跨平台可跑）：
- `IngestStatusTests`：packed 位域解析（对标 Rust `cffi::tests`）
- `FrameHeaderTests`：26B AF2 大端帧头解析
- `FileNameUtilTests`：文件名 sanitize + Windows 保留名处理
- `ProgressSnapshotTests`：进度 JSON 解析
- `PreviewFrameTests`：池化预览缓冲的所有权与幂等释放
- `ZxingDecoderTests`：共享 native packed 结果的长度、bbox、畸形输入及尾部字节拒绝
- `ScanSourceTests`：视频源 record 的 DisplayName 与相等性（设备/屏幕区域/窗口三源）
- `ScreenRectUtilTests`：选择器几何（任意方向拖动归一化、负坐标副屏、click 阈值、最小区域尺寸）

共享 C++ 核心另有原生 CTest（几何校验与 packed 布局）：

```powershell
ctest --test-dir apps/windows/native/build -C Release --output-on-failure
```

> Rust 侧 C ABI 单元测试：`cargo test -p transfer-engine --features cffi`（`cffi.rs`/`ingest_status.rs`/`progress.rs` 内部 `#[cfg(test)]`，验证 packed 状态与 JSON 快照；跨端线格式一致性由 `core/af2/tests/golden_vectors.rs` golden fixture 覆盖）。

---

## 10. 与 Android 端的对照

| 维度 | Android | Windows |
|------|---------|---------|
| UI | Compose | WPF XAML |
| 相机 | CameraX (Y plane) | OpenCvSharp VideoCapture (BGR→Gray) |
| 设备枚举 | CameraX 自动 | DirectShow DsDevice（★新增设备选择） |
| 屏幕捕获 | （无） | ★GDI BitBlt/PrintWindow：屏幕区域 + 独立窗口作为视频源（`ScreenCapture.cs` + 截图式 `RegionPicker`） |
| QR 解码 | ZXing-C++ v1.1.3 路径（JNI） | 等价 ZXing-C++ 模式（C ABI/P/Invoke） |
| 核心引擎 | Rust `jni.rs` (JNI) | Rust `cffi.rs` (C ABI) |
| 并行解码 | 2–6 workers + v1.1.3 调度/4 符号批摄入 | 同 worker/队列/批量/miss 状态机 + ingestLock |
| 落盘 | ContentStore blob + `index.json` | `%USERPROFILE%\Documents\AirFerry\store\blobs\<hh>\<sha256>` + `index.json` |
| 多文件包 | 经 Rust 快照 entries 还原（无本地解析器） | 经 Rust 快照 entries 还原（无本地解析器） |
| 签名 | keystore.properties | （暂无 Authenticode 签名） |
