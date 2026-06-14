use transfer_engine::sender::{SenderConfig, SenderSession};
use transfer_engine::receiver::ReceiverSession;
use transfer_engine::descriptor::FileMeta;
use qr_protocol::{Frame, SessionId};
use raptorq_core::Config;

#[test]
#[ignore = "diagnostic benchmark — run with: cargo test -- --ignored diag_small"]
fn diag_small() {
    let size = 50_000usize;
    let data: Vec<u8> = (0..size).map(|i| (i & 0xff) as u8).collect();
    let sid = SessionId::derive("f", size as u64, 0, &[]);
    let fm = FileMeta { filename: "f".into(), original_size: size as u64, ..Default::default() };
    let mut sender = SenderSession::new(&data, sid,
        SenderConfig { codec: Config::default(), redundancy_pct: 50 }, fm.clone()).unwrap();
    let k = sender.total_k();
    let meta = sender.meta().clone();

    println!("Sender: K={}, blocks={}", k, meta.blocks.len());
    for b in &meta.blocks {
        println!("  block {}: K={}", b.sbn, b.num_source_symbols);
    }

    // Method A: new_confirmed (skip descriptors)
    let mut rx_a = ReceiverSession::new_confirmed(0, meta.clone());
    let mut fed_a = 0;
    for _ in 0..500 {
        let f = sender.next_frame().unwrap();
        if f.header.flags & qr_protocol::FLAG_DESCRIPTOR != 0 { continue; }
        let bytes = f.to_bytes();
        let parsed = Frame::from_bytes(&bytes).unwrap();
        let _ = rx_a.ingest(parsed);
        fed_a += 1;
        if rx_a.is_complete() { break; }
    }
    println!("Method A (new_confirmed): fed={}, complete={}", fed_a, rx_a.is_complete());

    // Method B: from_first_frame + feed descriptors too
    sender = SenderSession::new(&data, sid,
        SenderConfig { codec: Config::default(), redundancy_pct: 50 }, fm.clone()).unwrap();
    sender.set_descriptor_interval(8);
    let mut rx_b: Option<ReceiverSession> = None;
    let mut fed_b = 0;
    for _ in 0..500 {
        let f = sender.next_frame().unwrap();
        let bytes = f.to_bytes();
        let parsed = Frame::from_bytes(&bytes).unwrap();
        if rx_b.is_none() {
            rx_b = Some(ReceiverSession::from_first_frame(&parsed));
        }
        let _ = rx_b.as_mut().unwrap().ingest(parsed);
        fed_b += 1;
        if rx_b.as_ref().unwrap().is_complete() { break; }
    }
    let rx_b = rx_b.unwrap();
    println!("Method B (from_first_frame+desc): fed={}, complete={}, confirmed={}",
        fed_b, rx_b.is_complete(), rx_b.is_meta_confirmed());
}
