use transfer_engine::descriptor::{FileMeta, build_payload, parse_payload};
use transfer_engine::sender::{SenderConfig, SenderSession};
use transfer_engine::receiver::ReceiverSession;
use qr_protocol::SessionId;

#[test]
fn file_meta_roundtrip() {
    let data: Vec<u8> = (0..50_000).map(|i| (i & 0xff) as u8).collect();
    let fm = FileMeta { filename: "test.pdf".to_string(), original_size: 50_000, crc32: 0xCAFEBABE };
    let sender = SenderSession::new(&data, SessionId::zero(), SenderConfig::default(), fm.clone()).unwrap();
    let meta = sender.meta().clone();

    let frame = transfer_engine::descriptor::build_frame(&meta, &fm, 0, 1, 1000).unwrap();
    let mut rx = ReceiverSession::new(0, meta.clone());
    let _ = rx.ingest(frame);
    assert_eq!(rx.file_meta().filename, "test.pdf");
    assert_eq!(rx.file_meta().original_size, 50_000);
    assert_eq!(rx.file_meta().crc32, 0xCAFEBABE);
    println!("✅ file_meta roundtrip: filename={} size={} crc=0x{:X}",
        rx.file_meta().filename, rx.file_meta().original_size, rx.file_meta().crc32);
}
