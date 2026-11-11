#!/bin/bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/../.."
case "${PLATFORM_NAME:-iphoneos}" in
  iphoneos) rust_target=aarch64-apple-ios ;;
  iphonesimulator)
    case "${NATIVE_ARCH_ACTUAL:-arm64}" in
      arm64) rust_target=aarch64-apple-ios-sim ;;
      *) rust_target=x86_64-apple-ios ;;
    esac ;;
  *) echo 'Unsupported Apple platform' >&2; exit 1 ;;
esac
rustup target add "$rust_target"
# cargo's --crate-type overrides the library output without changing the WASM/Android builds.
cargo rustc --locked -p transfer-engine --lib --release --features cffi --target "$rust_target" --crate-type staticlib
mkdir -p "apps/ios/Native/${PLATFORM_NAME:-iphoneos}"
cp "target/$rust_target/release/libtransfer_engine.a" "apps/ios/Native/${PLATFORM_NAME:-iphoneos}/"
