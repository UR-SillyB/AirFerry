# Python 发送端：文件转视频

Python 包位于 `apps/python/`，发行名称为 `airferry`，导入名称为 `airferry`，初始版本为 `0.1.0`，独立于扩展和 App 的版本号。当前提供可安装源码和 wheel/sdist 构建流程，尚未发布 PyPI，发行名称可用性尚未确认。

## 从源码安装

需要完整仓库、CPython 3.10+、Rust stable 和本机 C/C++ 构建工具。Windows 使用 MSVC 工具链；Linux/macOS 需要可用的 C 编译器以构建 Zstd/XZ 依赖。

```bash
# 仓库根目录，建议先激活虚拟环境
python -m pip install ./apps/python

# 安装测试依赖
python -m pip install "./apps/python[test]"
```

普通用户安装适配本机的预编译 wheel 时无需 Rust/C 编译器。PyO3 扩展使用 `abi3-py310`，面向启用 GIL 的 CPython 3.10+；不声明 PyPy、free-threaded Python 或未验证平台的支持。

## 转换文件

```python
from airferry import file_to_video

result = file_to_video("data.zip", "data.mp4")
print(result)
```

```bash
airferry data.zip data.mp4 --qr-count 4 --fps 30
python -m airferry data.zip data.mp4 --compression xz --overwrite
```

完整参数与进度回调见 [`apps/python/README.md`](../apps/python/README.md)。接口默认 30 fps、单码、模块 4 像素、50% 修复比例、1 次完整传输和 `auto` 压缩。协议 `symbol_size` 默认 1400 字节，可通过 Python 参数或 CLI `--symbol-size` 调整：64–2888 字节且按 8 对齐，过小导致描述符无法容纳时明确报错。每码保留四模块白边，整数倍最近邻放大；默认输出为 532×532（单码）或 1064×1064（四码）。使用 H.264、CRF 18、medium preset、`yuv420p`，不添加声音。

输出路径只接受 `.mp4`，父目录必须已存在；默认不覆盖已有文件。编码器先写输出同目录的临时文件，成功退出后提交，失败清理临时文件。默认无覆盖发布优先使用原子操作；文件系统不支持硬链接时，使用独占创建后复制，仍不覆盖并发创建的目标，但复制期间目标文件可能暂时可见。不支持文件夹、空文件、ETBUNDL1 多文件容器和 ETTEXTv1 专用文字容器。

## 编码计算与文件存储

安装阶段可以联网获取依赖。安装完成后，压缩、RaptorQ、QR 矩阵和 MP4 编码均在本机执行，不调用在线服务，不发送遥测，也不在运行时补下载模型或编码器。`imageio-ffmpeg` 的平台 wheel 在安装时提供 FFmpeg；运行时使用该 wheel 自带的二进制，缺少二进制或 H.264 编码器时清晰报错。

文件存储按普通文件系统语义处理，不检查路径是否位于本地磁盘。输入、输出和临时目录可使用 UNC、远程映射盘、reparse point、符号链接、NFS 等正常路径；系统文件 API 的读写可能产生相应网络流量。`file://` URL 会转换为文件系统路径，含 UNC 主机形式；其他 URL 需要相应文件 I/O 适配，当前接口不提供 HTTP 上传协议。

FFmpeg 从管道读取已生成的灰度帧，通过文件 API 写 MP4；`file,pipe` 协议设置不妨碍操作系统访问网络文件系统。“离线”约束的是编码计算对线上服务和组件下载的依赖，不要求整个进程没有任何网络流量。

为隔离设备准备安装材料时，在相同系统和 CPU 架构的联网设备上先构建本包 wheel，再收集依赖：

```bash
# 示例 wheel 路径需替换为本机实际构建结果
python -m pip download --only-binary=:all: --dest wheelhouse ./dist/python/airferry-0.1.0-cp310-abi3-win_amd64.whl
```

将整个 `wheelhouse/` 复制至隔离设备后执行：

```bash
python -m pip install --no-index --find-links ./wheelhouse airferry==0.1.0
airferry data.zip data.mp4
```

依赖和二进制必须预先完整准备；生成视频时不进行补下载。离线安装演示路径中的 Windows wheel 不能用于 Linux 或 macOS。

## 协议与有限视频

Python 扩展直接调用 `transfer-engine`、`raptorq-core` 和 `qr-protocol`，复用 vendored `fast_qr` 的固定 mask 路径，不另外实现线格式。普通文件使用 descriptor v3；压缩流超过 `SEGMENT_RAW_BYTES`（33,488,904 字节），或原文件超过 256 MiB 时使用 descriptor v5。后一个条件可以只产生一个压缩段。

处理顺序为：流式读取并创建稳定快照，计算原文件 CRC32/SHA-256，整体压缩，按规范坐标切分压缩流，逐段建立 RaptorQ 编码器，然后将 QR 画面顺序写入视频。`auto` 比较 Raw 与 Zstd Lv1；`zstd` 受接收器兼容窗口 `windowLog <= 23` 限制；`xz` 使用 preset 6，避免超出接收器内存预算。临时磁盘需容纳原始快照和压缩候选，峰值内存包含当前约 32 MiB 段及其 RaptorQ 编码开销，不能按段大小当作进程总内存上限。

