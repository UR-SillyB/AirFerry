use af2::receiver::{Af2Receiver, IngestEvent};
use af2::sender::{Af2Sender, SenderConfig};
use std::collections::HashMap;

/// Helper to simulate transmitting entries end-to-end through Af2Sender -> Af2Receiver
#[allow(clippy::too_many_arguments)]
fn run_simulated_transfer(
    items: Vec<(u8, String, Vec<u8>)>,
    symbol_size: usize,
    chunk_raw_size: u32,
    redundancy_pct: u8,
    max_frames: usize,
    drop_pct: usize,
    reorder: bool,
    duplicate_pct: usize,
    inject_garbage: bool,
) -> (bool, HashMap<u32, Vec<u8>>, String, u64) {
    let config = SenderConfig {
        symbol_size,
        chunk_raw_size,
        redundancy_pct,
    };
    let mut sender = Af2Sender::new(items, config).expect("sender build failed");
    let mut receiver = Af2Receiver::new();
    let mut received_chunks = HashMap::new();

    let mut generated_frames = Vec::new();
    for _ in 0..max_frames {
        generated_frames.push(sender.next_frame().expect("frame generation failed"));
    }

    // Apply transmission impairments
    let mut channel_frames = Vec::new();
    for (i, f) in generated_frames.into_iter().enumerate() {
        // Drop simulation
        if drop_pct > 0 && (i * 17 + 3) % 100 < drop_pct {
            continue;
        }
        channel_frames.push(f.clone());
        // Duplicate simulation
        if duplicate_pct > 0 && (i * 13 + 7) % 100 < duplicate_pct {
            channel_frames.push(f.clone());
        }
        // Garbage frame injection (corrupt or environmental junk)
        if inject_garbage && i % 25 == 0 {
            channel_frames.push(vec![0x41, 0x46, 0x02, 0xFF, 0x00, 0x12, 0x34, 0x56]);
            channel_frames.push(b"https://example.com/not-a-frame-just-junk-url-qr".to_vec());
        }
    }

    // Reorder simulation (chunks of 4 swapped)
    if reorder {
        for chunk in channel_frames.chunks_mut(4) {
            chunk.reverse();
        }
    }

    let mut is_complete = false;
    for frame in channel_frames {
        match receiver.ingest(&frame) {
            Ok(IngestEvent::ChunkReady { index, raw }) => {
                received_chunks.insert(index, raw);
            }
            Ok(IngestEvent::Relocked) => {
                received_chunks.clear();
            }
            _ => {}
        }
        if let Some(r) = receiver.root() {
            if r.chunk_count > 0 && received_chunks.len() >= r.chunk_count as usize {
                is_complete = true;
                break;
            }
        }
    }

    let (tid_hex, total_raw_size) = if let Some(r) = receiver.root() {
        let tid: String = r.transfer().iter().map(|b| format!("{b:02x}")).collect();
        (tid, r.total_raw_size)
    } else {
        (String::new(), 0)
    };
    (
        is_complete,
        received_chunks,
        tid_hex,
        total_raw_size,
    )
}

