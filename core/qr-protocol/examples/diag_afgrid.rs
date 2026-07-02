fn main() {
    use qr_protocol::afgrid;
    use qr_protocol::Frame;
    let sym = 512u32;
    let frame = Frame::build(1u128,0,0,0,1,10,sym,1,0,&vec![0x42; sym as usize]);
    let bytes = frame.to_bytes();
    let m = afgrid::encode(&bytes).unwrap();
    let cs = m.size; let cv = cs*2; let off=(cv-cs)/2;
    let mut gray = vec![255u8; cv*cv];
    for y in 0..cs { for x in 0..cs { if m.modules[y*cs+x] { gray[(off+y)*cv+(off+x)]=0; }}}
    let mods = afgrid::l1_gray::sample_modules(&gray, cv, cv, cs);
    let expect: Vec<u8> = m.modules.iter().map(|&b| b as u8).collect();
    let mut diff = 0usize;
    for i in 0..(cs*cs) { if mods[i] != expect[i] { diff += 1; } }
    eprintln!("module diff count={} / {}", diff, cs*cs);
    eprintln!("decode_modules={}", afgrid::decode_from_modules(&mods, cs).is_ok());
    eprintln!("decode_gray={}", afgrid::decode_from_gray(&gray, cv, cv, cs).is_some());
}
