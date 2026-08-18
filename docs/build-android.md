# Android 构建说明 (Android App Build)

## 前置条件

- JDK 17
- Android SDK（API 34+）
- Android NDK 27.0.12077973
- CMake 3.22.1（通过 SDK Manager 安装）
- Rust + cargo-ndk + Android targets（见 [dev-setup.md](dev-setup.md)）

## 构建 Rust JNI 库（自动，无需手动）

`assembleDebug` / `assembleRelease` 会自动在打包 JNI `.so` 前重编 Rust
`transfer_engine` 库（Gradle `compileRustJni` task，是
`merge*JniLibFolders` 的前置依赖）。因此**本地构建的 APK 永远不会打进旧的
`.so`**——APK 内的原生库始终与工作区 `core/` 源码匹配。无需手动跑 `cargo ndk`。

若确需手动单独重编（调试 native 代码 / 单独验证），等价命令：

```bash
export ANDROID_HOME=/path/to/android-sdk
export NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973
export PATH="$NDK_HOME/toolchains/llvm/prebuilt/$(uname -m)-linux-android/bin:$PATH"

cargo ndk -t arm64-v8a \
  -o apps/scanner/app/src/main/jniLibs \
  build -p transfer-engine --features jni --release
```

产物：`apps/scanner/app/src/main/jniLibs/arm64-v8a/libtransfer_engine.so`

> **为什么必须自动重编（v1.2.0 修复）**：曾出现「设备上应用显示 1.2.0 /
> versionCode 14，但 APK 内的 Rust JNI 库是旧版、缺少 v5 分段代码」，表现为
> 安卓扫码 >32 MiB 一直「正在同步」（Web 用最新 WASM 不受影响）。两层防护：
> ① Gradle 在打包 APK 前自动重编 Rust JNI；② 启动时做 native ABI/协议版本
> 握手（`NativeBridge.nativeAbiVersion()`，见「启动期 JNI 版本握手」）。

## 构建 APK

```bash
cd apps/scanner

# 设置 SDK 路径（首次）
cat > local.properties <<EOF
sdk.dir=/path/to/android-sdk
EOF

# 构建 Debug APK（debug keystore 签名，调试用）
./gradlew :app:assembleDebug

# 构建 Release APK（见下方签名配置）
./gradlew :app:assembleRelease
```

产物：
- Debug：`app/build/outputs/apk/debug/app-debug.apk`
- Release：`app/build/outputs/apk/release/app-release.apk`

### 启动期 JNI 版本握手（v1.2.0）

`ScanActivity` 启动自检在创建/销毁一个 receiver 之前，先调用
`NativeBridge.nativeAbiVersion()` 并断言其 `>= NativeBridge.NATIVE_ABI_VERSION`
（= `2`，对应 `AIRFERRY_NATIVE_ABI_VERSION`，即 AF2 快照化 FFI 版本）。

旧 `.so` 要么没有该符号（调用抛 `UnsatisfiedLinkError`）要么报更低版本——两种
情况都会在加载相机前直接进入 `ErrorScreen`「原生库版本过旧」，而**不会**让
`receiverCreate` 自检通过后静默地在 >32 MiB 传输上停在「正在同步」。这正是
「旧 `.so` 不再伪装成可用版本」的兜底。

### 关于 APK 体积（R8 优化）

Release 构建开启 R8 混淆 + 资源裁剪（`isMinifyEnabled = true` / `isShrinkResources = true`）。这是 APK 体积的主要来源优化：

