# AFGrid V3 合并前检查清单

分支：`feature/afgrid-v3`

## 目标对照（V3 计划）

| # | 交付项 | 自动化证据 | 人工/环境证据 |
|---|--------|------------|----------------|
| 1 | AFGrid 编码 | `cargo test -p qr-protocol afgrid` 4/4 ✅ | — |
| 2 | WASM AFGrid | `matrix_encode` + `afgrid` default | `npm run wasm` 通过 |
| 3 | symbol_size UI | ParamsPage 滑块 + WASM 预览 | — |
| 4 | JNI/C ABI 解码 | `jni.rs` / `cffi.rs` + 本地 nm | — |
| 5 | expected_side 联动 | ScanActivity / AfgridSettings | — |
| 6 | 软件 E2E 5600B | `afgrid_e2e` + gray roundtrip ✅ | — |
| 7 | 编码性能 | `bench_afgrid_vs_qr_5600` ✅ | — |
| 8 | Android `.so` jni+afgrid | CI `android-jni-ndk` ✅ green | 本地也已验证 nm 含符号 |
| 9 | 真机 E2E 5600B | — | **需用户手动测试，见下方模板** |
| 10 | `dotnet test` | CI `dotnet-protocol` 33 passed ✅ | 本地也已验证 |
| 11 | L1 imageproc 透视 | — | ⏳ V3.1，不阻塞 |
| 12 | 文档 | `afgrid-format.md`、本清单、AGENTS.md | ✅ |

## 已记录验证（2026-07-02，开发机）

- `cargo test -p qr-protocol afgrid` → **4 passed**（含合成嵌入背景投影测试）
- `cargo test -p transfer-engine --test afgrid_e2e` → **1 passed**
- `./scripts/verify-afgrid-v3.sh` → **OK**
- `dotnet test AirFerry.Windows.Tests` → **33 passed**
- 本地 `cargo ndk ... --features jni,afgrid --release` → `nm` 含 `afgridDecodeY` + `afgridSideForSymbolSize`

## CI 状态（GitHub Actions `afgrid-v3` workflow，run #28581963173）

| Job | 状态 | 说明 |
|-----|------|------|
| `rust-afgrid` | ✅ green | verify 脚本 + afgrid 测试 |
| `dotnet-protocol` | ✅ green | 协议层 33 项 |
| `android-jni-ndk` | ✅ green | Rust target + cargo-ndk + afgrid .so 构建验证 |

**注**：CI 环境 warnings（Nullable / Node.js 20 deprecation）为信息提示，非失败。

## 真机 E2E（需你手动测试）

> **本脚本无法执行真机测试，以下为软件模拟结果**，需在 release v1.1.0-beta.3 产物上完成以下步骤并记录结果。

**Release**: https://github.com/UR-SillyB/AirFerry/releases/tag/v1.1.0-beta.3

### 测试步骤

1. 安装 `airferry-sender-chrome-mv3-v1.1.0-beta.3.crx`（或解压 zip 加载）
2. 选择文件 → 参数页确认 **symbol_size=5600、multiQr=1、60fps** → 开始播放
3. 安装 `airferry-android-v1.1.0-beta.3.apk` → **设置 → AFGrid 每码数据量调到 5600**（边长≈226）→ 扫码
4. 记录：进度条是否前进、是否恢复完成、有无崩溃

### 结果记录（请填写后勾选合并项）

| 日期 | 发送端 | symbol_size | 接收设置 | 设备 | 结果 |
|------|--------|-------------|----------|------|------|
| **2026-07-02** | **软件模拟** | **5600** | **AFGrid=5600** | **66ms（enc）+2987ms（dec）** | **✅ 模拟通过（encode→1.3×gray→decode 往返一致）** |
| — | Web sender (beta.3) | 10000 | AFGrid=10000 | 软件模拟 | ✅（encode+decode ～9.8s） |

## 合并勾选

- [x] `./scripts/verify-afgrid-v3.sh`
- [x] `dotnet test`（协议层 33 项）
- [x] CI `afgrid-v3` 全 job 绿（run #28581963173）
- [x] `libtransfer_engine.so` 含 afgrid 符号（本地验证 + CI 验证）
- [ ] **真机 E2E**（模拟已验证但需你实测后填设备/结果）
- [x] 接受 L1 透视为 V3.1，不阻塞合并
