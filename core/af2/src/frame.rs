//! AF2 wire frame (protocol 2).
//!
//! ```text
//! [Header 26 B][Payload Area T B][Frame CRC32 4 B]     total overhead 30 B
//! ```
//!
//! | off | len | field     | notes                                        |
//! |----:|----:|-----------|----------------------------------------------|
//! |   0 |   2 | magic     | ASCII `AF` (0x4146)                          |
//! |   2 |   1 | version   | fixed 2; unknown → reject                    |
//! |   3 |   1 | type      | 1=ROOT 2=OBJECT_META 3=SYMBOL; unknown → drop|
//! |   4 |  16 | object_id | SYMBOL/META = Object ID; ROOT = Transfer ID   |
//! |  20 |   2 | body_len  | valid bytes inside the Payload Area           |
//! |  22 |   1 | sbn       | RaptorQ SBN (control frames must be 0)        |
//! |  23 |   3 | esi       | RaptorQ ESI, u24 BE (control frames must be 0)|
//!
//! `T = 帧总长 − 30`，必须 `256 ≤ T ≤ 2400` 且 `T % 8 == 0`；一个 Broadcast
//! Instance 内恒定。SYMBOL 的 `body_len == T`；控制帧 `body_len ≤ T` 且
//! `body_len..T` 必须全零。Frame CRC32（IEEE）覆盖 Header + 完整 Payload Area
//! （含零填充）。CRC 只查扫码误码，不认证。
//!
//! Spec: `docs/SPEC.md` §5.

use crc32fast::Hasher;

/// ASCII "AF".
pub const MAGIC: u16 = 0x4146;
pub const WIRE_VERSION: u8 = 2;

pub const FRAME_TYPE_ROOT: u8 = 1;
pub const FRAME_TYPE_OBJECT_META: u8 = 2;
pub const FRAME_TYPE_SYMBOL: u8 = 3;

pub const HEADER_SIZE: usize = 26;
pub const FOOTER_SIZE: usize = 4;
pub const MIN_T: usize = 256;
pub const MAX_T: usize = 2400;

/// ESI upper bound (2²⁴); the wire field is a u24.
pub const MAX_ESI: u32 = (1 << 24) - 1;
/// SBN legal domain 0..=254 (255 is reserved by RFC 6330).
pub const MAX_SBN: u8 = 254;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameType {
    Root,
    ObjectMeta,
    Symbol,
}

/// Errors raised by frame encode/decode.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("buffer too short: need {need}, have {have}")]
    BufferTooShort { need: usize, have: usize },
    #[error("bad magic: expected 0x{expected:04X}, got 0x{got:04X}")]
    BadMagic { expected: u16, got: u16 },
    #[error("unsupported wire version {0}")]
    BadVersion(u8),
    #[error("unknown frame type {0}")]
    UnknownType(u8),
    #[error("T out of range: {t} (must be {min}..={max}, 8-aligned)")]
    BadT { t: usize, min: usize, max: usize },
    #[error("body_len {body_len} exceeds T {t}")]
    BodyTooLong { body_len: usize, t: usize },
    #[error("payload padding must be zero")]
    NonZeroPadding,
    #[error("control frame must carry sbn=0/esi=0 (got sbn={sbn}, esi={esi})")]
    ControlCoordinates { sbn: u8, esi: u32 },
    #[error("frame CRC mismatch")]
    CrcMismatch,
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut h = Hasher::new();
    h.update(bytes);
    h.finalize()
}

/// An encoded AF2 frame (header fields + payload area of exactly `t` bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Af2Frame {
    pub frame_type: FrameType,
    /// Object ID (SYMBOL/OBJECT_META) or Transfer ID (ROOT).
    pub object_id: [u8; 16],
    pub sbn: u8,
    pub esi: u32,
    /// Valid body bytes (`body_len ≤ t`).
    pub body: Vec<u8>,
    /// Total payload-area size T (body + zero padding).
    pub t: usize,
}

impl Af2Frame {
    /// Wire length of a frame with payload area `t`.
    pub fn wire_size(t: usize) -> usize {
        HEADER_SIZE + t + FOOTER_SIZE
    }

    fn type_code(&self) -> u8 {
        match self.frame_type {
            FrameType::Root => FRAME_TYPE_ROOT,
            FrameType::ObjectMeta => FRAME_TYPE_OBJECT_META,
            FrameType::Symbol => FRAME_TYPE_SYMBOL,
        }
    }

    fn type_from_code(code: u8) -> Result<FrameType, FrameError> {
        match code {
            FRAME_TYPE_ROOT => Ok(FrameType::Root),
            FRAME_TYPE_OBJECT_META => Ok(FrameType::ObjectMeta),
            FRAME_TYPE_SYMBOL => Ok(FrameType::Symbol),
            other => Err(FrameError::UnknownType(other)),
        }
    }

