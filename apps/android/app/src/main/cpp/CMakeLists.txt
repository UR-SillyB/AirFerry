# EasyTransfer Android native: ZXing-C++ QR decoder + JNI bridge.
#
# Fetches zxing-cpp from source (pinned tag) and builds a thin JNI wrapper
# that exposes a luminance-decode entry point to Kotlin.

cmake_minimum_required(VERSION 3.22.1)
project(easytransfer_zxing LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Disable C assertions (NDEBUG) globally — ZXing-C++ contains assert() calls
# (e.g. RegressionLine::intersect) that fire on partial/corrupted QR codes and
# call abort(), crashing the app. NDEBUG makes assert() a no-op.
add_compile_definitions(NDEBUG)

# Align ELF LOAD segments to 16 KiB (0x4000). Android 15+ devices may run with
# a 16 KiB page size (notably 2025 flagship devices on Android 16), and the
# kernel refuses to dlopen() a .so whose LOAD segments are only 4 KiB
# (0x1000) aligned — System.loadLibrary then throws UnsatisfiedLinkError and
# every QR decode silently fails, so the receiver "cannot scan anything".
# NDK r27's clang/ld supports 16 KiB; -z max-page-size=16384 forces the linker
# to round segment alignment up to 16 KiB so the same .so loads on both 4 KiB
# and 16 KiB page-size devices. This must be a target option (not a global
# CMAKE_EXE_LINKER_FLAGS) so it also reaches the link step of the ZXing static
# lib we link in.
add_link_options("-Wl,-z,max-page-size=16384")

# --- Fetch ZXing-C++ (zxing-cpp) ---
# Correct repo: github.com/zxing-cpp/zxing-cpp. Pin stable v3.0.2.
set(ZXING_TAG "v3.0.2")
set(ZXING_SRC_DIR "${CMAKE_BINARY_DIR}/zxing-src")

include(FetchContent)
FetchContent_Declare(
    zxing
    GIT_REPOSITORY https://github.com/zxing-cpp/zxing-cpp.git
    GIT_TAG ${ZXING_TAG}
    SOURCE_DIR ${ZXING_SRC_DIR}
)
# Build only the core reader library (no examples, tests, writers, C-API).
set(ZXING_READERS ON CACHE BOOL "" FORCE)
set(ZXING_WRITERS OFF CACHE STRING "" FORCE)
set(ZXING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(ZXING_BLACKBOX_TESTS OFF CACHE BOOL "" FORCE)
set(ZXING_UNIT_TESTS OFF CACHE BOOL "" FORCE)
set(ZXING_C_API OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(zxing)

# --- JNI bridge library ---
add_library(easytransfer_zxing SHARED
    scan_jni.cpp
)
target_link_libraries(easytransfer_zxing
    ZXing::ZXing
    log
    android
)
