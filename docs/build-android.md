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
  -o apps/android/app/src/main/jniLibs \
  build -p transfer-engine --features jni --release
```

产物：`apps/android/app/src/main/jniLibs/arm64-v8a/libtransfer_engine.so`

## 构建 APK

```bash
cd apps/android

# 设置 SDK 路径（首次）
cat > local.properties <<EOF
sdk.dir=/path/to/android-sdk
EOF

# 构建 Debug APK
./gradlew :app:assembleDebug

# 构建 Release APK（当前 release 块未配置签名 → 产出未签名 APK，安装前需自行签名）
./gradlew :app:assembleRelease
```

产物：`app/build/outputs/apk/debug/app-debug.apk`
（Release：`app/build/outputs/apk/release/app-release-unsigned.apk`）

## 安装到设备

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

## 原生库说明

APK 包含三个原生库：

| 库 | 来源 | 用途 |
|----|------|------|
| `libtransfer_engine.so` | Rust → cargo-ndk | RaptorQ 编解码（JNI） |
| `libeasytransfer_zxing.so` | ZXing-C++ → CMake | QR 码解码（JNI） |
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

## 项目结构

```
apps/android/
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
        ├── java/com/easytransfer/app/
        │   ├── nativelib/
        │   │   └── NativeBridge.kt       # Rust JNI 绑定
        │   ├── scan/
        │   │   ├── ZxingDecoder.kt       # ZXing JNI 绑定
        │   │   ├── QrStreamAnalyzer.kt   # CameraX 分析器（生产者）
        │   │   ├── QrDecodePool.kt       # 并行解码池 + 串行 JNI 摄入
        │   │   ├── HighSpeedCaptureController.kt  # 实验性高速录制→批量解码
        │   │   └── ReceiverSessionManager.kt
        │   └── ui/
        │       ├── ScanActivity.kt       # 扫描页
        │       ├── ReceiveDetailActivity.kt
        │       ├── FileListActivity.kt
        │       └── SettingsActivity.kt   # 设置（含实验性高速开关）
        ├── jniLibs/arm64-v8a/    # Rust .so（cargo-ndk 产物）
        └── res/                  # 布局 + 资源
```

## 支持的 ABI

当前仅构建 `arm64-v8a`（64 位 ARM，覆盖 Android 10+ 的绝大多数设备）。如需 32 位支持，添加 `armeabi-v7a` 并补充对应的 Rust 编译：

```bash
cargo ndk -t arm64-v8a -t armeabi-v7a \
  -o apps/android/app/src/main/jniLibs \
  build -p transfer-engine --features jni --release
```