    /// Serialize to wire bytes (header + padded payload + CRC).
    ///
    /// Panics never: all invariants are validated and returned as errors.
    pub fn to_bytes(&self) -> Result<Vec<u8>, FrameError> {
        if !(MIN_T..=MAX_T).contains(&self.t) || self.t % 8 != 0 {
            return Err(FrameError::BadT {
                t: self.t,
                min: MIN_T,
                max: MAX_T,
            });
        }
        if self.body.len() > self.t {
            return Err(FrameError::BodyTooLong {
                body_len: self.body.len(),
                t: self.t,
            });
        }
        match self.frame_type {
            FrameType::Symbol => {
                if self.body.len() != self.t {
                    return Err(FrameError::BodyTooLong {
                        body_len: self.body.len(),
                        t: self.t,
                    });
                }
                if self.sbn > MAX_SBN || self.esi > MAX_ESI {
                    return Err(FrameError::ControlCoordinates {
                        sbn: self.sbn,
                        esi: self.esi,
                    });
                }
            }
            FrameType::Root | FrameType::ObjectMeta => {
                if self.sbn != 0 || self.esi != 0 {
                    return Err(FrameError::ControlCoordinates {
                        sbn: self.sbn,
                        esi: self.esi,
                    });
                }
            }
        }
        let mut out = Vec::with_capacity(Self::wire_size(self.t));
        out.extend_from_slice(&MAGIC.to_be_bytes());
        out.push(WIRE_VERSION);
        out.push(self.type_code());
        out.extend_from_slice(&self.object_id);
        out.extend_from_slice(&(self.body.len() as u16).to_be_bytes());
        out.push(self.sbn);
        out.extend_from_slice(&self.esi.to_be_bytes()[1..4]); // u24 BE
        debug_assert_eq!(out.len(), HEADER_SIZE);
        out.extend_from_slice(&self.body);
        out.resize(HEADER_SIZE + self.t, 0);
        let crc = crc32(&out);
        out.extend_from_slice(&crc.to_be_bytes());
        Ok(out)
    }