#[test]
fn boundary_suite_1_data_and_content_boundaries() {
    println!("\n--- Suite 1: Data and Content Boundaries ---");

    // 1.1 Single Byte
    let single_byte = vec![0x42];
    let (complete, chunks, _, raw_size) = run_simulated_transfer(
        vec![(2, "1byte.txt".into(), single_byte.clone())],
        512,
        8 << 20,
        10,
        200,
        0,
        false,
        0,
        false,
    );
    assert!(complete);
    assert_eq!(raw_size, 1);
    assert_eq!(chunks.get(&0).unwrap(), &single_byte);

    // 1.2 Boundary sizes around 26-64 bytes
    for len in [29, 30, 31, 63, 64, 65, 127, 128, 511, 512, 513, 1023, 1024, 1025] {
        let data = vec![0xA5; len];
        let (complete, chunks, _, raw_size) = run_simulated_transfer(
            vec![(1, format!("size_{len}.bin"), data.clone())],
            512,
            8 << 20,
            10,
            200,
            0,
            false,
            0,
            false,
        );
        assert!(complete, "Failed for length {len}");
        assert_eq!(raw_size, len as u64);
        assert_eq!(chunks.get(&0).unwrap(), &data);
    }

    // 1.3 Full 0x00..=0xFF Byte Spectrum & Binary Nulls
    let all_bytes: Vec<u8> = (0..=255).cycle().take(2048).collect();
    let (complete, chunks, _, raw_size) = run_simulated_transfer(
        vec![(1, "spectrum.bin".into(), all_bytes.clone())],
        512,
        8 << 20,
        10,
        200,
        0,
        false,
        0,
        false,
    );
    assert!(complete);
    assert_eq!(raw_size, all_bytes.len() as u64);
    assert_eq!(chunks.get(&0).unwrap(), &all_bytes);

    // 1.4 Extreme Unicode / Emojis / ZWJ / RTL
    let unicode_text = "🌟✨👨‍👩‍👧‍👦 汉语/中文 日本語 한국어 العربية עבריत 𝄢𝄞 🔥🌈🚀 \n\
                        ZeroWidth: \u{200B}\u{200C}\u{200D}\u{FEFF}\n\
                        Punctuation: ~!@#$%^&*()_+`-={}|[]\\:\";'<>?,./";
    let unicode_bytes = unicode_text.as_bytes().to_vec();
    let (complete, chunks, _, raw_size) = run_simulated_transfer(
        vec![(2, "unicode.txt".into(), unicode_bytes.clone())],
        512,
        8 << 20,
        10,
        200,
        0,
        false,
        0,
        false,
    );
    assert!(complete);
    assert_eq!(raw_size, unicode_bytes.len() as u64);
    assert_eq!(chunks.get(&0).unwrap(), &unicode_bytes);

    // 1.5 Incompressible Random Stream (2 MiB, multi-chunk across 1 MiB boundary)
    let mut random_bytes = vec![0u8; 2 * 1024 * 1024];
    for (i, b) in random_bytes.iter_mut().enumerate() {
        *b = ((i * 1664525 + 1013904223) >> 16) as u8;
    }
    let (complete, chunks, _, raw_size) = run_simulated_transfer(
        vec![(1, "random.bin".into(), random_bytes.clone())],
        1024,
        1024 * 1024, // 2 chunks of 1 MiB (valid AF2 power-of-two >= 1 MiB)
        10,
        3000,
        0,
        false,
        0,
        false,
    );
    assert!(complete);
    assert_eq!(raw_size, 2 * 1024 * 1024);
    let mut assembled = Vec::new();
    assembled.extend_from_slice(chunks.get(&0).unwrap());
    assembled.extend_from_slice(chunks.get(&1).unwrap());
    assert_eq!(assembled, random_bytes);
}

#[test]
fn boundary_suite_2_transmission_parameters_and_symbol_sizes() {
    println!("\n--- Suite 2: Transmission Parameters and Symbol Sizes ---");
    let test_data = b"AirFerry Transmission Parameters Boundary Matrix Test Verification Data Payload!".to_vec();

    // 2.1 All standard symbol sizes (256, 384, 512, 768, 1024, 1400)
    for sym_size in [256, 384, 512, 768, 1024, 1400] {
        let (complete, chunks, _, _) = run_simulated_transfer(
            vec![(1, format!("sym_{sym_size}.bin"), test_data.clone())],
            sym_size,
            8 << 20,
            10,
            200,
            0,
            false,
            0,
            false,
        );
        assert!(complete, "Symbol size {sym_size} failed");
        assert_eq!(chunks.get(&0).unwrap(), &test_data);
    }

    // 2.2 Extreme Redundancy Rates (5% min, 25% default, 50% max)
    for redundancy in [5, 10, 25, 50] {
        let (complete, chunks, _, _) = run_simulated_transfer(
            vec![(1, format!("red_{redundancy}.bin"), test_data.clone())],
            512,
            8 << 20,
            redundancy,
            200,
            0,
            false,
            0,
            false,
        );
        assert!(complete, "Redundancy {redundancy}% failed");
        assert_eq!(chunks.get(&0).unwrap(), &test_data);
    }
}

