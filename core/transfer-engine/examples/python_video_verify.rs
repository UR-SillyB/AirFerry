//! Verify the Python sender through the existing Rust receiver, independently
//! of the Python extension. Input records are a big-endian u32 length followed
//! by the exact binary bytes extracted from a video QR code.
//!
//! cargo run -p transfer-engine --example python_video_verify --release -- frames.bin recovered.bin

use std::collections::HashMap;
use std::error::Error;
use std::fs::{self, File};
use std::io::{self, BufReader, Read};

use qr_protocol::{compress, Frame};
use sha2::{Digest, Sha256};
use transfer_engine::{FileMeta, ReceiverSession, TransferAssembler};

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn verify_file(bytes: &[u8], meta: &FileMeta) -> Result<(), Box<dyn Error>> {
    if bytes.len() as u64 != meta.original_size {
        return Err(invalid("recovered file length differs from descriptor").into());
    }
    if !meta.crc32_known || crc32fast::hash(bytes) != meta.crc32 {
        return Err(invalid("recovered file CRC32 differs from descriptor").into());
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args_os().skip(1);
    let input = args
        .next()
        .ok_or("usage: python_video_verify FRAMES OUTPUT")?;
    let output = args
        .next()
        .ok_or("usage: python_video_verify FRAMES OUTPUT")?;
    if args.next().is_some() {
        return Err("usage: python_video_verify FRAMES OUTPUT".into());
    }
    let mut input = BufReader::new(File::open(input)?);
    let mut sessions = HashMap::<u128, ReceiverSession>::new();
    let mut assembler: Option<TransferAssembler> = None;
    let mut root_meta: Option<FileMeta> = None;
    let mut recovered: Option<Vec<u8>> = None;
    let mut record_count = 0usize;

    loop {
        let mut length = [0; 4];
        // Distinguish clean EOF from a truncated length prefix.
        if input.read(&mut length[..1])? == 0 {
            break;
        }
        input.read_exact(&mut length[1..])?;
        let length = u32::from_be_bytes(length) as usize;
        if !(64..=qr_protocol::qr_render::QR_MAX_BYTES).contains(&length) {
            return Err(invalid("QR record length is outside the wire capacity").into());
        }
        let mut bytes = vec![0; length];
        input.read_exact(&mut bytes)?;
        let frame = Frame::from_bytes(&bytes)?;
        record_count += 1;
        let receiver = sessions
            .entry(frame.header.session_id)
            .or_insert_with(|| ReceiverSession::from_first_frame(&frame));
        if receiver.is_complete() && receiver.is_meta_confirmed() {
            continue;
        }
        receiver.ingest(frame)?;
        if !receiver.is_complete() || !receiver.is_meta_confirmed() {
            continue;
        }

        let meta = receiver.file_meta().clone();
        if let Some(segment) = receiver.segment_meta() {
            let segment = segment.clone();
            if let Some(first) = &root_meta {
                if first.filename != meta.filename
                    || first.original_size != meta.original_size
                    || first.compression != meta.compression
                    || first.crc32 != meta.crc32
                {
                    return Err(invalid("segment root file metadata changed").into());
                }
            } else {
                root_meta = Some(meta.clone());
            }
            if assembler.is_none() {
                assembler = Some(TransferAssembler::new(&segment, &meta)?);
            }
            let mut compressed = receiver
                .assemble_raw()
                .ok_or_else(|| invalid("completed segment has no recovered bytes"))?;
            let compressed_size = usize::try_from(meta.compressed_size)?;
            if compressed_size > compressed.len() {
                return Err(invalid("segment compressed size exceeds recovered bytes").into());
            }
            compressed.truncate(compressed_size);
            let assembler = assembler.as_mut().unwrap();
            assembler.add_segment(&segment, &meta, compressed)?;
            if assembler.is_complete() {
                let compressed = assembler
                    .reassemble()
                    .ok_or_else(|| invalid("completed segments failed assembly"))?;
                let original = compress::decompress_with_limit(
                    &compressed,
                    meta.compression,
                    usize::try_from(meta.original_size)?,
                )?;
                verify_file(&original, &meta)?;
                if Sha256::digest(&original).as_slice() != segment.root_sha256 {
                    return Err(invalid("recovered root SHA-256 differs from descriptor").into());
                }
                recovered = Some(original);
            }
        } else {
            if root_meta.is_some() || recovered.is_some() {
                return Err(invalid("input contains more than one root transfer").into());
            }
            let original = receiver
                .assemble_result()?
                .ok_or_else(|| invalid("completed transfer failed assembly"))?;
            verify_file(&original, &meta)?;
            root_meta = Some(meta);
            recovered = Some(original);
        }
    }

    let recovered =
        recovered.ok_or_else(|| invalid("QR records did not recover a complete file"))?;
    let meta = root_meta.ok_or_else(|| invalid("no confirmed file descriptor"))?;
    fs::write(output, &recovered)?;
    println!(
        "verified {} records, {} bytes, filename={}",
        record_count,
        recovered.len(),
        meta.filename
    );
    Ok(())
}
