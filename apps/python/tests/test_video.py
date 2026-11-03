"""Public API behavior and runtime offline/transaction guarantees."""

import errno
import os
import socket
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from airferry import VideoProgress, file_to_video, video


def test_offline_generation(tmp_path, monkeypatch):
    """Real native + Pillow + bundled FFmpeg, with Python networking disabled."""

    def forbidden(*args, **kwargs):
        raise AssertionError("network access during video generation")

    for name in (
        "socket",
        "create_connection",
        "getaddrinfo",
        "gethostbyname",
        "gethostbyname_ex",
        "gethostname",
    ):
        monkeypatch.setattr(socket, name, forbidden)
    # Even an explicitly configured remote FFmpeg must not be consulted.
    monkeypatch.setenv("IMAGEIO_FFMPEG_EXE", "https://example.invalid/ffmpeg")
    monkeypatch.delenv("FFREPORT", raising=False)
    real_popen = subprocess.Popen
    commands = []

    def checked_popen(command, **kwargs):
        # Python 3.10/3.11 platform detection may run the local `ver` command.
        if isinstance(command, str) and command in (
            "ver",
            "command /c ver",
            "cmd /c ver",
        ):
            return real_popen(command, **kwargs)
        commands.append(command)
        whitelist_positions = [
            i for i, item in enumerate(command) if item == "-protocol_whitelist"
        ]
        assert len(whitelist_positions) == 2
        assert all(command[i + 1] == "file,pipe" for i in whitelist_positions)
        assert Path(command[0]).parent.name == "binaries"
        return real_popen(command, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", checked_popen)
    source = tmp_path / "offline.bin"
    source.write_bytes(b"entirely offline\x00\xff" * 1024)
    updates = []
    result = file_to_video(source, tmp_path / "offline.mp4", progress=updates.append)
    assert result.path.read_bytes()[4:8] == b"ftyp"
    assert len(commands) == 1
    assert updates[-1] == VideoProgress(result.frame_count, result.frame_count, 0, 1)
    assert result.duration > 0


def test_cancel_keeps_previous_output_and_cleans_temporary_video(tmp_path):
    source = tmp_path / "source.bin"
    source.write_bytes(bytes(range(256)) * 32)
    destination = tmp_path / "output.mp4"
    destination.write_bytes(b"previous video")

    def cancel(_):
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        file_to_video(source, destination, overwrite=True, progress=cancel)
    assert destination.read_bytes() == b"previous video"
    assert set(tmp_path.iterdir()) == {source, destination}


def test_ffmpeg_failure_preserves_existing_output(tmp_path, monkeypatch):
    source = tmp_path / "source.bin"
    source.write_bytes(b"payload" * 1024)
    destination = tmp_path / "previous.mp4"
    destination.write_bytes(b"previous")
    original_command = video._ffmpeg_command

    def invalid_codec(*args):
        command = original_command(*args)
        command[command.index("libx264")] = "airferry-nonexistent-codec"
        return command

    monkeypatch.setattr(video, "_ffmpeg_command", invalid_codec)
    with pytest.raises(RuntimeError, match="airferry-nonexistent-codec"):
        file_to_video(source, destination, overwrite=True)
    assert destination.read_bytes() == b"previous"
    assert set(tmp_path.iterdir()) == {source, destination}


def test_output_created_during_conversion_is_not_overwritten(tmp_path):
    source = tmp_path / "source.bin"
    source.write_bytes(b"payload" * 256)
    destination = tmp_path / "competing.mp4"

    def concurrent_writer(update):
        if update.frames_written == 1:
            destination.write_bytes(b"another writer")

    with pytest.raises(FileExistsError):
        file_to_video(source, destination, progress=concurrent_writer)
    assert destination.read_bytes() == b"another writer"


def test_input_cannot_be_overwritten(tmp_path):
    source = tmp_path / "input.mp4"
    source.write_bytes(b"input must survive")
    with pytest.raises(ValueError, match="different files"):
        file_to_video(source, source, overwrite=True)
    assert source.read_bytes() == b"input must survive"


def test_file_urls_with_escaped_names_generate_real_video(tmp_path):
    source = tmp_path / "输入 空格#%.bin"
    source.write_bytes(b"file URI input\0\xff" * 200)
    destination = tmp_path / "输出 空格#%.mp4"
    result = file_to_video(source.as_uri(), destination.as_uri())
    assert result.path == destination
    assert destination.read_bytes()[4:8] == b"ftyp"


def test_file_url_hosts_are_preserved_as_filesystem_paths():
    assert (
        video._filesystem_path("file://server/share/a%20b.bin")
        == Path("//server/share/a b.bin").absolute()
    )
    assert (
        video._filesystem_path("file:////server/share/a%20b.bin")
        == Path("//server/share/a b.bin").absolute()
    )


def test_localhost_file_urls_preserve_windows_shares():
    if os.name == "nt":
        assert video._filesystem_path("file://localhost/share/a%20b.bin") == Path(
            "//localhost/share/a b.bin"
        )
        assert video._filesystem_path("file://localhost/C:/a%20b.bin") == Path(
            "C:/a b.bin"
        )


def test_linked_storage_and_temporary_directory_are_accepted(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    (storage / "temporary").mkdir()
    source = storage / "source.bin"
    source.write_bytes(b"filesystem access through links" * 200)
    linked = tmp_path / "linked"
    if os.name == "nt":
        # Directory junctions are reparse points and need no symlink privilege.
        completed = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(linked), str(storage)],
            capture_output=True,
            check=False,
        )
        if completed.returncode:
            pytest.skip("directory junction creation is unavailable")
    else:
        linked.symlink_to(storage, target_is_directory=True)
    try:
        # Some Windows volumes allow junction traversal but reject directory
        # creation through it. Avoid tempfile's repeated name retries there.
        probe = linked / "temporary" / "write-probe"
        try:
            probe.mkdir()
        except OSError:
            pytest.skip("the filesystem cannot create directories through this link")
        else:
            probe.rmdir()
        with monkeypatch.context() as context:
            context.setattr(video.tempfile, "tempdir", str(linked / "temporary"))
            result = file_to_video(linked / "source.bin", linked / "output.mp4")
        assert result.path.read_bytes()[4:8] == b"ftyp"
        assert (storage / "output.mp4").is_file()
        assert list((storage / "temporary").iterdir()) == []
    finally:
        if os.name == "nt":
            linked.rmdir()
        else:
            linked.unlink()


