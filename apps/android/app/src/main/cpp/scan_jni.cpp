// EasyTransfer JNI bridge: ZXing-C++ QR decoder for CameraX YUV frames.
//
// Exposes `decodeY(...)` (full-frame) and `decodeYRegion(...)` (zero-copy
// center-ROI) to Kotlin. Returns the decoded byte payload (the serialized
// EasyTransfer frame) or null if no QR is found in the frame.
//
// Targets zxing-cpp v3.0.2 API: ImageView (with rowStride + cropped()),
// ReadBarcode.
//
// Performance notes (transfer-speedup):
//   - ImageView is constructed directly over the Y plane WITH its rowStride, so
//     the decoder steps over row padding in place. This removes the per-frame
//     compacting memcpy the old code ran to strip padding (~921 KB at 720p,
//     ~110 MB/s of pure copy at 60 fps). ImageView is a non-owning view, so it
//     is safe as long as the JNI byte[] pin outlives the ReadBarcode() call
//     (it does — ReleaseByteArrayElements runs after decoding).
//   - `decodeYRegion()` uses ImageView::cropped() for a zero-copy sub-window of
//     the center ROI, replacing the per-row arraycopy the caller used to do in
//     Kotlin (~275 KB/frame).
//   - ReadBarcode (singular) replaces ReadBarcodes: there is at most one
//     centered QR per frame, and the singular API returns the first valid
//     result without running a full multi-result scan.

#include <jni.h>
#include <android/log.h>
#include <climits>
#include <vector>

#include "ReadBarcode.h"
#include "ImageView.h"
#include "BarcodeFormat.h"

#define LOG_TAG "easytransfer-zxing"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// Forward decl: decodeInView fills the QR bounding box via this helper, which
// must be visible before decodeInView's definition.
template <typename Pos>
static void fillBbox(const Pos &pos, int *bbox);

// Decode the first valid QR in `view` and copy its raw payload into a fresh
// Java byte[]. Returns nullptr if no QR is found or on allocation failure.
// The ImageView must remain valid for the whole call.
//
// If `outBbox` is non-null and a QR is found, it is filled with the QR's axis-
// aligned bounding box in the *view's* pixel coordinates:
//   outBbox[0]=minX, outBbox[1]=minY, outBbox[2]=maxX, outBbox[3]=maxY.
// The caller uses this to crop a tighter ROI on the next frame (adaptive
// tracking) instead of always scanning the fixed 70% center region.
static jbyteArray decodeInView(JNIEnv *env, const ZXing::ImageView &view, int *outBbox) {
    // The configuration is identical for every frame; building it here keeps it
    // on the stack (no global-lifetime/threading concerns) at negligible cost
    // relative to the decode itself.
    ZXing::ReaderOptions options;
    options.setFormats(ZXing::BarcodeFormat::QRCode);
    // tryHarder=false: the aggressive geometry path (SampleQR/intersect) is
    // what triggers asserts on dense V40 codes. Our QRs are high-contrast and
    // well-formed, so the fast path suffices and is more stable.
    options.setTryHarder(false);
    options.setTryInvert(true);

    try {
        // ReadBarcode (singular): returns the first valid QR. With at most one
        // centered code per frame this avoids the full multi-result pass that
        // ReadBarcodes would run.
        auto result = ZXing::ReadBarcode(view, options);
        if (result.isValid()) {
            // Capture the QR's bounding box for adaptive ROI tracking. The
            // position is in the view's coordinate system (already accounts for
            // any cropped() offset applied to the ImageView).
            if (outBbox) {
                fillBbox(result.position(), outBbox);
            }
            const auto &bytes = result.bytes();
            if (!bytes.empty()) {
                jbyteArray out = env->NewByteArray(static_cast<jsize>(bytes.size()));
                if (!out) {
                    // NewByteArray failed (OOM) → clear the pending exception so
                    // it doesn't surface on the next unrelated JNI call.
                    if (env->ExceptionCheck()) env->ExceptionClear();
                    return nullptr;
                }
                env->SetByteArrayRegion(out, 0, static_cast<jsize>(bytes.size()),
                    reinterpret_cast<const jbyte *>(bytes.data()));
                if (env->ExceptionCheck()) {
                    env->ExceptionClear();
                    return nullptr;
                }
                return out;
            }
        }
    } catch (const std::exception &e) {
        LOGE("decode error: %s", e.what());
    }
    return nullptr;
}

