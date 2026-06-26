/**
 * Text payload container (AirFerry Text v1).
 *
 * A text transfer is — at the payload layer — just another single-file object:
 * it goes through the same compression → CRC → fingerprint → session-id →
 * RaptorQ → QR pipeline as a file. The only difference is a magic prefix that
 * lets the receiver tell "this is a text message" from "this is an ordinary
 * file's raw bytes", exactly the way the bundle magic distinguishes multi-file
 * bundles. This mirrors that established pattern (see `bundle.ts`) so no
 * descriptor / protocol-layer change is needed.
 *
 * ## Why a magic prefix instead of a descriptor field?
 *
 * The descriptor (`FileMeta`) currently carries filename / original_size /
 * crc32 / compression / compressed_size — no mime/kind field. Adding one would
 * mean a v4 descriptor extension + four-way sync (Rust core, JS, Android,
 * Windows) and risks the v2/v3 disambiguation regression that was already
 * fixed once. A payload magic puts the text/file distinction in the byte layer
 * alongside the existing bundle logic, keeps the descriptor unchanged, and is
 * automatically backward compatible: an old receiver that doesn't know the
 * magic falls through to single-file handling and saves the bytes as a `.txt`
 * (the sender declares `filename = "文字消息.txt"` in the descriptor), which a
 * user can still open.
 *
 * ## Wire format
 *
 *   offset  size   field
 *   0       8      magic: ASCII "ETTEXTv1" (0x45 54 54 45 58 54 76 31)
 *   8       …      UTF-8 text bytes (the message, no length prefix — the
 *                  transfer-level original_size / compressed_size already
 *                  delimit the payload; the magic is exactly 8 bytes so the
 *                  text starts at offset 8)
 *
 * No per-field CRC: the whole text is integrity-protected by the transfer-level
 * CRC32 (descriptor) + RaptorQ + the two frame CRCs, identical to a file. The
 * magic is 8 bytes so an accidental collision with an ordinary single file's
 * first bytes is effectively impossible (same rationale as the bundle magic).
 *
 * The Android receiver mirrors this in `TextParser.kt`; the Windows receiver
 * mirrors it in `TextParser.cs`.
 */

export const TEXT_MAGIC = "ETTEXTv1"

/** Display name written into the descriptor for a text transfer. */
export const TEXT_DISPLAY_NAME = "文字消息.txt"

/** True if `bytes` begins with the text magic (8 bytes). */
export function isTextPayload(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== TEXT_MAGIC.charCodeAt(i)) return false
  }
  return true
}

/**
 * Build the text transfer payload: `[magic][UTF-8 text]`. The returned bytes
 * are the "raw" input to the compressor — exactly what a single file's bytes
 * would be, just with the magic prepended.
 */
export function buildTextPayload(text: string): Uint8Array {
  const textBytes = new TextEncoder().encode(text)
  const out = new Uint8Array(8 + textBytes.length)
  for (let i = 0; i < 8; i++) out[i] = TEXT_MAGIC.charCodeAt(i)
  out.set(textBytes, 8)
  return out
}
