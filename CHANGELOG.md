# 变更记录 (CHANGELOG)

> 逐版本发布说明（与 GitHub Releases 一致，保留作离线变更史）。

---

## v1.2.7

本版为**接收端**新增两项能力：Windows 端的持续接收模式与网页接收端的屏幕/标签页捕获。传输协议未变，与 v1.2.0–v1.2.6 的 descriptor v5 完全兼容。

### Windows：持续接收模式

- 扫码页新增「持续接收」开关（默认关闭，原有单次接收模式不变）。开启后选择保存文件夹，接收完成**不再跳转结果页、不停止扫描**：文件直接存入所选文件夹并自动准备接收下一份，适合长时间从屏幕持续接收多份文件。持续期间可随时「更改」文件夹或「打开文件夹」。
- **文件去重**（按内容 SHA-256）：同一文件重播不重复保存；目标文件夹里已存在的同名同内容文件也会跳过（跨重启不产生副本）。每次跳过前都会**复验文件夹实际字节**——已保存的文件被删除或修改后，重播会重新保存完整副本，不会误判为重复而丢失恢复机会。
- 多文件包存入独立子文件夹（`发送_MMdd_HHmmss`），整包去重且跨重启有效（包目录内的清单标记记录每个成员的大小与哈希，命中后逐一复验）；写入为事务式，不会留下半成品目录。
- 大文件（>256 MiB 分段传输）跨盘保存采用「目标盘临时复制 → 校验 SHA-256 → 原子改名」流程，U 盘/移动硬盘等异盘场景可靠落盘；保存失败时保留分段恢复记录，可重试恢复。
- 持续接收的文件只存目标文件夹，不占用应用内存储双份磁盘。

### 网页接收端：屏幕 / 标签页捕获

- 进入接收页时的黑色相机框改为**来源选择**：摄像头（原有三级自适应）或屏幕捕获（`getDisplayMedia`，支持整个屏幕/浏览器标签页/窗口，由浏览器选择器决定）。选择后点「开始接收」启动。
- 不支持屏幕共享的设备（手机浏览器等）自动隐藏该选项，界面与旧版一致。
- 屏幕捕获预览完整显示画面（不再裁边），防止二维码位于画面边缘时被裁掉；通过浏览器「停止共享」结束捕获后自动回到来源选择。
- 历史分段任务的「继续恢复」同样支持屏幕捕获来源。
- 修复「开始接收」等主按钮未应用主色样式的问题。

### 版本

- Rust / sender / web / Windows：`1.2.7`
- Android：`versionName 1.2.7`，`versionCode 21`

Windows 端产物由 GitHub Actions CI（`.github/workflows/windows.yml`）在 Release 创建后构建并上传。

---

## v1.2.6

本版整理 Windows 接收结果页的信息层级和操作文案。传输协议未变，与 v1.2.0–v1.2.5 的 descriptor v5 完全兼容。

### Windows 接收结果页

- 单文件、文字和文件包结果页不再把「返回」与接收完成状态挤在同一横排：返回按钮独占首行，成功图标与完成提示放到下一行。
- 单文件结果页原「分享」和文件包结果页原「全部分享」实际均调用 Explorer 定位导出内容，现统一改为更准确的「打开文件夹」并使用文件夹图标。
- 相关事件处理器和错误提示同步改名，行为保持不变：单文件在 Explorer 中选中带逻辑文件名的导出副本，文件包打开导出目录。

### 版本

- Rust / sender / web / Windows：`1.2.6`
- Android：`versionName 1.2.6`，`versionCode 20`

Windows 端产物由 GitHub Actions CI（`.github/workflows/windows.yml`）在 Release 创建后构建并上传。

---

## v1.2.5

本版更新 AirFerry 的全平台视觉识别，并整理 Windows 扫描来源交互。传输协议未变，与 v1.2.0–v1.2.4 的 descriptor v5 完全兼容。

### 全平台图标

- **发送端与接收端分角色设计**：保持统一蓝色主题与结构语言，发送端突出多设备向外发送，接收端突出扫码接收。
- **浏览器扩展**：替换 Chrome / Edge / Firefox 的 16–128 px 多尺寸发送端图标，并保留 512 px 主图。
- **Web 标签页**：发送页与接收页分别加入对应 favicon；单文件发送端会内联 favicon，离线双击打开也能正常显示。
- **Android 与 Windows**：Android launcher（方形及圆形、多密度）和 Windows exe / 任务栏 / Alt-Tab 图标统一换为接收端图标。

### Windows 扫描来源

- 摄像头、USB/HDMI/SDI 采集卡与屏幕捕获现在位于同一个「扫描来源」单选列表中，彼此互斥。
- 统一使用一个主按钮启动当前来源；选择屏幕捕获时再进入区域/窗口选择器，降低误点和来源混淆。
- 新增扫描来源模型与跨平台单元测试，覆盖硬件来源和屏幕捕获哨兵项的行为。

### 版本

- Rust / sender / web / Windows：`1.2.5`
- Android：`versionName 1.2.5`，`versionCode 19`

Windows 端产物由 GitHub Actions CI（`.github/workflows/windows.yml`）在 Release 创建后构建并上传。

---

## v1.2.4

本版为全端细节与 Windows 稳定性加固批次：Windows 端完成应用图标体系与屏幕选择器加固，全端文字展示启发式收紧以避免大文本卡顿，并修复单文本落盘协议头剥离问题。传输协议未变，与 v1.2.0–v1.2.3 的 descriptor v5 完全兼容。

### Windows 扫码端

