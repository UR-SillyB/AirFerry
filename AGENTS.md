# AGENTS.md — AI 代理操作手册

> 本文是给 AI 代理（以及人类开发者）的**导航 + 操作索引**：怎么构建、怎么定位代码、怎么排错、哪些坑别踩。
> 本文**不重复** `docs/*.md` 的细节，每条都指向权威来源。跨端不变量的位级规格见 [`docs/SPEC.md`](docs/SPEC.md)。
> **遇到文档与代码冲突时，一律以代码为准**（见下方「文档与代码偏差清单」）。

## 项目一句话

**AirFerry**：完全离线的光学文件传输。发送端（浏览器扩展）把文件编成二维码视频流在屏幕上连续播放；接收端（Android App）用摄像头实时扫描恢复文件。两端共享同一套 Rust 核心库（分别编译为 WASM 与 Android Native `.so`），编解码逻辑数学上一致。**零网络依赖、单向信道、无握手**。

---

## 1. 仓库布局

```
AirFerry/
├── core/                       # Rust 核心库（三 crate workspace）
│   ├── raptorq-core/           #   RFC 6330 RaptorQ 编解码封装（纯逻辑）
│   ├── qr-protocol/            #   帧格式 / 分块 / 压缩 / CRC / QR 矩阵 / 会话 ID
│   └── transfer-engine/        #   编排 / 状态机 / 进度 / 断点 + WASM&JNI 绑定
├── apps/
│   ├── sender/                 # 浏览器扩展（Plasmo + React + TS + Vite + WASM）
│   │   ├── src/                #   TS 源码（页面 / WASM 桥 / 压缩 worker）
│   │   ├── wasm-pkg/           #   wasm-pack 产物（generated, git-ignored）
│   │   ├── assets/             #   扩展图标
│   │   └── scripts/            #   构建 / manifest 修正 / lzma-wasm 提取
│   └── scanner/                # Android App（Kotlin + CameraX + ZXing-C++）
│       └── app/src/main/
│           ├── java/com/airferry/app/   # Kotlin
│           ├── cpp/                     # ZXing-C++ JNI 桥（CMake）
│           └── jniLibs/arm64-v8a/       # Rust .so（cargo-ndk 产物, git-ignored）
├── docs/                       # 协议 / 架构 / API / 构建说明（中文）
├── scripts/build-all.sh        # 一键构建脚本
├── Cargo.toml                  # Rust workspace 根配置
└── dist/                       # 发布产物 + 签名密钥（git-ignored）
```

---

## 2. 快速构建命令

### 2.1 核心库（Rust）

```bash
# 全部单元 + 集成测试（根目录）
cargo test

# 含 diag_* 基准测试（默认 #[ignore]）
cargo test -- --ignored

# 仅构建
cargo build            # 或 cargo build --release
```

> 集成测试位于 `core/transfer-engine/tests/`：`e2e.rs`（端到端恢复 + 丢帧/乱序/重复）、`compress_pipeline.rs`（压缩往返）、`wasm_interop.rs`（跨语言，需先跑 `wasm_dump_frames.mjs` 生成 `frames.bin`/`payload.bin`）、`filemeta_check.rs`（元数据往返）；`diag_*.rs` 为性能/复现基准。

### 2.2 浏览器发送端（apps/sender）

```bash
cd apps/sender
npm install            # 首次（含 postinstall: 提取 lzma-wasm）

# ① 先构建 WASM（必须是扩展构建的前置）
npm run wasm
#   等价: wasm-pack build ../../core/transfer-engine --target web --features wasm,serde
#         && rm -rf wasm-pkg && cp -r ../../core/transfer-engine/pkg wasm-pkg
#   产物: apps/sender/wasm-pkg/transfer_engine*.js + *_bg.wasm
#   说明: `wasm` feature 已隐含 `serde`（见 core/transfer-engine/Cargo.toml），
#         故 `serde` 显式写出是冗余但无害的；后半段把产物从 pkg/ 搬到 wasm-pkg/。

# ② 构建扩展（全部 4 个目标，会自动先跑 extract-lzma-wasm）
npm run build
#   产物: apps/sender/build/{chrome,firefox}-{mv2,mv3}-prod/

# 单独构建某个目标
npm run build:chrome-mv3     # 或 :chrome-mv2 / :firefox-mv3 / :firefox-mv2

npm run dev                  # Plasmo HMR 开发模式
```

