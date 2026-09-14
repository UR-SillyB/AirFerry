package com.airferry.app.send

/** Only the next window may retain staged bytes; re-arming every live chunk
 *  would keep the entire transfer cached until the following epoch. */
internal fun nextPrefetchChunk(current: Int, chunkCount: Int): Int? {
    if (current < 0 || current >= chunkCount) return null
    return (current + 1) % chunkCount
}