- **效果**：Release APK 约 **6.1 MB**（未开 R8 时约 47 MB）。其中 `classes*.dex` 从 ~44.7 MB（3 个 dex、含 3.2 万个 `material-icons-extended` 图标类）降到 ~2.6 MB（1 个 dex、未用图标类被 R8 死代码消除全部剥离）；`lib/*.so`（Rust + ZXing-C++）约 2.6 MB 不变。
- **代价**：混淆会重命名类/方法。JNI 边界（`NativeBridge`、`ZxingDecoder`）用 `-keep` 保留类名与 `external fun` 方法名（见 `proguard-rules.pro`），否则 `Java_com_airferry_app_*` 静态 JNI 符号无法绑定 → 解码失败。`org.json` 亦因反射保留。
- **排错**：若 Release 出现 `UnsatisfiedLinkError` 或解码静默失败，先检查 `proguard-rules.pro` 的 keep 是否覆盖新增的 JNI 类；Debug 不受影响（不混淆）。
- 改 `proguard-rules.pro` 后需 `./gradlew :app:assembleRelease --rerun-tasks` 才会重跑 R8。

### 关于 Release 签名

Release 构建的签名配置由 `apps/scanner/keystore.properties`（git-ignored）驱动：

```kotlin
// app/build.gradle.kts
val keystoreProperties = Properties().apply {
    val f = rootProject.file("keystore.properties")  // apps/scanner/keystore.properties
    if (f.exists()) { f.inputStream().use { load(it) } }
}
signingConfigs {
    create("release") {
        if (releaseSigningReady) {
            storeFile     = rootProject.file(keystoreProperties.getProperty("storeFile"))
            storePassword = keystoreProperties.getProperty("storePassword")
            keyAlias      = keystoreProperties.getProperty("keyAlias")
            keyPassword   = keystoreProperties.getProperty("keyPassword")
        }
    }
}
buildTypes {
    release {
        signingConfig = if (releaseSigningReady) signingConfigs.getByName("release") else null
    }
}
// taskGraph guard: 任一 release 任务在 !releaseSigningReady 时抛 GradleException。
```

`keystore.properties`（每个构建环境各一份，git-ignored）指向 `dist/` 下的 release keystore：

```properties
# apps/scanner/keystore.properties
storeFile=../../dist/airferry-release.keystore
storePassword=airferry
keyAlias=airferry
keyPassword=airferry
```

> keystore 路径相对于 Gradle `rootProject`（即 `apps/scanner/`），解析到 `<repo>/dist/airferry-release.keystore`。`dist/` 与 `*.keystore` 均在 `.gitignore` 中，密钥随 release 产物一起放在 `dist/`、不入 git。
>
> 示例口令仅供本地说明；正式分发必须使用 AirFerry 的固定 release keystore。缺少文件、字段或 keystore 时 `assembleRelease` 会直接失败，绝不会回退到 debug key。根脚本还会用 `apksigner` 核对内置的发布证书 SHA-256 指纹 `44577EDA2C6D4F44638C9D61DC161F08FDB30FCEE6A3410AADAEB7CE65A97FDD`；签名变化会直接终止打包。

## 安装到设备

```bash
adb install app/build/outputs/apk/dist/app-release.apk
```

## 原生库说明

APK 包含三个原生库：

| 库 | 来源 | 用途 |
|----|------|------|
| `libtransfer_engine.so` | Rust → cargo-ndk | RaptorQ 编解码（JNI） |
| `libairferry_zxing.so` | ZXing-C++ → CMake/JNI | QR 全帧/多 ROI 解码；实现锁定为 v1.1.3 路径 |
| `libimage_processing_util_jni.so` | CameraX | 图像处理工具 |

## ZXing-C++ 构建

ZXing-C++ 通过 CMake `FetchContent` 从 GitHub 拉取（固定到 v3.0.2 的 commit），首次构建时自动编译。Android 的完整识别逻辑位于 `scan_jni.cpp`，并与 `QrDecodePool.kt`、`ZxingDecoder.kt` 一起锁定为 v1.1.3 的解码实现；Windows 用 C#/C ABI 镜像相同模式，但不直接编译这份 JNI 文件。依赖仍固定到不可变 commit，不回退供应链加固。

```cmake
# app/src/main/cpp/CMakeLists.txt
FetchContent_Declare(zxing
    GIT_REPOSITORY https://github.com/zxing-cpp/zxing-cpp.git
    GIT_TAG 8dd1cf5c4fd6fb6211bb96713db926ac6f2cf825
)
```