| 目标目录 | 支持浏览器 |
|---------|-----------|
| `chrome-mv3-prod` | Chrome / Edge（MV3） |
| `chrome-mv2-prod` | Chrome / Edge（MV2 遗留） |
| `firefox-mv3-prod` | Firefox 109+ |
| `firefox-mv2-prod` | Firefox 91+ |

### 2.3 Android 扫码端（apps/scanner）

```bash
# ① 先构建 Rust JNI 库（cargo-ndk，必须是 APK 构建的前置）
cargo ndk -t arm64-v8a \
  -o apps/scanner/app/src/main/jniLibs \
  build -p transfer-engine --features jni --release
#   产物: apps/scanner/app/src/main/jniLibs/arm64-v8a/libtransfer_engine.so

# ② 构建 APK
cd apps/scanner
./gradlew :app:assembleDebug      # 调试 APK
./gradlew :app:assembleRelease    # 发布 APK（用 keystore.properties 签名，缺失则回退 debug 签名）
#   产物: app/build/outputs/apk/{debug,release}/app-*.apk

adb install app/build/outputs/apk/release/app-release.apk
```

> ZXing-C++（`libairferry_zxing.so`）由 Gradle 的 CMake 任务在首次 APK 构建时从 GitHub 拉取 v3.0.2 自动编译（需网络；缓存后离线可用）。
> **16 KiB 页对齐**：Android 15+ 的 16 KiB 页设备会拒绝 `dlopen` 仅 4 KiB 对齐的 `.so`（表现：所有 QR 解码静默失败）。`cpp/CMakeLists.txt` 用 `-Wl,-z,max-page-size=16384` 强制对齐；Rust `.so` 由 cargo-ndk 默认对齐。验证：`llvm-readelf -l lib*.so | grep LOAD`（Align 列应为 `0x4000`）。

### 2.4 一键脚本 `scripts/build-all.sh`

| 子命令 | 动作 | 是否自动跑 cargo-ndk |
|--------|------|---------------------|
| `all`（默认） | `build_sender` + `build_scanner` | ✅ |
| `sender` | WASM + 扩展 4 目标 | — |
| `scanner` | `cargo ndk` 编译 `.so` → `./gradlew assembleRelease` | ✅ |
| `wasm` | 仅 `npm run wasm` | — |
| `dist` | **仅打包**：把已构建的 `build/` + APK 复制/签名到 `dist/`（不重新构建） | — |
| `release` | `build_sender` → `build_scanner` → `pack_dist`（全量构建 + 打包） | ✅ |

```bash
./scripts/build-all.sh              # 构建 sender + scanner（不打包）
./scripts/build-all.sh release      # 全量构建 + 打包到 dist/（最常用）
./scripts/build-all.sh dist         # 仅打包（假设已构建好，不重新编译）
./scripts/build-all.sh sender       # 仅浏览器端（含 WASM）
./scripts/build-all.sh scanner      # 仅 APK
./scripts/build-all.sh wasm         # 仅 WASM
```