def _unsupported_hardlinks(monkeypatch):
    def unsupported(*_args):
        raise OSError(errno.EOPNOTSUPP, "filesystem does not support hard links")

    # Exercise the POSIX publish branch even on Windows without modifying the
    # process-wide os.name that pathlib and pytest also consult.
    monkeypatch.setattr(video, "os", SimpleNamespace(name="posix", link=unsupported))


def test_publish_without_hardlink_support_keeps_no_overwrite_guarantee(
    tmp_path, monkeypatch
):
    _unsupported_hardlinks(monkeypatch)
    temporary = tmp_path / "temporary.mp4"
    destination = tmp_path / "destination.mp4"
    temporary.write_bytes(b"completed video")
    video._publish(temporary, destination, False)
    assert destination.read_bytes() == b"completed video"
    assert not temporary.exists()
    temporary.write_bytes(b"another video")
    with pytest.raises(FileExistsError):
        video._publish(temporary, destination, False)
    assert destination.read_bytes() == b"completed video"
    assert temporary.read_bytes() == b"another video"


def test_publish_copy_failure_cleans_new_output(tmp_path, monkeypatch):
    _unsupported_hardlinks(monkeypatch)
    temporary = tmp_path / "temporary.mp4"
    destination = tmp_path / "destination.mp4"
    temporary.write_bytes(b"completed video")

    def interrupted_copy(_source, output, **_kwargs):
        output.write(b"partial")
        raise OSError("storage interrupted")

    monkeypatch.setattr(video.shutil, "copyfileobj", interrupted_copy)
    with pytest.raises(OSError, match="storage interrupted"):
        video._publish(temporary, destination, False)
    assert not destination.exists()
    assert temporary.read_bytes() == b"completed video"


def test_empty_file_and_invalid_qr_configuration(tmp_path):
    source = tmp_path / "empty.bin"
    source.touch()
    with pytest.raises(ValueError, match="empty"):
        file_to_video(source, tmp_path / "output.mp4")
    assert not (tmp_path / "output.mp4").exists()
    source.write_bytes(b"nonempty")
    with pytest.raises(ValueError, match="symbol_size"):
        file_to_video(source, tmp_path / "output.mp4", symbol_size=1401)
    with pytest.raises(ValueError, match="qr_count"):
        file_to_video(source, tmp_path / "output.mp4", qr_count=1.0)


def test_repeats_and_cli(tmp_path):
    source = tmp_path / "input.bin"
    source.write_bytes(b"replay" * 100)
    once = file_to_video(source, tmp_path / "once.mp4")
    repeated = file_to_video(source, tmp_path / "twice.mp4", repeats=2)
    assert repeated.frame_count == once.frame_count * 2
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "airferry",
            str(source),
            str(tmp_path / "cli.mp4"),
            "--qr-count",
            "4",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert (tmp_path / "cli.mp4").read_bytes()[4:8] == b"ftyp"
    # Also exercise failure without Python tracebacks.
    failure = subprocess.run(
        [sys.executable, "-m", "airferry", str(source), str(tmp_path / "cli.mp4")],
        capture_output=True,
        text=True,
        check=False,
    )
    assert failure.returncode == 1
    assert "Traceback" not in failure.stderr


def test_bundled_ffmpeg_missing_does_not_download(tmp_path, monkeypatch):
    source = tmp_path / "source.bin"
    source.write_bytes(b"local only")
    monkeypatch.setattr(
        video, "FNAME_PER_PLATFORM", {video._platform_key(): "missing-ffmpeg"}
    )
    with pytest.raises(FileNotFoundError, match="Bundled FFmpeg is missing"):
        file_to_video(source, tmp_path / "output.mp4")
    assert not (tmp_path / "output.mp4").exists()


def test_fresh_process_generates_video_with_all_socket_audit_events_denied(tmp_path):
    source = tmp_path / "isolated.bin"
    source.write_bytes(b"offline subprocess\0\xff" * 512)
    destination = tmp_path / "isolated.mp4"
    script = """
import sys
def deny_network(event, args):
    if event.startswith('socket.'):
        raise RuntimeError('network access denied: ' + event)
sys.addaudithook(deny_network)
from airferry import file_to_video
file_to_video(sys.argv[1], sys.argv[2], qr_count=4)
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(source), str(destination)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert destination.read_bytes()[4:8] == b"ftyp"
