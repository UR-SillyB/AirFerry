//! AF2 Manifest (protocol 2, §7).
//!
//! An independent RaptorQ object, ALWAYS RAW (never compressed). Cap 16 MiB.
//! Layout: `[Header 80B][Entry Records][Chunk Hash Table][Manifest TLVs]`.
//!
//! Path rules (violating ANY → reject the whole Manifest):
//! Unicode NFC, strict UTF-8, relative `/`-separated; no empty path, empty
//! component, `.`, `..`, leading `/`, backslash, NUL, or C0 controls; total
//! ≤ 1024 B, single component ≤ 255 B; byte-level unique within the Manifest.
//! Entries sorted by canonical-path UTF-8 byte order; non-directory entry
//! contents concatenate seamlessly in that order into the Canonical Content
//! Stream (`content_offset` must chain exactly; the last end ==
//! `total_raw_size`).

use crate::id::{empty_hash, hash, KIND_DIRECTORY, KIND_FILE, KIND_UTF8_TEXT};
use crate::tlv::Tlv;

pub const MANIFEST_MAGIC: &[u8; 4] = b"AFM2";
pub const MANIFEST_SCHEMA: u8 = 1;
pub const HEADER_SIZE: usize = 80;
/// Fixed part of an Entry Record before path + TLVs.
pub const ENTRY_FIXED: usize = 60;
pub const MAX_MANIFEST_BYTES: usize = 16 << 20;
pub const MAX_PATH_BYTES: usize = 1024;
pub const MAX_COMPONENT_BYTES: usize = 255;
pub const MAX_ENTRIES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestEntry {
    pub kind: u8,
    pub path: String,
    /// Canonical Content Stream offset/length for non-directory entries.
    /// Directories carry 0/0 and `hash == H(empty)`.
    pub content_offset: u64,
    pub content_size: u64,
    pub content_hash: [u8; 32],
    pub extensions: Vec<Tlv>,
}

