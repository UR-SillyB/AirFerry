"""Encode QR video offline, using filesystem paths chosen by the caller."""

from __future__ import annotations

import errno
import os
import shutil
import subprocess
import sys
import sysconfig
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import url2pathname

import imageio_ffmpeg
from imageio_ffmpeg._definitions import FNAME_PER_PLATFORM
from PIL import Image, ImageOps

from ._native import SEGMENT_RAW_BYTES, NativeTransfer


@dataclass(frozen=True)
class VideoProgress:
    frames_written: int
    total_frames: int
    segment_index: int
    segment_count: int


@dataclass(frozen=True)
class VideoResult:
    path: Path
    width: int
    height: int
    frame_count: int
    fps: int
    segment_count: int
    compression: str
    original_size: int
    compressed_size: int

    @property
    def duration(self) -> float:
        """Exact encoded duration in seconds."""
        return self.frame_count / self.fps


def _integer(name: str, value: int, minimum: int, maximum: int) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        raise ValueError(f"{name} must be an integer in {minimum}..{maximum}")


def _filesystem_path(value: str | os.PathLike[str]) -> Path:
    """Accept ordinary OS paths and file URLs without storage-location policy."""
    raw = os.fspath(value)
    if isinstance(raw, str) and raw.lower().startswith("file:"):
        parsed = urlsplit(raw)
        location = parsed.path
        local_authority = parsed.netloc.lower() == "localhost"
        windows_drive = (
            len(location) >= 3 and location[0] == "/" and location[2] in (":", "|")
        )
        if parsed.netloc and not (
            local_authority and (os.name != "nt" or windows_drive)
        ):
            location = f"//{parsed.netloc}{location}"
        raw = url2pathname(location)
    return Path(raw).absolute()


