# AFGrid 自定义码格式（v1 单色）

> 与 QR 并列的显示层编码。帧线格式（60B 头 + payload + 4B 尾）、RaptorQ、双层 CRC 不变。

## 目标

- **单超大码**：默认 `symbol_size=5600`（等价原 4×1400B QR），`multiQr=1`。
- **连续可调**：`symbol_size` 256–16384，边长由公式反算；接收端从帧头/描述符自适应，无需两端约定 QR 版本。

## 矩阵布局

- 1 模块宽边框：顶+左全黑（L 角定位），底+右交替时序边。
- 数据区：模式字(2B) + 完整帧字节 + RS 保护（分块 RS + 4 路交织）。
- 输出契约与 QR 相同：`Vec<bool>` 行主序 + `side`，WASM `next_qr_into` 不变。

## 模式字（2 字节，当前默认）

- v1 / 单色 / 标准方向 / GF256 RS10。未识别 → 解码返回空，RaptorQ 兜底。

## 构建

- Rust：`core/qr-protocol/src/afgrid/`，默认 feature `afgrid`。
- 发送：`transfer-engine` 的 `matrix_encode::encode_frame_matrix` 在 `afgrid` 开启时用 AFGrid。
- 接收：Android `NativeBridge.afgridDecodeY`；Windows `airferry_afgrid_decode` P/Invoke。

## 测试

```bash
cargo test -p qr-protocol afgrid
cargo test -p transfer-engine afgrid_encode_smoke
cargo test -- --ignored bench_afgrid_vs_qr_5600   # 性能对比（可选）
```

## 文档索引

- 导航：`AGENTS.md` §3（afgrid 模块）
- 帧格式不变：`docs/qr-frame-format.md`

## V3 实现状态（feature/afgrid-v3）

| 项 | 状态 |
|----|------|
| 发送端 AFGrid 编码 + 连续 symbol_size UI | ✅ |
| 接收端 Rust 解码（L1 Otsu/中心裁剪 + ±12 side 搜索） | ✅ 软件/合成图 E2E |
| 接收端 expected_side ↔ symbol_size（JNI/C ABI + 设置页） | ✅ |
| 真机透视/反光鲁棒 L1（imageproc 单应性） | ⏳ 未实现，依赖后续迭代 |
| WASM / Android .so 本机构建 | 需在目标机执行下方命令 |

### 构建与验证

```bash
# Rust 测试（含 AFGrid 合成灰度往返）
cargo test -p qr-protocol afgrid
cargo test -p transfer-engine afgrid_encode_smoke

# 发送端 WASM（须 Node + sender 依赖）
cd apps/sender && npm run wasm

# Android JNI（须 NDK）
cargo ndk -t arm64-v8a -o apps/scanner/app/src/main/jniLibs \
  build -p transfer-engine --features jni,afgrid --release

# Windows（须在 Windows + .NET 8）
./scripts/build-windows.ps1
cd apps/windows && dotnet test
```

真机 E2E：发送端 symbol_size=5600、接收端设置同步后扫码；边长由 `afgridSideForSymbolSize` 与发送端公式一致。

## symbol_size 联动

| 端 | 机制 |
|----|------|
| 发送 | `TransferConfig.symbolSize` + `afgridSideForSymbolSize()` 预览 |
| Android 接收 | 设置 → `afgrid_symbol_size` → `NativeBridge.afgridSideForSymbolSize` → `QrDecodePool.afgridExpectedSide` |
| Windows 接收 | `QrDecodePool.AfgridExpectedSide` 默认 `AfgridSideForSymbolSize(5600)`（可改属性） |
| Rust | `qr_protocol::afgrid::side_for_symbol_size` 单一公式 |

解码时 `decode_from_gray` 在 expected_side ±12 模块内搜索，容忍轻微缩放误差。

## 验证记录（开发机）

| 检查项 | 结果 | 日期/说明 |
|--------|------|-----------|
| `./scripts/verify-afgrid-v3.sh` | ✅ 通过 | cargo afgrid + e2e + smoke |
| `npm run wasm` | ✅ 曾通过 | 需发版前重跑 |
| `libtransfer_engine.so` | ⚠️ 仓库内存在旧产物 | **须** `cargo ndk ... jni,afgrid` 后 `nm` 含 `afgrid` |
| `dotnet test` | ⏳ 本机无 dotnet | Windows CI/本机执行 |
| 真机 E2E 5600 | ⏳ 待人工 | 见 `docs/afgrid-merge-checklist.md` |

合并前清单：**[afgrid-merge-checklist.md](./afgrid-merge-checklist.md)**