- **应用图标体系**：生成多尺寸 `app.ico` 嵌入 exe（任务栏、Alt-Tab 与资源管理器），并在窗口标题栏中通过自定义 `ImageIcon` 控件渲染 Fluent 标题栏图标；修复 WPF Resource 嵌入保证 XAML 运行时稳定解析。
- **屏幕选择器加固**：
  - 分层覆盖窗口背景设为微透明（`#01000000`），彻底解决 OS 级 alpha=0 命中测试穿透导致下层应用响应点击的问题。
  - 选择器坐标统一切换为物理全局坐标，修复多显示器不同 DPI 下拖拽选框错位问题。
  - 覆盖层增加右键快捷选择整屏（全屏应用/游戏首选），并吞掉中键/X 键及滚轮输入。
  - 选择完成后延迟关闭覆盖层以吞掉尾随双击输入，防止双击穿透进刚选中的下层应用。
- **主题适配修复**：根据注册表纠正系统主题浅/深色判断，避免在浅色系统下误判为 Dark 主题。
- **接收页交互**：
  - 接收详情页、文字接收页、包接收页左上角增加「返回」按钮，方便直接返回。
  - 接收完成后的保存成功状态内联展示在按钮上（「已保存 ✓」并禁用），不再弹模态弹窗打断操作。

### 全端文字与大文件处理

- **文字展示页启发式收紧**：仅 `txt` 与 `md` 扩展名进入文字展示页，其余文本格式（json/html/csv/代码等）统一走文件路径，避免多兆字节文件在文字页整读整渲染导致卡顿或溢出。
- **UI 内联渲染上限**：各端内联文字渲染上限统一为 256 KiB。
- **单文本协议头剥离**：修复 ETTEXTv1 超限或异常时落盘未剥离 8 字节协议头（magic）的问题，确保落盘文件与原始内容完全一致。

### 版本

- Rust / sender / web / Windows：`1.2.4`
- Android：`versionName 1.2.4`，`versionCode 18`

Windows 端产物由 GitHub Actions CI（`.github/workflows/windows.yml`）在 tag 创建后构建并上传。

---

## v1.2.3

本版为全面修复与加固批次：Windows 端 UI 重做并新增屏幕捕获，Android 端消除主线程卡顿与一处崩溃，网页接收端补上会话防护，核心库收紧两个安全面。传输协议未变，与 v1.2.0–v1.2.2 的 descriptor v5 完全兼容。

### Windows 扫码端

- UI 全面重做为 WPF-UI Fluent 设计体系：浅色为主、深色可选、支持跟随系统（含品牌主色与语义色实时同步），弹窗/卡片/按钮/图标统一 Fluent 风格。
- 新增「屏幕捕获」视频源：截图式选择器（每显示器覆盖层，拖动=屏幕矩形区域、单击=某窗口、Esc 取消），适合同机浏览器播放二维码做端到端测试、虚拟机/远程桌面窗口等无摄像头场景。
- 设备选择页统一枚举摄像头与 USB/HDMI/SDI 采集卡（采集卡自动标注）。
- 修复大文件分段接收：分段恢复的期望长度语义修正（压缩流大小 vs 解压后大小勿混）、入库中断重试按稳定条目 ID 去重，不再产生重复历史条目。
- 摄像头拔出/无信号 5 秒后自动停止并提示「视频源已关闭」（此前会无限空转）。
- 屏幕捕获选择器与入口按钮补齐异常兜底，覆盖窗创建失败不再可能崩溃进程。

### Android 扫码端

- 历史列表加载/清空/删除、SAF 保存拷贝、CRC 计算全部移出主线程，长列表和删除大文件不再卡顿；重扫/继续恢复的会话重置改为异步，消除主线程等待锁的 ANR 风险。
- 修复一处崩溃：Activity 销毁后「清空/删除」的后台完成回调仍会刷新列表，向已关闭的线程池提交任务抛 `RejectedExecutionException`。
- 分段大文件的磁盘账本在恢复校验后即时落盘修正：此前「账本计数满但某段损坏」的罕见情形会随每个二维码重复触发全量重哈希（持续 CPU/IO 自旋）。
- 文字接收改用文件路径传递（消除超大文本的 `TransactionTooLargeException`）。

### 网页接收端

- 新增会话防护 sessionGuard：缓存引导探针必须校验帧魔数/版本，环境二维码（URL、支付码等）不再可能以垃圾会话 ID 锁死接收；会话失配连续 3 次且从未接受过符号时自动重锁重引导（镜像 Android/Windows 行为），修复「扫得到码但永远建立不了传输」。
- 二维码解码 worker 池在反序列化失败（messageerror）时自动终止并替换该 worker，池容量不再可能逐个衰减为 0。

### 发送端

- 多文件打包前校验 `File.arrayBuffer()` 读取完整性：内存压力下的静默短读此前会产出内部自洽的损坏包（所有校验都过、落盘即坏），现在直接报错提示重试。

### 核心库（三端同步）

- zstd 解码窗口钳制为 windowLog ≤ 23（编码端同步封顶）：恶意 CRC 校验通过的帧头此前可强制约 128 MiB 的解码窗口分配（独立于输出上限的输入侧漏洞），现在一律拒绝。本栈自产流（浏览器 level 1，windowLog ≤ 19）不受影响。
- 接收对象完成后，后续数据帧一律按重复帧早退：恶意屏幕可持续产出校验合法的新鲜修复符号，此前会使接收端状态无界增长（慢速内存 DoS）并让进度超过 100%。

### CI / 发布

- Pages workflow 的全部第三方 action 钉定到完整 commit SHA。
- 扩展/网页端新增 sessionGuard 单元测试（`npm test`）。

### 版本

- Rust / sender / web / Windows：`1.2.3`
- Android：`versionName 1.2.3`，`versionCode 17`

Windows 端产物由 GitHub Actions CI（`.github/workflows/windows.yml`）在 tag 创建后构建并上传。

---

## v1.2.2

本版补齐发送端主动停止播放的能力，并修复 Windows CI 发布构建会取消 push 质量门的问题。传输协议未变，与 v1.2.0/v1.2.1 的 descriptor v5 完全兼容。

### 发送端

