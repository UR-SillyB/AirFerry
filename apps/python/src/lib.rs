//! Python bridge. Protocol framing and QR generation stay in the shared core.

use pyo3::exceptions::{PyOSError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use qr_protocol::{compress, qr_render, SessionId};
use raptorq_core::{Config, MAX_ORIGINAL_BYTES};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use transfer_engine::{
    FileMeta, SegmentMeta, SenderConfig, SenderSession, MAX_SEGMENT_COUNT, SEGMENT_RAW_BYTES,
};

const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_QR_SYMBOL_BYTES: u32 = 2888;

#[derive(Debug)]
enum NativeError {
    Io(io::Error),
    Value(String),
}

impl From<io::Error> for NativeError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<transfer_engine::Error> for NativeError {
    fn from(value: transfer_engine::Error) -> Self {
        Self::Value(value.to_string())
    }
}

impl From<NativeError> for PyErr {
    fn from(value: NativeError) -> Self {
        match value {
            NativeError::Io(error) => PyOSError::new_err(error.to_string()),
            NativeError::Value(message) => PyValueError::new_err(message),
        }
    }
}

type NativeResult<T> = Result<T, NativeError>;

/// Prepared disk snapshot plus one lazily initialized RaptorQ segment.
#[pyclass(module = "airferry._native")]
struct NativeTransfer {
    #[pyo3(get)]
    filename: String,
    #[pyo3(get)]
    original_size: u64,
    #[pyo3(get)]
    compressed_size: u64,
    #[pyo3(get)]
    compression: String,
    #[pyo3(get)]
    crc32: u32,
    #[pyo3(get)]
    session_id: String,
    #[pyo3(get)]
    segment_count: u32,
    spool_path: PathBuf,
    root_id: SessionId,
    root_sha256: [u8; 32],
    compression_tag: u8,
    config: SenderConfig,
    segmented: bool,
    current: Option<SenderSession>,
}

#[pymethods]
impl NativeTransfer {
    #[new]
    #[pyo3(signature = (input_path, spool_path, compression="auto", symbol_size=1400, redundancy_pct=50))]
    fn new(
        py: Python<'_>,
        input_path: PathBuf,
        spool_path: PathBuf,
        compression: &str,
        symbol_size: u32,
        redundancy_pct: u8,
    ) -> PyResult<Self> {
        py.detach(|| {
            Self::prepare(
                &input_path,
                &spool_path,
                compression,
                symbol_size,
                redundancy_pct,
            )
        })
        .map_err(Into::into)
    }

    /// Start (or restart) one canonical compressed-stream segment; return its K.
    fn start_segment(&mut self, py: Python<'_>, index: u32) -> PyResult<u32> {
        py.detach(|| self.start_segment_impl(index))
            .map_err(Into::into)
    }

    /// Wire bytes for interoperability tests or custom QR renderers.
    fn next_frame<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        let data = py.detach(|| self.next_frame_impl()).map_err(PyErr::from)?;
        Ok(PyBytes::new(py, &data))
    }

    /// Row-major grayscale modules without a quiet zone (0=black, 255=white).
    fn next_qr<'py>(&mut self, py: Python<'py>) -> PyResult<(usize, Bound<'py, PyBytes>)> {
        let (side, modules) = py
            .detach(|| {
                let frame = self.next_frame_impl()?;
                let matrix = qr_render::encode(&frame)
                    .map_err(|error| NativeError::Value(error.to_string()))?;
                let modules = matrix
                    .modules
                    .into_iter()
                    .map(|dark| if dark { 0 } else { 255 })
                    .collect::<Vec<u8>>();
                Ok::<_, NativeError>((matrix.size, modules))
            })
            .map_err(PyErr::from)?;
        Ok((side, PyBytes::new(py, &modules)))
    }
}

