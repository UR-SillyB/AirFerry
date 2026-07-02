# AFGrid V3 合并前检查清单

分支：`feature/afgrid-v3`（提交 `a4e5288`、`00cd49e` 及后续）

## 目标对照（V3 计划）

| # | 交付项 | 自动化证据 | 人工/环境证据 |
|---|--------|------------|----------------|
| 1 | AFGrid 编码（单大码、RS+交织） | `cargo test -p qr-protocol afgrid` ✅ | — |
| 2 | WASM 发送 `next_qr*` 走 AFGrid | `matrix_encode.rs` + default `afgrid` feature | `cd apps/sender && npm run wasm`（本仓库已跑通） |
| 3 | symbol_size 连续可调 UI | `types.ts`/`ParamsPage.tsx`/`afgrid.ts` | 浏览器目视 |
| 4 | 接收 Rust 解码 + JNI/C ABI | `afgridDecodeY` / `airferry_afgrid_decode` | — |
| 5 | expected_side ↔ symbol_size | Android 设置+ScanActivity；Windows 设置+ScanViewModel | 两端数值一致 |
| 6 | 软件 E2E（5600B） | `afgrid_e2e`、`gray_roundtrip_synthetic` ✅ | — |
| 7 | 编码性能验证 | `diag_afgrid bench_afgrid_vs_qr_5600 -- --ignored` | ~2.8ms vs ~52ms/屏 |
| 8 | Android `libtransfer_engine.so` | — | **须** `ANDROID_NDK_HOME` + `cargo ndk ... jni,afgrid` |
| 9 | 真机 E2E 5600B | — | 发送/接收 symbol_size=5600，恢复文件 |
| 10 | Windows `dotnet test` | — | **须** Windows + .NET 8 SDK |
| 11 | 完整 L1 透视 imageproc | 文档标明 ⏳ 未达 | 后续迭代 |
| 12 | 文档留存 | `docs/afgrid-format.md`、本清单、`AGENTS.md` | — |

## 一键（本机可跑部分）

```bash
./scripts/verify-afgrid-v3.sh
```

## Android JNI（无 NDK 时失败属预期）

```bash
export ANDROID_NDK_HOME="$HOME/Library/Android/sdk/ndk/<version>"   # 或 Studio 安装的 NDK
cargo ndk -t arm64-v8a -o apps/scanner/app/src/main/jniLibs \
  build -p transfer-engine --features jni,afgrid --release
./gradlew :app:assembleDebug   # 在 apps/scanner
```

## 真机 E2E（symbol_size=5600）

1. **发送端**：传输参数 → 大码 5600B 或滑块 5600，`multiQr=1`。
2. **Android 接收**：设置 → AFGrid 每码数据量 **5600**（边长应 ≈226）→ 扫码页。
3. **Windows 接收**：设置 → AFGrid **5600** → 扫描。
4. 成功：进度前进、描述符确认、文件/文字恢复；失败：查 logcat / 边长是否一致。

## Windows 测试

```powershell
.\scripts\build-windows.ps1
cd apps\windows; dotnet test
```

## 合并建议

- [ ] `./scripts/verify-afgrid-v3.sh` 通过  
- [ ] `libtransfer_engine.so` 已构建并打进 APK（或 Release 流水线）  
- [ ] 至少一端真机 AFGrid 5600 扫码成功（记录日期/机型）  
- [ ] Windows `dotnet test` 通过（在 Windows CI/本机）  
- [ ] 接受 L1 透视为 V3.1 范围，不阻塞合并  