**注意**：首次构建需要网络访问；构建缓存后离线可用。

### 16 KiB page size 对齐（重要）

Android 15+ 支持以 16 KiB page size 运行的设备，2025 年的旗舰机（如 Android 16 的小米新机）
默认采用 16 KiB。内核**拒绝 `dlopen` LOAD 段只对齐到 4 KiB（0x1000）的 `.so`**——
`System.loadLibrary` 会抛 `UnsatisfiedLinkError`，ZXing 解码库加载失败后**所有 QR 解码静默
失败，表现为扫码端完全扫不出任何码**。

`CMakeLists.txt` 通过链接器选项强制 LOAD 段对齐到 16 KiB：

```cmake
# app/src/main/cpp/CMakeLists.txt
add_link_options("-Wl,-z,max-page-size=16384")
```

这样同一个 `.so` 在 4 KiB 和 16 KiB page-size 的设备上都能加载。Rust 侧的
`libtransfer_engine.so` 由 cargo-ndk/LLVM 默认对齐到 16 KiB，无需额外配置。

**验证对齐**（NDK 自带 `llvm-readelf`）：

```bash
READELF=$NDK_HOME/toolchains/llvm/prebuilt/<host>/bin/llvm-readelf
# LOAD 段 Align 列应为 0x4000（16 KiB）；若是 0x1000 则在 16 KiB 设备上会加载失败
$READELF -l lib/arm64-v8a/libairferry_zxing.so | grep LOAD
```

## 项目结构

```
apps/scanner/
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
├── gradlew
├── local.properties              # SDK 路径（git-ignored）
└── app/
    ├── build.gradle.kts          # 依赖 + NDK/CMake 配置
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── cpp/
        │   ├── CMakeLists.txt    # ZXing-C++ 构建
        │   └── scan_jni.cpp      # v1.1.3 ZXing-C++ JNI 解码实现
        ├── java/com/airferry/app/
        │   ├── nativelib/
        │   │   └── NativeBridge.kt       # Rust JNI 绑定
        │   ├── scan/
        │   │   ├── ZxingDecoder.kt       # ZXing JNI 绑定
        │   │   ├── QrStreamAnalyzer.kt   # CameraX 分析器（生产者）
        │   │   ├── QrDecodePool.kt       # 并行解码池 + 串行 JNI 摄入
│   │   ├── ReceiverSessionManager.kt
│   │   ├── ContentStore.kt       # 内容库存储（entries 索引 + blob 引用计数）
│   │   ├── TextLike.kt           # 文本类扩展名启发式 + 严格 UTF-8
│   │   └── FileNameUtil.kt       # 接收文件命名（去重 / 目录）
│   └── ui/
│       ├── ScanActivity.kt       # 扫描页（ImageAnalysis 1920×1080；FLAG_KEEP_SCREEN_ON 防长传息屏；压缩后大小用描述符真实值、分段时显示第 N 段/共 M 段、重扫已完成段立即识别跳过不重传整段）
│       ├── ReceiveDetailActivity.kt  # 结果页同样 FLAG_KEEP_SCREEN_ON（防止恢复瞬间系统超时接管而变暗）
│       ├── ReceiveTextActivity.kt    # 文字/文本类复制页（同上常亮）
│       ├── ReceiveBundleActivity.kt  # 多文件；.txt 等可点开复制（同上常亮）
│       ├── FileListActivity.kt
│       └── SettingsActivity.kt
        ├── jniLibs/arm64-v8a/    # Rust .so（cargo-ndk 产物）
        └── res/                  # 布局 + 资源
```

## 支持的 ABI

当前仅构建 `arm64-v8a`（64 位 ARM，覆盖 Android 10+ 的绝大多数设备）。如需 32 位支持，添加 `armeabi-v7a` 并补充对应的 Rust 编译：

```bash
cargo ndk -t arm64-v8a -t armeabi-v7a \
  -o apps/scanner/app/src/main/jniLibs \
  build -p transfer-engine --features jni --release
```
