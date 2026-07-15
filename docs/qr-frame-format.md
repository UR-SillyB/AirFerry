# QR 帧格式规范 (QR Frame Format)

## QR 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| Version | **动态最小版本** | 按每帧字节长选能容纳的最小版本（见下） |
| 纠错级别 | L | 最低冗余，最大化数据容量 |
| 传输模式 | Binary | 二进制模式 |
| 帧长 | 60 + T + 4 字节 | Header + Payload(=symbol_size) + Footer |

发送端不再固定使用 Version 40。`qr_render::encode` 调用 `min_version_for(len)` 选取能容纳整帧字节的**最小** EC-L 版本：版本越低、模块越大越稀疏，手机摄像头越容易解析。由于一次会话内帧长恒定，每帧渲染为相同版本，屏幕上的 QR 尺寸稳定。

| symbol_size | 整帧字节 (=60+T+4) | 选定版本 | 模块数 |
|-------------|-------------------|---------|--------|
| 512 | 576 | V16 | 81×81 |
| 896 | 960 | V21 | 101×101 |
| 1008 | 1072 | V22 | 105×105 |
| 1024（核心库默认） | 1088 | V23 | 109×109 |
| 1400（浏览器默认，激进预设） | **1464** | **V27** | **125×125** |
| 1900（极速预设） | 1964 | 动态最小 | 见 `min_version_for` |
| 2400（极限预设） | 2464 | 动态最小 | 见 `min_version_for` |

权威源：`core/qr-protocol/src/qr_render.rs`（含 `min_version_for` 与单测：1400 → 125 模块 = V27）。

### 速度预设（浏览器发送端）

UI 把 (symbol_size, fps) 打包成用户选项；默认「激进」实测最快（`apps/sender/src/types.ts` `SPEED_PRESETS` / `DEFAULT_CONFIG`）：

| 预设 id | symbol_size | 推荐 fps | 版本（约） | 说明 |
|---------|-------------|---------|-----------|------|
| stable | 512 | 45 | V16 | 最易扫，弱环境/老设备 |
| fast | 896 | 60 | V21 | 平衡 |
| extreme | 1008 | 60 | V22 | 更密、对焦要求更高 |
| aggressive（默认） | 1400 | 60 | V27 | 实测最快；码密度高 |
| turbo | 1900 | 60 | 更高 | 码密度极高 |
| max | 2400 | 60 | 接近上限 | 接近 V39 一带 |

> 历史教训：曾对每帧强制 Version 40（177×177，最密），导致每个模块占用的摄像头像素过少，数据帧无法解码、接收端卡在「恢复中 0%」。改用最小版本后稳定。

## 帧封装

参见 [protocol.md](protocol.md) 的帧格式定义（Header 60B + Payload T 字节 + Footer 4B，大端序，双层 CRC32）。

## QR 矩阵生成

发送端使用 Rust `fast_qr` crate 将帧字节编码为模块矩阵：

```rust
// qr-protocol/src/qr_render.rs
pub fn min_version_for(len: usize) -> Option<u8>        // 最小可容纳版本（1..=40）
pub fn encode(data: &[u8]) -> Result<QrMatrix>          // 选最小版本编码
// 输出：QrMatrix { modules: Vec<bool>, size: usize }
// modules[y * size + x] = true 表示深色模块
```

矩阵经 WASM（`next_qr_into` / `next_qr_multi_into` 热路径）交给浏览器；Canvas 在 JS 中用 `drawMatrix` 把模块展开为像素后 **单次 `putImageData`** 绘制（见 `apps/sender/src/components/QrStream.tsx`）。

## 渲染优化

浏览器扩展 / 网页端的 Canvas 渲染器实现：

| 优化 | 实现 |
|------|------|
| Quiet Zone | 4 模块边距（QR 规范要求） |
| 黑白对比 | 纯黑 `#000000` + 纯白 `#ffffff` |
| 自动亮度 | `filter: brightness(≥1.15)` 屏幕增亮 |
| 自动对比 | `filter: contrast(1.1)` |
| 像素展开 | `drawMatrix`：模块 → `ImageData`，每码一次 `putImageData`（非逐模块 fillRect） |
| 零拷贝热路径 | `next_qr_*_into` 写入预分配 buffer，跨帧复用 |
| 全屏 | Fullscreen API，消除浏览器 UI 干扰 |

## 帧率控制

| 模式 | FPS | 说明 |
|------|-----|------|
| 低 | 20 | 大码/弱环境 |
| 稳定 | 30 | 弱环境/老设备 |
| 推荐 | 45 | 扫描可靠性与吞吐的平衡 |
| 默认 | 60 | 配合接收端并行解码 |
| 高刷 | 120 | 高刷新率屏幕 |
| 无限制 | 0 | `setTimeout(0)` 驱动，不按 rAF 节流 |

通过 `requestAnimationFrame` + 时间间隔节流（fps>0）实现精确帧率，并带防失速保护。接收端摄像头建议以较高帧率采集，才能稳定抓到每个不同帧。

## 4 码并行模式

默认开启（`multiQr=4`）：同一帧在屏幕上 tile 4 个**不同**的符号（4 个独立 QR），每个 QR 各携带一个 (sbn,esi) 符号。接收端默认开启多码解码（ZXing `decodeMultiple`），一帧读到 4 个符号 → 吞吐 ~4×。代价是每个 QR 更小、更密，对对焦和距离要求更严。UI 里作为开关（开 → 4 码，关 → 单码）；接收端关闭多码时只会读到其中一个码。

## 亚像素抖动 (Dither)

`ditherJitter`（默认**关**）：每帧把每个 QR 随机平移 ±1px，打散 QR 模块网格与摄像头传感器之间的摩尔纹（moiré）。比率影响可忽略、对解码无风险。默认关闭是因为它在远程桌面 / 部分摄像头组合下可能造成闪烁；如遇摩尔纹导致的解码不稳可在设置里打开。
