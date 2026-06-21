# 开发环境搭建 (Development Setup)

## 概述

AirFerry 的开发需要以下工具链：Rust（核心库）、Node.js（浏览器扩展）、JDK + Android SDK/NDK（Android App）。

## 1. Rust 工具链

```bash
# 安装 Rust（https://rustup.rs）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 验证
rustc --version   # ≥ 1.75
cargo --version
```

## 2. WebAssembly 工具

```bash
# 添加 WASM 编译目标
rustup target add wasm32-unknown-unknown

# 安装 wasm-pack
cargo install wasm-pack
```

## 3. Android 工具链

### Android SDK + NDK

```bash
# 安装 Android command-line tools（macOS）
brew install --cask android-commandlinetools

# 设置环境变量（加入 ~/.zshrc 或 ~/.bashrc）
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT=$ANDROID_HOME
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# 安装 SDK 组件
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
sdkmanager "cmake;3.22.1"
sdkmanager "ndk;27.0.12077973"

# 验证
adb version
```

### Android Rust 交叉编译

```bash
# 添加 Android 编译目标
rustup target add aarch64-linux-android armv7-linux-androideabi \
                 i686-linux-android x86_64-linux-android

# 安装 cargo-ndk
cargo install cargo-ndk
```

## 4. Node.js（浏览器扩展）

```bash
# 安装 Node.js ≥ 18（https://nodejs.org 或 brew install node）
node --version   # ≥ 18
npm --version

# 可选：pnpm
npm install -g pnpm
```

## 5. JDK（Android 构建）

```bash
# JDK 17
brew install --cask temurin@17

export JAVA_HOME=$(/usr/libexec/java_home -v 17)
```

## 快速验证

```bash
# 克隆项目
git clone <repo-url> AirFerry
cd AirFerry

# 1. 测试核心库（全部单元 + 集成测试，跨 raptorq-core / qr-protocol / transfer-engine）
cargo test

# 2. 构建 WASM 核心
cd apps/sender
npm install
npm run wasm

# 3. 构建浏览器扩展
npm run build

# 4. 构建 Rust Android 库
cd ../..
cargo ndk -t arm64-v8a -o apps/scanner/app/src/main/jniLibs \
  build -p transfer-engine --features jni --release

# 5. 构建 Android APK
cd apps/scanner
./gradlew :app:assembleDebug
```

## 环境变量汇总

```bash
# 加入 ~/.zshrc 或 ~/.bashrc
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT=$ANDROID_HOME
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

## 常见问题

### wasm-pack 构建失败：`clang: error: unknown target triple 'wasm32-unknown-unknown'`

确保已添加 WASM 目标：`rustup target add wasm32-unknown-unknown`

### cargo-ndk 构建失败：`failed to find tool "aarch64-linux-android-clang"`

NDK 未在 PATH 中。设置 `NDK_HOME` 并将 NDK 工具链加入 PATH：

```bash
export NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973
export PATH="$NDK_HOME/toolchains/llvm/prebuilt/$(uname -m)-linux-android/bin:$PATH"
```

### Android 构建失败：`NDK from ndk.dir ... disagrees with android.ndkVersion`

确保 `local.properties` 中的 NDK 版本与 `app/build.gradle.kts` 的 `ndkVersion` 一致。

### ZXing-C++ 首次构建缓慢

CMake 首次会从 GitHub 克隆 zxing-cpp 并编译（约 1–2 分钟）。后续构建使用缓存。
