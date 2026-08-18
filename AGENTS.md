# AGENTS.md — AI 代理操作手册 (AF2)

> **AirFerry**：完全离线的光学二维码视频流传输。发送端（扩展/网页）将文件编码为二维码视频流在屏幕播放；接收端（Android/Windows App）通过摄像头/采集卡/屏幕捕获扫码恢复。零网络依赖、单向信道、无握手。协议采用 **AF2 Wire Protocol**（`magic: AF, wire_version: 2`）。

---

## 1. 快速构建与测试命令

```bash
# Rust 核心库与全工作区测试
cargo test --workspace
cargo test -p transfer-engine --features cffi
cargo test -p transfer-engine --features jni
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p transfer-engine --target wasm32-unknown-unknown --features wasm

# 前端：浏览器扩展、Web 发送/接收端与单文件版（apps/web）
cd apps/web && npm ci && npm run wasm && npm run build:all

# Android 扫码端（apps/scanner）
cd apps/scanner && ./gradlew :app:testDebugUnitTest :app:assembleDebug

# 门禁与校验
node scripts/version.mjs check
node scripts/verify-dist.mjs
```

---

## 2. 仓库布局与导航

```
AirFerry/
├── core/
│   ├── af2/                    # AF2 核心协议层（帧格式、三层ID、BLAKE3、Manifest、OTI推导、状态机、Playlist）
│   ├── raptorq-core/           # RFC 6330 RaptorQ 编解码封装
│   ├── qr-protocol/            # QR 渲染 (fast_qr) 与压缩集成
│   ├── transfer-engine/        # 原生与跨端绑定 (WASM, JNI, C-ABI)
│   ├── zxing-decoder/          # 接收端唯一 QR 解码后端（FAST ZXing-C++，Y 灰度平面）
│   └── testdata/               # 跨端 golden fixtures（线格式一致性断言）
├── apps/
│   ├── web/                    # 前端（浏览器扩展 + Web 发送/接收端 + 单文件版，Vite + React + TS，单一 package）
│   ├── scanner/                # Android 扫码端 (Kotlin + CameraX + ZXing-C++)
│   └── windows/                # Windows 扫码端 (C# WPF + HandyControl + OpenCvSharp)
├── docs/                       # 契约与构建规范（唯一线协议源 docs/SPEC.md）
├── scripts/                    # 构建、门禁与发布辅助脚本
└── dist/                       # 发布产物目录（git-ignored，不放私钥）
```

---

## 3. 核心协议与工程不变量

1. **协议唯一权威源**：线格式以 [`docs/SPEC.md`](docs/SPEC.md) 与 `core/af2/` 代码为准。
2. **三层身份体系**：
   - `Content ID`（256位）：内容与路径结构指纹；
   - `Transfer ID`（128位）：内容按指定 `chunk_raw_size`（默认 8 MiB）切块的身份；
   - `Object ID`（128位）：包含 `encoded_hash`，解码前绑定，杜绝混流。
3. **严格变小才压缩**：Chunk 仅在压缩后严格小于原始大小时允许使用 Zstd/Xz，否则必须为 RAW。
4. **WASM 单轨化**：`wasm-bindgen = 0.2.92` 标量构建，单一 `wasm-pkg/` 通吃 Chrome 87 到最新版。
5. **FAST-only 接收端**：接收端 QR 解码使用自编译 FAST ZXing-C++（Y 灰度平面），构建缺失即失败。
6. **单一快照 FFI**：JNI (`receiverSnapshotJson`) 与 C-ABI (`airferry_receiver_snapshot_json`) 统一返回 Schema 2 快照 JSON。
7. **版本事实源**：以根 `Cargo.toml [workspace.package].version` 为准，`node scripts/version.mjs check` 门禁保证版本位点一致。