/// Build a Manifest from precomputed entry/chunk hashes.
///
/// This is the bounded-memory sender path used by browser hosts: file bytes
/// are streamed once to incremental BLAKE3 hashers outside the protocol core,
/// then only metadata and 32-byte digests cross into the manifest builder.
/// The resulting Manifest is validated with the same path/order/chunk-count
/// invariants as [`build_manifest`].
pub fn build_manifest_from_hashes(
    items: impl IntoIterator<Item = (u8, String, u64, [u8; 32])>,
    chunk_raw_size: u32,
    chunk_hashes: Vec<[u8; 32]>,
) -> Result<Manifest, ManifestError> {
    use unicode_normalization::UnicodeNormalization;
    let mut items: Vec<(u8, String, u64, [u8; 32])> = items
        .into_iter()
        .map(|(kind, path, size, digest)| (kind, path.nfc().collect(), size, digest))
        .collect();
    items.sort_by(|a, b| a.1.as_bytes().cmp(b.1.as_bytes()));

    let mut entries = Vec::with_capacity(items.len());
    let mut stream_end = 0u64;
    for (kind, path, size, digest) in items {
        validate_path(&path).map_err(|reason| ManifestError::BadEntry {
            index: entries.len(),
            reason,
        })?;
        let (offset, content_size, content_hash) = if kind == KIND_DIRECTORY {
            if size != 0 || digest != empty_hash() {
                return Err(ManifestError::BadEntry {
                    index: entries.len(),
                    reason: "directory entry must carry zero size and H(empty)",
                });
            }
            (0, 0, empty_hash())
        } else {
            let offset = stream_end;
            stream_end = stream_end.checked_add(size).ok_or(ManifestError::BadEntry {
                index: entries.len(),
                reason: "canonical stream size overflow",
            })?;
            (offset, size, digest)
        };
        entries.push(ManifestEntry {
            kind,
            path,
            content_offset: offset,
            content_size,
            content_hash,
            extensions: vec![],
        });
    }
    if stream_end == 0 {
        return Err(ManifestError::EmptyStream);
    }
    let chunk_count = crate::root::expected_chunk_count(stream_end, chunk_raw_size);
    if chunk_hashes.len() != chunk_count as usize {
        return Err(ManifestError::BadChunkHashesLen(
            u32::try_from(chunk_hashes.len().saturating_mul(32)).unwrap_or(u32::MAX),
        ));
    }
    let manifest = Manifest {
        entries,
        chunk_count,
        chunk_raw_size,
        total_raw_size: stream_end,
        chunk_hashes,
        extensions: vec![],
    };
    // Encode exercises all structural invariants (path uniqueness/order,
    // stream chaining, chunk geometry and size caps) before this is trusted.
    let bytes = manifest.encode()?;
    let (validated, _) = Manifest::parse(&bytes)?;
    Ok(validated)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub entries: Vec<ManifestEntry>,
    pub chunk_count: u32,
    pub chunk_raw_size: u32,
    pub total_raw_size: u64,
    /// Chunk Hash Table (one BLAKE3-256 per canonical chunk, position-indexed).
    pub chunk_hashes: Vec<[u8; 32]>,
    pub extensions: Vec<Tlv>,
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest: bad magic")]
    BadMagic,
    #[error("manifest: unsupported schema {0}")]
    BadSchema(u8),
    #[error("manifest: length fields inconsistent (header {header}, body {body})")]
    LengthMismatch { header: usize, body: usize },
    #[error("manifest: reserved field must be zero")]
    ReservedNotZero,
    #[error("manifest: entry count {0} exceeds 4096")]
    TooManyEntries(u32),
    #[error("manifest: chunk_hashes_len {0} != chunk_count × 32")]
    BadChunkHashesLen(u32),
    #[error("manifest: chunk_count {count} != ceil(total/chunk) = {expected}")]
    ChunkCountMismatch { count: u32, expected: u32 },
    #[error("manifest: chunk_raw_size {0:#x} not legal")]
    BadChunkSize(u32),
    #[error("manifest: total_raw_size must be ≥ 1 (empty canonical stream is unrepresentable)")]
    EmptyStream,
    #[error("manifest: exceeds 16 MiB cap ({0} bytes)")]
    TooLarge(usize),
    #[error("manifest: entry {index}: {reason}")]
    BadEntry { index: usize, reason: &'static str },
    #[error("manifest: paths not strictly ascending at entry {index}")]
    NotSorted { index: usize },
    #[error("manifest: duplicate path {path:?}")]
    DuplicatePath { path: String },
    #[error("manifest: content stream gap at entry {index}: offset {offset}, expected {expected}")]
    StreamGap { index: usize, offset: u64, expected: u64 },
    #[error("manifest: stream end {end} != total_raw_size {total}")]
    StreamEndMismatch { end: u64, total: u64 },
    #[error("manifest: truncated while reading {what}")]
    Truncated { what: &'static str },
    #[error("manifest: {0}")]
    Tlv(#[from] crate::tlv::TlvError),
}

fn is_nfc(s: &str) -> bool {
    // True NFC check (SPEC §7.2 path rules): accept exactly the strings that
    // are already in Normalization Form C. A blacklist of combining blocks
    // would be wrong in both directions — it rejected spec-legal NFC text
    // (Thai vowels, Hebrew niqqud and Arabic marks legitimately remain as
    // combining characters after NFC) while missing decomposed sequences
    // outside the listed blocks.
    use unicode_normalization::UnicodeNormalization;
    s.nfc().eq(s.chars())
}

/// Validate one canonical path (§7.2 rules). Public for sender-side reuse.
///
/// Wire-level rules only: NFC, relative, `/`-separated, no empty/dot/NUL/C0
/// components, byte/length bounds. Windows-hostile names (`:` components,
/// reserved device names, trailing dots/spaces) are NOT wire violations —
/// they are legal manifest paths that receivers sanitize at save time via
/// [`sanitize_save_paths`] (§7.2: cleaning changes only the saved name).
pub fn validate_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty() {
        return Err("empty path");
    }
    if !is_nfc(path) {
        return Err("path is not in Unicode NFC (or carries combining marks)");
    }
    if path.len() > MAX_PATH_BYTES {
        return Err("path exceeds 1024 bytes");
    }
    if path.starts_with('/') {
        return Err("absolute path");
    }
    if path.contains('\\') {
        return Err("backslash separator");
    }
    if path.contains('\0') {
        return Err("NUL in path");
    }
    if path.chars().any(|c| (c as u32) < 0x20) {
        return Err("C0 control character in path");
    }
    for comp in path.split('/') {
        if comp.is_empty() {
            return Err("empty path component");
        }
        if comp == "." || comp == ".." {
            return Err("dot component");
        }
        if comp.len() > MAX_COMPONENT_BYTES {
            return Err("component exceeds 255 bytes");
        }
    }
    Ok(())
}

/// `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9` (with or without an extension)
/// cannot exist as files on Windows — save-time sanitization appends a `~`
/// so the file can be created (§7.2: 确定性加后缀，只改保存名).
fn is_windows_reserved_name(comp: &str) -> bool {
    let stem = comp.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved_bare = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL");
    let reserved_num = |prefix: &str| {
        stem.strip_prefix(prefix)
            .and_then(|d| d.parse::<u8>().ok())
            .is_some_and(|n| (1..=9).contains(&n))
    };
    reserved_bare || reserved_num("COM") || reserved_num("LPT")
}

/// Sanitize one path component for a Windows-targeted save.
fn sanitize_component_windows(comp: &str) -> String {
    let mut out = comp.replace(':', "_");
    if is_windows_reserved_name(&out) {
        out.push('~');
    }
    if out.ends_with('.') || out.ends_with(' ') {
        out.push('~');
    }
    out
}

/// §7.2 save-time platform sanitization over a whole entry set — the save
/// name only: verification (entry hashes, Content ID) always uses the
/// canonical manifest path.
///
/// - `windows == false`: names return unchanged (POSIX-family filesystems
///   accept every wire-legal path).
/// - `windows == true`: per component, `:` → `_` (drive/ADS separator);
///   reserved device names and trailing dots/spaces (unsavable on NTFS)
///   get a `~`; entries that collide under case-folding get deterministic
///   `~1`, `~2`, … suffixes in manifest order.
///
/// The result can never escape the target directory: wire-legal inputs are
/// already relative, `/`-separated and free of `.`/`..`, and the sanitizer
/// introduces none of those.
pub fn sanitize_save_paths(paths: &[&str], windows: bool) -> Vec<String> {
    if !windows {
        return paths.iter().map(|p| p.to_string()).collect();
    }
    let mut out: Vec<String> = paths
        .iter()
        .map(|p| {
            p.split('/')
                .map(sanitize_component_windows)
                .collect::<Vec<_>>()
                .join("/")
        })
        .collect();
    // Case-fold collisions: first occurrence keeps the name, later ones get
    // ~k (k = occurrence number), deterministic in manifest order.
    let mut folds: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for p in out.iter_mut() {
        let key = p.to_lowercase();
        let next = folds.entry(key).or_insert(0);
        if *next > 0 {
            p.push_str(&format!("~{}", *next));
        }
        *next += 1;
    }
    out
}

impl Manifest {
    /// Full semantic validation (paths, ordering, stream chaining, chunk
    /// table). Called by both encode and parse.
    fn validate(&self) -> Result<(), ManifestError> {
        if self.entries.len() > MAX_ENTRIES {
            return Err(ManifestError::TooManyEntries(self.entries.len() as u32));
        }
        if !crate::root::CHUNK_SIZES.contains(&self.chunk_raw_size) {
            return Err(ManifestError::BadChunkSize(self.chunk_raw_size));
        }
        if self.total_raw_size == 0 {
            return Err(ManifestError::EmptyStream);
        }
        let expected_chunks =
            crate::root::expected_chunk_count(self.total_raw_size, self.chunk_raw_size);
        if self.chunk_count != expected_chunks {
            return Err(ManifestError::ChunkCountMismatch {
                count: self.chunk_count,
                expected: expected_chunks,
            });
        }
        if self.chunk_hashes.len() != self.chunk_count as usize {
            return Err(ManifestError::BadChunkHashesLen(self.chunk_count));
        }
        let mut prev_path: Option<&str> = None;
        let mut stream_end: u64 = 0;
        for (index, e) in self.entries.iter().enumerate() {
            validate_path(&e.path)
                .map_err(|reason| ManifestError::BadEntry { index, reason })?;
            if ![KIND_FILE, KIND_UTF8_TEXT, KIND_DIRECTORY].contains(&e.kind) {
                return Err(ManifestError::BadEntry {
                    index,
                    reason: "unknown entry kind",
                });
            }
            if let Some(prev) = prev_path {
                if e.path.as_bytes() <= prev.as_bytes() {
                    return Err(ManifestError::NotSorted { index });
                }
            }
            prev_path = Some(e.path.as_str());
            if e.kind == KIND_DIRECTORY {
                if e.content_offset != 0 || e.content_size != 0 || e.content_hash != empty_hash() {
                    return Err(ManifestError::BadEntry {
                        index,
                        reason: "directory must carry zero offset/size and H(empty)",
                    });
                }
            } else {
                if e.content_offset != stream_end {
                    return Err(ManifestError::StreamGap {
                        index,
                        offset: e.content_offset,
                        expected: stream_end,
                    });
                }
                stream_end = stream_end
                    .checked_add(e.content_size)
                    .ok_or(ManifestError::BadEntry { index, reason: "size overflow" })?;
            }
        }
        if stream_end != self.total_raw_size {
            return Err(ManifestError::StreamEndMismatch {
                end: stream_end,
                total: self.total_raw_size,
            });
        }
        Ok(())
    }

    /// Serialize the full manifest bytes (header + entries + chunk table + TLVs).
    pub fn encode(&self) -> Result<Vec<u8>, ManifestError> {
        self.validate()?;
        let mut entry_area = Vec::new();
        for e in &self.entries {
            let path = e.path.as_bytes();
            let ext = crate::tlv::encode_tlvs(&e.extensions)?;
            let record_len = ENTRY_FIXED + path.len() + ext.len();
            entry_area.extend_from_slice(&(record_len as u32).to_be_bytes());
            entry_area.push(e.kind);
            entry_area.push(0); // flags
            entry_area.extend_from_slice(&0u16.to_be_bytes());
            entry_area.extend_from_slice(&(path.len() as u16).to_be_bytes());
            entry_area.extend_from_slice(&(ext.len() as u16).to_be_bytes());
            entry_area.extend_from_slice(&e.content_offset.to_be_bytes());
            entry_area.extend_from_slice(&e.content_size.to_be_bytes());
            entry_area.extend_from_slice(&e.content_hash);
            entry_area.extend_from_slice(path);
            entry_area.extend_from_slice(&ext);
        }
        let chunk_area_len = self.chunk_hashes.len() * 32;
        let ext_area = crate::tlv::encode_tlvs(&self.extensions)?;
        let manifest_len = HEADER_SIZE + entry_area.len() + chunk_area_len + ext_area.len();
        if manifest_len > MAX_MANIFEST_BYTES {
            return Err(ManifestError::TooLarge(manifest_len));
        }
        let mut out = Vec::with_capacity(manifest_len);
        out.extend_from_slice(MANIFEST_MAGIC);
        out.push(MANIFEST_SCHEMA);
        out.push(0); // flags
        out.extend_from_slice(&(HEADER_SIZE as u16).to_be_bytes());
        out.extend_from_slice(&(manifest_len as u32).to_be_bytes());
        out.extend_from_slice(&(self.entries.len() as u32).to_be_bytes());
        out.extend_from_slice(&self.chunk_count.to_be_bytes());
        out.extend_from_slice(&self.chunk_raw_size.to_be_bytes());
        out.extend_from_slice(&self.total_raw_size.to_be_bytes());
        out.extend_from_slice(&crate::id::content_id(
            &self
                .entries
                .iter()
                .map(|e| crate::id::EntryIdInput {
                    kind: e.kind,
                    path: &e.path,
                    size: if e.kind == KIND_DIRECTORY { 0 } else { e.content_size },
                    entry_hash: e.content_hash,
                })
                .collect::<Vec<_>>(),
        ));
        out.extend_from_slice(&(entry_area.len() as u32).to_be_bytes());
        out.extend_from_slice(&(chunk_area_len as u32).to_be_bytes());
        out.extend_from_slice(&(ext_area.len() as u32).to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
        debug_assert_eq!(out.len(), HEADER_SIZE);
        out.extend_from_slice(&entry_area);
        for h in &self.chunk_hashes {
            out.extend_from_slice(h);
        }
        out.extend_from_slice(&ext_area);
        Ok(out)
    }

    /// Parse + fully validate an untrusted manifest byte blob.
    pub fn parse(bytes: &[u8]) -> Result<(Self, [u8; 32]), ManifestError> {
        if bytes.len() < HEADER_SIZE || &bytes[0..4] != MANIFEST_MAGIC {
            return Err(ManifestError::BadMagic);
        }
        if bytes[4] != MANIFEST_SCHEMA {
            return Err(ManifestError::BadSchema(bytes[4]));
        }
        let fixed_len = u16::from_be_bytes([bytes[6], bytes[7]]) as usize;
        if fixed_len != HEADER_SIZE {
            return Err(ManifestError::LengthMismatch {
                header: fixed_len,
                body: HEADER_SIZE,
            });
        }
        let manifest_len = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
        if manifest_len != bytes.len() || manifest_len > MAX_MANIFEST_BYTES {
            return Err(ManifestError::LengthMismatch {
                header: manifest_len,
                body: bytes.len(),
            });
        }
        if bytes[5] != 0 || bytes[76..80] != [0; 4] {
            return Err(ManifestError::ReservedNotZero);
        }
        let entry_count = u32::from_be_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize;
        let chunk_count = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let chunk_raw_size = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        let total_raw_size = u64::from_be_bytes([
            bytes[24], bytes[25], bytes[26], bytes[27], bytes[28], bytes[29], bytes[30], bytes[31],
        ]);
        let mut content_id_out = [0u8; 32];
        content_id_out.copy_from_slice(&bytes[32..64]);
        let entries_len = u32::from_be_bytes([bytes[64], bytes[65], bytes[66], bytes[67]]) as usize;
        let chunk_hashes_len = u32::from_be_bytes([bytes[68], bytes[69], bytes[70], bytes[71]]) as usize;
        let ext_len = u32::from_be_bytes([bytes[72], bytes[73], bytes[74], bytes[75]]) as usize;
        let end = HEADER_SIZE
            .checked_add(entries_len)
            .and_then(|v| v.checked_add(chunk_hashes_len))
            .and_then(|v| v.checked_add(ext_len))
            .ok_or(ManifestError::LengthMismatch {
                header: usize::MAX,
                body: bytes.len(),
            })?;
        if end != bytes.len() {
            return Err(ManifestError::LengthMismatch {
                header: end,
                body: bytes.len(),
            });
        }
        if entry_count > MAX_ENTRIES {
            return Err(ManifestError::TooManyEntries(entry_count as u32));
        }
        // u64 math: on wasm32 `chunk_count as usize * 32` wraps for large
        // counts, letting an attacker smuggle a bogus count past this gate
        // and trigger a huge `Vec::with_capacity` / OOB indexing below.
        if chunk_hashes_len as u64 != u64::from(chunk_count) * 32 {
            return Err(ManifestError::BadChunkHashesLen(chunk_hashes_len as u32));
        }

        let mut entries = Vec::with_capacity(entry_count);
        let mut off = HEADER_SIZE;
        for index in 0..entry_count {
            let what = "entry record header";
            if bytes.len() - off < ENTRY_FIXED {
                return Err(ManifestError::Truncated { what });
            }
            let record_len = u32::from_be_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]]) as usize;
            let kind = bytes[off + 4];
            if bytes[off + 5] != 0 || bytes[off + 6..off + 8] != [0; 2] {
                return Err(ManifestError::BadEntry {
                    index,
                    reason: "flags/reserved not zero",
                });
            }
            let path_len = u16::from_be_bytes([bytes[off + 8], bytes[off + 9]]) as usize;
            let e_ext_len = u16::from_be_bytes([bytes[off + 10], bytes[off + 11]]) as usize;
            if record_len != ENTRY_FIXED + path_len + e_ext_len {
                return Err(ManifestError::BadEntry {
                    index,
                    reason: "record_len does not match fields",
                });
            }
            let content_offset = u64::from_be_bytes([
                bytes[off + 12], bytes[off + 13], bytes[off + 14], bytes[off + 15],
                bytes[off + 16], bytes[off + 17], bytes[off + 18], bytes[off + 19],
            ]);
            let content_size = u64::from_be_bytes([
                bytes[off + 20], bytes[off + 21], bytes[off + 22], bytes[off + 23],
                bytes[off + 24], bytes[off + 25], bytes[off + 26], bytes[off + 27],
            ]);
            let mut content_hash = [0u8; 32];
            content_hash.copy_from_slice(&bytes[off + 28..off + 60]);
            off += ENTRY_FIXED;
            if bytes.len() - off < path_len + e_ext_len {
                return Err(ManifestError::Truncated { what: "entry path/TLVs" });
            }
            let path = core::str::from_utf8(&bytes[off..off + path_len])
                .map_err(|_| ManifestError::BadEntry {
                    index,
                    reason: "path is not valid UTF-8",
                })?
                .to_string();
            off += path_len;
            let extensions = crate::tlv::parse_tlvs(&bytes[off..off + e_ext_len])?;
            crate::tlv::check_unknown_critical(&extensions)?;
            off += e_ext_len;
            entries.push(ManifestEntry {
                kind,
                path,
                content_offset,
                content_size,
                content_hash,
                extensions,
            });
        }
        if off != HEADER_SIZE + entries_len {
            return Err(ManifestError::LengthMismatch {
                header: entries_len,
                body: off.saturating_sub(HEADER_SIZE),
            });
        }
        if bytes.len() - off < chunk_hashes_len {
            return Err(ManifestError::Truncated {
                what: "chunk hash table",
            });
        }
        let mut chunk_hashes = Vec::with_capacity(chunk_count as usize);
        for i in 0..chunk_count as usize {
            let mut h = [0u8; 32];
            h.copy_from_slice(&bytes[off + i * 32..off + i * 32 + 32]);
            chunk_hashes.push(h);
        }
        off += chunk_hashes_len;
        if bytes.len() - off < ext_len {
            return Err(ManifestError::Truncated {
                what: "manifest TLVs",
            });
        }
        let extensions = crate::tlv::parse_tlvs(&bytes[off..off + ext_len])?;
        crate::tlv::check_unknown_critical(&extensions)?;

        let m = Manifest {
            entries,
            chunk_count,
            chunk_raw_size,
            total_raw_size,
            chunk_hashes,
            extensions,
        };
        m.validate()?;
        // Cross-check the carried content id against a fresh recomputation.
        let recomputed = crate::id::content_id(
            &m.entries
                .iter()
                .map(|e| crate::id::EntryIdInput {
                    kind: e.kind,
                    path: &e.path,
                    size: if e.kind == KIND_DIRECTORY { 0 } else { e.content_size },
                    entry_hash: e.content_hash,
                })
                .collect::<Vec<_>>(),
        );
        if recomputed != content_id_out {
            return Err(ManifestError::BadEntry {
                index: usize::MAX,
                reason: "content id mismatch (corrupt or malicious manifest)",
            });
        }
        Ok((m, content_id_out))
    }
}