**脚本行为要点**（权威源 `scripts/build-all.sh`）：
- **版本号**：从 `apps/sender/package.json` 的 `version` 读取（`read_version()`），与扩展 manifest 同源。改版本改这一处即可被脚本读取，但 APK/扩展本身的版本号仍需手动同步（见 §2.5）。
- **`build_scanner` 自动跑 cargo-ndk**：在 `./gradlew assembleRelease` **之前**先用 `cargo ndk -t arm64-v8a ... build -p transfer-engine --features jni --release` 编译 `libtransfer_engine.so` 到 `jniLibs/`。这是为了避免打进过期 `.so`（AirFerry 重命名后旧符号 `com.easytransfer.*` 与 Kotlin 新包名对不上会 `UnsatisfiedLinkError` 闪退）。因此 `scanner`/`all`/`release` 子命令都自带这步，无需手动前置。
- **Chrome crx 签名**：调用 macOS Chrome 的 `--pack-extension` + `--pack-extension-key`。私钥固定在 `dist/airferry-extension.pem`——**首次运行自动生成并挪到此处，之后 MV2/MV3 复用同一私钥**，保证扩展 ID 稳定。找不到 Chrome 二进制时跳过 crx、仅留 zip。
- **`pack_dist` 会清旧产物**：删 `dist/airferry-{android-*.apk,sender-*.crx,sender-*.zip,sender-*.xpi}`，但**不动** `*.pem` 和 `*.keystore`。

### 2.5 构建目录布局

三层产物目录，**全部 git-ignored**（见 `.gitignore`）：

```
源码 ──构建──► 中间产物目录 ──打包──► dist/（发布）
```

| 目录 | 内容 | 来源 | git-ignored |
|------|------|------|-------------|
| `apps/sender/wasm-pkg/` | WASM 编译产物（`transfer_engine*.js` + `*_bg.wasm` + `.d.ts`）；内含 `.gitignore` 为 `*`（全忽略） | `npm run wasm` | ✅ |
| `apps/sender/build/` | Plasmo 扩展构建产物：`{chrome,firefox}-{mv2,mv3}-prod/` 四个目录 + 构建期生成的 `.crx`/`.xpi`/`.zip` | `npm run build` | ✅ |
| `apps/scanner/app/build/` | Gradle/APK 构建产物：`outputs/apk/{debug,release}/app-*.apk` + native-debug-symbols + baselineProfiles | `./gradlew` | ✅ |
| `apps/scanner/app/src/main/jniLibs/arm64-v8a/` | Rust 编译的 `libtransfer_engine.so` + 遗留的 `libet_code.so`（**当前代码无任何 `System.loadLibrary("et_code")` 引用，未使用，建议清理**）。ZXing 的 `libairferry_zxing.so` 不在此处——由 CMake 在 APK 构建时直接编译进 APK | `cargo ndk ... build` | ✅ |
| `dist/` | 发布归档 + 签名材料（`*.pem` Chrome 私钥、`airferry-release.keystore`） | `pack_dist` | ✅ |
| `target/` | Rust 编译缓存（workspace 共享） | `cargo` | ✅ |

> 构建产物**绝不提交 git**。分发走 GitHub Release，产物放 `dist/`。

### 2.6 产物格式与命名规范

发布归档（`dist/`）的命名格式 = `airferry-{端}-{平台}-v{版本}.{扩展}`：

| 产物 | 命名格式 | 格式说明 |
|------|---------|---------|
| Android APK | `airferry-android-v{VER}.apk` | arm64-v8a 单 ABI；Android 10+（minSdk 29）；用 `apps/scanner/keystore.properties` 指向的 keystore 签名（缺失则回退 debug 签名） |
| Chrome MV3 | `airferry-sender-chrome-mv3-v{VER}.crx` + `.zip` | `.crx` = Cr24 签名格式（Chrome 88+/Edge 88+，可拖拽安装）；`.zip` = 解压目录打包（商店外安装被拦截时的回退） |
| Chrome MV2 | `airferry-sender-chrome-mv2-v{VER}.crx` + `.zip` | 同上，旧版兼容 |
| Firefox MV3 | `airferry-sender-firefox-mv3-v{VER}.xpi` | Firefox 109+；`.xpi` 本质是 zip 改名 |
| Firefox MV2 | `airferry-sender-firefox-mv2-v{VER}.xpi` | Firefox 91+ |

