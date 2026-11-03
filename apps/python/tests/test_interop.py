"""Real MP4 -> grayscale pixels -> ZXing -> existing Rust receiver checks.

Requires the ``test`` extra and a Rust toolchain; run with ``pytest -m interop``.
No sender internals or in-process receiver bindings are used to decode the video.
"""

from __future__ import annotations

import hashlib
import random
import struct
import subprocess
from pathlib import Path

import pytest
from airferry import file_to_video

pytestmark = pytest.mark.interop
REPOSITORY = next(
    (
        parent
        for parent in Path(__file__).resolve().parents
        if (parent / "core/transfer-engine/Cargo.toml").is_file()
    ),
    None,
)


@pytest.fixture(scope="module")
def rust_receiver() -> Path:
    """Build the independent receiver with the repository's normal Rust core."""
    if REPOSITORY is None:
        pytest.skip("interop verification requires a repository checkout")
    completed = subprocess.run(
        [
            "cargo",
            "build",
            "--locked",
            "--release",
            "-p",
            "transfer-engine",
            "--example",
            "python_video_verify",
            "--message-format=json",
        ],
        cwd=REPOSITORY,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    # Cargo's JSON artifact location also respects CARGO_TARGET_DIR overrides.
    import json

    for line in completed.stdout.splitlines():
        message = json.loads(line)
        if (
            message.get("reason") == "compiler-artifact"
            and message["target"]["name"] == "python_video_verify"
            and message.get("executable")
        ):
            return Path(message["executable"])
    pytest.fail("Cargo did not report the python_video_verify executable")


def extract_video_records(video: Path, destination: Path, *, drop_every: int = 0):
    """Read the encoded MP4 itself, preserving the QR codes' binary payloads."""
    imageio_ffmpeg = pytest.importorskip("imageio_ffmpeg")
    zxingcpp = pytest.importorskip("zxingcpp")
    image = pytest.importorskip("PIL.Image")
    frames = imageio_ffmpeg.read_frames(str(video), pix_fmt="gray", bits_per_pixel=8)
    counts = []
    try:
        metadata = next(frames)
        with destination.open("wb") as output:
            for index, pixels in enumerate(frames):
                if drop_every and (index + 1) % drop_every == 0:
                    continue
                frame = image.frombytes("L", metadata["size"], pixels)
                codes = zxingcpp.read_barcodes(
                    frame,
                    formats=zxingcpp.BarcodeFormat.QRCode,
                    try_rotate=False,
                    try_invert=False,
                )
                counts.append(len(codes))
                for code in codes:
                    # .text would corrupt arbitrary binary data via transcoding.
                    payload = bytes(code.bytes)
                    assert payload[:3] == b"ET\x01", "decoded a non-AirFerry QR code"
                    output.write(struct.pack(">I", len(payload)))
                    output.write(payload)
    finally:
        frames.close()
    assert counts and sum(counts), "no AirFerry QR code could be read from the MP4"
    return metadata, counts


def recover_records(receiver: Path, records: Path, output: Path) -> str:
    completed = subprocess.run(
        [str(receiver), str(records), str(output)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    return completed.stdout


@pytest.mark.parametrize(
    ("compression", "qr_count", "payload"),
    [
        ("none", 1, random.Random(42).randbytes(16_384)),
        ("zstd", 1, b"Zstandard video QR interoperability\x00\xff\n" * 256),
        (
            "xz",
            4,
            b"AirFerry Python sender binary interoperability\x00\xff\x80\n" * 128,
        ),
        ("auto", 1, "中文文件内容与二进制校验\n".encode() * 128),
    ],
    ids=["raw-single", "zstd-single", "xz-four", "auto-unicode"],
)
def test_generated_mp4_recovers_original_file(
    tmp_path: Path, rust_receiver: Path, compression: str, qr_count: int, payload: bytes
):
    source = tmp_path / "测试文件.bin"
    source.write_bytes(payload)
    result = file_to_video(
        source,
        tmp_path / "transfer.mp4",
        fps=24,
        qr_count=qr_count,
        module_size=4,
        redundancy_pct=50,
        compression=compression,
    )
    records = tmp_path / "decoded-qr-records.bin"
    metadata, counts = extract_video_records(result.path, records)
    assert tuple(metadata["size"]) == (result.width, result.height)
    assert metadata["fps"] == pytest.approx(24)
    assert len(counts) == result.frame_count
    assert all(count == qr_count for count in counts), counts
    recovered = tmp_path / "recovered.bin"
    report = recover_records(rust_receiver, records, recovered)
    assert source.name in report
    assert (
        hashlib.sha256(recovered.read_bytes()).digest()
        == hashlib.sha256(payload).digest()
    )
    assert recovered.read_bytes() == payload


def test_mp4_repair_symbols_recover_after_video_frame_loss(
    tmp_path: Path, rust_receiver: Path
):
    # Enough independent source symbols to exercise repair recovery, including
    # dropping source data frames. Keep the initial descriptor frame intact.
    payload = random.Random(12345).randbytes(32_768)
    source = tmp_path / "lossy-transfer.bin"
    source.write_bytes(payload)
    result = file_to_video(
        source,
        tmp_path / "lossy-transfer.mp4",
        qr_count=1,
        module_size=4,
        redundancy_pct=50,
        compression="none",
    )
    records = tmp_path / "surviving-qr-records.bin"
    _, counts = extract_video_records(result.path, records, drop_every=7)
    assert len(counts) < result.frame_count
    recovered = tmp_path / "recovered-after-loss.bin"
    recover_records(rust_receiver, records, recovered)
    assert recovered.read_bytes() == payload


@pytest.mark.slow
def test_large_original_uses_v5_even_when_compressed_video_is_small(
    tmp_path: Path, rust_receiver: Path
):
    # A highly compressible original can fit one optical segment while exceeding
    # the legacy receiver's 256 MiB decompression ceiling. It still needs v5.
    original_size = 256 * 1024 * 1024 + 1
    source = tmp_path / "large-zero-file.bin"
    with source.open("wb") as output:
        output.truncate(original_size)
    result = file_to_video(
        source,
        tmp_path / "large-original.mp4",
        compression="zstd",
        redundancy_pct=50,
    )
    assert result.original_size == original_size
    assert result.segment_count == 1
    assert result.compressed_size < 1024 * 1024
    records = tmp_path / "large-original-qr-records.bin"
    extract_video_records(result.path, records)
    with records.open("rb") as stream:
        length = struct.unpack(">I", stream.read(4))[0]
        first = stream.read(length)
    assert first[3] & 1, "the first QR must be a descriptor"
    assert first[61] == 5, "a >256 MiB original must use descriptor v5"
    recovered = tmp_path / "large-original-recovered.bin"
    recover_records(rust_receiver, records, recovered)
    assert recovered.stat().st_size == original_size

    def sha256_file(path: Path) -> bytes:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        return digest.digest()

    assert sha256_file(recovered) == sha256_file(source)
