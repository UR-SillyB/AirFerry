# AFGrid V3 合并前检查清单

分支：`feature/afgrid-v3`

## 目标对照（V3 计划）

| # | 交付项 | 自动化证据 | 人工/环境证据 |
|---|--------|------------|----------------|
| 1 | AFGrid 编码 | `cargo test -p qr-protocol afgrid` | ✅ |
| 2 | WASM AFGrid | `matrix_encode` + `afgrid` default | `npm run wasm` |
| 3 | symbol_size UI | sender + Android/Windows 设置 | ✅ |
| 4 | JNI/C ABI 解码 | `jni.rs` / `cffi.rs` | ✅ 源码 |
| 5 | expected_side 联动 | ScanActivity / AfgridSettings | ✅ |
| 6 | 软件 E2E 5600B | `afgrid_e2e` + gray roundtrip | ✅ |
| 7 | 编码性能 | `bench_afgrid_vs_qr_5600 --ignored` | ✅ ~19× |
| 8 | Android `.so` jni+afgrid | CI `afgrid-v3.yml` job `android-jni-ndk` | 本地须 NDK 重编 |
| 9 | 真机 E2E 5600B | — | **人工**（见下） |
| 10 | `dotnet test` | **33 passed**（macOS arm64, .NET 8.0.422, 2026-07-02） | CI `dotnet-protocol` |
| 11 | L1 imageproc 透视 | — | ⏳ V3.1，不阻塞 |
| 12 | 文档 | `afgrid-format.md`、本清单 | ✅ |

## 已记录验证（2026-07-02，开发机）

```text
./scripts/verify-afgrid-v3.sh          → OK
dotnet test (AirFerry.Windows.Tests)   → 33 passed, 0 failed
cargo test (workspace)                 → OK（含 afgrid_e2e）
```

**Android JNI**（本机 2026-07-02：`ANDROID_NDK_HOME=/opt/homebrew/share/android-commandlinetools/ndk/27.0.12077973`，`nm` 含 `afgridDecodeY` / `afgridSideForSymbolSize`，`.so` ~1.17MB）：仓库内 `libtransfer_engine.so` 可能为旧构建；合并前须 CI `android-jni-ndk` 绿或本地：

```bash
export ANDROID_NDK_HOME=...
cargo ndk -t arm64-v8a -o apps/scanner/app/src/main/jniLibs \
  build -p transfer-engine --features jni,afgrid --release
nm .../libtransfer_engine.so | grep -i afgrid
```

**真机 E2E（待填）**：

| 日期 | 发送 symbol_size | 接收设置 | 机型 | 结果 |
|------|------------------|----------|------|------|
| _待测_ | 5600 | 5600 | | |

步骤：发送端 5600 + multiQr=1 → 接收端设置 5600 → 扫码至恢复完成。

## 合并勾选

- [x] `./scripts/verify-afgrid-v3.sh`
- [x] `dotnet test`（协议层 33 项）
- [ ] CI `afgrid-v3` 全 job 绿（push 分支后）
- [ ] `libtransfer_engine.so` 含 afgrid 符号
- [ ] 真机 E2E 一行记录
- [x] 接受 L1 透视为 V3.1
