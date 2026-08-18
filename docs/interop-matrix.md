# AF2 三端互操作矩阵（计划 F1）

> 验收对象：AF2 单协议（`AF` / wire 2）在 Rust 核心 / Web（WASM）/ Android / Windows
> 四端的线格式一致性。执行载体：`node scripts/check-interop.mjs`（自动化套件）+ 下表人工验收清单。
> 协议语义的唯一权威是 Rust 核心（`core/af2/` + `core/testdata/af2/manifest.json` golden vectors）。

---

## 1. 自动化矩阵（每次提交可跑）

| 端 | 套件 | 覆盖 |
|---|---|---|
| Rust 核心 | `cargo test --workspace` | 帧/ROOT/META/Manifest/TLV 编解码、三层 ID 推导、OTI-only RaptorQ 往返、三 codec × 边界尺寸、乱序/重复/丢帧/任意点加入、跨实例不混流、Manifest 后到暂存复核、§12 resume/虚报治愈、golden vectors 全量往返（唯一权威） |
| Web (WASM) | `npm run typecheck` + `npm test` | golden vectors 帧头级断言（magic/版本/ID 宽度/线常量）+ 发送端 TS 面类型闭合 |
| Android | `./gradlew :app:testDebugUnitTest` | golden vectors 帧头级 + JNI 状态字契约 + §12 崩溃间隙（spill 截断可探测、账本 torn-tail、头原子性） |
| Windows | `dotnet test` | golden vectors 帧头级 + C-ABI 状态字契约 + §12 崩溃间隙（同上） + 落盘命名清洗 |
| 全局 | `node scripts/version.mjs check` | 版本位点一致（根 Cargo.toml 为事实源） |

## 2. 物理链路人工验收清单（CI 无法自动化）

发送端只有一个产品实现（Web/扩展，WASM）；接收端三端。以下每行 = 一次人工验证，
记录（日期、发送端构建、接收端构建、结果）。**换协议字节后必须重跑本清单。**

| # | 场景 | 发送 | 接收 | 通过标准 |
|---|---|---|---|---|
| 1 | 单文件基线（~10 MiB 随机） | Web | Android / Windows / Web | 恢复文件 SHA-256 与原件一致 |
| 2 | UTF-8 文字消息 | Web | 三端 | 文本逐字节一致 |
| 3 | 多文件 + 目录层级（含中文/NFC 路径） | Web | 三端 | 路径与内容一致；Windows 保留名被清洗 |
| 4 | 大文件跨块（> 8 MiB 多 chunk，如 100 MiB） | Web | 三端 | 全部 chunk 完成、终验通过 |
| 5 | 中途加入（播到一半才开始扫码） | Web | 三端 | 仍能收敛恢复（自举闭合） |
| 6 | 断点续传：接收 50% 后杀进程重启 | Web | Android / Windows | ledger + spill 恢复，续传完成 |
| 7 | 崩溃间隙：重启后损坏 spill 中一块 | Web | Android / Windows | 虚报位被清，重收该块后完成 |
| 8 | 换参重播：同内容换 T / codec 重发 | Web | 三端 | 已完成块复用、未完成 Decoder 不混流 |
| 9 | 恶意输入：v1 (`ET`) 帧、坏 CRC、超长 TLV | — | 三端 | fail-closed 拒绝；v1 帧提示"对端版本过旧" |
| 10 | 同 chunk 两编码实例交替播放 | Web | 三端 | 路由层不混流（object_id 绑定） |

## 3. 已知边界（已记录决策，非缺陷）

- **Web 发送端压缩实现**（SPEC §13）：Web (wasm32-unknown-unknown) 发送端通过纯 Rust 的 `zrip` (Zstd) 和 `lzma-rust2` (XZ) 进行压缩选优，严格遵守 §7.1“严格变小才压缩”的双端不变量。
- **物理链路依赖 FAST ZXing**（FAST-only）：`airferry_zxing.js/.wasm` 缺失时构建直接失败，不存在降级路径（SPEC §5 / 阶段 B3）。
- **跨端一致性分层**：宿主只做帧头级断言 + 路由（协议语义收敛在 Rust）；宿主镜像解析线格式是禁止项（SPEC §9）。
