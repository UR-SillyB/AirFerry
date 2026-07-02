#!/usr/bin/env bash
# AFGrid V3 可自动化验证（CI/开发机）。NDK .so、dotnet、真机 E2E 见 docs/afgrid-merge-checklist.md
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "== cargo test (workspace) =="
cargo test --quiet 2>&1 | tail -3
echo "== qr-protocol afgrid =="
cargo test -p qr-protocol afgrid --quiet
echo "== transfer-engine afgrid_e2e + smoke =="
cargo test -p transfer-engine --test afgrid_e2e --test diag_afgrid afgrid_encode_smoke --quiet
SO="$ROOT/apps/scanner/app/src/main/jniLibs/arm64-v8a/libtransfer_engine.so"
if [[ -f "$SO" ]]; then
  echo "== JNI .so present: $SO =="
  ls -la "$SO"
else
  echo "SKIP: no libtransfer_engine.so (run cargo ndk with ANDROID_NDK_HOME)"
fi
if command -v dotnet >/dev/null 2>&1; then
  echo "== dotnet test (windows protocol tests) =="
  (cd "$ROOT/apps/windows" && dotnet test AirFerry.Windows.Tests/AirFerry.Windows.Tests.csproj -c Release) || true
else
  echo "SKIP: dotnet not in PATH"
fi
echo "OK: automatable AFGrid V3 checks passed"
