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
    private val onDecoded: (ByteArray) -> Unit
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

    /** Per-worker reusable ROI crop buffer (grows on demand, never shared). */
    private class CropBuf {
        var buf = ByteArray(0)
        fun ensure(n: Int): ByteArray {
            if (buf.size < n) buf = ByteArray(n)
            return buf
        }
    }

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
    private val decodedFrames = AtomicLong(0)
    /** Consecutive ROI misses, used to throttle full-frame fallback decodes. */
    private val roiMiss = AtomicLong(0)

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
        val crop = CropBuf()
        while (running.get()) {
            val frame = try {
                queue.poll(200, TimeUnit.MILLISECONDS)
            } catch (e: InterruptedException) {
                break
            } ?: continue
            try {
                val payload = decode(frame, crop)
                if (payload != null) {
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
            } catch (e: Throwable) {
                // Never let a worker die on one bad frame.
                Log.w(TAG, "decode/ingest error", e)
            } finally {
                recycleBuffer(frame.y)
            }
        }
    }

    /**
     * Decode one frame. Tries a center-ROI crop first (the QR is centered and
     * fills a fraction of the frame, so cropping cuts ZXing work and raises the
     * sustainable decode rate). If the ROI misses, a full-frame decode is run
     * only occasionally (1 in [FULL_DECODE_EVERY] consecutive misses) so an
     * off-center QR is still caught without paying for a full decode on every
     * empty frame.
     */
    private fun decode(frame: YFrame, crop: CropBuf): ByteArray? {
        val w = frame.width
        val h = frame.height
        val rs = frame.rowStride
        val side = (minOf(w, h) * ROI_FRACTION).toInt()
        val roiUsable = side >= MIN_ROI &&
            side < w && side < h &&
            // Defensive bounds: the last ROI row must stay within the buffer.
            (((h - side) / 2 + side) * rs) <= frame.len
        if (roiUsable) {
            val out = crop.ensure(side * side)
            cropCenter(frame.y, w, h, rs, side, out)
            val p = try {
                ZxingDecoder.decodeY(out, side, side, side)
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "ZXing native lib not loaded", e); return null
            } catch (e: Exception) {
                null
            }
            if (p != null) {
                roiMiss.set(0)
                return p
            }
            // ROI missed; only fall through to a full-frame decode periodically.
            if (roiMiss.incrementAndGet() % FULL_DECODE_EVERY != 0L) return null
        }
        return try {
            ZxingDecoder.decodeY(frame.y, w, h, rs)
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "ZXing native lib not loaded", e); null
        } catch (e: Exception) {
            null
        }
    }

    /** Copy a centered `side×side` square out of a (possibly padded) Y plane. */
    private fun cropCenter(y: ByteArray, w: Int, h: Int, rowStride: Int, side: Int, out: ByteArray) {
        val x0 = (w - side) / 2
        val y0 = (h - side) / 2
        var di = 0
        for (row in 0 until side) {
            val si = (y0 + row) * rowStride + x0
            System.arraycopy(y, si, out, di, side)
            di += side
        }
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
        private const val ROI_FRACTION = 0.7f
        /** Don't ROI-crop below this side length (too few px/module to decode). */
        private const val MIN_ROI = 240
        /** When the ROI keeps missing, do a full-frame decode this often. */
        private const val FULL_DECODE_EVERY = 8L
        /** Cap the recycled-buffer free-list so it can't grow unbounded. */
        private const val MAX_FREE = 12
    }
}
