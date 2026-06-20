package com.easytransfer.app.scan

import android.util.Log
import java.nio.ByteBuffer
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock

/**
 * Decouples camera capture from QR decoding.
 *
 * The CameraX analyzer (the *producer*) copies each frame's Y (luminance) plane
 * into a pooled buffer, enqueues it, and immediately closes the `ImageProxy`. A
 * pool of N worker threads drains the queue and runs ZXing on each frame (on a
 * center ROI first, see [decode]). Every decoded payload is handed to
 * [onDecoded] under a single [ingestLock], so the **non-thread-safe** native
 * receiver (the `transfer_engine` JNI handle) is only ever touched by one thread
 * at a time — ZXing decode runs fully parallel, native ingest stays serialized.
 *
 * Out-of-order delivery is fine: RaptorQ symbols are keyed by `(sbn, esi)`, so
 * dropping or reordering frames never corrupts recovery — it only costs time.
 *
 * @param onDecoded invoked (serialized) with each decoded QR payload.
 */
class QrDecodePool(
    private val onDecoded: (ByteArray) -> Unit,
    /**
     * Experimental multi-QR mode: when true, each frame is decoded with
     * `ReadBarcodes` (plural) and *every* valid code's payload is ingested
     * (not just the first), so a sender tiling N codes per frame yields ~N
     * symbols/tick. Off (default) → single-code tracked-ROI path.
     */
    private val multiMode: Boolean = false,
) {
    /** A captured luminance frame; [y] is a pooled buffer (recycled after use). */
    private class YFrame(
        @JvmField val y: ByteArray,
        @JvmField val width: Int,
        @JvmField val height: Int,
        @JvmField val rowStride: Int,
        /** Number of valid bytes in [y] (may be < y.size for a recycled buffer). */
        @JvmField val len: Int
    )

    private val workerCount =
        (Runtime.getRuntime().availableProcessors() - 2).coerceIn(2, 6)
    private val queue = ArrayBlockingQueue<YFrame>(workerCount + 2)
    private val freeList = ArrayDeque<ByteArray>()
    private val freeLock = Any()
    private val ingestLock = ReentrantLock(true) // fair: keep ingest roughly in arrival order
    private val running = AtomicBoolean(false)
    private val workers = ArrayList<Thread>()

    // Metrics (read by the UI for live diagnostics).
    private val capturedFrames = AtomicLong(0)
    private val droppedFrames = AtomicLong(0)
    /** Count of decoded *symbols* (QR codes), not frames. A multi-QR frame that
     *  yields N codes increments this by N, so the UI's "解码速率" reads as
     *  symbols/sec and scales correctly with the on-screen code count. */
    private val decodedFrames = AtomicLong(0)
    /** Consecutive ROI misses, used to throttle full-frame fallback decodes. */
    private val roiMiss = AtomicLong(0)

    /**
     * Last-known QR bounding box in full-frame pixel coords {minX, minY, maxX,
     * maxY}, or null before the first lock / after a miss. Read/written by
     * multiple workers; a stale read is harmless (worst case: one frame uses a
     * slightly old position), so a plain volatile reference suffices. The array
     * itself is treated as immutable after publication.
     */
    @Volatile
    private var lastQrBbox: IntArray? = null

    /**
     * Multi-QR tracking: the last known bboxes of each on-screen code (a packed
     * IntArray of 4×N ints: {minX,minY,maxX,maxY} per code). null before the
     * first full-frame lock. Published as a single immutable reference so a
     * worker reading a stale copy merely re-scans one extra frame harmlessly.
     */
    @Volatile
    private var multiTrackedBboxes: IntArray? = null
    /** Number of multi codes in [multiTrackedBboxes] (bboxes.length / 4). */
    @Volatile
    private var multiTrackedCount: Int = 0
    /** Consecutive tracked-region misses in multi mode → trigger re-lock. */
    private val multiMiss = AtomicLong(0)

    fun start() {
        if (running.getAndSet(true)) return
        for (i in 0 until workerCount) {
            val t = Thread({ workerLoop() }, "qr-decode-$i").apply { isDaemon = true }
            workers.add(t)
            t.start()
        }
        Log.i(TAG, "decode pool started: $workerCount workers")
    }

    /**
     * Producer entry. Copies the Y plane out of [src] into a pooled buffer and
     * enqueues it; the caller still owns [src] and must close its `ImageProxy`
     * after this returns. Drop-newest when the queue is full (any distinct
     * fountain symbol is equally useful, so dropping the freshest under load is
     * harmless and never stalls the camera).
     */
    fun submit(src: ByteBuffer, width: Int, height: Int, rowStride: Int) {
        if (!running.get()) return
        val len = src.remaining()
        if (len <= 0) return
        // Sanity-check the declared geometry against the buffer length. The full-
        // frame decode path (below) passes (w, h, rs) to native, which indexes
        // `(height-1)*rowStride + width`; a HAL that returns a plane shorter
        // than that (or a stale width/height after a resolution change) would
        // hand ZXing a truncated frame that decodes to nothing — silently
        // wasting CPU. Reject such frames up front instead.
        if (width <= 0 || height <= 0 || rowStride <= 0 ||
            len < (height - 1) * rowStride + width
        ) {
            droppedFrames.incrementAndGet()
            return
        }
        capturedFrames.incrementAndGet()
        val buf = obtainBuffer(len)
        src.get(buf, 0, len)
        val frame = YFrame(buf, width, height, rowStride, len)
        if (!queue.offer(frame)) {
            droppedFrames.incrementAndGet()
            recycleBuffer(buf)
        }
    }

    private fun workerLoop() {
        // Per-worker scratch for the native bbox write-back (decodeYRegionTracked
        // fills [0..3]). Avoids allocating per frame and avoids cross-worker
        // contention on a shared array.
        val bboxOut = IntArray(4)
        while (running.get()) {
            val frame = try {
                queue.poll(200, TimeUnit.MILLISECONDS)
            } catch (e: InterruptedException) {
                break
            } ?: continue
            try {
                if (multiMode) {
                    // Multi-QR tracked pipeline:
                    //  1. Hot path: if we have per-code bboxes from the last lock,
                    //     decode each in a tight expanded window (ReadBarcode singular
                    //     per window) — avoids the full-frame finder scan entirely.
                    //  2. Cold path: a periodic full-frame ReadBarcodes re-locks all
                    //     code positions (every MULTI_FULL_DECODE_EVERY misses, or on
                    //     the very first frame). This is the only place that pays for
                    //     a whole-frame scan.
                    val results = decodeMultiTracked(frame)
                    if (results.isNotEmpty()) {
                        decodedFrames.addAndGet(results.size.toLong())
                        ingestLock.lock()
                        try {
                            for (r in results) onDecoded(r.payload)
                        } finally {
                            ingestLock.unlock()
                        }
                    }
                } else {
                    val payload = decode(frame, bboxOut)
                    if (payload != null) {
                        // Single-code path: one decoded symbol per frame.
                        decodedFrames.incrementAndGet()
                        // Serialize native ingest: one thread in onDecoded at a time.
                        // The lock (not a single-thread executor) also applies natural
                        // backpressure so a fast batch decode can't grow an unbounded
                        // pending-ingest queue.
                        ingestLock.lock()
                        try {
                            onDecoded(payload)
                        } finally {
                            ingestLock.unlock()
                        }
                    }
                }
            } catch (e: Throwable) {
                // Never let a worker die on one bad frame.
                Log.w(TAG, "decode/ingest error", e)
            } finally {
                recycleBuffer(frame.y)
            }
        }
    }

    /**
     * Multi-QR decode with per-code ROI tracking.
     *
     * Hot path: each code's last-known bbox (from the previous lock) is passed
     * to `decodeMultiYTracked`, which crops a zero-copy expanded window around
     * each and runs ReadBarcode (singular) inside it. This skips the full-frame
     * finder scan — the dominant cost of multi decode — reducing per-frame work
     * from O(frame pixels) to O(Σ code module pixels).
     *
     * Cold path: every [MULTI_FULL_DECODE_EVERY] consecutive tracked misses, or
     * on the first frame (no bboxes yet), run a full-frame `ReadBarcodes` to
     * (re-)lock all on-screen code positions. A successful full-frame read seeds
     * [multiTrackedBboxes] so subsequent frames use the fast region path.
     *
     * Returns the decoded codes (payloads). RaptorQ dedups by sbn/esi, so it's
     * fine if a code occasionally fails to decode in its window.
     */
    private fun decodeMultiTracked(frame: YFrame): List<ZxingDecoder.MultiResult> {
        val tracked = multiTrackedBboxes
        val trackedCount = multiTrackedCount
        // Hot path: region decode per code when we have hints AND we're not due
        // for a full-frame re-lock.
        val dueFullLock = tracked == null ||
            multiMiss.get() % MULTI_FULL_DECODE_EVERY == 0L
        if (!dueFullLock && tracked != null && trackedCount > 0) {
            val buf = try {
                ZxingDecoder.decodeMultiYTracked(
                    frame.y, frame.width, frame.height, frame.rowStride,
                    tracked, trackedCount, TRACK_MARGIN,
                )
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "ZXing native lib not loaded", e); null
            } catch (e: Exception) {
                null
            }
            val results = ZxingDecoder.parseMulti(buf)
            if (results.isNotEmpty()) {
                // Refresh tracked bboxes with the freshly decoded positions.
                publishMultiBboxes(results)
                multiMiss.set(0)
                return results
            }
            // All-region miss → fall through to full-frame re-lock this frame.
            multiMiss.incrementAndGet()
        }
        // Cold path: full-frame scan, seeds the tracker.
        val buf = try {
            ZxingDecoder.decodeMultiY(
                frame.y, frame.width, frame.height, frame.rowStride
            )
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "ZXing native lib not loaded", e); return emptyList()
        } catch (e: Exception) {
            return emptyList()
        }
        val results = ZxingDecoder.parseMulti(buf)
        if (results.isNotEmpty()) {
            publishMultiBboxes(results)
            multiMiss.set(0)
        } else {
            multiMiss.incrementAndGet()
        }
        return results
    }

    /**
     * Publish the per-code bboxes from a decode round as the next frame's
     * tracking hints. Packs {minX,minY,maxX,maxY} per code into a fresh IntArray
     * and swaps it atomically (the old array is not mutated, so any in-flight
     * worker reading the previous reference is safe).
     */
    private fun publishMultiBboxes(results: List<ZxingDecoder.MultiResult>) {
        if (results.isEmpty()) return
        val packed = IntArray(results.size * 4)
        for (i in results.indices) {
            val b = results[i].bbox
            packed[i * 4] = b[0]
            packed[i * 4 + 1] = b[1]
            packed[i * 4 + 2] = b[2]
            packed[i * 4 + 3] = b[3]
        }
        multiTrackedBboxes = packed
        multiTrackedCount = results.size
    }

    /**
     * Decode one frame with adaptive ROI tracking.
     *
     * Three escalating tiers, cheapest first:
     *  1. **Tracked tight ROI**: if we recently locked the QR ([lastQrBbox]),
     *     crop a small window (the bbox expanded by [TRACK_MARGIN]) and decode
     *     it. On a screen QR the code barely moves frame-to-frame, so this
     *     window is far smaller than the fixed center region — much less ZXing
     *     work, raising the sustainable decode rate.
     *  2. **Center ROI**: the fixed large center region (the QR is nominally
     *     centered). Used on a tracked miss, or before the first lock.
     *  3. **Full frame**: only 1 in [FULL_DECODE_EVERY] consecutive ROI misses,
     *     to catch an off-center/oversized browser QR without paying for a full
     *     decode every frame. A full-frame hit also seeds [lastQrBbox].
     *
     * Both ROI tiers use the zero-copy native crop and report the QR's bbox, so
     * any successful decode refreshes [lastQrBbox] for the next frame's tier-1.
     */
    private fun decode(frame: YFrame, bboxOut: IntArray): ByteArray? {
        val w = frame.width
        val h = frame.height
        val rs = frame.rowStride

        // Tier 1: tracked tight ROI around the last known position.
        val tracked = lastQrBbox
        if (tracked != null) {
            val t = tightRoi(tracked, w, h, rs, frame.len)
            if (t != null) {
                val (tx0, ty0, tside) = t
                val p = try {
                    ZxingDecoder.decodeYRegionTracked(frame.y, w, h, rs, tx0, ty0, tside, bboxOut)
                } catch (e: UnsatisfiedLinkError) {
                    Log.e(TAG, "ZXing native lib not loaded", e); return null
                } catch (e: Exception) {
                    null
                }
                if (p != null) {
                    roiMiss.set(0)
                    lastQrBbox = bboxOut.copyOf()
                    return p
                }
                // Tracked window missed → the QR moved or blurred; drop the lock
                // and fall through to the center-ROI tier (do NOT keep hunting
                // in a stale window).
                lastQrBbox = null
            }
        }

        // Tier 2: fixed center ROI.
        val side = (minOf(w, h) * ROI_FRACTION).toInt()
        val x0 = (w - side) / 2
        val y0 = (h - side) / 2
        // Defensive bounds: native also validates, but guarding here keeps a bad
        // geometry from crossing the JNI boundary.
        val roiUsable = side >= MIN_ROI &&
            side < w && side < h && x0 >= 0 && y0 >= 0 &&
            // The last ROI row's tail must stay within the buffer.
            (y0 + side - 1) * rs + (x0 + side) <= frame.len
        if (roiUsable) {
            val p = try {
                ZxingDecoder.decodeYRegionTracked(frame.y, w, h, rs, x0, y0, side, bboxOut)
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "ZXing native lib not loaded", e); return null
            } catch (e: Exception) {
                null
            }
            if (p != null) {
                roiMiss.set(0)
                lastQrBbox = bboxOut.copyOf()
                return p
            }
            // ROI missed; only fall through to a full-frame decode periodically.
            if (roiMiss.incrementAndGet() % FULL_DECODE_EVERY != 0L) return null
        }

        // Tier 3: occasional full-frame decode. If this succeeds, keep the
        // reported bbox so the next frames use the fast tracked ROI instead of
        // repeatedly falling back to expensive full-frame scans.
        val p = try {
            ZxingDecoder.decodeYTracked(frame.y, w, h, rs, bboxOut)
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "ZXing native lib not loaded", e); null
        } catch (e: Exception) {
            null
        }
        if (p != null) {
            roiMiss.set(0)
            lastQrBbox = bboxOut.copyOf()
        }
        return p
    }

    /**
     * Compute a tight square ROI around [bbox] expanded by [TRACK_MARGIN], or
     * null if it can't be made valid (e.g. stale/oversized bbox). Returns
     * `(x0, y0, side)` clamped to the frame and within the buffer.
     */
    private fun tightRoi(
        bbox: IntArray, w: Int, h: Int, rs: Int, len: Int
    ): Triple<Int, Int, Int>? {
        val minX = bbox[0]; val minY = bbox[1]; val maxX = bbox[2]; val maxY = bbox[3]
        if (maxX <= minX || maxY <= minY) return null
        val qw = (maxX - minX).toFloat()
        val qh = (maxY - minY).toFloat()
        // Expand by TRACK_MARGIN on every side so the window tolerates motion.
        val margin = (maxOf(qw, qh) * TRACK_MARGIN).toInt()
        val ex0 = (minX - margin).coerceAtLeast(0)
        val ey0 = (minY - margin).coerceAtLeast(0)
        val ex1 = (maxX + margin).coerceAtMost(w)
        val ey1 = (maxY + margin).coerceAtMost(h)
        val side = minOf(ex1 - ex0, ey1 - ey0)
        if (side < MIN_ROI) return null
        // Make it a square centered on the QR's bbox (ZXing's cropped takes a
        // square region in this codebase).
        val cx = (ex0 + ex1) / 2
        val cy = (ey0 + ey1) / 2
        val half = side / 2
        val x0 = (cx - half).coerceIn(0, (w - side))
        val y0 = (cy - half).coerceIn(0, (h - side))
        // Bounds check mirroring the center-ROI path.
        if ((y0 + side - 1) * rs + (x0 + side) > len) return null
        return Triple(x0, y0, side)
    }

    private fun obtainBuffer(len: Int): ByteArray {
        synchronized(freeLock) {
            while (freeList.isNotEmpty()) {
                val b = freeList.removeLast()
                if (b.size >= len) return b
                // Smaller (stale) buffer from a resolution change — drop it.
            }
        }
        return ByteArray(len)
    }

    private fun recycleBuffer(buf: ByteArray) {
        synchronized(freeLock) {
            if (freeList.size < MAX_FREE) freeList.addLast(buf)
        }
    }

    fun shutdown() {
        if (!running.getAndSet(false)) return
        workers.forEach { it.interrupt() }
        workers.forEach { try { it.join(300) } catch (_: InterruptedException) {} }
        workers.clear()
        queue.clear()
        synchronized(freeLock) { freeList.clear() }
    }

    fun capturedCount(): Long = capturedFrames.get()
    /** Total decoded *symbols* (QR codes), not frames. See [decodedFrames]. */
    fun decodedCount(): Long = decodedFrames.get()
    fun droppedCount(): Long = droppedFrames.get()

    /**
     * Run [action] while holding the ingest lock, so it cannot overlap any
     * in-flight `onDecoded` call. The caller uses this to safely destroy/swap the
     * native receiver (ingest is `&mut`, assemble is `&` — they must not race).
     */
    fun runExclusive(action: () -> Unit) {
        ingestLock.lock()
        try {
            action()
        } finally {
            ingestLock.unlock()
        }
    }

    companion object {
        private const val TAG = "QrDecodePool"
        /** Center-crop side as a fraction of the shorter frame dimension. */
        private const val ROI_FRACTION = 0.9f
        /** Don't ROI-crop below this side length (too few px/module to decode). */
        private const val MIN_ROI = 240
        /** When the ROI keeps missing, do a full-frame decode this often. */
        private const val FULL_DECODE_EVERY = 3L
        /**
         * How much the tracked ROI expands beyond the last QR bbox, as a
         * fraction of the QR size. 0.35 tolerates hand/phone motion between
         * frames while keeping the window much smaller than the center ROI.
         */
        private const val TRACK_MARGIN = 0.35f
        /**
         * In multi-QR mode, re-run a full-frame scan (re-lock all code
         * positions) this many consecutive tracked misses after the last
         * success. Codes on a screen barely move frame-to-frame, so the tracked
         * path stays locked; this only fires when motion/blur breaks the lock.
         */
        private const val MULTI_FULL_DECODE_EVERY = 3L
        /** Cap the recycled-buffer free-list so it can't grow unbounded. */
        private const val MAX_FREE = 12
    }
}