每段有 `K` 个源符号，最低数据码预算为 `D = K + max(8, ceil(K * redundancy_pct / 100))`。描述符保持每 17 个协议码一次，首码也是描述符；最低协议码数为 `N = D + ceil(D / 16)`。每段每次传输实际视频帧数为 `max(fps, ceil(N / qr_count))`，保证至少 1 秒；补足最低时长和末帧格位时继续产生新的修复符号。

Python 采用独立的会话身份策略：仍调用核心 `SessionId::derive`，文件名、大小和毫秒 mtime 为身份字段，fingerprint 依次包含原文件 SHA-256、压缩算法标签、`symbol_size` 的小端字节及精确压缩流 SHA-256。编码参数、压缩库输出或文件内容改变后会得到不同会话 ID，避免接收端将不同 OTI 或不同压缩流的已存符号混用于断点恢复。该 ID 不要求与浏览器的首尾片段指纹策略相同；线格式与接收器处理方式完全复用核心。

`repeats` 重复完整传输，不增加独立修复信息。循环播放同一个有限 MP4 也不能补足始终未成功扫描的不同符号。现场需要根据曝光、缩放、屏幕和摄像头调整帧率或模块尺寸。真实 MP4 解码往返测试证明数字编码链路；手机拍摄、原生 App UI 与不同播放器缩放仍需独立验收。

## 测试与构建

```bash
# 仓库根目录；Python 扩展默认不进入原有三个核心 crate 的测试集合
cargo test
cargo test -p airferry-python
python -m pytest apps/python/tests
```

`interop` 测试实际生成 MP4，再解码视频画面、通过 ZXing-C++ 提取原始 QR bytes，交给现有 Rust 接收器恢复并比较原文件。`slow` 用于较大文件或昂贵边界用例：

```bash
python -m pytest apps/python/tests -m "not slow"
python -m pytest apps/python/tests -m interop
```

离线编码测试使用本地样本，启动全新 Python 进程、在导入包之前通过 audit hook 禁止全部 `socket.*` 事件，再实际生成四码 MP4；另验证 FFmpeg 的灰度输入走管道、MP4 输出走文件 API。这证明编码计算不依赖在线服务，不要求用户指定的网络文件系统 I/O 没有流量。本机还验证了仅安装本包、Pillow 和 imageio-ffmpeg 的干净虚拟环境，离线安装后完成视频生成。测试还覆盖 `file://`、链接目录及不支持硬链接时的保存降级；真实视频恢复覆盖丢帧和超过 256 MiB 的原文件压缩后使用单段 v5，不能据此声称完成了手机拍摄验收。

Windows 本机 SMB 共享也已实际验证：输入、输出和临时目录全部使用 UNC 路径，以及使用对应 `file://` URL 生成视频，均能经 QR 解码和独立 Rust 接收器逐字节恢复原文件。

构建工具采用 [maturin 的混合 Python/Rust 项目布局](https://www.maturin.rs/project_layout.html)，`pyproject.toml` 负责 Python 元数据，Python 版本从 crate 的 `0.1.0` 读取。最低 maturin 版本为 1.15，以避开旧版本的 workspace 源码包处理问题。maturin 的 sdist 收集本地 path 依赖，源码包必须包含三个共享 crate 和 vendored `fast_qr`；发布前应从源码包本身重建 wheel，验证没有隐含依赖仓库外部文件。[maturin 分发指南](https://www.maturin.rs/distribution.html)说明了源码包与 manylinux 构建要求。

`apps/python/Cargo.toml` 特意将 `fast_qr` 声明为直接 path 依赖：仅有根 workspace 的 `[patch.crates-io]` 时，maturin 不会自动把该 vendored crate 收进 sdist。不要因 Rust 代码未直接引用该依赖而删除它。`pyproject.toml` 只显式纳入 `tests/*.py`，并排除旧 `dist/`、虚拟环境、Python 缓存及已编译扩展；不能把本机旧 wheel 或 `.pyc` 一起发布为源码。

```bash
python -m pip install "maturin>=1.15,<2" build twine
python -m build --wheel --sdist apps/python --outdir dist/python
python -m twine check dist/python/*

# 在仓库根目录，以实际生成的 sdist 文件名为准
python -m pip wheel --no-deps --wheel-dir dist/sdist-check dist/python/airferry-0.1.0.tar.gz
```

源码包重建使用临时解包目录；不要用源码树已有 `_native` 文件冒充 wheel 验证。产物、虚拟环境、`__pycache__` 和原生扩展均不提交 Git。

## CI 与未来发布

`.github/workflows/python.yml` 为 Windows x64、Linux x64（manylinux2014）、macOS Intel 与 Apple Silicon 构建 abi3 wheel，并安装生成的 wheel 运行测试；另一个 job 检查 sdist 中 vendored QR 文件完整且不含缓存/旧制品，再从 sdist 重新构建 wheel，并运行两项 WASM 隔离回归。真实离线编码测试在依赖安装完成之后执行。CI 固定 maturin 1.15.0，并将制品保留为 GitHub Actions artifacts。

本轮本机验证在 Windows 上进行；Linux/macOS 视频生成已配置 CI 验证，当前尚未取得这两个平台的真实 CI 通过记录。

推送相关源码、pull request 和手动 `workflow_dispatch` 均只执行构建与验证，不创建 Release，也不上传 PyPI。`scripts/build-all.sh` 不包含 Python 构建或上传步骤。未来首次发布前需要确认 PyPI 发行名称、账户权限、最终版本以及目标平台制品，之后才能运行发布命令；不要把当前源码安装示例当作 PyPI 已上架证明。