// Multi-code decode: run ReadBarcodes (plural) over `view` and collect every
// valid QR's payload into a flat buffer for the experimental multi-QR mode.
// Returns a freshly-allocated Java byte[] laid out as:
//   [u32 count_LE][for each code: u32 len_LE + len bytes payload]
// or nullptr if no valid QR is found. The Kotlin side parses this and ingests
// each payload into the same RaptorQ session (codes are distinguished by their
// embedded sbn/esi, so no protocol change is needed).
//
// tryHarder stays false: multi-QR codes are deliberately smaller (tiled), but
// they are still high-contrast screen codes, so the fast path is stable and
// avoids the assert-prone aggressive geometry path.
static jbyteArray decodeInViewMulti(JNIEnv *env, const ZXing::ImageView &view) {
    ZXing::ReaderOptions options;
    options.setFormats(ZXing::BarcodeFormat::QRCode);
    options.setTryHarder(false);
    options.setTryInvert(true);

    try {
        auto results = ZXing::ReadBarcodes(view, options);
        // Build the flat output in a std::vector first (count unknown until we
        // filter valid/non-empty), then copy into the Java array in one shot.
        std::vector<uint8_t> out;
        out.resize(4);  // placeholder for count
        uint32_t count = 0;
        for (const auto &result : results) {
            if (!result.isValid()) continue;
            const auto &bytes = result.bytes();
            if (bytes.empty()) continue;
            uint32_t len = static_cast<uint32_t>(bytes.size());
            // length-prefix (little-endian u32) + payload
            out.push_back(len & 0xFF);
            out.push_back((len >> 8) & 0xFF);
            out.push_back((len >> 16) & 0xFF);
            out.push_back((len >> 24) & 0xFF);
            out.insert(out.end(), bytes.begin(), bytes.end());
            count++;
        }
        if (count == 0) return nullptr;
        // Write the actual count into the header slot.
        out[0] = count & 0xFF;
        out[1] = (count >> 8) & 0xFF;
        out[2] = (count >> 16) & 0xFF;
        out[3] = (count >> 24) & 0xFF;

        jbyteArray arr = env->NewByteArray(static_cast<jsize>(out.size()));
        if (!arr) {
            if (env->ExceptionCheck()) env->ExceptionClear();
            return nullptr;
        }
        env->SetByteArrayRegion(arr, 0, static_cast<jsize>(out.size()),
            reinterpret_cast<const jbyte *>(out.data()));
        if (env->ExceptionCheck()) {
            env->ExceptionClear();
            return nullptr;
        }
        return arr;
    } catch (const std::exception &e) {
        LOGE("multi decode error: %s", e.what());
    }
    return nullptr;
}

// Write the axis-aligned bounding box of a ZXing position (a Quadrilateral of
// four corner points) into bbox[4] = {minX, minY, maxX, maxY}. v3.0.2's
// Quadrilateral derives from std::array<T,4>, so the four corners are indexed
// [0]=topLeft, [1]=topRight, [2]=bottomRight, [3]=bottomLeft.
template <typename Pos>
static void fillBbox(const Pos &pos, int *bbox) {
    bbox[0] = INT_MAX; bbox[1] = INT_MAX; bbox[2] = INT_MIN; bbox[3] = INT_MIN;
    for (int i = 0; i < 4; i++) {
        int x = static_cast<int>(pos[i].x);
        int y = static_cast<int>(pos[i].y);
        if (x < bbox[0]) bbox[0] = x;
        if (y < bbox[1]) bbox[1] = y;
        if (x > bbox[2]) bbox[2] = x;
        if (y > bbox[3]) bbox[3] = y;
    }
}

