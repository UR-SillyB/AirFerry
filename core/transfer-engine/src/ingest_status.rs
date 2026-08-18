//! Shared per-frame ingest status packing.
//!
//! The receiver's [`ingest`](crate::receiver::ReceiverSession::ingest) path
//! returns only success/failure; the JNI, C ABI, and WASM bindings each need to
//! hand the host a compact per-frame summary (completion, acceptance, mismatch
//! streak, received-symbol count). Packing that into a single 64-bit word avoids
//! a per-frame JSON allocation + cross-boundary string copy at 60 fps.
//!
//! Historically the JNI ([`crate::jni`]) and C ABI ([`crate::cffi`]) layers each
//! kept a byte-for-byte identical private `pack_ingest_status` plus an
//! `INGEST_ERROR` sentinel. This module is the single source of truth so the
//! WASM binding (and any future binding) cannot drift from the wire contract.
//!
//! ## Bit layout of the packed `u64` (all fields unsigned, little-endian bits)
//! - bit  0      : `complete` (1 once the object is fully decoded)
//! - bit  1      : `accepted` (1 if this frame contributed a new symbol)
//! - bit  2      : `manifest_ready` (1 on the frame that completed the manifest)
//! - bit  3      : `chunk_ready` (1 on the frame that completed a chunk —
//!   fetch it with `receiver_assemble_chunk(last_chunk_index)`
//!   then release it with `receiver_forget_chunk`)
//! - bit  4      : `relocked` (1 ONLY on [`RELOCKED_BIT`]: a foreign transfer
//!   now owns the session and every host-side transfer artifact — chunk
//!   spill, resume ledger, pending re-verify set — belongs to nobody.
//!   Hosts must react to THIS bit, never to the `accepted && received == 0`
//!   heuristic: after a §12 resume `received_symbols` is still 0, so the
//!   first accepted META frame of the resumed session carries exactly that
//!   heuristic signature and would spuriously destroy the resumed data.)
//! - bits 8..23  : `session_mismatch_streak` (0..=0xFFFF, clamped)
//! - bits 32..63 : `received_symbols` (low 32 bits; real transfers stay well
//!   below 2^32)
//!
//! `received_symbols == u32::MAX` (i.e. bits 32..63 all set, flags clear) is
//! reserved as the [`INGEST_ERROR`] sentinel — a real transfer never reaches it.

/// Packed ingest-status bit offsets / widths.
const COMPLETE_BIT: u32 = 0;
const ACCEPTED_BIT: u32 = 1;
const MANIFEST_READY_BIT: u32 = 2;
const CHUNK_READY_BIT: u32 = 3;
const STREAK_OFFSET: u32 = 8;
const STREAK_WIDTH: u32 = 16;
const RECEIVED_OFFSET: u32 = 32;

/// Set on the one frame where a foreign transfer took over the session
/// (`Relocked`). The ONLY signal hosts may use to discard transfer-owned
/// artifacts — see the module-level layout notes for why the historical
/// `accepted && received_symbols == 0` heuristic is wrong (it also matches
/// `MetaBound`/`InstanceSwitched` on a freshly §12-resumed session whose
/// counter is still zero).
pub const RELOCKED_BIT: u64 = 1u64 << 4;

/// Error sentinel: `received_symbols = u32::MAX` with all flags clear. The host
/// treats this as "frame rejected / nothing to do". Kept bit-for-bit identical
/// across all bindings so the host-side unpack code is shared.
pub const INGEST_ERROR: u64 = 0xFFFF_FFFFu64 << RECEIVED_OFFSET;

/// Pack the per-frame status into the 64-bit layout documented at the module
/// level. `mismatch_streak` is clamped into 16 bits; `received_symbols` is
/// clamped into 32 bits.
pub fn pack(
    complete: bool,
    accepted: bool,
    manifest_ready: bool,
    chunk_ready: bool,
    mismatch_streak: u32,
    received_symbols: u32,
) -> u64 {
    let mut bits: u64 = 0;
    if complete {
        bits |= 1u64 << COMPLETE_BIT;
    }
    if accepted {
        bits |= 1u64 << ACCEPTED_BIT;
    }
    if manifest_ready {
        bits |= 1u64 << MANIFEST_READY_BIT;
    }
    if chunk_ready {
        bits |= 1u64 << CHUNK_READY_BIT;
    }
    // Clamp streak into 16 bits (it's reset well before 2^16 in practice).
    let streak_mask: u64 = (1u64 << STREAK_WIDTH) - 1;
    bits |= ((mismatch_streak as u64) & streak_mask) << STREAK_OFFSET;
    // Clamp received_symbols into 32 bits (a real transfer stays well below).
    let recv32 = u64::from(received_symbols);
    bits |= recv32 << RECEIVED_OFFSET;
    bits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_and_accept_flags() {
        assert_eq!(pack(false, false, false, false, 0, 0), 0);
        assert_eq!(pack(true, false, false, false, 0, 0), 1);
        assert_eq!(pack(false, true, false, false, 0, 0), 1 << 1);
        assert_eq!(pack(true, true, false, false, 0, 0), 0b11);
    }

    #[test]
    fn event_bits_are_independent_of_complete() {
        // A chunk can complete before the whole object: chunk_ready must be
        // observable on its own so hosts can persist + evict incrementally.
        assert_eq!(pack(false, true, false, true, 0, 7), (1 << 1) | (1 << 3) | (7 << 32));
        assert_eq!(pack(false, true, true, false, 0, 3), (1 << 1) | (1 << 2) | (3 << 32));
        // All flags set at once stays representable.
        assert_eq!(
            pack(true, true, true, true, 0, 1),
            0b1111 | (1u64 << 32)
        );
    }

    #[test]
    fn streak_packed_into_bits_8_23() {
        assert_eq!(pack(false, false, false, false, 1, 0), 1 << 8);
        assert_eq!(pack(false, false, false, false, 0xFFFF, 0), 0xFFFFu64 << 8);
    }

    #[test]
    fn streak_clamped_to_16_bits() {
        assert_eq!(pack(false, false, false, false, 0x1FFFF, 0), 0xFFFFu64 << 8);
    }

    #[test]
    fn received_symbols_packed_into_bits_32_63() {
        assert_eq!(pack(false, false, false, false, 0, 1), 1u64 << 32);
    }

    #[test]
    fn combined_fields() {
        assert_eq!(
            pack(true, true, false, false, 0x1234, 0x5678),
            0b11 | (0x1234u64 << 8) | (0x5678u64 << 32)
        );
    }

    #[test]
    fn error_sentinel_layout() {
        assert_eq!(INGEST_ERROR, 0xFFFF_FFFFu64 << 32);
        assert_eq!(((INGEST_ERROR >> 32) & 0xFFFF_FFFF), 0xFFFF_FFFF);
        // The sentinel must keep all flag bits clear so the host can't mistake
        // it for a normal "complete + accepted" frame.
        assert_eq!(INGEST_ERROR & 0b11, 0);
    }

    #[test]
    fn relocked_bit_is_independent_and_outside_existing_fields() {
        assert_eq!(RELOCKED_BIT, 1u64 << 4);
        // Orthogonal to the event flags and every packed field.
        assert_eq!(RELOCKED_BIT & 0b1111, 0);
        assert_eq!((RELOCKED_BIT >> 8) & 0xFFFF, 0);
        assert_eq!(RELOCKED_BIT >> 32, 0);
        // A Relocked word packs accepted + the bit and nothing else.
        assert_eq!(pack(false, true, false, false, 0, 0) | RELOCKED_BIT, 0b1_0010);
    }
}
