use raptorq_core::{Config, Encoder, Decoder};
use std::time::Instant;

fn test_k(k_target: usize) {
    let size = k_target * 1024;
    let data: Vec<u8> = (0..size).map(|i| (i & 0xff) as u8).collect();

    let t0 = Instant::now();
    let enc = Encoder::new(&data, Config::default()).unwrap();
    let meta = enc.meta().clone();
    let k: u32 = meta.blocks.iter().map(|b| b.num_source_symbols).sum();
    println!("K={}: encoder built in {:.2}s", k, t0.elapsed().as_secs_f64());

    let t1 = Instant::now();
    for sbn in 0..meta.blocks.len() as u32 {
        let bk = meta.blocks[sbn as usize].num_source_symbols;
        for esi in 0..bk {
            let _ = enc.source_symbol(sbn, esi);
        }
    }
    println!("K={}: all source symbols fetched in {:.2}s", k, t1.elapsed().as_secs_f64());

    let t2 = Instant::now();
    let mut dec = Decoder::new(meta.clone());
    for sbn in 0..meta.blocks.len() as u32 {
        let bk = meta.blocks[sbn as usize].num_source_symbols;
        for esi in 0..bk {
            let sym = enc.source_symbol(sbn, esi).unwrap();
            let _ = dec.add_symbol(&sym);
        }
    }
    println!("K={}: decode in {:.2}s complete={}", k, t2.elapsed().as_secs_f64(), dec.is_complete());
}

#[test]
fn perf_test() {
    for &k in &[49, 200, 500, 1000, 2048] {
        test_k(k);
    }
}
