use transfer_engine::sender::{SenderConfig, SenderSession};
use transfer_engine::descriptor::{FileMeta, build_payload};
use qr_protocol::SessionId;
use raptorq_core::Config;

#[test]
#[ignore]
#[ignore = "diagnostic benchmark — run with: cargo test -- --ignored diag_blockcount"]
fn diag_blockcount_sizes() {
    for size in [500_000usize, 1_000_000, 2_000_000, 2_430_754, 3_000_000, 5_000_000] {
        let data: Vec<u8> = (0..size).map(|i| ((i * 2654435761) & 0xff) as u8).collect();
        let sid = SessionId::derive("f", size as u64, 0, &[]);
        let fm = FileMeta { filename: "完整组图.png".into(), original_size: size as u64, compressed_size: size as u64, ..Default::default() };
        let sender = SenderSession::new(&data, sid, SenderConfig { codec: Config::default(), redundancy_pct: 10 }, fm).unwrap();
        let meta = sender.meta();
        let build = build_payload(meta, sender.file_meta());
        println!("size={:>9} K={:>5} blocks={:>4} desc_build={}",
            size, sender.total_k(), meta.blocks.len(),
            match &build { Ok(p) => format!("OK({}B)", p.len()), Err(e) => format!("ERR: {e}") });
    }
}