- 普通播放和全屏播放都新增「停止播放」按钮，解决单文件网页发送端只能刷新停止的问题（[#4](https://github.com/UR-SillyB/AirFerry/issues/4)）。
- 停止时先同步取消动画帧回调，再释放 WASM 编码会话，避免队列中的旧回调访问已释放内存。
- 停止后保留已准备的文件与参数并返回参数页，可直接再次开始，无需重新选文件或压缩。

### CI / 发布

- Windows workflow 的 concurrency group 现在包含事件类型和发布 tag：push 质量门与 `workflow_dispatch` 发布构建不再互相取消，同一 tag 的过期手动构建仍会正常取消。

### 版本

- Rust / sender / web / Windows：`1.2.2`
- Android：`versionName 1.2.2`，`versionCode 16`

Windows 端产物由 GitHub Actions CI（`.github/workflows/windows.yml`）在 tag 创建后构建并上传。

---

## v1.2.1

本版是 Web 接收端与发布流程的稳定性修复。传输协议未变，与 v1.2.0 的 descriptor v5 完全兼容。

### Web 接收端

- 修复在线扫码接收 zstd 压缩内容到达 100% 后报 `Failed to fetch wasm-zstd.wasm: 404` 的问题（[#3](https://github.com/UR-SillyB/AirFerry/issues/3)）。
- 原因是 Vite 把 receive worker 输出到 `assets/`，worker 内的相对路径却被解析为 `assets/wasm-zstd.wasm`；实际 WASM 位于站点根目录。raw 内容不触发解压，因此小文件可能表现正常。
- 主线程现在会预加载 zstd WASM，并在 receive worker `init` 前通过 `wasm-init` 传入；worker 消息 FIFO 保证解压前已安装模块字节。
- 预加载增加 5 秒超时，挂起的连接不会无限阻塞接收端初始化。
- 懒加载兜底路径按执行环境分流：页面主线程相对 `document.baseURI`，打包 worker 从 `assets/` 上跳一级，兼容 GitHub Pages 等子路径部署和已存分段任务导出。

### 发布流程

- `dist` 重新打包时会从 Web 构建目录恢复 standalone 单文件 HTML，避免清理旧产物后遗漏该文件。
- 新增 `./scripts/build-all.sh dist-upload-list`，只列出当前版本且扩展名在白名单内的发布产物，防止使用 `dist/*` 时误上传 Chrome 私钥或 Android keystore。

### 版本

- Rust / sender / web / Windows：`1.2.1`
- Android：`versionName 1.2.1`，`versionCode 15`

Windows 端产物由 GitHub Actions CI（`.github/workflows/windows.yml`）在 tag 创建后构建并上传。

---

## v1.2.0

本版正式发布大文件分段传输、网页接收端与 Windows 接收端，并合入发布前多轮代码审计和实机反馈修复。正式版统一使用 **descriptor v5**：整份文件先压缩，再把压缩流切成约 31.9 MiB 的分段。

### ⚠️ 预发布升级说明

- 此前的 `v1.2.0-beta.1` Release 和提前创建的 `v1.2.0` tag 已撤回；它们不是正式版。
- 早期预发布构建曾使用 descriptor v4（8 MiB 原文段 + 逐段压缩），与正式版 v5 语义不兼容。接收端会 fail-closed 拒绝 v4，使用过预发布构建的用户须让发送端和接收端同时升级，并重新扫描未完成的大文件任务。
- 普通单文件、文字和多文件包继续使用 descriptor v3，与旧版保持兼容。

### 大文件分段与完整性

- 超过 256 MiB 的单文件自动走 descriptor v5；即使高压缩率使压缩流小于 256 MiB，也仍强制分段，避免误走单对象恢复路径。
- 发送端增量计算完整原文件 SHA-256；每个分段同时携带根文件摘要与本段摘要。Android、Windows、网页端在最终导出前重算完整摘要，拒绝混合不同文件修订版的分段。
- Android 与 Web 的已存分段快速路径改为完整 SHA-256 校验；账本摘要缺失或内容损坏时重新接收并自愈，不再只检查长度、位图或开头 1 KiB。
- Android/Windows 在解压前按最终解压大小复查磁盘空间，并预留 64 MiB；完成文件通过同卷原子移动进入内容地址库，降低额外磁盘占用并支持幂等续提。
- Android JNI 流式解压不再把大文件输出错误钳制到 256 MiB；内存解压接口仍保留 256 MiB 安全上限。
- Web 优先使用 File System Access 流式写盘；无该 API 时 Blob 回退限制为 64 MiB。

### 接收端可靠性

- 描述符默认间隔由 16 调整为 17 帧，使其在 2/4 多码布局中轮流经过所有物理码位；修复 Android 摄像头持续漏掉固定角落时只缓存数据帧、一直显示“正在同步”的问题。
- 修复 Web 切换传输或重扫时，异步重复段检测误释放新会话的问题。
- QR worker 崩溃后会终止并替换死亡 worker、重新初始化 WASM，线程池不会逐渐耗尽；FAST ZXing 输入内存用 `try/finally` 释放。
- Android `onDestroy` 的 native 清理移到 daemon 后台线程，避免大文件恢复期间旋转屏或退后台触发 ANR，并修复 session 清理竞态。
- Windows 流式解压路径改为 UTF-8，支持中文用户名与“文档”等非 ASCII 目录；二维码解码 worker 停止增加 2 秒超时。
- Rust pre-descriptor 缓存严格按字节预算计费；压缩描述符拒绝 `original_size == 0`；C/JNI 内存解压 cap 钳制到安全上限，流式输出 flush 失败会清理残留文件。

### 产品与发布

- 网页发送端与网页接收端拆成两个独立 zip；发送端另提供可在 `file://` 双击运行的单文件 HTML，构建结果只保留 `index.html`。
- 网页接收端使用四 worker 并行 QR 解码、全分辨率全图识别，并在 FAST ZXing 不可用时回退到 `zxing-wasm`。
- Android Release 开启 R8 与资源裁剪，补齐结果页常亮、分段进度显示及已完成段快速跳过。
- 发布脚本固定校验 Android 发布证书和 Chrome 扩展公钥；Windows CI 从指定 tag 派生并核对版本，不再维护独立硬编码版本号。

### 版本

- Rust / sender / web / Windows：`1.2.0`
- Android：`versionName 1.2.0`，`versionCode 14`

Windows 端产物由 GitHub Actions CI（`.github/workflows/windows.yml`）构建与发布；本地 macOS 构建不包含 Windows 产物。

---

## v1.1.6

> 本版本相对 v1.1.5 的主要更新：**全新网页接收端（Web Receiver）**——纯浏览器即可用摄像头扫码恢复文件/文字/包，与 Android / Windows 接收端共享同一 Rust 核心（`ReceiverSessionWasm`）；**接收端 UI 全面对齐发送端设计系统**；并伴随 Rust 核心库的多项接收链路增强。**不涉及协议兼容性破坏**（帧格式 / OTI / 压缩标记不变），Android / Windows 接收端与浏览器发送端可跨版本互操作。

### ★ 网页接收端（v1.1.6 新增，`receiver.html`）

- **发送端 / 接收端独立构建**：`npm run build` 产出发送端 `dist/`（index.html），`npm run build:receiver` 产出接收端 `dist-receiver/`（receiver.html），打包为 `airferry-sender-web-v{VER}.zip` + `airferry-receiver-web-v{VER}.zip` 两个独立可部署产物。
- **纯浏览器扫码接收**：`getUserMedia` 拿摄像头（**三级 fallback**：后置高分辨高帧率 → 后置无约束 → 默认摄像头 `true`；`frameRate:{ideal:60,max:60}` 钉住 60fps 上限）→ `requestVideoFrameCallback` 取帧（**1080 全分辨率，绝不 downscale**）→ **QR decode worker 池**（`QR_WORKER_POOL=4` 并行解码，跨核分摊帧率，镜像 Android 线程池；整帧全图解码 `maxNumberOfSymbols:4`，不用固定 ROI）→ **receive worker**（`ReceiverSessionWasm` 串行 ingest + `assemble_raw` + JS 侧 zstd/xz 解压 + CRC 校验 + 文字/包/单文件分流）。
- **fastzxing 双后端**：默认走自编译 ZXing-C++ → WASM 快路径（吃 Y 灰度平面，合成四码 598px **~10.4ms**）；回退 `zxing-wasm/reader` 兼容路径。见 `docs/perf-web-receiver.md`。
- **接收端 UI 对齐发送端**：`ReceivePage.tsx` 样式从 `app.css` 抽离为独立 `apps/sender/src/assets/receive.css`，复用发送端骨架（`.app`/`.app-header`/`.app-main`）与设计 token（`--color-primary` 等），无硬编码色；进度条 / 参数卡 / 结果卡 / 按钮与发送端同源观感。
- **局域网 HTTPS 测试**：`apps/web/scripts/serve-https.mjs`（默认端口 **8765**，自签证书在 `apps/web/.cert/`）——`getUserMedia` 需安全上下文。

### 接收链路增强（Rust 核心）

- **`ReceiverSessionWasm` 缓存引导**：`from_descriptor`（完整验证 OTI）+ `new(sid_lo,sid_hi)` 缓存引导——任意码（非必须左上角 descriptor）都能开始建立传输，descriptor 到达即确认 OTI 并重放缓存帧。
- **`Progress.symbol_size` 字段**：三端（jni/wasm/cffi）同步输出，供 UI 计算线上吞吐（否则按 1 字节/符号算错）。
- **`ingest_status.rs` 位布局**：三端共享的 ingest 状态字（C ABI packed u64），Android/Windows/Web 一致。
- **帧头 session_id 解析**：接收端从任意数据帧头解析 16B 大端 session_id（`[4..20]`），`new(lo,hi)` 传 `(低64, 高64)`。
- **WASM 接收端解压 fail-closed**：不暴露 `assemble_result`，wasm32 解压失败即报错（见 AGENTS.md §5 第10条）。

### 版本

- **1.1.6**（Android versionCode=**11**）；sender/web、Rust、Android APK 已同步。Windows 接收端由 CI（`windows.yml`）在 Windows runner 上重新构建上传。本版无协议破坏，接收端功能与 v1.1.5 兼容。

### 产物

> 命名规范见 [AGENTS.md §2.8](../../AGENTS.md#28-产物格式与命名规范)。**统一格式 `airferry-{角色}-{平台/变体}-v{版本}.{扩展}`**：`sender` = 发送端，`receiver` = 接收端。所有 asset **不设 label**（直接看文件名）。

**发送端**（播放二维码视频流）

| 文件 | 说明 |
|------|------|
| `airferry-sender-chrome-mv3-v1.1.6.crx` | Chrome / Edge 浏览器扩展，MV3（现代版）。`.crx` 已签名，拖入 `chrome://extensions` 即装；新版 Chrome 若拦截商店外 `.crx`，改用同名 `.zip` 解压加载 |
| `airferry-sender-chrome-mv3-v1.1.6.zip` | Chrome / Edge MV3 的解压加载版（`.crx` 被拦截时用「加载已解压的扩展程序」） |
| `airferry-sender-chrome-mv2-v1.1.6.crx` | Chrome / Edge MV2 扩展，已签名，供旧版浏览器兼容 |
| `airferry-sender-chrome-mv2-v1.1.6.zip` | Chrome / Edge MV2 的解压加载版（`.crx` 被拦截时用「加载已解压的扩展程序」） |
| `airferry-sender-firefox-mv3-v1.1.6.xpi` | Firefox 扩展，MV3（Firefox 116+） |
| `airferry-sender-firefox-mv2-v1.1.6.xpi` | Firefox 扩展，MV2（Firefox 91+） |
| `airferry-sender-web-v1.1.6.zip` | **网页发送端**静态站点：解压后部署到任意静态托管（GitHub Pages / Netlify / 任意子路径均可）。仅含发送端入口（`index.html`） |
| `airferry-sender-web-standalone-v1.1.6.html` | 网页发送端单文件版（约 2MB，所有 JS/CSS/WASM 内联），双击即可在 `file://` 下运行，无需服务器 |

**接收端**（用摄像头 / 采集卡扫码恢复文件）

| 文件 | 说明 |
|------|------|
| `airferry-receiver-android-arm64-v1.1.6.apk` | **Android 扫码端**。arm64-v8a 单架构，Android 10+（minSdk 29）。安装后打开 App 对准屏幕播放的二维码即可接收文件；已用 release keystore 签名 |
| `airferry-receiver-windows-x64-v1.1.6.zip` | **Windows 扫码端**。x64 单架构，Windows 10+，需安装 [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0)。除摄像头外还支持 **USB / HDMI / SDI 采集卡**作为视频源（设备列表会自动标注），适合对接专业视频输出；解压后运行 `AirFerry.exe` |
| `airferry-receiver-web-v1.1.6.zip` | **网页接收端**静态站点（`receiver.html`）。v1.1.6 起**独立打包**，与发送端 web zip 分离，可独立部署。⚠️ **不能双击 `receiver.html` 运行**，需部署到 HTTPS / localhost（见下方「网页接收端部署与限制」） |

> **网页接收端部署与限制**（重要）
>
> 1. **不能直接点开 html 运行**：网页接收端是静态站点，需先部署（`nginx`/GitHub Pages/Netlify 等）或本地起一个静态服务器，再在浏览器打开 `receiver.html`。
> 2. **必须 HTTPS 或 localhost**：浏览器安全策略要求 `getUserMedia`（摄像头）只在安全上下文可用。`file://` 直开、普通 http（非 localhost）都无法访问摄像头。**一键启动**（仓库自带局域网 HTTPS 服务器）：
>    ```bash
>    cd apps/web
>    npm run build:receiver          # 构建 dist-receiver/（release 里的 zip 已含产物，可跳过）
>    node scripts/serve-https.mjs dist-receiver .cert/selfsigned.crt .cert/selfsigned.key 8765
>    # 手机/电脑浏览器打开 https://localhost:8765/receiver.html（局域网 https://<LAN-IP>:8765/receiver.html）
>    ```
>    自签证书在 `apps/web/.cert/`，浏览器访问会警告，点「高级」→「继续」即可。
> 3. **速度低于原生**：web 端 JS/WASM 解码 + 浏览器摄像头管道，结构性慢于 Android / Windows 原生（C++ 多线程 + SIMD）。追求满速扫码建议用原生接收端（APK / Windows zip）。
>
> **结论**：本机有摄像头、想零安装快速体验 → 网页接收端（需按上面第 2 步起 HTTPS）；追求稳定满速 / 采集卡 → 原生接收端。

---

## v1.1.5

> 本版本相对 v1.1.4 的主要更新：**发送端 UI 自适应重构**、**统计速率滑动窗口修复**（FPS / 传输速率不再被累积均值稀释），以及文案精简与按钮样式优化。不涉及协议，接收端功能与 v1.1.4 一致。下载文件统一带 `sender`（发送端）/ `receiver`（接收端）角色前缀，asset 不设 label。

### 统计速率修复（滑动窗口）

- **问题**：统计页的 FPS 与传输速率原本按**整个会话的累积平均**（`frames / 总耗时`、`bytes / 总耗时`）计算。渲染循环一旦出现过任何瞬时停顿——后台标签节流、GC 卡顿、掉帧、休眠——`elapsed_ms` 继续累加而 `frames` 不再增长，累积平均值会**永久被拉低且永不恢复**。因此长时间运行后，即使二维码实际输出速度保持恒定，页面上的 FPS / 速率数字却越来越小。
- **修复**：核心库 `Stats` 改为**最近 3 秒滑动窗口**统计。每个帧样本记录时间戳与字节数并保留在环形缓冲；FPS / 吞吐只按窗口内的「帧数 / 时间跨度」与「字节数 / 时间跨度」计算，瞬时停顿只会短暂压低当前值、随后自动恢复，数字实时贴近实际输出。窗口内样本不足时回退到累积平均以保证启动初期数值合理。发送端（WASM / 网页）与接收端（Android / Windows）共用同一 `Stats`，两端同步受益。

### 发送端 UI 重构

- **入口布局优化**：选择页顶部按钮行拆为「添加文件夹」+「添加文字」两个入口；底部大拖放区（dropzone）专注「添加文件」入口（点击打开文件选择器，也支持拖放与全页拖放）。文件夹选择优先使用 `showDirectoryPicker` API，不支持时回退 `<input webkitdirectory>`，递归加入文件夹内所有文件。
- **全视口自适应**：内容短时整体垂直居中（不再贴顶），内容长时自然滚动（不截断）。配合 `100dvh` 适配移动端动态视口。新增 `≤900px`（平板）/ `≤600px`（手机）/ `≤340px`（极窄屏）三档响应式断点，容器、卡片、QR 画布、拖放区、按钮、表格、弹窗、文件名截断宽度逐档收紧，杜绝横向滚动。极窄屏（iPhone SE / 折叠屏）自动隐藏步骤文字标签，只显数字圆点。
- **界面重设计**：所有 emoji 图标替换为内联 SVG 矢量图标，继承 `currentColor`、高清不糊。步骤条文字标签独立为 `.step-label`；已完成步骤的圆点自动换为对勾。错误横幅去掉内联样式，改为语义化 `role="alert"` 与统一样式。
- **文件列表默认折叠**：选择页文件列表默认折叠，仅显示「N 项 · 总大小 · 展开」摘要行；点击展开完整列表，每项仍可单独移除。「清空」按钮在折叠 / 展开两种状态都常驻摘要行右侧。
- **传输参数页**：冗余率 / 亮度等滑块字段重排为「标签 + 当前值」两栏；复选项改为标准勾选布局。
- **文案精简**：移除应用副标题、选择页引导描述、传输参数页引导描述三处冗余文案；dropzone 大按钮文案简化为「点击添加文件」/「或拖拽文件到此处」。
- **发送按钮样式**：disabled 状态改为灰色背景 + 灰色文字（替代原来不够明显的半透明处理），可点击状态保持不变。

### 无障碍与动效

- **键盘焦点**：主按钮新增 `:focus-visible` 可见焦点环。
- **自定义滑块**：range 滑块统一轨道与拇指样式（Webkit / Firefox）。
- **减弱动效**：尊重系统 `prefers-reduced-motion`，关闭过渡动画。

### 版本

- **1.1.5**（Android versionCode=**10**）；sender/web、Rust、Android APK 已同步。Windows 接收端由 CI（`windows.yml`）在 Windows runner 上重新构建上传。本版无协议改动，接收端功能与 v1.1.4 一致。

### 产物

> 命名规范见 [AGENTS.md §2.8](../../AGENTS.md#28-产物格式与命名规范)。**统一格式 `airferry-{角色}-{平台/变体}-v{版本}.{扩展}`**：`sender` = 发送端，`receiver` = 接收端。所有 asset **不设 label**（直接看文件名）。

**发送端**（播放二维码视频流）

| 文件 | 说明 |
|------|------|
| `airferry-sender-chrome-mv3-v1.1.5.crx` | Chrome / Edge 浏览器扩展，MV3（现代版）。`.crx` 已签名，拖入 `chrome://extensions` 即装；新版 Chrome 若拦截商店外 `.crx`，改用同名 `.zip` 解压加载 |
| `airferry-sender-chrome-mv3-v1.1.5.zip` | Chrome / Edge MV3 的解压加载版（`.crx` 被拦截时用「加载已解压的扩展程序」） |
| `airferry-sender-chrome-mv2-v1.1.5.crx` | Chrome / Edge MV2 扩展，已签名，供旧版浏览器兼容 |
| `airferry-sender-chrome-mv2-v1.1.5.zip` | Chrome / Edge MV2 的解压加载版（`.crx` 被拦截时用「加载已解压的扩展程序」） |
| `airferry-sender-firefox-mv3-v1.1.5.xpi` | Firefox 扩展，MV3（Firefox 116+） |
| `airferry-sender-firefox-mv2-v1.1.5.xpi` | Firefox 扩展，MV2（Firefox 91+） |
| `airferry-sender-web-v1.1.5.zip` | 网页发送端静态站点，解压后部署到任意静态托管（GitHub Pages / Netlify / 任意子路径均可） |
| `airferry-sender-web-standalone-v1.1.5.html` | 网页发送端单文件版（约 2MB，所有 JS/CSS/WASM 内联），双击即可在 `file://` 下运行，无需服务器 |

**接收端**（用摄像头 / 采集卡扫码恢复文件）

| 文件 | 说明 |
|------|------|
| `airferry-receiver-android-arm64-v1.1.5.apk` | **Android 扫码端**。arm64-v8a 单架构，Android 10+（minSdk 29）。安装后打开 App 对准屏幕播放的二维码即可接收文件；已用 release keystore 签名 |
| `airferry-receiver-windows-x64-v1.1.5.zip` | **Windows 扫码端**。x64 单架构，Windows 10+，需安装 [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0)。除摄像头外还支持 **USB / HDMI / SDI 采集卡**作为视频源（设备列表会自动标注），适合对接专业视频输出；解压后运行 `AirFerry.exe` |

---

## v1.1.4

> 本版本相对 v1.1.3 的主要更新：**首次提供完整 Windows 扫码端**（摄像头 + USB/HDMI/SDI 采集卡）、协议与资源安全加固、网页全页拖放、扫码页常亮，以及移除不可靠的二维码状态显示。下载文件统一带 `sender`（发送端）/ `receiver`（接收端）角色前缀，asset 不设 label。

### 新增：Windows 扫码端首次完整实现

- **完整扫码链路**：Windows 接收端正式上线。多 worker 并行解码 + 串行 Rust 摄入，支持多码 ROI 跟踪、15 FPS 预览与 3 秒实时吞吐窗口。
- **采集卡支持**：除摄像头外，USB / HDMI / SDI 采集卡均可作为视频源，设备列表会自动标注采集卡类型，适合对接专业视频输出。
- **完整接收流程**：统一 ContentStore 历史记录、文本/文件/bundle 结果页、原名导出（保留逻辑文件名、扩展名和 MIME），以及摄像头原地停止/继续。
- **不可信文件隔离**：历史文件只在应用内预览；导出到外部时写入 MOTW（Mark of the Web），不直接 shell 执行接收内容。
- **安全停止**：producer、recovery、worker、native session/camera 严格有序释放；慢驱动超时后由单一后台任务按固定顺序持有资源，避免并发 free/Dispose。

### 协议与资源安全加固

- **协议输入校验**：补齐 OTI、SBN、ESI、descriptor、Frame 长度校验；C ABI 的 raw pointer API 明确标注为 unsafe，并修复 assemble 输出参数的泄漏边界。
- **资源预算**：对象上限统一为 32 MiB；断点 JSON 的输入/输出、符号数量和字节数各有独立预算，降低合法大对象触发 OOM 的风险。
- **ContentStore 故障保护**：索引损坏时先备份再停止写入，不再静默清空覆盖。

### 发送端体验

- **网页全页拖放**：文件或文件夹可拖到页面任意位置；目录分批递归读取，支持并发拖放、卸载作废和读取中状态。
- **WASM session 生命周期**：消除 epoch 失效、替换、卸载和 React StrictMode 下的双重 `free()` 风险。

### 扫码端

- **扫码页常亮**：Android 扫码页设置 `FLAG_KEEP_SCREEN_ON`，避免长时间传输时息屏锁屏。
- **移除二维码状态显示**：删除逐二维码活跃/暂停状态行及其时间戳、四宫格映射和定时刷新，不再展示判断不可靠的状态。

### 构建与测试

- WASM legacy/SIMD 在隔离 workspace 构建，并用跨进程锁保护发布和消费；web 使用独立现代 WASM 快照。
- Windows 构建仅接受真实 DLL，并由固定 SHA 的 GitHub Actions 在 Windows runner 打包。
- 新增 Android 协议/helper 单测与 Windows C ABI、CRC、预览、导出测试；同步更新协议和构建文档。

### 版本

- **1.1.4**（Android versionCode=**9**）；sender/web、Rust、Windows 和 `windows.yml` 已同步。

### 产物

> 命名规范见 [AGENTS.md §2.8](../../AGENTS.md#28-产物格式与命名规范)。**统一格式 `airferry-{角色}-{平台/变体}-v{版本}.{扩展}`**：`sender` = 发送端（把文件编成二维码流播放），`receiver` = 接收端（用摄像头/采集卡扫码恢复文件）。所有 asset **不设 label**（直接看文件名）。

**发送端**（播放二维码视频流）

| 文件 | 说明 |
|------|------|
| `airferry-sender-chrome-mv3-v1.1.4.crx` | Chrome / Edge 浏览器扩展，MV3（现代版）。`.crx` 已签名，拖入 `chrome://extensions` 即装；新版 Chrome 若拦截商店外 `.crx`，改用同名 `.zip` 解压加载 |
| `airferry-sender-chrome-mv3-v1.1.4.zip` | Chrome / Edge MV3 的解压加载版（`.crx` 被拦截时用「加载已解压的扩展程序」） |
| `airferry-sender-chrome-mv2-v1.1.4.crx` | Chrome / Edge MV2 扩展，已签名，供旧版浏览器兼容 |
| `airferry-sender-chrome-mv2-v1.1.4.zip` | Chrome / Edge MV2 的解压加载版（`.crx` 被拦截时用「加载已解压的扩展程序」） |
| `airferry-sender-firefox-mv3-v1.1.4.xpi` | Firefox 扩展，MV3（Firefox 116+） |
| `airferry-sender-firefox-mv2-v1.1.4.xpi` | Firefox 扩展，MV2（Firefox 91+） |
| `airferry-sender-web-v1.1.4.zip` | 网页发送端静态站点，解压后部署到任意静态托管（GitHub Pages / Netlify / 任意子路径均可） |
| `airferry-sender-web-standalone-v1.1.4.html` | 网页发送端单文件版（约 2MB，所有 JS/CSS/WASM 内联），双击即可在 `file://` 下运行，无需服务器 |

**接收端**（用摄像头 / 采集卡扫码恢复文件）

| 文件 | 说明 |
|------|------|
| `airferry-receiver-android-arm64-v1.1.4.apk` | **Android 扫码端**。arm64-v8a 单架构，Android 10+（minSdk 29）。安装后打开 App 对准屏幕播放的二维码即可接收文件；已用 release keystore 签名 |
| `airferry-receiver-windows-x64-v1.1.4.zip` | **Windows 扫码端**。x64 单架构，Windows 10+，需安装 [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0)。除摄像头外还支持 **USB / HDMI / SDI 采集卡**作为视频源（设备列表会自动标注），适合对接专业视频输出；解压后运行 `AirFerry.exe` |

---

## v1.1.3

### 功能

- **ContentStore 内容寻址存储**（Android + Windows）：同内容只落一份 blob；列表/详情使用逻辑索引解析内部 hash 路径。
- **取消 recovered 双写 + 分享直出 FileProvider**（Android）：不再 `cache/recovered_*` 与 `received/` 各拷一份；分享直接暴露 store blob，同时通过 URI `DISPLAY_NAME` 携带逻辑文件名，自定义 provider 也按该名称返回 MIME，避免接收应用保存成 `.bin`。
- **Windows 分享保留扩展名并安全暂存**：ContentStore 的 hash blob 只用于内部去重；交给 Explorer 前生成带逻辑原名的临时导出副本、写入 MOTW，失败立即回收，并清理超过 24 小时的受控分享目录。
- **启动清理遗留 cache**（Android）：`AirFerryApp` 启动时清旧 `recovered_*` / `share/`，并迁移 legacy `received/`。
- **发送端 Chrome 78 兼容**：`newId()` 不再依赖 `crypto.randomUUID()`（用 `getRandomValues` 回退）。

### 版本

- **1.1.3**（versionCode=**8**）；`windows.yml` VER 同步。

### 产物

| 文件 | 说明 |
|------|------|
| `airferry-android-v1.1.3.apk` | Android 接收端 |
| `airferry-windows-x64-v1.1.3.zip` | Windows（CI） |
| `airferry-sender-chrome-mv3-v1.1.3.crx` / `.zip` | Chrome MV3 |
| `airferry-sender-chrome-mv2-v1.1.3.crx` / `.zip` | Chrome MV2 |
| `airferry-sender-firefox-mv3-v1.1.3.xpi` | Firefox MV3 |
| `airferry-sender-firefox-mv2-v1.1.3.xpi` | Firefox MV2 |
| `airferry-web-v1.1.3.zip` | 网页端 |
| `airferry-web-standalone-v1.1.3.html` | 单文件网页 |

---

## v1.1.2

### 修复

- **Android 重复分享文件名带 `(1)`**：分享缓存目录不再用 `uniqueTarget` 追加序号；改为固定名 + 覆盖写入（`FileNameUtil.shareStagingFile`）。影响单文件详情 / 打包列表 / 历史批量分享。`received/` 归档仍用 `uniqueTarget` 防覆盖历史文件。

### 版本

- 版本号同步至 **1.1.2**（`package.json` / `build.gradle.kts` versionCode=**7** / `Cargo.toml` / `AirFerry.Windows.csproj` / `windows.yml` `VER`）。

### 产物

| 文件 | 说明 |
|------|------|
| `airferry-android-v1.1.2.apk` | Android 接收端 |
| `airferry-windows-x64-v1.1.2.zip` | Windows 接收端（CI） |
| `airferry-sender-chrome-mv3-v1.1.2.crx` / `.zip` | Chrome / Edge MV3 |
| `airferry-sender-chrome-mv2-v1.1.2.crx` / `.zip` | Chrome / Edge MV2 |
| `airferry-sender-firefox-mv3-v1.1.2.xpi` | Firefox MV3 |
| `airferry-sender-firefox-mv2-v1.1.2.xpi` | Firefox MV2 |
| `airferry-web-v1.1.2.zip` | 网页端 |
| `airferry-web-standalone-v1.1.2.html` | 网页端单文件 |

---

## v1.1.1

### 发送端

- **统一选择页**：取消「文件 / 文字」Tab；添加文件（拖拽/点选/文件夹，**追加**）+ 添加文字（弹窗命名为 `.txt`）进同一列表；**仅**点「发送」才压缩并进入参数页（修复拖完即跳转）。
- **混发**：文件与文字同批 → 文字物化为命名 `.txt`，≥2 项走 `ETBUNDL1`。
- **单条纯文字**：仍走 `ETTEXTv1`（收端文字页可复制 / 分享 / 存盘）。

### 接收端（Android / Windows）

- **文本类可复制**：扩展名启发式（`TextLike` / `FileNameUtil.IsTextLikeName`：txt/md/json/csv/源码等）——单文件、打包条目、历史列表均可进 `ReceiveText`。
- **严格 UTF-8**：非法 UTF-8 的「文本扩展名」回退普通文件页，避免 U+FFFD 静默损坏。
- **CRC**：文本归档 / 历史重开以**磁盘字节** CRC 为准，与 descriptor 校验语义对齐。

### 发版 / 版本

- 版本号同步至 **1.1.1**（`package.json` / `build.gradle.kts` versionCode=**6** / `Cargo.toml` / `AirFerry.Windows.csproj` / `windows.yml` `VER`）。
- **Windows 正式产物默认走 GitHub Actions**（`.github/workflows/windows.yml` → `workflow_dispatch` 的 `windows-pack`），详见 AGENTS.md §2.9 与 `docs/build-windows.md` §6。

### 产物

| 文件 | 说明 |
|------|------|
| `airferry-android-v1.1.1.apk` | Android 接收端（Android 10+，arm64-v8a） |
| `airferry-windows-x64-v1.1.1.zip` | Windows 接收端（CI `windows.yml` 打包；需 .NET 8） |
| `airferry-sender-chrome-mv3-v1.1.1.crx` / `.zip` | Chrome / Edge MV3 |
| `airferry-sender-chrome-mv2-v1.1.1.crx` / `.zip` | Chrome / Edge MV2 |
| `airferry-sender-firefox-mv3-v1.1.1.xpi` | Firefox MV3 |
| `airferry-sender-firefox-mv2-v1.1.1.xpi` | Firefox MV2 |
| `airferry-web-v1.1.1.zip` | 网页端静态站点 |
| `airferry-web-standalone-v1.1.1.html` | 网页端单文件版（需单独 `build:standalone`） |

---

## v1.1.0

### 性能

- **发送端 fixed-mask QR 编码**：会话内帧长恒定，vendor/fast_qr 在指定 mask 时跳过 8-mask 评估（约再提速一个数量级于已换用的 fast_qr Reed-Solomon 路径）。当前热路径已演进为 `next_qr_scratch` + 借用 WASM 视图 + JS `drawMatrix`。
- **发送档位**：新增 turbo（后续因 RaptorQ 8 字节对齐修正为 1904B）/ max（2400B）符号预设；默认仍为激进 1400B。
- **Android 分析流保持 1080p**：ImageAnalysis 请求 1920×1080，优先保证高版本/多码下的模块像素密度与识别率。

### 其他

- 清理未启用的 WASM RGBA API 与实验分支。
- 版本号四处同步至 1.1.0（`package.json` / `build.gradle.kts` versionCode=5 / `Cargo.toml` / `AirFerry.Windows.csproj`）。

### 产物

| 文件 | 说明 |
|------|------|
| `airferry-android-v1.1.0.apk` | Android 接收端（Android 10+，arm64-v8a，release 签名） |
| `airferry-windows-x64-v1.1.0.zip` | Windows 接收端（仅 Windows 构建时打包；需 .NET 8） |
| `airferry-sender-chrome-mv3-v1.1.0.crx` / `.zip` | Chrome / Edge MV3（Cr24 签名，pem 复用） |
| `airferry-sender-chrome-mv2-v1.1.0.crx` / `.zip` | Chrome / Edge MV2 |
| `airferry-sender-firefox-mv3-v1.1.0.xpi` | Firefox MV3 |
| `airferry-sender-firefox-mv2-v1.1.0.xpi` | Firefox MV2 |
| `airferry-web-v1.1.0.zip` | 网页端静态站点 |
| `airferry-web-standalone-v1.1.0.html` | 网页端单文件版（需单独 `build:standalone`） |

> Windows zip 若本机构建环境非 Windows 则可能缺失，由 CI `windows.yml` 补打。

### 致谢

AirFerry 在离线光学传输的工程思路上参考了 [**RaptorQR**](https://github.com/infrost/RaptorQR)（MIT）。

---