**扩展产物内部结构**（每个 `*-prod/` 目录）：
- `manifest.json`——由 `scripts/fix-manifest.cjs` 后处理：复制真实 RGBA 图标覆盖 Plasmo 占位图、MV2 删 `action` 留 `browser_action` 并把 CSP 改为 `wasm-eval`、Firefox 补 `browser_specific_settings.gecko.id = airferry@airferry.app`、修补 HTML `<title>`
- `transfer_engine_bg.wasm` + `wasm-zstd.wasm` + `lzma-wasm.wasm`——运行时加载的 WASM 模块
- 图标 `icon{16,32,48,64,128}.png`

> MV2 与 MV3 用同一 Chrome 签名私钥打包会得到**相同的扩展 ID**（`nboajkjpabbekenmadidokmefholfmfk`），便于升级替换。

### ⚠️ 关键依赖顺序（最容易踩的坑）

1. **WASM 必须先于扩展构建**：`npm run build` 不自动跑 `npm run wasm`，扩展构建前 `wasm-pkg/` 必须存在。（`build-all.sh sender/release` 会自动先跑 WASM。）
2. **JNI `.so` 必须先于 APK 构建**：`cargo ndk ... build` 产出 `libtransfer_engine.so` 到 `jniLibs/` 后，`./gradlew` 才能打包进 APK。**`build-all.sh` 的 `scanner`/`all`/`release` 子命令会自动先跑 cargo-ndk**（见 §2.4），所以走脚本不会踩坑；但**若单独手动跑 `./gradlew`**（不经脚本），必须自己先跑 cargo-ndk，否则 APK 会带过期/缺失的 `.so`、扫码端运行时 `UnsatisfiedLinkError` 闪退。
3. **`dist` 子命令不重新构建**：它假设 `apps/sender/build/` 与 APK 已就绪，只做复制/签名/打包。缺产物会 `error` 退出。
4. **版本号三处同步**：`build-all.sh` 的发布文件名版本取自 `apps/sender/package.json`，但 APK 自身的 `versionName`（`build.gradle.kts`）和 Rust crate 版本（`Cargo.toml`）需手动保持一致。改版本时改 `package.json`（→ 文件名）+ `build.gradle.kts`（→ APK 内嵌）+ `Cargo.toml`（→ 核心库），三者一起改。

---

## 3. 代码导航地图（file:line 索引）

### 3.1 核心库热路径

| 关注点 | 位置 | 说明 |
|--------|------|------|
| 编码器（源符号 O(1) + 按需修复） | `core/raptorq-core/src/encoder.rs:63,73` | `source_symbol` / `repair_symbols` |
| 解码器（任意顺序符号 + 块满即解） | `core/raptorq-core/src/decoder.rs:64` | `add_symbol`，含 ESI/载荷越界守卫(line 78) |
| **安全闸门** OTI 校验 | `core/raptorq-core/src/meta.rs:97` | `ObjectMeta::validate`——接收前必跑，防 panic-on-abort |
| **帧解析热点** | `core/qr-protocol/src/frame.rs:122` | `Frame::from_bytes`：magic/version/双层 CRC 校验 |
| 帧封装 | `core/qr-protocol/src/frame.rs:71,109` | `build` / `to_bytes` |
| 会话 ID 派生（FNV-1a 128） | `core/qr-protocol/src/session.rs:23` | `derive`——必须与 TS 端位一致 |
| 压缩分发 + 解压炸弹防护 | `core/qr-protocol/src/compress.rs:68,97` | `compress_with` / `decompress_with_limit` |
| QR 矩阵（动态最小版本） | `core/qr-protocol/src/qr_render.rs:74` | `encode`：576B帧→V16，1088B帧→V23 |
| **发送端帧流入口** | `core/transfer-engine/src/sender.rs:164` | `next_frame`：每16帧插描述符，首帧即描述符 |
| 无限新鲜修复符号 | `core/transfer-engine/src/sender.rs:235` | `next_symbol_id`：源一遍→无限新修复 |
| **接收端摄入入口** | `core/transfer-engine/src/receiver.rs:147` | `ingest`：缓存引导→描述符确认 OTI→喂解码器 |
| 描述符载荷解析 | `core/transfer-engine/src/descriptor.rs:178` | `parse_payload`：v1/v2/v3 + v2/v3 消歧 |
| 进度快照 | `core/transfer-engine/src/progress.rs` | `Progress` / `Stats` |
| 断点状态序列化 | `core/transfer-engine/src/resume.rs` | `ResumeState`（serde-gated） |
| **JNI 绑定（Android）** | `core/transfer-engine/src/jni.rs:68` | `receiverIngest` 返回**packed jlong**（非 JSON，见 SPEC） |
| **WASM 绑定（浏览器）** | `core/transfer-engine/src/wasm.rs:86` | `next_qr`：帧+QR 编码一次调用 |

