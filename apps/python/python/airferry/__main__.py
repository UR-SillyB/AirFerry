"""Command-line file-to-video conversion."""

from __future__ import annotations

import argparse
import sys

from . import __version__, file_to_video


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert a file to an AirFerry QR video using offline codecs."
    )
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("input", help="input filesystem path or file URL")
    parser.add_argument("output", help="output .mp4 path")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--qr-count", type=int, choices=(1, 4), default=1)
    parser.add_argument("--module-size", type=int, default=4)
    parser.add_argument("--symbol-size", type=int, default=1400)
    parser.add_argument("--redundancy-pct", type=int, default=50)
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument(
        "--compression", choices=("auto", "none", "zstd", "xz"), default="auto"
    )
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = file_to_video(
            args.input,
            args.output,
            fps=args.fps,
            qr_count=args.qr_count,
            module_size=args.module_size,
            symbol_size=args.symbol_size,
            redundancy_pct=args.redundancy_pct,
            repeats=args.repeats,
            compression=args.compression,
            overwrite=args.overwrite,
        )
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"airferry: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("airferry: cancelled", file=sys.stderr)
        return 130
    print(
        f"{result.path} ({result.width}x{result.height}, {result.frame_count} frames, {result.duration:.2f}s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
