//! AF2 three-layer identity (protocol 2).
//!
//! | ID          | bits | answers                            | changes when              |
//! |-------------|-----:|------------------------------------|---------------------------|
//! | Content ID  |  256 | what content + path structure      | never (content identity)  |
//! | Transfer ID |  128 | at which chunk_raw_size it is cut  | only chunk_raw_size       |
//! | Object ID   |  128 | this exact encoding of one object  | OTI/codec/bytes — anything|
//!
//! All hashes are BLAKE3-256 (`H`). `Trunc128(h)` = first 16 bytes in wire
//! order. mtime/MIME/permissions never enter identity (v1 lesson: touch broke
//! resume); they are Entry TLV annotations.
//!
//! Spec: §4.

use blake3::Hasher;

pub const CONTENT_DOMAIN: &[u8] = b"AF2/content/v1";
pub const TRANSFER_DOMAIN: &[u8] = b"AF2/transfer/v1";
pub const OBJECT_DOMAIN: &[u8] = b"AF2/object/v1";

/// Entry kinds (Entry Record `kind` field values).
pub const KIND_FILE: u8 = 1;
pub const KIND_UTF8_TEXT: u8 = 2;
pub const KIND_DIRECTORY: u8 = 3;

/// The manifest-entry description that feeds the Content ID.
#[derive(Debug, Clone)]
pub struct EntryIdInput<'a> {
    pub kind: u8,
    pub path: &'a str,
    pub size: u64,
    /// BLAKE3-256 of the entry content. Directories use `H(empty)`.
    pub entry_hash: [u8; 32],
}

/// `content_id = H("AF2/content/v1" || entry_count:u32 || repeated { kind ||
/// path_len:u16 || path || size:u64 || entry_hash[32] })` over entries sorted
/// by canonical-path UTF-8 byte order.
pub fn content_id(entries: &[EntryIdInput<'_>]) -> [u8; 32] {
    let mut h = Hasher::new();
    h.update(CONTENT_DOMAIN);
    h.update(&(entries.len() as u32).to_be_bytes());
    for e in entries {
        h.update(&[e.kind]);
        h.update(&(e.path.len() as u16).to_be_bytes());
        h.update(e.path.as_bytes());
        h.update(&e.size.to_be_bytes());
        h.update(&e.entry_hash);
    }
    *h.finalize().as_bytes()
}

/// BLAKE3-256 helper.
pub fn hash(bytes: &[u8]) -> [u8; 32] {
    let mut h = Hasher::new();
    h.update(bytes);
    *h.finalize().as_bytes()
}

/// Hash of the empty input (directories' entry_hash).
pub fn empty_hash() -> [u8; 32] {
    hash(&[])
}

/// `transfer_id = Trunc128(H("AF2/transfer/v1" || manifest_hash[32] ||
/// chunk_raw_size:u32))`.
pub fn transfer_id(manifest_hash: &[u8; 32], chunk_raw_size: u32) -> [u8; 16] {
    let mut h = Hasher::new();
    h.update(TRANSFER_DOMAIN);
    h.update(manifest_hash);
    h.update(&chunk_raw_size.to_be_bytes());
    let out = *h.finalize().as_bytes();
    let mut res = [0u8; 16];
    res.copy_from_slice(&out[..16]);
    res
}

/// Object roles (`role` byte of the Object ID input and OBJECT_META record).
pub const ROLE_MANIFEST: u8 = 1;
pub const ROLE_CHUNK: u8 = 2;

/// `object_id = Trunc128(H("AF2/object/v1" || transfer_id[16] || role:u8 ||
/// object_index:u32 || codec_id:u8 || fec_id:u8 || oti[12] ||
/// encoded_hash[32]))`.
///
/// `encoded_hash = H(Encoded Object exact bytes)` and is carried ONLINE by
/// OBJECT_META, so the receiver recomputes the object_id on META arrival and
/// rejects mismatches BEFORE any decoding (decode-time binding happens again
/// on the recovered bytes). Different compressor output / OTI ⇒ different id —
/// cross-instance mixing is structurally impossible at the routing layer.
pub fn object_id(
    transfer_id: &[u8; 16],
    role: u8,
    object_index: u32,
    codec_id: u8,
    fec_id: u8,
    oti: &[u8; 12],
    encoded_hash: &[u8; 32],
) -> [u8; 16] {
    let mut h = Hasher::new();
    h.update(OBJECT_DOMAIN);
    h.update(transfer_id);
    h.update(&[role]);
    h.update(&object_index.to_be_bytes());
    h.update(&[codec_id, fec_id]);
    h.update(oti);
    h.update(encoded_hash);
    let out = *h.finalize().as_bytes();
    let mut res = [0u8; 16];
    res.copy_from_slice(&out[..16]);
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blake3_empty_matches_reference_vector() {
        // §3 self-check: H(empty) must equal the official BLAKE3 empty digest.
        assert_eq!(
            hex(&empty_hash()),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn content_id_is_order_sensitive_and_stable() {
        let a = EntryIdInput {
            kind: KIND_FILE,
            path: "a.txt",
            size: 1,
            entry_hash: hash(b"a"),
        };
        let b = EntryIdInput {
            kind: KIND_UTF8_TEXT,
            path: "b.txt",
            size: 2,
            entry_hash: hash(b"b"),
        };
        let ab = content_id(&[a.clone(), b.clone()]);
        let ab2 = content_id(&[a.clone(), b.clone()]);
        assert_eq!(ab, ab2, "deterministic");
        let ba = content_id(&[b, a]);
        assert_ne!(ab, ba, "entry order is part of the identity");
    }

    #[test]
    fn transfer_id_depends_only_on_manifest_and_chunk_size() {
        let mh = hash(b"manifest");
        assert_eq!(transfer_id(&mh, 8 << 20), transfer_id(&mh, 8 << 20));
        assert_ne!(transfer_id(&mh, 8 << 20), transfer_id(&mh, 16 << 20));
        assert_ne!(transfer_id(&mh, 8 << 20), transfer_id(&hash(b"other"), 8 << 20));
    }

    #[test]
    fn object_id_separates_codec_and_oti_instances() {
        let tid = transfer_id(&hash(b"m"), 8 << 20);
        let base = || (tid, ROLE_CHUNK, 3u32, 0u8, 1u8, [7u8; 12], hash(b"enc"));
        let enc = hash(b"enc");
        let oti = [7u8; 12];
        let a = object_id(&tid, ROLE_CHUNK, 3, 0, 1, &oti, &enc);
        let b = base();
        assert_eq!(a, object_id(&b.0, b.1, b.2, b.3, b.4, &b.5, &b.6));
        assert_ne!(a, object_id(&tid, ROLE_CHUNK, 3, 1, 1, &oti, &enc)); // codec
        assert_ne!(a, object_id(&tid, ROLE_CHUNK, 4, 0, 1, &oti, &enc)); // index
        assert_ne!(a, object_id(&tid, ROLE_CHUNK, 3, 0, 1, &[8; 12], &enc)); // OTI
        assert_ne!(a, object_id(&tid, ROLE_CHUNK, 3, 0, 1, &oti, &hash(b"other"))); // bytes
        assert_ne!(a, object_id(&tid, ROLE_MANIFEST, 3, 0, 1, &oti, &enc)); // role
    }
}
