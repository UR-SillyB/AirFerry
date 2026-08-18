//! AF2 Object Meta Record (protocol 2, §8).
//!
//! Fixed 112 bytes + TLVs; carried by an OBJECT_META frame body. Provides
//! everything needed to build a decoder for the Manifest or one chunk.
//!
//! ```text
//! off  len  field
//! 0    4    magic ASCII "AFO2"
//! 4    1    schema = 1
//! 5    1    role: 1=MANIFEST 2=CHUNK
//! 6    2    fixed_len = 112
//! 8    2    extensions_len
//! 10   2    reserved = 0
//! 12   16   transfer_id
//! 28   4    object_index (Manifest=0; Chunk=chunk_index)
//! 32   1    codec_id (0=RAW 1=Zstd 2=Xz)
//! 33   1    fec_id (fixed 1 = RaptorQ RFC 6330)
//! 34   2    reserved = 0
//! 36   12   oti (RFC 6330 12B wire format)
//! 48   32   raw_hash (post-decode, post-decompress bytes)
//! 80   32   encoded_hash (exact Encoded Object bytes)
//! ```

use crate::id::object_id;

pub use crate::id::{ROLE_CHUNK, ROLE_MANIFEST};

pub const META_MAGIC: &[u8; 4] = b"AFO2";
pub const META_SCHEMA: u8 = 1;
pub const META_FIXED_LEN: usize = 112;
pub const FEC_ID_RAPTORQ: u8 = 1;

/// Codec registry (§10). All three are MUST-implement — a one-way channel
/// cannot negotiate, so "optional" means "everyone implements everything".
pub const CODEC_RAW: u8 = 0;
pub const CODEC_ZSTD: u8 = 1;
pub const CODEC_XZ: u8 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectMetaRecord {
    pub role: u8,
    pub transfer_id: [u8; 16],
    pub object_index: u32,
    pub codec_id: u8,
    pub fec_id: u8,
    pub oti: [u8; 12],
    pub raw_hash: [u8; 32],
    pub encoded_hash: [u8; 32],
    pub extensions: Vec<crate::tlv::Tlv>,
}

#[derive(Debug, thiserror::Error)]
pub enum MetaError {
    #[error("meta: bad magic")]
    BadMagic,
    #[error("meta: unsupported schema {0}")]
    BadSchema(u8),
    #[error("meta: unknown role {0}")]
    BadRole(u8),
    #[error("meta: fixed_len must be 112, got {0}")]
    BadFixedLen(u16),
    #[error("meta: body_len mismatch (fixed+ext = {sum}, body = {body})")]
    BodyLenMismatch { sum: usize, body: usize },
    #[error("meta: reserved field must be zero")]
    ReservedNotZero,
    #[error("meta: fec_id must be 1 (RaptorQ), got {0}")]
    BadFec(u8),
    #[error("meta: unknown codec_id {0}")]
    BadCodec(u8),
    #[error("meta: manifest object must use codec RAW (got {0})")]
    ManifestNotRaw(u8),
    #[error("meta: object_id mismatch: frame carried {frame:?}, recomputed {computed:?}")]
    ObjectIdMismatch { frame: [u8; 16], computed: [u8; 16] },
    #[error("meta: {0}")]
    Tlv(#[from] crate::tlv::TlvError),
}

impl ObjectMetaRecord {
    /// Recompute the object id from the record's own fields (§4.3): the
    /// receiver binds META to the routing layer BEFORE building any decoder.
    pub fn recompute_object_id(&self) -> [u8; 16] {
        object_id(
            &self.transfer_id,
            self.role,
            self.object_index,
            self.codec_id,
            self.fec_id,
            &self.oti,
            &self.encoded_hash,
        )
    }

    pub fn encode(&self) -> Result<Vec<u8>, MetaError> {
        if self.role != ROLE_MANIFEST && self.role != ROLE_CHUNK {
            return Err(MetaError::BadRole(self.role));
        }
        if self.fec_id != FEC_ID_RAPTORQ {
            return Err(MetaError::BadFec(self.fec_id));
        }
        if ![CODEC_RAW, CODEC_ZSTD, CODEC_XZ].contains(&self.codec_id) {
            return Err(MetaError::BadCodec(self.codec_id));
        }
        if self.role == ROLE_MANIFEST && self.codec_id != CODEC_RAW {
            return Err(MetaError::ManifestNotRaw(self.codec_id));
        }
        let ext = crate::tlv::encode_tlvs(&self.extensions)?;
        let mut out = Vec::with_capacity(META_FIXED_LEN + ext.len());
        out.extend_from_slice(META_MAGIC);
        out.push(META_SCHEMA);
        out.push(self.role);
        out.extend_from_slice(&(META_FIXED_LEN as u16).to_be_bytes());
        out.extend_from_slice(&(ext.len() as u16).to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes());
        out.extend_from_slice(&self.transfer_id);
        out.extend_from_slice(&self.object_index.to_be_bytes());
        out.push(self.codec_id);
        out.push(self.fec_id);
        out.extend_from_slice(&0u16.to_be_bytes());
        out.extend_from_slice(&self.oti);
        out.extend_from_slice(&self.raw_hash);
        out.extend_from_slice(&self.encoded_hash);
        debug_assert_eq!(out.len(), META_FIXED_LEN);
        out.extend_from_slice(&ext);
        Ok(out)
    }

