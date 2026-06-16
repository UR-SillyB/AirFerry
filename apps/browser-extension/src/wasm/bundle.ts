/**
 * Multi-file bundle container (EasyTransfer Bundle v1).
 *
 * The whole transfer is a single RaptorQ object: one compressed payload → one
 * QR video stream. To send several files "in one go" we pack them into one
 * byte blob *before* compression, so the entire bundle benefits from the
 * three-algorithm compressor and travels as a single transfer. After RaptorQ
 * recovery + decompression, the receiver detects the bundle by its magic
 * prefix and unpacks it back into the individual files.
 *
 * ## When is a bundle used?
 *
 *  - 1 file  → NOT bundled. Sent as a raw single file (current behaviour). The
 *              receiver saves it under the descriptor filename. Fully backward
 *              compatible.
 *  - ≥2 files → bundled. The receiver detects the magic and unpacks every file.
 *
 * ## Wire format (all integers big-endian)
 *
 *   offset  size   field
 *   0       8      magic: ASCII "ETBUNDL1" (0x45 54 42 55 4E 44 4C 31)
 *   8       2      version: u16 = 1
 *   10      2      file_count: u16  (number of files, 1..65535)
 *   12      …      file entries (file_count ×):
 *                    2   name_len: u16  (UTF-8 byte length, 0..65535)
 *                    N   name: name_len bytes, UTF-8
 *                    8   size: u64     (file content length in bytes)
 *                    S   content: size bytes
 *
 * No per-file CRC: the whole bundle is integrity-protected by the
 * transfer-level CRC32 (descriptor) + RaptorQ + the two frame CRCs. The magic
 * is 8 bytes to make an accidental collision with an ordinary single file's
 * first bytes effectively impossible.
 *
 * The Android receiver mirrors this exact layout in `BundleParser.kt`.
 */

export const BUNDLE_MAGIC = "ETBUNDL1"
const BUNDLE_VERSION = 1

/** One file inside a bundle. `data` is the raw file content. */
export interface BundleEntry {
  name: string
  data: Uint8Array
}

export interface BundleManifestEntry {
  name: string
  size: number
}

export interface BuiltBundle {
  bytes: Uint8Array
  entries: BundleManifestEntry[]
}

/** True if `bytes` begins with the bundle magic (8 bytes). */
export function isBundle(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== BUNDLE_MAGIC.charCodeAt(i)) return false
  }
  return true
}

/** Encode a big-endian u16 into a 2-byte array. */
function u16be(v: number): [number, number] {
  return [(v >>> 8) & 0xff, v & 0xff]
}

/** Encode a non-negative safe-integer as a big-endian u64 (8 bytes). */
function u64be(v: number): number[] {
  // Split via BigInt to stay correct above 2^53 (theoretical only; files this
  // large are impractical over QR, but the format is defined as u64).
  const big = BigInt(v)
  const out: number[] = []
  for (let i = 7; i >= 0; i--) {
    out.push(Number((big >> BigInt(i * 8)) & 0xffn))
  }
  return out
}

/**
 * Pack `files` into a single bundle byte array. Files are read fully into
 * memory (the single-file path already does the same).
 */
export async function buildBundle(files: File[]): Promise<BuiltBundle> {
  if (files.length === 0) {
    throw new Error("buildBundle: no files")
  }
  if (files.length > 0xffff) {
    throw new Error("buildBundle: too many files (max 65535)")
  }

  // Read every file up front so we can size the output buffer exactly.
  const entries: BundleEntry[] = []
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer())
    entries.push({ name: f.name, data })
  }

  // Pre-encode names + compute total length.
  const nameBytes: Uint8Array[] = entries.map((e) =>
    new TextEncoder().encode(e.name)
  )
  let total = 8 + 2 + 2 // magic + version + count
  for (let i = 0; i < entries.length; i++) {
    total += 2 + nameBytes[i].length + 8 + entries[i].data.length
  }

  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  let o = 0

  // magic
  for (let i = 0; i < 8; i++) out[o++] = BUNDLE_MAGIC.charCodeAt(i)
  // version (u16 BE)
  dv.setUint16(o, BUNDLE_VERSION)
  o += 2
  // file_count (u16 BE)
  dv.setUint16(o, entries.length)
  o += 2

  const manifest: BundleManifestEntry[] = []
  for (let i = 0; i < entries.length; i++) {
    const name = nameBytes[i]
    dv.setUint16(o, name.length)
    o += 2
    out.set(name, o)
    o += name.length
    // size as u64 BE
    const sizeBytes = u64be(entries[i].data.length)
    for (const b of sizeBytes) out[o++] = b
    // content
    out.set(entries[i].data, o)
    o += entries[i].data.length
    manifest.push({ name: entries[i].name, size: entries[i].data.length })
  }

  return { bytes: out, entries: manifest }
}
