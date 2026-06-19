# QR 帧格式规范 (QR Frame Format)

## QR 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| Version | **动态最小版本** | 按每帧字节长选能容纳的最小版本（见下） |
| 纠错级别 | L | 最低冗余，最大化数据容量 |
| 传输模式 | Binary | 二进制模式 |
| 帧长 | 60 + T + 4 字节 | Header + Payload(=symbol_size) + Footer |

发送端不再固定使用 Version 40。`qr_render::encode` 调用 `min_version_for(len)` 选取能容纳整帧字节的**最小** EC-L 版本：版本越低、模块越大越稀疏，手机摄像头越容易解析。由于一次会话内帧长恒定，每帧渲染为相同版本，屏幕上的 QR 尺寸稳定。

| symbol_size | 整帧字节 | 选定版本 | 模块数 |
|-------------|---------|---------|--------|
| 512（浏览器默认） | 576 | V16 | 81×81 |
| 1024（核心库默认） | 1088 | V23 | 109×109 |

> 历史教训：曾对每帧强制 Version 40（177×177，最密），导致每个模块占用的摄像头像素过少，数据帧无法解码、接收端卡在「恢复中 0%」。改用最小版本后稳定。

## 帧封装

参见 [protocol.md](protocol.md) 的帧格式定义（Header 60B + Payload T 字节 + Footer 4B，大端序，双层 CRC32）。

## QR 矩阵生成

发送端使用 Rust `qrcode` crate 将帧字节编码为模块矩阵：

```rust
// qr-protocol/src/qr_render.rs
pub fn min_version_for(len: usize) -> Option<Version>  // 最小可容纳版本
pub fn encode(data: &[u8]) -> Result<QrMatrix>          // 选最小版本编码
// 输出：QrMatrix { modules: Vec<bool>, size: usize }
// modules[y * size + x] = true 表示深色模块
```

矩阵通过 WASM 暴露给浏览器（`encode_qr` 函数），Canvas 逐行游程绘制（run-length，减少 draw call）。

## 渲染优化

浏览器扩展的 Canvas 渲染器实现：

| 优化 | 实现 |
|------|------|
| Quiet Zone | 4 模块边距（QR 规范要求） |
| 黑白对比 | 纯黑 `#000000` + 纯白 `#ffffff` |
| 自动亮度 | `filter: brightness(≥1.15)` 屏幕增亮 |
| 自动对比 | `filter: contrast(1.1)` |
| 游程绘制 | 同行连续深色模块合并为一次 `fillRect` |
| 稳定缓冲 | 仅在目标尺寸变化时重置 canvas 背景缓冲（避免 60fps 下周期性卡顿） |
| 全屏 | Fullscreen API，消除浏览器 UI 干扰 |

## 帧率控制

| 模式 | FPS | 说明 |
|------|-----|------|
| 稳定 | 30 | 弱环境/老设备 |
| 推荐 | 45（默认） | 扫描可靠性与吞吐的平衡 |
| 高速 | 60 | 配合接收端并行解码 |

通过 `requestAnimationFrame` + 时间间隔节流实现精确帧率，并带防失速保护（落后超过 ~2 帧时对齐到当前时间，避免连发补帧的级联降速）。接收端摄像头建议以 ≥2× 发送帧率采集，才能稳定抓到每个不同帧。