### 3.2 浏览器发送端

| 关注点 | 位置 | 说明 |
|--------|------|------|
| 主应用（4 页路由） | `apps/sender/src/options.tsx:92` | select→params→play→stats |
| popup（仅启动器） | `apps/sender/src/popup.tsx` | 打开 options 新标签页 |
| **QR 渲染循环** | `apps/sender/src/components/QrStream.tsx:37` | Canvas2D rAF 驱动 `next_qr`/`next_qr_multi` |
| 单次 putImageData 绘制 | `apps/sender/src/components/QrStream.tsx:239` | `drawMatrix`：避免逐模块 fillRect |
| **三算法选优压缩** | `apps/sender/src/wasm/compress.ts:277` | `preparePayload`：raw/zstd/xz，早期退出阈值 **70%** |
| 压缩 worker（离主线程） | `apps/sender/src/workers/compress.worker.ts` | 读→压缩→CRC32→会话 ID |
| WASM 加载器 | `apps/sender/src/wasm/loader.ts:14` | `ensureWasm` 一次性初始化 |
| 会话 ID（TS 端，镜像 Rust） | `apps/sender/src/wasm/session.ts:17` | `deriveSessionId` |
| 多文件容器 | `apps/sender/src/wasm/bundle.ts` | 打包格式 |
| 4 个页面 | `apps/sender/src/pages/*.tsx` | FileSelect / Params / Play / Stats |
| manifest 后处理 | `apps/sender/scripts/fix-manifest.cjs` | 图标/MV2 CSP/Firefox id |

### 3.3 Android 扫码端

| 关注点 | 位置 | 说明 |
|--------|------|------|
| Activity / 管线编排 | `app/.../ui/ScanActivity.kt:60` | owns 管线、相机绑定、摄入线程 |
| CameraX 生产者（非阻塞） | `app/.../scan/QrStreamAnalyzer.kt:16` | 拷贝 Y 平面入队后立即 close |
| **并行解码 + 串行摄入** | `app/.../scan/QrDecodePool.kt:27` | N worker(2-6) + `ingestLock` 串行化 |
| 多码 ROI 解码追踪 | `app/.../scan/QrDecodePool.kt:277` | `decodeMultiTracked` |
| **Rust JNI 桥（Kotlin）** | `app/.../nativelib/NativeBridge.kt` | `receiverIngest` 返回 Long |
| **接收会话管理器** | `app/.../scan/ReceiverSessionManager.kt:17` | 仅从描述符初始化；`IngestStatus.unpack`(line 67) |
| 帧头解析（Kotlin 侧） | `app/.../scan/ReceiverSessionManager.kt:98` | `parseHeader`：60B 大端 |
| ZXing JNI 桥（Kotlin） | `app/.../scan/ZxingDecoder.kt` | 单码/多码/ROI 解码 |
| **ZXing-C++ JNI（native）** | `app/src/main/cpp/scan_jni.cpp:52` | `decodeInView`：TryHarder+TryInvert |
| 多文件包解包 | `app/.../scan/BundleParser.kt` | 恢复后拆包 |
| UI | `app/.../ui/{ReceiveDetail,ReceiveBundle,FileList,Settings}Activity.kt` | 详情/列表/设置 |