    /// Parse + validate. Does NOT itself check the object id against the frame
    /// header — the caller (receiver) does that with
    /// [`ObjectMetaRecord::recompute_object_id`], because only it knows the
    /// frame's carried id.
    pub fn parse(body: &[u8]) -> Result<Self, MetaError> {
        if body.len() < META_FIXED_LEN || &body[0..4] != META_MAGIC {
            return Err(MetaError::BadMagic);
        }
        if body[4] != META_SCHEMA {
            return Err(MetaError::BadSchema(body[4]));
        }
        let role = body[5];
        let fixed_len = u16::from_be_bytes([body[6], body[7]]) as usize;
        if fixed_len != META_FIXED_LEN {
            return Err(MetaError::BadFixedLen(fixed_len as u16));
        }
        let ext_len = u16::from_be_bytes([body[8], body[9]]) as usize;
        if body.len() != META_FIXED_LEN + ext_len {
            return Err(MetaError::BodyLenMismatch {
                sum: META_FIXED_LEN + ext_len,
                body: body.len(),
            });
        }
        if body[10] != 0 || body[11] != 0 || body[34] != 0 || body[35] != 0 {
            return Err(MetaError::ReservedNotZero);
        }
        let mut transfer_id = [0u8; 16];
        transfer_id.copy_from_slice(&body[12..28]);
        let object_index = u32::from_be_bytes([body[28], body[29], body[30], body[31]]);
        let codec_id = body[32];
        let fec_id = body[33];
        let mut oti = [0u8; 12];
        oti.copy_from_slice(&body[36..48]);
        let mut raw_hash = [0u8; 32];
        raw_hash.copy_from_slice(&body[48..80]);
        let mut encoded_hash = [0u8; 32];
        encoded_hash.copy_from_slice(&body[80..112]);
        let extensions = crate::tlv::parse_tlvs(&body[META_FIXED_LEN..])?;
        crate::tlv::check_unknown_critical(&extensions)?;
        let rec = ObjectMetaRecord {
            role,
            transfer_id,
            object_index,
            codec_id,
            fec_id,
            oti,
            raw_hash,
            encoded_hash,
            extensions,
        };
        // Re-validate on parse (encode runs the full rule set).
        rec.encode()?;
        Ok(rec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::transfer_id;

    fn sample(role: u8, codec: u8) -> ObjectMetaRecord {
        ObjectMetaRecord {
            role,
            transfer_id: transfer_id(&[9; 32], 8 << 20),
            object_index: if role == ROLE_MANIFEST { 0 } else { 7 },
            codec_id: codec,
            fec_id: FEC_ID_RAPTORQ,
            oti: [0, 0, 0, 1, 0, 0, 0, 4, 0, 1, 0, 8],
            raw_hash: [0x44; 32],
            encoded_hash: [0x55; 32],
            extensions: vec![],
        }
    }

    #[test]
    fn round_trip_and_object_id_binding() {
        let m = sample(ROLE_CHUNK, CODEC_ZSTD);
        let bytes = m.encode().unwrap();
        assert_eq!(bytes.len(), META_FIXED_LEN);
        let parsed = ObjectMetaRecord::parse(&bytes).unwrap();
        assert_eq!(parsed, m);
        // object_id binding: recomputation matches a stable value and changes
        // with any parameter.
        let oid = m.recompute_object_id();
        assert_eq!(oid, parsed.recompute_object_id());
        let mut other = m.clone();
        other.codec_id = CODEC_RAW;
        assert_ne!(oid, other.recompute_object_id());
    }

    #[test]
    fn rejects_violations() {
        assert!(matches!(
            sample(ROLE_MANIFEST, CODEC_ZSTD).encode(),
            Err(MetaError::ManifestNotRaw(1))
        ));
        let mut m = sample(ROLE_CHUNK, CODEC_ZSTD);
        m.fec_id = 2;
        assert!(matches!(m.encode(), Err(MetaError::BadFec(2))));
        let m = sample(ROLE_CHUNK, 9);
        assert!(matches!(m.encode(), Err(MetaError::BadCodec(9))));
        let mut bytes = sample(ROLE_CHUNK, CODEC_RAW).encode().unwrap();
        bytes[10] = 1; // reserved
        assert!(matches!(
            ObjectMetaRecord::parse(&bytes),
            Err(MetaError::ReservedNotZero)
        ));
    }
}