def _frame_budget(k: int, redundancy_pct: int, qr_count: int) -> int:
    # The first QR is a descriptor; every 17th QR thereafter is one too.
    # Eight repair symbols give tiny files useful headroom despite rounding.
    data_codes = k + max(8, (k * redundancy_pct + 99) // 100)
    protocol_codes = data_codes + (data_codes + 15) // 16
    return (protocol_codes + qr_count - 1) // qr_count


def _render(transfer: NativeTransfer, qr_count: int, module_size: int) -> Image.Image:
    tiles = []
    for _ in range(qr_count):
        side, modules = transfer.next_qr()
        tile = ImageOps.expand(
            Image.frombytes("L", (side, side), modules), border=4, fill=255
        )
        tile = tile.resize(
            (tile.width * module_size, tile.height * module_size),
            Image.Resampling.NEAREST,
        )
        tiles.append(tile)
    columns = 2 if qr_count == 4 else 1
    cell = max(tile.width for tile in tiles)
    side = cell * columns
    # H.264 yuv420p requires even dimensions; add white, never resize modules.
    canvas = Image.new("L", (side + side % 2, side + side % 2), 255)
    for index, tile in enumerate(tiles):
        canvas.paste(tile, ((index % columns) * cell, (index // columns) * cell))
    return canvas


def _ffmpeg_command(
    executable: str, path: Path, width: int, height: int, fps: int
) -> list[str]:
    return [
        executable,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        "rawvideo",
        "-pixel_format",
        "gray",
        "-video_size",
        f"{width}x{height}",
        "-framerate",
        str(fps),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "medium",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        "mp4",
        str(path),
    ]


def _platform_key() -> str:
    # platform.machine() calls socket.gethostname() on older Windows Python.
    # These OS/interpreter fields need neither socket APIs nor helper commands.
    if os.name == "nt":
        tag = sysconfig.get_platform().lower()
        if tag == "win-amd64":
            return "windows-x86_64"
        if tag == "win32":
            return "windows-i686"
        return "unsupported"
    machine = os.uname().machine.lower()
    architecture = {
        "x86_64": "x86_64",
        "amd64": "x86_64",
        "arm64": "aarch64",
        "aarch64": "aarch64",
    }.get(machine)
    system = {"darwin": "macos", "linux": "linux"}.get(sys.platform)
    return f"{system}-{architecture}" if system and architecture else "unsupported"


def _ffmpeg_executable() -> Path:
    # Use only the binary delivered during pip installation. No PATH/Conda
    # fallback and no IMAGEIO_FFMPEG_EXE override can launch a remote program.
    name = FNAME_PER_PLATFORM.get(_platform_key())
    if not name:
        raise RuntimeError(
            "No bundled FFmpeg for this platform; install a supported imageio-ffmpeg wheel"
        )
    path = Path(imageio_ffmpeg.__file__).parent / "binaries" / name
    if not path.is_file():
        raise FileNotFoundError(
            "Bundled FFmpeg is missing; reinstall the imageio-ffmpeg wheel"
        )
    return path


def _publish(temporary: Path, destination: Path, overwrite: bool) -> None:
    if overwrite:
        os.replace(temporary, destination)
    elif os.name == "nt":
        os.rename(temporary, destination)  # Windows rename fails if destination exists.
    else:
        try:
            os.link(temporary, destination)  # Atomic no-replace where supported.
        except OSError as error:
            if error.errno not in {
                errno.ENOTSUP,
                errno.EOPNOTSUPP,
                errno.EPERM,
                errno.ENOSYS,
                errno.EXDEV,
            }:
                raise
            # Network shares and some local filesystems do not support links.
            # Exclusive creation still prevents overwriting a concurrent writer.
            with temporary.open("rb") as source:
                output = destination.open("xb")
                try:
                    with output:
                        shutil.copyfileobj(source, output, length=1024 * 1024)
                except BaseException:
                    destination.unlink(missing_ok=True)
                    raise
        temporary.unlink()


def file_to_video(
    input_path: str | os.PathLike[str],
    output_path: str | os.PathLike[str],
    *,
    fps: int = 30,
    qr_count: int = 1,
    module_size: int = 4,
    symbol_size: int = 1400,
    redundancy_pct: int = 50,
    repeats: int = 1,
    compression: str = "auto",
    overwrite: bool = False,
    progress: Callable[[VideoProgress], None] | None = None,
) -> VideoResult:
    """Convert one file to an AirFerry-compatible H.264 MP4 using offline codecs.

    Installation supplies the native encoder and FFmpeg. Compression and video
    encoding do not use online services or download runtime components. Input,
    output, and temporary storage use normal filesystem I/O, including network
    shares, mapped drives, symbolic links, and file URLs. Network storage may
    produce filesystem traffic independently of the offline encoding pipeline.

    ``compression`` is ``auto`` (smaller of raw and Zstd level 1), ``none``,
    ``zstd``, or ``xz``. One pass contains all source symbols plus at least
    eight repair symbols per segment and at least one second per segment.
    Repeats replay the complete transfer;
    they do not increase the number of distinct repair symbols.

    The output parent must exist. An existing output is preserved unless
    ``overwrite=True``; even then it is replaced only after FFmpeg succeeds.
    A progress callback may raise to cancel, leaving the old output intact.
    """
    _integer("fps", fps, 1, 120)
    _integer("module_size", module_size, 1, 16)
    _integer("symbol_size", symbol_size, 64, 2888)
    if symbol_size % 8:
        raise ValueError("symbol_size must be divisible by 8")
    _integer("redundancy_pct", redundancy_pct, 5, 50)
    _integer("repeats", repeats, 1, 100)
    _integer("qr_count", qr_count, 1, 4)
    if qr_count not in (1, 4):
        raise ValueError("qr_count must be 1 or 4")
    if compression not in ("auto", "none", "zstd", "xz"):
        raise ValueError("compression must be auto, none, zstd, or xz")
    if progress is not None and not callable(progress):
        raise TypeError("progress must be callable")
    source = _filesystem_path(input_path)
    destination = _filesystem_path(output_path)
    if not source.is_file():
        raise FileNotFoundError(f"input is not a file: {source}")
    if destination.suffix.lower() != ".mp4":
        raise ValueError("output_path must have the .mp4 extension")
    if not destination.parent.is_dir():
        raise FileNotFoundError(
            f"output directory does not exist: {destination.parent}"
        )
    if source.resolve() == destination.resolve() or (
        destination.exists() and os.path.samefile(source, destination)
    ):
        raise ValueError("input and output must be different files")
    if os.path.lexists(destination) and not overwrite:
        raise FileExistsError(destination)
    if destination.is_dir():
        raise IsADirectoryError(destination)
    executable_path = _ffmpeg_executable()
    with tempfile.TemporaryDirectory(prefix="airferry-") as work:
        transfer = NativeTransfer(
            source, Path(work) / "payload.bin", compression, symbol_size, redundancy_pct
        )
        budgets = []
        for index in range(transfer.segment_count):
            length = min(
                SEGMENT_RAW_BYTES, transfer.compressed_size - index * SEGMENT_RAW_BYTES
            )
            k = (length + symbol_size - 1) // symbol_size
            budgets.append(max(fps, _frame_budget(k, redundancy_pct, qr_count)))
        total_frames = sum(budgets) * repeats
        # Keep the temporary MP4 on the destination filesystem for atomic commit.
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{destination.stem}-", suffix=".mp4", dir=destination.parent
        )
        os.close(fd)
        temporary = Path(temporary_name)
        process = None
        written = 0
        width = height = 0
        try:
            with tempfile.TemporaryFile(mode="w+b", dir=work) as errors:
                try:
                    for _ in range(repeats):
                        for index, budget in enumerate(budgets):
                            k = transfer.start_segment(index)
                            if (
                                max(fps, _frame_budget(k, redundancy_pct, qr_count))
                                != budget
                            ):
                                raise RuntimeError(
                                    "native source-symbol count differs from video budget"
                                )
                            for _ in range(budget):
                                frame = _render(transfer, qr_count, module_size)
                                if process is None:
                                    width, height = frame.size
                                    process = subprocess.Popen(
                                        _ffmpeg_command(
                                            str(executable_path),
                                            temporary,
                                            width,
                                            height,
                                            fps,
                                        ),
                                        stdin=subprocess.PIPE,
                                        stdout=subprocess.DEVNULL,
                                        stderr=errors,
                                        creationflags=subprocess.CREATE_NO_WINDOW
                                        if os.name == "nt"
                                        else 0,
                                    )
                                if frame.size != (width, height):
                                    raise RuntimeError(
                                        "QR dimensions changed within the transfer"
                                    )
                                process.stdin.write(frame.tobytes())
                                written += 1
                                if progress is not None:
                                    progress(
                                        VideoProgress(
                                            written,
                                            total_frames,
                                            index,
                                            transfer.segment_count,
                                        )
                                    )
                    process.stdin.close()
                    returncode = process.wait()
                    if returncode:
                        raise RuntimeError(f"FFmpeg exited with status {returncode}")
                except (BrokenPipeError, OSError, RuntimeError) as exc:
                    if process is not None:
                        process.kill()
                        process.wait()
                    errors.seek(0, os.SEEK_END)
                    errors.seek(max(0, errors.tell() - 8192))
                    detail = errors.read().decode("utf-8", errors="replace").strip()
                    if detail:
                        raise RuntimeError(f"Video encoding failed: {detail}") from exc
                    raise
            if written != total_frames or temporary.stat().st_size == 0:
                raise RuntimeError("FFmpeg did not produce the complete video")
            _publish(temporary, destination, overwrite)
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                if process.stdin is not None and not process.stdin.closed:
                    try:
                        process.stdin.close()
                    except OSError:
                        pass
                process.wait()
            temporary.unlink(missing_ok=True)
        return VideoResult(
            destination,
            width,
            height,
            written,
            fps,
            transfer.segment_count,
            transfer.compression,
            transfer.original_size,
            transfer.compressed_size,
        )