---

## 4. 调试速查表（症状 → 首查位置）

| 症状 | 首查 | 可能原因 |
|------|------|---------|
| 收端卡「恢复中 0%」 | `descriptor.rs:178 parse_payload` + `receiver.rs:147 ingest` | OTI 未确认（`meta_confirmed=false`）；描述符解析失败 |
| 收端崩溃（扫码即崩） | `meta.rs:97 validate` + `receiver.rs:208-222` 守卫 | 恶意/越界坐标未在入解码器前拦截（panic=abort 下致命） |
| 进度越往后越慢 | `sender.rs:235 next_symbol_id` | 必须是「源一遍→无限新鲜修复」，不能循环有限计划 |
| 帧被静默丢弃 | `frame.rs:122 from_bytes` | magic/version/双层 CRC 校验失败 |
| 恢复出空文件 | `descriptor.rs` v2/v3 消歧(line 173) + `compressed_size_known` | v3 尾部被误读为 v2 补零 |
| 解压 OOM / 崩溃 | `compress.rs:97 decompress_with_limit` | 炸弹上限未封顶到 `original_size` |
| JNI 摄入竞态/UAF | `QrDecodePool.ingestLock` + `ScanActivity` `ingestStopped` | 句柄非线程安全，未串行化 |
| 摄像头读不出码 | `qr_render.rs:74 encode`（版本选择）+ `scan_jni.cpp:64`（TryHarder） | 版本过高致模块过密；或 16KiB 页未对齐致 .so 加载失败 |
| 压缩总是走 raw（100%） | `compress.ts:163 initZstdFromBytes` | worker 内 zstd WASM 未加载成功 |
| 扩展构建缺 WASM | `apps/sender/wasm-pkg/` | 忘了先 `npm run wasm` |
| APK 缺 native 库 | `jniLibs/arm64-v8a/libtransfer_engine.so` | 手动跑 `./gradlew` 而未经 `build-all.sh`（后者已自动先跑 cargo-ndk） |

---

## 5. 文档与代码偏差清单（AI 高风险，务必注意）

> 调研发现多处文档滞后于代码。**修改/引用时一律以代码为准**。下面是已确认的偏差：

1. **`docs/api.md` JNI 签名过时**：
   - 写 `receiverIngest` 返回 `ByteArray?`（进度 JSON）—— **实际返回 packed `jlong` 位域**（`jni.rs:68`）。位布局见 [`docs/SPEC.md`](docs/SPEC.md) §JNI ingest 状态字。Kotlin 侧 `IngestStatus.unpack`（`ReceiverSessionManager.kt:67`）镜像此布局。
   - 写 `receiverAssemble(handle, outBuf): Int` —— **实际是 `receiverAssembleBytes(handle): ByteArray`**（原子返回完整字节，修复了 >2GB 截断 + 长度/填充竞态）。

2. **压缩参数（两端不同，勿混为一谈）**：
   - **浏览器发送端**（`apps/sender/src/wasm/compress.ts:55-64`）：Zstd **level 1**、Xz **level 9**、early-exit 阈值 **70%**（`e10079d`/`c2ae4a2` 提交已调；三算法选优 raw/zstd/xz）。
   - **Rust 核心库**（`core/qr-protocol/src/compress.rs:25,48`）：Zstd **level 22**（`DEFAULT_LEVEL`）、Xz **level 6 + EXTREME**（`XZ_PRESET`）。
   - 两端用不同级别是**有意的**：发送端追求压缩启动快（Lv1），接收端只做解压、用高 ratio（见 `compress.rs:42-44` 的 NOTE）。两端产物是标准 zstd/xz 流，互操作正确。引用压缩参数时**必须分清是 TS 端还是 Rust 端**，不要合并描述。

