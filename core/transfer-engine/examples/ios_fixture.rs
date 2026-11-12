//! Binary fixtures for the Swift C-ABI integration test (no camera needed).
use qr_protocol::{compress, SessionId};
use transfer_engine::{FileMeta, SenderConfig, SenderSession};
fn main() {
    let directory = std::env::args().nth(1).expect("output directory");
    std::fs::create_dir_all(&directory).unwrap();
    let original: Vec<u8> = (0..12000).map(|i| (i % 256) as u8).collect();
    std::fs::write(format!("{directory}/expected.bin"), &original).unwrap();
    for compression in 0..=2 {
        let payload = compress::compress_with(&original, compression).unwrap();
        let sid = SessionId::derive("ios", original.len() as u64, compression as u64, &[]);
        let meta = FileMeta {
            filename: "../binary.dat".into(),
            original_size: original.len() as u64,
            crc32: crc32fast::hash(&original),
            compression,
            compressed_size: payload.len() as u64,
            compressed_size_known: true,
            crc32_known: true,
        };
        let mut sender = SenderSession::new(&payload, sid, SenderConfig::default(), meta).unwrap();
        let mut frames = Vec::new();
        for _ in 0..sender.total_k() * 3 + 64 {
            let frame = sender.next_frame().unwrap().to_bytes();
            frames.extend_from_slice(&(frame.len() as u32).to_be_bytes());
            frames.extend_from_slice(&frame);
        }
        std::fs::write(format!("{directory}/{compression}.frames"), frames).unwrap();
    }
}
