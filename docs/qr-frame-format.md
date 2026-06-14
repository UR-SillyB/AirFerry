# QR 帧格式规范 (QR Frame Format)

## QR 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| Version | 40 | 最大版本，177×177 模块 |
| 纠错级别 | L | 最低冗余，最大化数据容量 |
| 传输模式 | Binary | 二进制模式 |
| 最大容量 | 2953 字节 | V40-L 二进制容量 |
| 实际帧长 | 1088 字节 | 60 Header + 1024 Payload + 4 Footer |

容量利用率 = 1088 / 2953 ≈ **37%**，保持低模块密度，大幅提升扫描可靠性。

## 帧封装

参见 [protocol.md](protocol.md) 的帧格式定义。

## QR 矩阵生成

发送端使用 Rust `qrcode` crate 将帧字节编码为模块矩阵：

```rust
// qr-protocol/src/qr_render.rs
pub fn encode(data: &[u8]) -> Result<QrMatrix>
// 输出：QrMatrix { modules: Vec<bool>, size: usize }
// modules[y * size + x] = true 表示深色模块
```

矩阵通过 WASM 暴露给浏览器（`encode_qr` 函数），Canvas 逐模块绘制。

## 渲染优化

浏览器扩展的 Canvas 渲染器实现：

| 优化 | 实现 |
|------|------|
| Quiet Zone | 4 模块边距（QR 规范要求） |
| 黑白对比 | 纯黑 `#000000` + 纯白 `#ffffff` |
| 自动亮度 | `filter: brightness(≥1.15)` 屏幕增亮 |
| 自动对比 | `filter: contrast(1.1)` |
| 模块缩放 | 根据 Canvas 尺寸自适应模块像素大小 |
| 全屏 | Fullscreen API，消除浏览器 UI 干扰 |

## 帧率控制

| 模式 | FPS | 目标速率 |
|------|-----|---------|
| 稳定 | 30 | ~50 KB/s+ |
| 高速 | 60 | ~100 KB/s+ |

通过 `requestAnimationFrame` + 时间间隔节流实现精确帧率。
