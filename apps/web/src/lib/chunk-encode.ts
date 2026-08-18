/**
 * Balanced chunk pre-encoding (AF2 sender policy, SPEC §10.1 — host-side).
 *
 * Runs at "开始传输" time, BEFORE `build`/`build_cached`: every chunk is
 * classified and encoded here (sample skip → best-of zstd-L1/xz-p2 →
 * R-gated p6 escalation, all inside `encode_chunk_balanced` in the Rust
 * core), then handed to the sender as pre-encoded chunks. The play loop's
 * rAF tick never compresses — `ensure_chunk_encoder` consumes what this pass
 * produced.
 *
 * The pass is advisory: any throw → the caller falls back to the plain lazy
 * build (current behavior), so a policy bug can never block sending.
 */

import { encode_chunk_balanced, plan_chunks } from "@/wasm/loader"
import type { PreparedItem } from "@/workers/compress.worker"

export const CODEC_RAW = 0

export interface ChunkEncoding {
  index: number
  /** Wire codec tag (0=RAW marker, 1=Zstd, 2=Xz). */
  codec: number
  /** Encoded bytes; empty for the RAW marker. */
  data: Uint8Array
}

export interface PrepareChunkOptions {
  chunkRawSize: number
  /** Playout payload rate in bytes/sec (fps × symbolSize × QR count). */
  channelBps: number
  /** Single-chunk transfers always escalate to the high-ratio preset. */
  forceFull: boolean
  onProgress?: (done: number, total: number) => void
}

interface PlannedSegment {
  item: number
  start: number
  len: number
}

function yieldToUi(): Promise<void> {
  // One macrotask between chunks keeps the params page's spinner animating
  // and event loop responsive while wasm encodes synchronously (~0.1–1s per
  // chunk in practice).
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Assemble one chunk's raw bytes from the planned item segments. */
function assembleChunk(
  items: PreparedItem[],
  segments: PlannedSegment[],
): Uint8Array {
  const total = segments.reduce((sum, s) => sum + s.len, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const seg of segments) {
    const src = new Uint8Array(items[seg.item].content, seg.start, seg.len)
    out.set(src, pos)
    pos += seg.len
  }
  return out
}

/**
 * Pre-encode every chunk of the canonical stream. Returns one entry per
 * chunk (RAW results become empty markers — the raw slice is streamed
 * directly, no duplicated memory).
 */
export async function prepareChunkEncodings(
  items: PreparedItem[],
  opts: PrepareChunkOptions,
): Promise<ChunkEncoding[]> {
  if (items.length === 0) throw new Error("no items to encode")
  const kinds = new Uint8Array(items.map((it) => it.kind))
  const paths = items.map((it) => it.path)
  const sizes = new Float64Array(items.map((it) => it.content.byteLength))
  const plan = JSON.parse(
    plan_chunks(kinds, paths, sizes, opts.chunkRawSize),
  ) as { chunks: number[][] }
  const chunks: PlannedSegment[][] = plan.chunks.map((flat) => {
    const segs: PlannedSegment[] = []
    for (let i = 0; i < flat.length; i += 3) {
      segs.push({ item: flat[i], start: flat[i + 1], len: flat[i + 2] })
    }
    return segs
  })
  const encodings: ChunkEncoding[] = []
  for (let i = 0; i < chunks.length; i++) {
    const raw = assembleChunk(items, chunks[i])
    const enc = encode_chunk_balanced(
      raw,
      BigInt(Math.max(0, Math.round(opts.channelBps))),
      opts.forceFull,
    )
    try {
      if (enc.codec_id === CODEC_RAW) {
        encodings.push({ index: i, codec: CODEC_RAW, data: new Uint8Array(0) })
      } else {
        if (enc.data.length >= raw.length) {
          // Strictly-smaller is a wire invariant — refuse to provision a
          // violation even if the core policy somehow produced one.
          throw new Error(
            `chunk ${i}: encoded ${enc.data.length} not < raw ${raw.length}`,
          )
        }
        encodings.push({ index: i, codec: enc.codec_id, data: enc.data })
      }
    } finally {
      // The wasm-side EncodedChunk holds the full ≤8 MiB encoded block until
      // GC; freeing here keeps the pre-encode pass from inflating the WASM
      // heap by the whole transfer size.
      enc.free()
    }
    opts.onProgress?.(i + 1, chunks.length)
    if (i < chunks.length - 1) await yieldToUi()
  }
  return encodings
}
