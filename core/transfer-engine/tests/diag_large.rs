use transfer_engine::sender::{SenderConfig, SenderSession};
use transfer_engine::receiver::ReceiverSession;
use transfer_engine::descriptor::FileMeta;
use qr_protocol::{Frame, SessionId};
use raptorq_core::Config;
use std::time::Instant;

#[test]
#[ignore = "diagnostic benchmark — run with: cargo test -- --ignored diag_2mb"]
fn diag_2mb_from_first_frame() {
    let size = 2 * 1024 * 1024;
    let data: Vec<u8> = (0..size).map(|i| (i & 0xff) as u8).collect();
    let sid = SessionId::derive("big.bin", size as u64, 0, &[]);
    let fm = FileMeta { filename: "big.bin".into(), original_size: size as u64, ..Default::default() };

    let mut sender = SenderSession::new(&data, sid,
        SenderConfig { codec: Config::default(), redundancy_pct: 20 },
        fm.clone()).unwrap();
    sender.set_descriptor_interval(8);

    println!("K={}, blocks={}", sender.total_k(), sender.meta().blocks.len());

    let mut rx: Option<ReceiverSession> = None;
    let t0 = Instant::now();
    let mut data_count = 0u32;
    let mut desc_count = 0u32;
    for i in 0..(sender.total_k() * 3 + 200) {
        let f = sender.next_frame().unwrap();
        let bytes = f.to_bytes();
        let parsed = Frame::from_bytes(&bytes).unwrap();
        if rx.is_none() {
            rx = Some(ReceiverSession::from_first_frame(&parsed));
        }
        let is_desc = parsed.header.flags & qr_protocol::FLAG_DESCRIPTOR != 0;
        if is_desc { desc_count += 1; } else { data_count += 1; }
        let _ = rx.as_mut().unwrap().ingest(parsed);
        if i % 500 == 0 && i > 0 {
            let p = rx.as_ref().unwrap().progress();
            println!("frame {}: data={} desc={} confirmed={} decoded={}/{} elapsed={:.1}s",
                i, data_count, desc_count, rx.as_ref().unwrap().is_meta_confirmed(),
                p.decoded_symbols, p.total_symbols, t0.elapsed().as_secs_f64());
        }
        if rx.as_ref().unwrap().is_complete() {
            println!("COMPLETE at frame {}! data={} desc={} elapsed={:.1}s",
                i, data_count, desc_count, t0.elapsed().as_secs_f64());
            break;
        }
    }
    let rx = rx.unwrap();
    assert!(rx.is_complete(), "2MB failed: decoded={}/{} confirmed={}",
        rx.progress().decoded_symbols, rx.progress().total_symbols, rx.is_meta_confirmed());
}