impl NativeTransfer {
    fn prepare(
        input_path: &Path,
        spool_path: &Path,
        mode: &str,
        symbol_size: u32,
        redundancy_pct: u8,
    ) -> NativeResult<Self> {
        if !matches!(mode, "auto" | "none" | "zstd" | "xz") {
            return Err(NativeError::Value(
                "compression must be 'auto', 'none', 'zstd', or 'xz'".into(),
            ));
        }
        if symbol_size > MAX_QR_SYMBOL_BYTES {
            return Err(NativeError::Value(
                "symbol_size must be 8-byte aligned and between 64 and 2888".into(),
            ));
        }
        let codec =
            Config::new(symbol_size).map_err(|error| NativeError::Value(error.to_string()))?;
        let config = SenderConfig {
            codec,
            redundancy_pct,
        };
        config.validate()?;
        let filename = input_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| NativeError::Value("input filename must be valid UTF-8".into()))?
            .to_owned();
        if filename.len() > 255 {
            return Err(NativeError::Value(
                "input filename must be at most 255 UTF-8 bytes".into(),
            ));
        }
        let source = File::open(input_path)?;
        let initial = source.metadata()?;
        if !initial.is_file() {
            return Err(NativeError::Value("input must be a regular file".into()));
        }
        if initial.len() == 0 {
            return Err(NativeError::Value(
                "empty files cannot be sent by AirFerry".into(),
            ));
        }
        let parent = spool_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let resolved_spool = parent.canonicalize()?.join(
            spool_path
                .file_name()
                .ok_or_else(|| NativeError::Value("invalid spool path".into()))?,
        );
        if input_path.canonicalize()? == resolved_spool
            || spool_path
                .canonicalize()
                .is_ok_and(|path| input_path.canonicalize().is_ok_and(|input| input == path))
        {
            return Err(NativeError::Value(
                "input_path and spool_path must differ".into(),
            ));
        }
        // create_new ensures the binding never overwrites a caller's file.
        let raw = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(spool_path)?;
        let mut raw = BufWriter::new(raw);
        let mut source = BufReader::new(source);
        let mut crc = crc32fast::Hasher::new();
        let mut sha = Sha256::new();
        let mut original_size = 0u64;
        let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
        loop {
            let count = source.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            raw.write_all(&buffer[..count])?;
            crc.update(&buffer[..count]);
            sha.update(&buffer[..count]);
            original_size = original_size
                .checked_add(count as u64)
                .ok_or_else(|| NativeError::Value("input size overflow".into()))?;
        }
        raw.flush()?;
        drop(raw);
        let final_meta = source.get_ref().metadata()?;
        if original_size != initial.len()
            || final_meta.len() != initial.len()
            || final_meta.modified()? != initial.modified()?
        {
            return Err(NativeError::Value(
                "input file changed while preparing its snapshot".into(),
            ));
        }
        let root_sha256: [u8; 32] = sha.finalize().into();
        let crc32 = crc.finalize();
        let tag = match mode {
            "none" => compress::COMPRESSION_NONE,
            "xz" => compress::COMPRESSION_XZ,
            _ => compress::COMPRESSION_ZSTD,
        };
        let mut compression_tag = tag;
        if tag != compress::COMPRESSION_NONE {
            let mut candidate_name = spool_path.as_os_str().to_os_string();
            candidate_name.push(".compressed");
            let candidate = PathBuf::from(candidate_name);
            let target = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)?;
            let mut input = BufReader::new(File::open(spool_path)?);
            let output = BufWriter::new(target);
            match tag {
                compress::COMPRESSION_ZSTD => {
                    let mut encoder = zstd::stream::write::Encoder::new(output, 1)?;
                    encoder.window_log(23)?;
                    io::copy(&mut input, &mut encoder)?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                }
                compress::COMPRESSION_XZ => {
                    let mut encoder = xz2::write::XzEncoder::new(output, 6);
                    io::copy(&mut input, &mut encoder)?;
                    let mut output = encoder.finish()?;
                    output.flush()?;
                }
                _ => unreachable!(),
            }
            drop(input);
            if mode == "auto" && fs::metadata(&candidate)?.len() >= original_size {
                compression_tag = compress::COMPRESSION_NONE;
                fs::remove_file(candidate)?;
            } else {
                // Only remove the snapshot created above; arbitrary existing
                // paths are protected by create_new.
                fs::remove_file(spool_path)?;
                fs::rename(candidate, spool_path)?;
            }
        }
        let compressed_size = fs::metadata(spool_path)?.len();
        let segment_count_u64 = compressed_size.div_ceil(SEGMENT_RAW_BYTES);
        if segment_count_u64 == 0 || segment_count_u64 > u64::from(MAX_SEGMENT_COUNT) {
            return Err(NativeError::Value(
                "compressed file exceeds AirFerry's segment-count limit".into(),
            ));
        }
        let compression = match compression_tag {
            compress::COMPRESSION_NONE => "none",
            compress::COMPRESSION_ZSTD => "zstd",
            _ => "xz",
        }
        .to_owned();
        // Include the exact encoded stream hash: compression mode or library
        // revisions may change its bytes while the original file stays equal.
        let mut encoded_hash = Sha256::new();
        let mut encoded = BufReader::new(File::open(spool_path)?);
        loop {
            let count = encoded.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            encoded_hash.update(&buffer[..count]);
        }
        let mut fingerprint = root_sha256.to_vec();
        fingerprint.push(compression_tag);
        // Different symbol sizes have different OTI and cannot reuse symbols
        // persisted by an existing receiver task.
        fingerprint.extend_from_slice(&symbol_size.to_le_bytes());
        fingerprint.extend_from_slice(&encoded_hash.finalize());
        let mtime_ms = initial
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        let root_id = SessionId::derive(&filename, original_size, mtime_ms, &fingerprint);
        Ok(Self {
            filename,
            original_size,
            compressed_size,
            compression,
            crc32,
            session_id: format!("{:032x}", root_id.0),
            segment_count: segment_count_u64 as u32,
            spool_path: spool_path.to_owned(),
            root_id,
            root_sha256,
            compression_tag,
            config,
            segmented: compressed_size > SEGMENT_RAW_BYTES || original_size > MAX_ORIGINAL_BYTES,
            current: None,
        })
    }

    fn start_segment_impl(&mut self, index: u32) -> NativeResult<u32> {
        if index >= self.segment_count {
            return Err(NativeError::Value("segment index out of range".into()));
        }
        // Drop the previous encoder before reading/encoding the next segment.
        self.current = None;
        let offset = u64::from(index) * SEGMENT_RAW_BYTES;
        let len = (self.compressed_size - offset).min(SEGMENT_RAW_BYTES);
        let mut input = File::open(&self.spool_path)?;
        input.seek(SeekFrom::Start(offset))?;
        let mut payload = vec![0; len as usize];
        input.read_exact(&mut payload)?;
        let file_meta = FileMeta {
            filename: self.filename.clone(),
            original_size: self.original_size,
            crc32: self.crc32,
            compression: self.compression_tag,
            compressed_size: len,
            compressed_size_known: true,
            crc32_known: true,
        };
        let sender = if self.segmented {
            let segment = SegmentMeta {
                root_session_id: self.root_id.0,
                segment_index: index,
                segment_count: self.segment_count,
                original_offset: offset,
                root_original_size: self.compressed_size,
                root_sha256: self.root_sha256,
                raw_sha256: Sha256::digest(&payload).into(),
            };
            SenderSession::new_segment(
                &payload,
                SessionId::derive_segment(self.root_id.0, index),
                self.config,
                file_meta,
                segment,
            )?
        } else {
            SenderSession::new(&payload, self.root_id, self.config, file_meta)?
        };
        // The core intentionally truncates filenames to fit small descriptor
        // payloads. A file-export API instead rejects that lossy conversion.
        let descriptor = if let Some(segment) = sender.segment_meta() {
            transfer_engine::descriptor::build_segment_payload(
                sender.meta(),
                sender.file_meta(),
                segment,
            )?
        } else {
            transfer_engine::descriptor::build_payload(sender.meta(), sender.file_meta())?
        };
        let parsed = transfer_engine::descriptor::parse_payload(&descriptor)
            .ok_or_else(|| NativeError::Value("failed to validate file descriptor".into()))?;
        if parsed.file_meta.filename != self.filename {
            return Err(NativeError::Value(
                "symbol_size is too small to preserve the filename; choose a larger symbol_size"
                    .into(),
            ));
        }
        let k = sender.total_k();
        self.current = Some(sender);
        Ok(k)
    }

    fn next_frame_impl(&mut self) -> NativeResult<Vec<u8>> {
        self.current
            .as_mut()
            .ok_or_else(|| {
                NativeError::Value("call start_segment() before requesting frames".into())
            })?
            .next_frame()
            .map(|frame| frame.to_bytes())
            .map_err(Into::into)
    }
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<NativeTransfer>()?;
    module.add("SEGMENT_RAW_BYTES", SEGMENT_RAW_BYTES)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use transfer_engine::{Frame, ReceiverSession};

    fn transfer(data: &[u8], mode: &str) -> (tempfile::TempDir, NativeTransfer) {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("测试-data.bin");
        fs::write(&input, data).unwrap();
        let prepared =
            NativeTransfer::prepare(&input, &dir.path().join("payload"), mode, 1400, 50).unwrap();
        (dir, prepared)
    }

    #[test]
    fn prepared_streams_recover_with_the_shared_receiver() {
        let original = b"AirFerry protocol interoperability\0\xff".repeat(900);
        for mode in ["none", "zstd", "xz", "auto"] {
            let (_dir, mut sender) = transfer(&original, mode);
            let k = sender.start_segment_impl(0).unwrap();
            assert_eq!(u64::from(k), sender.compressed_size.div_ceil(1400));
            let first = Frame::from_bytes(&sender.next_frame_impl().unwrap()).unwrap();
            let mut receiver = ReceiverSession::from_first_frame(&first);
            receiver.ingest(first).unwrap();
            // Deliberately lose every fifth data/descriptor frame and require
            // fresh repair symbols to recover, rather than testing a copy.
            for index in 0..(k * 3 + 60) {
                let frame = Frame::from_bytes(&sender.next_frame_impl().unwrap()).unwrap();
                if index % 5 != 0 {
                    receiver.ingest(frame).unwrap();
                }
                if receiver.is_complete() {
                    break;
                }
            }
            assert!(receiver.is_complete(), "{mode}");
            assert_eq!(receiver.file_meta().filename, "测试-data.bin");
            assert_eq!(
                receiver.assemble_result().unwrap().unwrap(),
                original,
                "{mode}"
            );
        }
    }

    #[test]
    fn final_segment_uses_compressed_offsets_and_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.bin");
        let mut input = File::create(&path).unwrap();
        input.set_len(SEGMENT_RAW_BYTES).unwrap();
        input.seek(SeekFrom::End(0)).unwrap();
        input.write_all(b"tail").unwrap();
        drop(input);
        let mut sender =
            NativeTransfer::prepare(&path, &dir.path().join("spool"), "none", 1400, 50).unwrap();
        assert_eq!(sender.segment_count, 2);
        assert_eq!(sender.start_segment_impl(1).unwrap(), 1);
        let first = Frame::from_bytes(&sender.next_frame_impl().unwrap()).unwrap();
        let mut receiver = ReceiverSession::from_first_frame(&first);
        receiver.ingest(first).unwrap();
        let segment = receiver.segment_meta().unwrap();
        assert_eq!(segment.original_offset, SEGMENT_RAW_BYTES);
        assert_eq!(segment.root_original_size, SEGMENT_RAW_BYTES + 4);
        assert_eq!(segment.root_sha256, sender.root_sha256);
        assert_eq!(
            segment.raw_sha256,
            <[u8; 32]>::from(Sha256::digest(b"tail"))
        );
        for _ in 0..10 {
            receiver
                .ingest(Frame::from_bytes(&sender.next_frame_impl().unwrap()).unwrap())
                .unwrap();
            if receiver.is_complete() {
                break;
            }
        }
        assert_eq!(&receiver.assemble_raw().unwrap()[..4], b"tail");
    }

    #[test]
    fn highly_compressible_large_original_still_requires_v5() {
        let (_dir, mut sender) = transfer(b"small compressed stream", "zstd");
        // Exercise the exact policy boundary without allocating a 256 MiB
        // test file: the spool is a valid stream and the metadata is the input.
        sender.original_size = MAX_ORIGINAL_BYTES + 1;
        sender.segmented =
            sender.compressed_size > SEGMENT_RAW_BYTES || sender.original_size > MAX_ORIGINAL_BYTES;
        sender.start_segment_impl(0).unwrap();
        let first = Frame::from_bytes(&sender.next_frame_impl().unwrap()).unwrap();
        let info = transfer_engine::descriptor::parse_payload(&first.payload).unwrap();
        assert_eq!(info.segment.unwrap().segment_count, 1);
    }

    #[test]
    fn preparation_does_not_overwrite_files_and_rejects_empty_or_lossy_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("data.bin");
        fs::write(&input, b"keep").unwrap();
        assert!(NativeTransfer::prepare(&input, &input, "none", 1400, 50).is_err());
        assert_eq!(fs::read(&input).unwrap(), b"keep");
        let spool = dir.path().join("spool");
        fs::write(&spool, b"existing").unwrap();
        assert!(NativeTransfer::prepare(&input, &spool, "none", 1400, 50).is_err());
        assert_eq!(fs::read(&spool).unwrap(), b"existing");
        fs::write(&input, b"").unwrap();
        assert!(
            NativeTransfer::prepare(&input, &dir.path().join("empty-spool"), "none", 1400, 50)
                .is_err()
        );
        let (_dir, mut sender) = transfer(b"payload", "none");
        sender.filename = "x".repeat(200);
        sender.config.codec = Config::new(128).unwrap();
        assert!(sender.start_segment_impl(0).is_err());
    }

    #[test]
    fn session_identity_tracks_exact_encoded_content() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("same.bin");
        fs::write(&input, b"repeatable".repeat(100)).unwrap();
        let a = NativeTransfer::prepare(&input, &dir.path().join("a"), "none", 1400, 50).unwrap();
        let b = NativeTransfer::prepare(&input, &dir.path().join("b"), "none", 1400, 50).unwrap();
        let c = NativeTransfer::prepare(&input, &dir.path().join("c"), "zstd", 1400, 50).unwrap();
        let d = NativeTransfer::prepare(&input, &dir.path().join("d"), "none", 1024, 50).unwrap();
        assert_eq!(a.session_id, b.session_id);
        assert_ne!(a.session_id, c.session_id);
        assert_ne!(a.session_id, d.session_id);
    }
}
