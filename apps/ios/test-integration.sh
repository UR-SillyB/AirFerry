#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/airferry-ios.XXXXXX")
# Retain fixtures on failure so CI/local failures are inspectable.
cargo run --locked -p transfer-engine --example ios_fixture -- "$fixture_dir"
cargo rustc --locked -p transfer-engine --lib --features cffi --crate-type staticlib
swiftc -import-objc-header apps/ios/Native/AirFerry.h \
  apps/ios/AirFerry/QRBytes.swift apps/ios/AirFerry/Receiver.swift apps/ios/Integration/main.swift \
  -L target/debug -ltransfer_engine -L /opt/homebrew/lib -L /usr/local/lib -llzma \
  -o "$fixture_dir/integration"
"$fixture_dir/integration" "$fixture_dir"