// Validate Y-plane geometry (width/height/rowStride vs buffer length) and pin
// the byte[] for the duration of the decode. Returns the pinned pointer (and
// the array length via *outLen) or nullptr on failure. The caller MUST pair
// every non-null return with ReleaseByteArrayElements(.., JNI_ABORT).
static jbyte *pinYPlane(JNIEnv *env, jbyteArray yPlane, jint width, jint height,
                        jint rowStride, jsize *outLen) {
    jsize len = env->GetArrayLength(yPlane);
    if (outLen) *outLen = len;
    // Validate dimensions BEFORE pinning. `width`/`height`/`rowStride` and the
    // array length must be self-consistent, or the view would let zxing read
    // out of bounds (SIGSEGV). Use 64-bit math so the region size can't
    // overflow. This mirrors the check QrDecodePool.submit() already does, but
    // native is the trust boundary so we defend here too.
    if (width <= 0 || height <= 0 || rowStride < width ||
        static_cast<int64_t>(height - 1) * static_cast<int64_t>(rowStride) +
            static_cast<int64_t>(width) > static_cast<int64_t>(len)) {
        return nullptr;
    }
    return env->GetByteArrayElements(yPlane, nullptr);
}

extern "C" {

// Full-frame decode: view the padded Y plane in place (no compacting memcpy).
JNIEXPORT jbyteArray JNICALL
Java_com_easytransfer_app_scan_ZxingDecoder_decodeY(
    JNIEnv *env, jobject /*thiz*/,
    jbyteArray yPlane, jint width, jint height, jint rowStride
) {
    jbyte *data = pinYPlane(env, yPlane, width, height, rowStride, nullptr);
    if (!data) return nullptr;

    jbyteArray result = nullptr;
    try {
        // ImageView is a non-owning view over `data`; passing rowStride lets
        // zxing step over row padding without copying. (v3.0.2 signature:
        // ImageView(data, w, h, format, rowStride = 0, pixStride = 0).)
        ZXing::ImageView view(reinterpret_cast<const uint8_t *>(data),
                              width, height, ZXing::ImageFormat::Lum, rowStride);
        result = decodeInView(env, view, nullptr);
    } catch (const std::exception &e) {
        LOGE("ImageView error: %s", e.what());
    }
    // JNI_ABORT: we never modified the source bytes, so skip the copy-back.
    env->ReleaseByteArrayElements(yPlane, data, JNI_ABORT);
    return result;
}

// Zero-copy center-ROI decode: views a (x0, y0, side, side) sub-window of the
// padded Y plane via ImageView::cropped(), avoiding the per-row arraycopy the
// caller used to do in Kotlin. `x0`/`y0` are top-left pixel coordinates.
JNIEXPORT jbyteArray JNICALL
Java_com_easytransfer_app_scan_ZxingDecoder_decodeYRegion(
    JNIEnv *env, jobject /*thiz*/,
    jbyteArray yPlane, jint width, jint height, jint rowStride,
    jint x0, jint y0, jint side
) {
    jbyte *data = pinYPlane(env, yPlane, width, height, rowStride, nullptr);
    if (!data) return nullptr;

    jbyteArray result = nullptr;
    try {
        ZXing::ImageView full(reinterpret_cast<const uint8_t *>(data),
                              width, height, ZXing::ImageFormat::Lum, rowStride);
        // cropped() clamps to frame bounds and returns a non-owning sub-view
        // that reuses the parent rowStride — no pixel copy. An empty/invalid
        // region (side <= 0) lets zxing throw, caught below as a no-decode.
        ZXing::ImageView roi = full.cropped(x0, y0, side, side);
        result = decodeInView(env, roi, nullptr);
    } catch (const std::exception &e) {
        LOGE("ImageView/region error: %s", e.what());
    }
    env->ReleaseByteArrayElements(yPlane, data, JNI_ABORT);
    return result;
}

// Adaptive-tracking ROI decode. Same zero-copy crop as decodeYRegion, but on
// success also writes the QR's full-frame bounding box into `outBbox[4]`
// {minX, minY, maxX, maxY}. The caller feeds that bbox back as the next frame's
// ROI hint, so once the QR is locked the decoder scans a tight window around it
// instead of the fixed 70% center region — less ZXing work per frame, higher
// sustainable decode rate at 720p/60fps.
//
// `outBbox` is a 4-int array the caller pre-allocates; on a miss it is left
// untouched (the caller falls back to the fixed center ROI). The bbox is
// expressed in full-frame pixel coordinates.
JNIEXPORT jbyteArray JNICALL
Java_com_easytransfer_app_scan_ZxingDecoder_decodeYRegionTracked(
    JNIEnv *env, jobject /*thiz*/,
    jbyteArray yPlane, jint width, jint height, jint rowStride,
    jint x0, jint y0, jint side, jintArray outBbox
) {
    jbyte *data = pinYPlane(env, yPlane, width, height, rowStride, nullptr);
    if (!data) return nullptr;

    // Default bbox = the requested region itself, so on a miss the caller can
    // still use it (though it typically falls back to a fresh center ROI).
    int bbox[4] = {x0, y0, x0 + side, y0 + side};
    jbyteArray result = nullptr;
    try {
        ZXing::ImageView full(reinterpret_cast<const uint8_t *>(data),
                              width, height, ZXing::ImageFormat::Lum, rowStride);
        ZXing::ImageView roi = full.cropped(x0, y0, side, side);
        result = decodeInView(env, roi, bbox);
    } catch (const std::exception &e) {
        LOGE("ImageView/tracked error: %s", e.what());
    }
    env->ReleaseByteArrayElements(yPlane, data, JNI_ABORT);

    // Publish the bbox (in full-frame coords) only if we actually decoded. The
    // ROI view's local origin is (x0, y0), so translate the view-relative
    // position back into full-frame coordinates.
    if (result != nullptr && outBbox != nullptr) {
        if (env->GetArrayLength(outBbox) >= 4) {
            int full[4] = {bbox[0] + x0, bbox[1] + y0, bbox[2] + x0, bbox[3] + y0};
            env->SetIntArrayRegion(outBbox, 0, 4, full);
            if (env->ExceptionCheck()) env->ExceptionClear();
        }
    }
    return result;
}

// Multi-QR full-frame decode (experimental). Scans the whole frame with
// ReadBarcodes and returns every valid QR's payload in a flat buffer (see
// decodeInViewMulti). Used only when the receiver has multi-QR mode enabled;
// otherwise the single-code tracked path is used. The Y plane is viewed in
// place (rowStride honored) — no compacting copy.
JNIEXPORT jbyteArray JNICALL
Java_com_easytransfer_app_scan_ZxingDecoder_decodeMultiY(
    JNIEnv *env, jobject /*thiz*/,
    jbyteArray yPlane, jint width, jint height, jint rowStride
) {
    jbyte *data = pinYPlane(env, yPlane, width, height, rowStride, nullptr);
    if (!data) return nullptr;

    jbyteArray result = nullptr;
    try {
        ZXing::ImageView view(reinterpret_cast<const uint8_t *>(data),
                              width, height, ZXing::ImageFormat::Lum, rowStride);
        result = decodeInViewMulti(env, view);
    } catch (const std::exception &e) {
        LOGE("ImageView/multi error: %s", e.what());
    }
    env->ReleaseByteArrayElements(yPlane, data, JNI_ABORT);
    return result;
}

}  // extern "C"
