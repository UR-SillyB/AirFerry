# Android 构建说明 (Android App Build)

## 前置条件

- JDK 17
- Android SDK（API 34+）
- Android NDK 27.0.12077973
- CMake 3.22.1（通过 SDK Manager 安装）
- Rust + cargo-ndk + Android targets（见 [dev-setup.md](dev-setup.md)）

## 构建 Rust JNI 库

```bash
export ANDROID_HOME=/path/to/android-sdk
export NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973
export PATH="$NDK_HOME/toolchains/llvm/prebuilt/$(uname -m)-linux-android/bin:$PATH"

cargo ndk -t arm64-v8a \
  -o apps/scanner/app/src/main/jniLibs \
  build -p transfer-engine --features jni --release
```

产物：`apps/scanner/app/src/main/jniLibs/arm64-v8a/libtransfer_engine.so`

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
        if (!keystoreProperties.isEmpty) {
            storeFile     = rootProject.file(keystoreProperties.getProperty("storeFile"))
            storePassword = keystoreProperties.getProperty("storePassword")
            keyAlias      = keystoreProperties.getProperty("keyAlias")
            keyPassword   = keystoreProperties.getProperty("keyPassword")
        }
    }
}
buildTypes {
    release {
        // 有 keystore.properties → 用 release keystore；否则回退 debug（保证 CI 无密钥也能产出 APK）
        signingConfig = if (!keystoreProperties.isEmpty)
            signingConfigs.getByName("release")
        else signingConfigs.getByName("debug")
    }
}
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
> 仓库自带的默认口令（`airferry`）仅供自托管分发；正式上架 Play Store 等商店时，请生成强口令的专用 keystore 并替换此文件。无此文件时构建自动回退 debug 签名，不会硬失败。

## 安装到设备

```bash
adb install app/build/outputs/apk/dist/app-release.apk
```

## 原生库说明

APK 包含三个原生库：

| 库 | 来源 | 用途 |
|----|------|------|
| `libtransfer_engine.so` | Rust → cargo-ndk | RaptorQ 编解码（JNI） |
| `libairferry_zxing.so` | ZXing-C++ → CMake | QR 码解码（JNI） |
| `libimage_processing_util_jni.so` | CameraX | 图像处理工具 |

## ZXing-C++ 构建

ZXing-C++ 通过 CMake `FetchContent` 从 GitHub 拉取（pinned v3.0.2），首次构建时自动编译。

```cmake
# app/src/main/cpp/CMakeLists.txt
FetchContent_Declare(zxing
    GIT_REPOSITORY https://github.com/zxing-cpp/zxing-cpp.git
    GIT_TAG v3.0.2
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
        │   └── scan_jni.cpp      # ZXing JNI 桥接
        ├── java/com/airferry/app/
        │   ├── nativelib/
        │   │   └── NativeBridge.kt       # Rust JNI 绑定
        │   ├── scan/
        │   │   ├── ZxingDecoder.kt       # ZXing JNI 绑定
        │   │   ├── QrStreamAnalyzer.kt   # CameraX 分析器（生产者）
        │   │   ├── QrDecodePool.kt       # 并行解码池 + 串行 JNI 摄入
        │   │   ├── HighSpeedCaptureController.kt  # 实验性高速录制→批量解码
        │   │   ├── ReceiverSessionManager.kt
        │   │   ├── BundleParser.kt       # ETBUNDL1 多文件容器解析
        │   │   └── FileNameUtil.kt       # 接收文件命名（去重 / 目录）
        │   └── ui/
        │       ├── ScanActivity.kt       # 扫描页
        │       ├── ReceiveDetailActivity.kt
        │       ├── ReceiveBundleActivity.kt  # 多文件接收结果页
        │       ├── FileListActivity.kt
        │       └── SettingsActivity.kt   # 设置（含实验性高速开关）
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