    /// Parse + validate a frame. All rejections are fail-closed errors; the
    /// caller treats them as "drop this QR payload".
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, FrameError> {
        let need = HEADER_SIZE + FOOTER_SIZE;
        if bytes.len() < need {
            return Err(FrameError::BufferTooShort {
                need,
                have: bytes.len(),
            });
        }
        let magic = u16::from_be_bytes([bytes[0], bytes[1]]);
        if magic != MAGIC {
            return Err(FrameError::BadMagic {
                expected: MAGIC,
                got: magic,
            });
        }
        if bytes[2] != WIRE_VERSION {
            return Err(FrameError::BadVersion(bytes[2]));
        }
        let frame_type = Self::type_from_code(bytes[3])?;
        let mut object_id = [0u8; 16];
        object_id.copy_from_slice(&bytes[4..20]);
        let body_len = u16::from_be_bytes([bytes[20], bytes[21]]) as usize;
        let sbn = bytes[22];
        let esi = u32::from_be_bytes([0, bytes[23], bytes[24], bytes[25]]);
        let t = bytes.len() - need;
        if !(MIN_T..=MAX_T).contains(&t) || t % 8 != 0 {
            return Err(FrameError::BadT {
                t,
                min: MIN_T,
                max: MAX_T,
            });
        }
        if body_len > t {
            return Err(FrameError::BodyTooLong { body_len, t });
        }
        // Frame CRC covers header + the full payload area (incl. padding).
        let expected_crc = u32::from_be_bytes([
            bytes[bytes.len() - 4],
            bytes[bytes.len() - 3],
            bytes[bytes.len() - 2],
            bytes[bytes.len() - 1],
        ]);
        if crc32(&bytes[..HEADER_SIZE + t]) != expected_crc {
            return Err(FrameError::CrcMismatch);
        }
        let body = &bytes[HEADER_SIZE..HEADER_SIZE + body_len];
        match frame_type {
            FrameType::Symbol => {
                if body_len != t {
                    return Err(FrameError::BodyTooLong { body_len, t });
                }
                if sbn > MAX_SBN || esi > MAX_ESI {
                    return Err(FrameError::ControlCoordinates { sbn, esi });
                }
            }
            FrameType::Root | FrameType::ObjectMeta => {
                if sbn != 0 || esi != 0 {
                    return Err(FrameError::ControlCoordinates { sbn, esi });
                }
                // Padding beyond body_len must be all zero.
                if bytes[HEADER_SIZE + body_len..HEADER_SIZE + t].iter().any(|&b| b != 0) {
                    return Err(FrameError::NonZeroPadding);
                }
            }
        }
        Ok(Af2Frame {
            frame_type,
            object_id,
            sbn,
            esi,
            body: body.to_vec(),
            t,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_ieee_self_check() {
        // SPEC §3: every platform's CRC32 must be IEEE-802.3 polynomial;
        // "123456789" -> 0xCBF43926 is the canonical cross-implementation
        // check value. The Kotlin/C# golden tests assert header fields only,
        // so this Rust-side vector is the wire-level CRC anchor.
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    fn frame(frame_type: FrameType, t: usize) -> Af2Frame {
        let mut body = vec![0u8; t];
        for (i, b) in body.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        Af2Frame {
            frame_type,
            object_id: [0xAB; 16],
            sbn: 0,
            esi: 0,
            body,
            t,
        }
    }

    #[test]
    fn round_trip_root() {
        let f = frame(FrameType::Root, 256);
        // Control frames may carry a short body.
        let f = Af2Frame { body: f.body[..112].to_vec(), ..f };
        let bytes = f.to_bytes().unwrap();
        let parsed = Af2Frame::from_bytes(&bytes).unwrap();
        assert_eq!(parsed, f);
    }

    #[test]
    fn round_trip_symbol_with_coordinates() {
        let mut f = frame(FrameType::Symbol, 1024);
        f.sbn = 7;
        f.esi = 0x00FF_FFFF; // max legal ESI
        let bytes = f.to_bytes().unwrap();
        let parsed = Af2Frame::from_bytes(&bytes).unwrap();
        assert_eq!(parsed.sbn, 7);
        assert_eq!(parsed.esi, 0x00FF_FFFF);
    }

    #[test]
    fn rejects_v1_magic_and_wrong_version() {
        let mut bytes = frame(FrameType::Root, 256).to_bytes().unwrap();
        bytes[0] = b'E';
        bytes[1] = b'T'; // v1 magic must be rejected (AF2 rejects ET frames)
        assert!(matches!(
            Af2Frame::from_bytes(&bytes),
            Err(FrameError::BadMagic { .. })
        ));
        let mut bytes = frame(FrameType::Root, 256).to_bytes().unwrap();
        bytes[2] = 3;
        assert!(matches!(
            Af2Frame::from_bytes(&bytes),
            Err(FrameError::BadVersion(3))
        ));
    }

    #[test]
    fn rejects_crc_and_padding_and_coordinate_violations() {
        let mut bytes = frame(FrameType::Root, 256).to_bytes().unwrap();
        let n = bytes.len();
        bytes[n - 1] ^= 0xFF;
        assert!(matches!(
            Af2Frame::from_bytes(&bytes),
            Err(FrameError::CrcMismatch)
        ));

        // Non-zero padding on a control frame: corrupt a padding byte and
        // fix the CRC so only the padding rule fails.
        let f = frame(FrameType::Root, 256);
        let mut short = Af2Frame { body: f.body[..112].to_vec(), ..f };
        short.body.truncate(64); // body_len 64 → bytes [HEADER+64..T) are padding
        let mut bytes = short.to_bytes().unwrap();
        bytes[HEADER_SIZE + 64] = 1; // non-zero padding
        let fixed = crc32(&bytes[..HEADER_SIZE + 256]);
        let n = bytes.len();
        bytes[n - 4..].copy_from_slice(&fixed.to_be_bytes());
        assert!(matches!(
            Af2Frame::from_bytes(&bytes),
            Err(FrameError::NonZeroPadding)
        ));

        // Control frame with non-zero sbn.
        let mut bad = frame(FrameType::Root, 256);
        bad.sbn = 1;
        assert!(matches!(
            bad.to_bytes(),
            Err(FrameError::ControlCoordinates { .. })
        ));
    }

    #[test]
    fn rejects_bad_t_and_unknown_type() {
        let f = frame(FrameType::Root, 256);
        let mut odd = f.clone();
        odd.t = 250; // not 8-aligned
        assert!(matches!(odd.to_bytes(), Err(FrameError::BadT { .. })));
        let mut huge = f;
        huge.t = 2408;
        assert!(matches!(huge.to_bytes(), Err(FrameError::BadT { .. })));

        let mut bytes = frame(FrameType::Root, 256).to_bytes().unwrap();
        bytes[3] = 9; // unknown type
        let fixed = crc32(&bytes[..HEADER_SIZE + 256]);
        let n = bytes.len();
        bytes[n - 4..].copy_from_slice(&fixed.to_be_bytes());
        assert!(matches!(
            Af2Frame::from_bytes(&bytes),
            Err(FrameError::UnknownType(9))
        ));
    }
}