3. **版本号/Release 混用**：三处版本均为 `1.0.0`，但 README 与 dist 历史里出现过 v1.0.0/v1.1.0 混用。改版本时三处同步，且 `scripts/build-all.sh` 的 release 打包文件名需同时改。

4. **高速录制模式为死代码**：`HighSpeedCaptureController.kt`、Settings 里的高速开关、`docs/architecture.md`/`data-flow.md` 的「实验性高速录制」段落——**当前代码中已禁用**（`ScanActivity` onCreate 中 `highSpeedEnabled = false`，UI 分支 `if (highSpeed)` 永不渲染）。文档仍当可用功能描述。

5. **`derive_meta_from_totals` 已废弃**：`receiver.rs:422`，仅保留 JNI ABI 兼容，**新代码勿调用**（其 OTI 构建在大文件上会 assert）。现代路径：从描述符帧拿权威 OTI。

---

## 6. 架构关键不变量（速览，详见 [`docs/SPEC.md`](docs/SPEC.md)）

- **同一份 Rust 源码** → 两个 FFI 目标：浏览器 `wasm32-unknown-unknown`（wasm-bindgen）、Android `aarch64-linux-android`（`#[no_mangle] extern "system"`）。编解码数学一致。
- **帧格式**：`[Header 60B][Payload T][Footer 4B]`，大端，magic `0x4554`，version 1，双层 CRC32；T=symbol_size（浏览器默认 1400——`DEFAULT_CONFIG.symbolSize`，核心库默认 1024——`Config::default()`）。
- **会话 ID**：FNV-1a 128-bit（name/size/mtime/指纹），确定性 → 断点恢复。Rust 与 TS 实现必须位一致。
- **喷泉码发射**：源符号跨块轮询发一遍 → 无限新鲜修复符号（ESI 单调递增、永不重复）。进度近似线性，无 coupon-collector 拖尾。
- **接收端安全生命线**：`panic = "abort"` 构建，任何 panic = 进程崩溃。`ObjectMeta::validate` + `decompress_with_limit` 是把恶意/越界输入挡在解码器前的防线。
- **线程模型**：原生 receiver 句柄**非线程安全**。Android 用一把 `ingestLock` 串行化所有摄入；ZXing 解码在 N 个 worker 上并行。

---

## 7. 约定

- **语言**：文档、提交信息均用中文；代码注释中英混合（Rust 偏英文 doc-comment，TS 偏英文）。
- **构建 profile**：`release` 用 `opt-level="z"` + LTO + `panic="abort"`（求小体积）；但热路径 crate（raptorq-core / qr-protocol / raptorq / qrcode / crc32fast / transfer-engine）单独提升到 `opt-level=3`（见 `Cargo.toml`）。
- **不提交产物**：`target/`、`wasm-pkg/`、`build/`、`dist/`、`*.so`、`*.apk`、`*.pem`、`*.keystore` 均在 `.gitignore`。
- **修改帧/协议字段**：两端（Rust + TS + Kotlin）必须同步；更新 [`docs/SPEC.md`](docs/SPEC.md) 的位级规格。

## 8. 权威文档索引

| 主题 | 文档 |
|------|------|
| 跨端契约（位级不变量） | [docs/SPEC.md](docs/SPEC.md) |
| 协议规范 | [docs/protocol.md](docs/protocol.md) |
| 帧格式 | [docs/qr-frame-format.md](docs/qr-frame-format.md) |
| RaptorQ 参数 | [docs/raptorq-params.md](docs/raptorq-params.md) |
| 系统架构 | [docs/architecture.md](docs/architecture.md) |
| 数据流 | [docs/data-flow.md](docs/data-flow.md) |
| API 参考（⚠️ JNI 部分已过时，见 §5） | [docs/api.md](docs/api.md) |
| 构建指南 - 浏览器 | [docs/build-browser.md](docs/build-browser.md) |
| 构建指南 - Android | [docs/build-android.md](docs/build-android.md) |
| 开发环境搭建 | [docs/dev-setup.md](docs/dev-setup.md) |
