// EasyTransfer JNI bridge: ZXing-C++ QR decoder for CameraX YUV frames.
//
// Exposes `decodeY(...)` to Kotlin. Returns the decoded byte payload (the
// serialized EasyTransfer frame) or null if no QR is found in the frame.
//
// Targets zxing-cpp v3.0.2 API: Barcode / ReadBarcodes / ReaderOptions.

#include <jni.h>
#include <android/log.h>
#include <vector>
#include <cstring>

#include "ReadBarcode.h"
#include "ImageView.h"
#include "BarcodeFormat.h"

#define LOG_TAG "easytransfer-zxing"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" {

// Accept a single luminance (Y) plane from CameraX's ImageProxy and decode any
// QR code in it. Returns the raw byte payload, or nullptr.
JNIEXPORT jbyteArray JNICALL
Java_com_easytransfer_app_scan_ZxingDecoder_decodeY(
    JNIEnv *env, jobject /*thiz*/,
    jbyteArray yPlane, jint width, jint height, jint rowStride
) {
    jsize len = env->GetArrayLength(yPlane);
    jbyte *data = env->GetByteArrayElements(yPlane, nullptr);
    if (!data) {
        return nullptr;
    }

    // Unpack the Y plane (may have row padding) into a compact greyscale buffer.
    std::vector<uint8_t> grey(static_cast<size_t>(width) * height);
    const uint8_t *src = reinterpret_cast<const uint8_t *>(data);
    for (int y = 0; y < height; y++) {
        std::memcpy(grey.data() + static_cast<size_t>(y) * width,
                    src + static_cast<size_t>(y) * rowStride,
                    static_cast<size_t>(width));
    }
    env->ReleaseByteArrayElements(yPlane, data, JNI_ABORT);

    try {
        ZXing::ImageView image(grey.data(), width, height, ZXing::ImageFormat::Lum);
        ZXing::ReaderOptions options;
        options.setFormats(ZXing::BarcodeFormat::QRCode);
        // tryHarder=false: the aggressive geometry path (SampleQR/intersect) is
        // what triggers asserts on dense V40 codes. Our QRs are high-contrast
        // and well-formed, so the fast path suffices and is more stable.
        options.setTryHarder(false);
        options.setTryInvert(true);

        // ReadBarcodes returns a vector<Barcode>; we take the first valid one.
        auto results = ZXing::ReadBarcodes(image, options);
        for (const auto &result : results) {
            if (result.isValid()) {
                const auto &bytes = result.bytes();
                if (!bytes.empty()) {
                    jbyteArray out = env->NewByteArray(static_cast<jsize>(bytes.size()));
                    if (out) {
                        env->SetByteArrayRegion(out, 0, static_cast<jsize>(bytes.size()),
                            reinterpret_cast<const jbyte *>(bytes.data()));
                    }
                    return out;
                }
            }
        }
    } catch (const std::exception &e) {
        LOGE("decode error: %s", e.what());
    }
    return nullptr;
}

}  // extern "C"
