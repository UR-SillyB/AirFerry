/**
 * Deterministic session-id derivation — mirrors `qr_protocol::session` (Rust)
 * so a sender and a receiver compute the same 128-bit id for the same file.
 *
 * Implements FNV-1a 128-bit over the identity material (name + size + mtime +
 * content fingerprint). BigInt is used because JS has no native u128.
 */

const FNV128_OFFSET_BIAS = 0x6c62272e07bb01426b82175983ad0b58n
const FNV128_PRIME = 0x0000000001000000000000000000013bn
const U128_MASK = (1n << 128n) - 1n

/** 128-bit session id as [low64, high64]. */
export type SessionId = { lo: bigint; hi: bigint }

/** Derive a session id from file identity + content fingerprint. */
export function deriveSessionId(
  name: string,
  size: bigint,
  mtimeMs: bigint,
  fingerprint: Uint8Array
): SessionId {
  let h = FNV128_OFFSET_BIAS
  const feed = (bytes: ArrayLike<number>) => {
    for (let i = 0; i < bytes.length; i++) {
      h ^= BigInt(bytes[i])
      h = (h * FNV128_PRIME) & U128_MASK
    }
  }
  // Encode strings + numbers as UTF-8 / LE bytes, matching Rust's feed order.
  feed(new TextEncoder().encode(name))
  feed(leBytes64(size))
  feed(leBytes64(mtimeMs))
  feed(fingerprint)
  return { lo: h & ((1n << 64n) - 1n), hi: (h >> 64n) & ((1n << 64n) - 1n) }
}

/** 64-bit content fingerprint (FNV-1a 64) over head+tail, mirrors Rust. */
export function contentFingerprint(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const FNV64_OFFSET = 0xcbf29ce484222325n
  const FNV64_PRIME = 0x100000001b3n
  const MASK64 = (1n << 64n) - 1n
  let h = FNV64_OFFSET
  const run = (buf: Uint8Array) => {
    for (let i = 0; i < buf.length; i++) {
      h ^= BigInt(buf[i])
      h = (h * FNV64_PRIME) & MASK64
    }
  }
  run(head)
  run(tail)
  return leBytes64(h)
}

function leBytes64(v: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let tmp = v
  for (let i = 0; i < 8; i++) {
    out[i] = Number(tmp & 0xffn)
    tmp >>= 8n
  }
  return out
}