#[test]
fn boundary_suite_3_multi_file_and_directory_hierarchy() {
    println!("\n--- Suite 3: Multi-File and Directory Hierarchy ---");

    // 3.1 Multi-file bundle with nested paths
    let file1 = b"Content of root file 1".to_vec();
    let file2 = b"Content of sub-directory file 2 with more bytes".to_vec();
    let file3 = b"Deeply nested file 3 data".to_vec();

    let items = vec![
        (1, "root_file.txt".into(), file1.clone()),
        (1, "subdir/nested_file.bin".into(), file2.clone()),
        (1, "a/b/c/d/deep_file.dat".into(), file3.clone()),
    ];

    let (complete, chunks, _, raw_size) =
        run_simulated_transfer(items, 512, 8 << 20, 10, 300, 0, false, 0, false);
    assert!(complete);
    assert_eq!(raw_size, (file1.len() + file2.len() + file3.len()) as u64);

    // Manifest sorts entries lexicographically: "a/b/c/d/deep_file.dat" < "root_file.txt" < "subdir/nested_file.bin"
    let stream = chunks.get(&0).unwrap();
    let mut offset = 0;
    assert_eq!(&stream[offset..offset + file3.len()], &file3[..]);
    offset += file3.len();
    assert_eq!(&stream[offset..offset + file1.len()], &file1[..]);
    offset += file1.len();
    assert_eq!(&stream[offset..offset + file2.len()], &file2[..]);
}

#[test]
fn boundary_suite_4_channel_impairments_and_error_recovery() {
    println!("\n--- Suite 4: Channel Impairments, High Loss, Reorder, Dupes, Garbage ---");
    let payload = vec![0x37; 16 * 1024]; // 16 KB data

    // 4.1 High Drop Rate (30% packet loss)
    let (complete, chunks, _, _) = run_simulated_transfer(
        vec![(1, "loss30.bin".into(), payload.clone())],
        512,
        8 << 20,
        35,  // 35% redundancy to overcome 30% loss
        600, // allow enough frames in playlist loop
        30,  // 30% drop
        false,
        0,
        false,
    );
    assert!(complete, "Failed under 30% drop rate");
    assert_eq!(chunks.get(&0).unwrap(), &payload);

    // 4.2 Extreme Drop Rate (50% packet loss) + Fountain Code Recovery
    let (complete, chunks, _, _) = run_simulated_transfer(
        vec![(1, "loss50.bin".into(), payload.clone())],
        512,
        8 << 20,
        50,   // 50% redundancy
        1200, // playlist fountain cycles supply infinite repair symbols
        50,   // 50% drop rate
        false,
        0,
        false,
    );
    assert!(complete, "Failed under 50% fountain recovery");
    assert_eq!(chunks.get(&0).unwrap(), &payload);

    // 4.3 Reordering + Heavy Duplication (40% duplicates) + Garbage Frame Injection
    let (complete, chunks, _, _) = run_simulated_transfer(
        vec![(1, "chaotic.bin".into(), payload.clone())],
        512,
        8 << 20,
        20,
        800,
        15,   // 15% drop
        true, // heavy reordering
        40,   // 40% duplicates
        true, // injected garbage & non-frame QR payloads
    );
    assert!(complete, "Failed under chaotic channel conditions");
    assert_eq!(chunks.get(&0).unwrap(), &payload);
}

#[test]
fn boundary_suite_5_stream_switching_and_relock() {
    println!("\n--- Suite 5: Stream Switching and Relock Resistance ---");
    let transfer_a = vec![0xAA; 4096];
    let transfer_b = vec![0xBB; 4096];

    let mut sender_a = Af2Sender::new(
        vec![(1, "a.bin".into(), transfer_a.clone())],
        SenderConfig::default(),
    )
    .unwrap();
    let mut sender_b = Af2Sender::new(
        vec![(1, "b.bin".into(), transfer_b.clone())],
        SenderConfig::default(),
    )
    .unwrap();

    let mut rx = Af2Receiver::new();

    // Ingest some frames from A
    let f1 = sender_a.next_frame().unwrap();
    let f2 = sender_a.next_frame().unwrap();
    assert_eq!(rx.ingest(&f1).unwrap(), IngestEvent::RootLocked);
    assert_eq!(rx.ingest(&f2).unwrap(), IngestEvent::Dropped); // Repeated root or meta

    // Ingest 1 frame from B -> RootMismatch (streak 1), must NOT relock immediately
    let fb_root = sender_b.next_frame().unwrap();
    assert_eq!(
        rx.ingest(&fb_root).unwrap(),
        IngestEvent::RootMismatch { streak: 1 }
    );

    // Ingest 2nd frame from B -> RootMismatch (streak 2)
    assert_eq!(
        rx.ingest(&fb_root).unwrap(),
        IngestEvent::RootMismatch { streak: 2 }
    );

    // Ingest 3rd frame from B -> Relocked! (Streak 3 reached)
    assert_eq!(rx.ingest(&fb_root).unwrap(), IngestEvent::Relocked);

    // Next frame from B locks the new root
    assert_eq!(rx.ingest(&fb_root).unwrap(), IngestEvent::RootLocked);
}

