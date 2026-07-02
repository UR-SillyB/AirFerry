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