/// Build a manifest from entry contents: computes the Canonical Content
/// Stream coordinates, per-entry hashes and the chunk hash table.
pub fn build_manifest<'a>(
    items: impl IntoIterator<Item = (u8, &'a str, &'a [u8])>,
    chunk_raw_size: u32,
) -> Result<Manifest, ManifestError> {
    // Sender-side NFC normalization (SPEC §7.2): the wire requires NFC and
    // macOS hands out NFD filenames, so normalize up front instead of
    // failing the transfer. Sort by canonical path byte order afterwards
    // (identity requires it).
    use unicode_normalization::UnicodeNormalization;
    let mut items: Vec<(u8, String, &[u8])> = items
        .into_iter()
        .map(|(kind, path, content)| (kind, path.nfc().collect::<String>(), content))
        .collect();
    items.sort_by(|a, b| a.1.as_bytes().cmp(b.1.as_bytes()));
    let mut entries = Vec::new();
    let mut stream = Vec::new();
    let mut stream_end: u64 = 0;
    for (kind, path, content) in items {
        validate_path(&path).map_err(|reason| ManifestError::BadEntry {
            index: entries.len(),
            reason,
        })?;
        if kind == KIND_DIRECTORY && !content.is_empty() {
            return Err(ManifestError::BadEntry {
                index: entries.len(),
                reason: "directory entry must carry empty content",
            });
        }
        if kind == KIND_UTF8_TEXT && core::str::from_utf8(content).is_err() {
            // Fail at the sender instead of a guaranteed §13 ⑧ rejection at
            // every receiver after a full transfer.
            return Err(ManifestError::BadEntry {
                index: entries.len(),
                reason: "UTF8_TEXT entry content is not valid UTF-8",
            });
        }
        let (offset, size, chash) = if kind == KIND_DIRECTORY {
            (0, 0, empty_hash())
        } else {
            let offset = stream_end;
            stream.extend_from_slice(content);
            stream_end += content.len() as u64;
            (offset, content.len() as u64, hash(content))
        };
        entries.push(ManifestEntry {
            kind,
            path,
            content_offset: offset,
            content_size: size,
            content_hash: chash,
            extensions: vec![],
        });
    }
    let total = stream.len() as u64;
    if total == 0 {
        return Err(ManifestError::EmptyStream);
    }
    let chunk_count = crate::root::expected_chunk_count(total, chunk_raw_size);
    let mut chunk_hashes = Vec::with_capacity(chunk_count as usize);
    // u64 offsets: see sender.rs — usize math wraps on wasm32 for >4 GiB
    // streams. Casts below are bounded by stream.len() <= usize::MAX.
    for i in 0..u64::from(chunk_count) {
        let start = i * u64::from(chunk_raw_size);
        let end = (start + u64::from(chunk_raw_size)).min(stream.len() as u64);
        chunk_hashes.push(hash(&stream[start as usize..end as usize]));
    }
    Ok(Manifest {
        entries,
        chunk_count,
        chunk_raw_size,
        total_raw_size: total,
        chunk_hashes,
        extensions: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Manifest {
        build_manifest(
            [
                (KIND_UTF8_TEXT, "msg.txt", b"hello AF2" as &[u8]),
                (KIND_FILE, "data/bin.dat", &[7u8; 300]),
                (KIND_DIRECTORY, "empty-dir", b""),
            ],
            1 << 20,
        )
        .unwrap()
    }

    #[test]
    fn round_trip_and_content_id_binding() {
        let m = sample();
        let bytes = m.encode().unwrap();
        let (parsed, cid) = Manifest::parse(&bytes).unwrap();
        assert_eq!(parsed, m);
        // Deterministic content id.
        let (_, cid2) = Manifest::parse(&bytes).unwrap();
        assert_eq!(cid, cid2);
        // Different content → different id.
        let m2 = build_manifest(
            [(KIND_UTF8_TEXT, "msg.txt", b"hello AF3" as &[u8])],
            1 << 20,
        )
        .unwrap();
        let (_, cid3) = Manifest::parse(&m2.encode().unwrap()).unwrap();
        assert_ne!(cid, cid3);
    }

    #[test]
    fn chunk_table_matches_stream_slices() {
        let m = sample();
        // total = 9 + 300 = 309 bytes, one 1 MiB chunk.
        assert_eq!(m.chunk_count, 1);
        let stream_len = m.entries.iter().filter(|e| e.kind != KIND_DIRECTORY).map(|e| e.content_size).sum::<u64>();
        assert_eq!(stream_len, 309);
        assert_eq!(m.chunk_hashes.len(), 1);
        let mut stream = Vec::new();
        // Canonical Content Stream sorts by path: "data/bin.dat" before "msg.txt".
        stream.extend_from_slice(&[7u8; 300]);
        stream.extend_from_slice(b"hello AF2");
        assert_eq!(m.chunk_hashes[0], hash(&stream));
    }

    #[test]
    fn rejects_path_violations() {
        for bad in [
            "", "/abs", "a//b", ".", "..", "a/../b", "a\\b", "a\x01b",
            &"x".repeat(1025),
        ] {
            assert!(validate_path(bad).is_err(), "path {bad:?} must be rejected");
        }
        assert!(validate_path("dir/好文件.txt").is_ok());
        assert!(validate_path(&("a/".repeat(200) + "leaf.txt")).is_ok());
        // §7.2: Windows-hostile names are wire-legal (save-time sanitization
        // handles them), NOT manifest rejections.
        assert!(validate_path("aux/config.txt").is_ok());
        assert!(validate_path("notes:a.txt").is_ok());
        assert!(validate_path("NUL").is_ok());
    }

    #[test]
    fn sanitize_save_paths_windows_rules() {
        // POSIX saves keep canonical names untouched.
        assert_eq!(
            sanitize_save_paths(&["aux/config.txt", "notes:a.txt"], false),
            ["aux/config.txt", "notes:a.txt"]
        );
        // Windows rules: colon → _, reserved names and trailing dots/spaces
        // get `~`, case-fold collisions get deterministic suffixes.
        assert_eq!(
            sanitize_save_paths(&["aux/config.txt", "notes:a.txt", "tail."], true),
            ["aux~/config.txt", "notes_a.txt", "tail.~"]
        );
        assert_eq!(sanitize_save_paths(&["CON"], true), ["CON~"]);
        assert_eq!(sanitize_save_paths(&["com3.bin"], true), ["com3.bin~"]);
        // Same path twice (multi-entry manifests forbid duplicates, but the
        // sanitizer must stay deterministic if a caller misuses it).
        assert_eq!(
            sanitize_save_paths(&["A.txt", "a.txt", "A.TXT"], true),
            ["A.txt", "a.txt~1", "A.TXT~2"]
        );
    }

    #[test]
    fn rejects_empty_canonical_stream() {
        // SPEC §6: total_raw_size ≥ 1 — an all-empty item set (or a single
        // empty file) cannot be represented on the wire.
        assert!(matches!(
            build_manifest([(KIND_UTF8_TEXT, "empty.txt", b"" as &[u8])], 1 << 20),
            Err(ManifestError::EmptyStream)
        ));
        let mut m = sample();
        m.total_raw_size = 0;
        m.chunk_count = 0;
        m.chunk_hashes.clear();
        assert!(matches!(m.encode(), Err(ManifestError::EmptyStream)));
    }

    #[test]
    fn rejects_unsorted_and_stream_gaps() {
        // Unsorted input is auto-sorted by build_manifest; craft a raw
        // manifest with a broken stream chain instead.
        let mut m = sample();
        m.entries[0].content_offset = 5; // gap
        assert!(matches!(
            m.encode(),
            Err(ManifestError::StreamGap { .. })
        ));
        let mut m = sample();
        m.total_raw_size += 1; // end mismatch
        assert!(matches!(
            m.encode(),
            Err(ManifestError::StreamEndMismatch { .. })
        ));
    }

    #[test]
    fn rejects_content_id_tamper() {
        let bytes = sample().encode().unwrap();
        // Flip a byte inside the first entry's content_hash (offset =
        // HEADER + ENTRY_FIXED - 32 + 4 region) and watch the cross-check fail.
        let mut tampered = bytes.clone();
        let hash_off = HEADER_SIZE + ENTRY_FIXED - 32;
        tampered[hash_off] ^= 0xFF;
        assert!(Manifest::parse(&tampered).is_err());
    }

    #[test]
    fn rejects_malformed_record_len_and_entries_len_mismatch() {
        let bytes = sample().encode().unwrap();

        // 1. entries_len declared larger than actual records
        let mut b1 = bytes.clone();
        let orig_entries_len = u32::from_be_bytes([b1[64], b1[65], b1[66], b1[67]]);
        b1[64..68].copy_from_slice(&(orig_entries_len + 10).to_be_bytes());
        let orig_manifest_len = u32::from_be_bytes([b1[8], b1[9], b1[10], b1[11]]);
        b1[8..12].copy_from_slice(&(orig_manifest_len + 10).to_be_bytes());
        b1.extend_from_slice(&[0u8; 10]);
        assert!(matches!(
            Manifest::parse(&b1),
            Err(ManifestError::LengthMismatch { .. })
        ));

        // 2. record_len field internal mismatch
        let mut b2 = bytes;
        let orig_rec_len = u32::from_be_bytes([
            b2[HEADER_SIZE],
            b2[HEADER_SIZE + 1],
            b2[HEADER_SIZE + 2],
            b2[HEADER_SIZE + 3],
        ]);
        b2[HEADER_SIZE..HEADER_SIZE + 4].copy_from_slice(&(orig_rec_len + 5).to_be_bytes());
        assert!(matches!(
            Manifest::parse(&b2),
            Err(ManifestError::BadEntry { reason: "record_len does not match fields", .. })
        ));
    }
}