#[test]
fn boundary_suite_6_cross_instance_isolation_no_poisoning() {
    println!("\n--- Suite 6: §17 d) Cross-Instance Isolation (Alternating Instances) ---");
    // Same payload, two senders with different T (yielding distinct Object IDs).
    // Alternating symbol/meta frames from both instances must NEVER poison the
    // receiver's active decoder — foreign symbols are dropped at the routing layer.
    let payload = vec![0x5A; 8192];
    let mut sender_t512 = Af2Sender::new(
        vec![(1, "data.bin".into(), payload.clone())],
        SenderConfig {
            symbol_size: 512,
            chunk_raw_size: 1 << 20,
            redundancy_pct: 30,
        },
    )
    .unwrap();
    let mut sender_t1024 = Af2Sender::new(
        vec![(1, "data.bin".into(), payload.clone())],
        SenderConfig {
            symbol_size: 1024,
            chunk_raw_size: 1 << 20,
            redundancy_pct: 30,
        },
    )
    .unwrap();

    let mut rx = Af2Receiver::new();
    // Ingest all frames from T=1024 while interleaving symbols from T=512
    let mut chunk_recovered = false;
    for _ in 0..500 {
        // Feed foreign T=512 frame: if it is a data frame it is dropped; if it
        // is ROOT we skip it here so we specifically test symbol-level isolation.
        let f_other = sender_t512.next_frame().unwrap();
        let frame_parsed = af2::frame::Af2Frame::from_bytes(&f_other).unwrap();
        if frame_parsed.frame_type != af2::frame::FrameType::Root {
            let _ = rx.ingest(&f_other);
        }

        let f_target = sender_t1024.next_frame().unwrap();
        let ev = rx.ingest(&f_target).unwrap();
        if let IngestEvent::ChunkReady { raw, .. } = ev {
            assert_eq!(raw, payload);
            chunk_recovered = true;
            break;
        }
    }
    assert!(chunk_recovered, "Target instance must recover cleanly despite interleaved foreign symbols");
}

#[test]
fn boundary_suite_7_late_joiner_linear_convergence() {
    println!("\n--- Suite 7: §17 c) Late Joiner (Arbitrary Start Point) ---");
    // A receiver joining mid-broadcast after hundreds of frames have already
    // been emitted must synchronize and recover via subsequent fresh repair symbols.
    let data = vec![0x7E; 12 * 1024];
    let mut sender = Af2Sender::new(
        vec![(1, "late.bin".into(), data.clone())],
        SenderConfig {
            symbol_size: 512,
            chunk_raw_size: 1 << 20,
            redundancy_pct: 50,
        },
    )
    .unwrap();

    // Burn 150 frames before the receiver turns on
    for _ in 0..150 {
        let _ = sender.next_frame().unwrap();
    }

    let mut rx = Af2Receiver::new();
    let mut completed = false;
    for _ in 0..600 {
        let f = sender.next_frame().unwrap();
        let ev = rx.ingest(&f).unwrap();
        if let IngestEvent::ChunkReady { raw, .. } = ev {
            assert_eq!(raw, data);
            completed = true;
            break;
        }
    }
    assert!(completed, "Late joiner must lock onto periodic control frames and decode");
}

#[test]
fn boundary_suite_8_manifest_post_verification_and_stream_gate() {
    println!("\n--- Suite 8: §17 f) Post-Verification & §13 ⑧⑨ Finalize Gate ---");
    let text = "Hello AF2 full integrity chain verification!".as_bytes().to_vec();
    let mut sender = Af2Sender::new(
        vec![(2, "msg.txt".into(), text.clone())],
        SenderConfig::default(),
    )
    .unwrap();
    let mut rx = Af2Receiver::new();

    let mut staged_raw = None;
    for _ in 0..500 {
        let f = sender.next_frame().unwrap();
        let ev = rx.ingest(&f).unwrap();
        if let IngestEvent::ChunkReady { raw, .. } = ev {
            staged_raw = Some(raw);
            break;
        }
    }
    let raw = staged_raw.expect("Chunk must complete");
    // Verify against Manifest table
    assert!(rx.verify_chunk(0, &raw));
    // Verify bad hash fails
    let mut bad_raw = raw.clone();
    bad_raw[0] ^= 0xFF;
    assert!(!rx.verify_chunk(0, &bad_raw));

    // Full stream finalization gate
    rx.verify_final_stream(&raw).expect("Final stream gate must pass");
    assert!(rx.verify_final_stream(&bad_raw).is_err());
}
