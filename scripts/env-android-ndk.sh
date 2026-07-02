# Source from repo root:  source scripts/env-android-ndk.sh
# Aligns with apps/scanner/local.properties sdk.dir + app ndkVersion 27.0.12077973
if [[ -z "${ANDROID_SDK_ROOT:-}" ]]; then
  if [[ -f "$(dirname "$0")/../apps/scanner/local.properties" ]]; then
    SDK_DIR=$(grep '^sdk.dir=' "$(dirname "$0")/../apps/scanner/local.properties" | cut -d= -f2-)
    export ANDROID_SDK_ROOT="$SDK_DIR"
  else
    export ANDROID_SDK_ROOT="/opt/homebrew/share/android-commandlinetools"
  fi
fi
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
NDK_VER="${AIRFERRY_NDK_VERSION:-27.0.12077973}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_SDK_ROOT/ndk/$NDK_VER}"
if [[ ! -d "$ANDROID_NDK_HOME" ]]; then
  echo "WARN: ANDROID_NDK_HOME not found: $ANDROID_NDK_HOME" >&2
  return 1 2>/dev/null || exit 1
fi
