//! GF(256) RS ~10% parity + 4-way interleave (chunked for GF(255) block limit).

use reed_solomon::{Decoder, Encoder};

pub const INTERLEAVE: usize = 4;
pub const MAX_RS_DATA: usize = 200;

pub fn rs_parity_len(data_len: usize) -> usize {
    ((data_len as f64) * 0.10).ceil().max(2.0) as usize
}

fn interleave(data: &[u8], stripes: usize) -> Vec<u8> {
    if data.is_empty() {
        return vec![];
    }
    let pad = (stripes - (data.len() % stripes)) % stripes;
    let mut padded = data.to_vec();
    padded.resize(data.len() + pad, 0);
    let row_len = padded.len() / stripes;
    let mut out = Vec::with_capacity(padded.len());
    for c in 0..row_len {
        for r in 0..stripes {
            out.push(padded[r * row_len + c]);
        }
    }
    out
}

fn deinterleave(data: &[u8], stripes: usize, orig_len: usize) -> Vec<u8> {
    if data.is_empty() {
        return vec![];
    }
    let row_len = data.len() / stripes;
    let mut padded = vec![0u8; data.len()];
    let mut idx = 0;
    for c in 0..row_len {
        for r in 0..stripes {
            padded[r * row_len + c] = data[idx];
            idx += 1;
        }
    }
    padded.truncate(orig_len);
    padded
}

fn encode_chunk(data: &[u8]) -> Vec<u8> {
    let npar = rs_parity_len(data.len());
    let enc = Encoder::new(npar);
    let encoded = enc.encode(data);
    let mut out = data.to_vec();
    out.extend_from_slice(encoded.ecc());
    out
}

fn decode_chunk(codeword: &mut [u8], data_len: usize) -> bool {
    let npar = rs_parity_len(data_len);
    if codeword.len() < data_len + npar {
        return false;
    }
    let dec = Decoder::new(npar);
    dec.correct(codeword, None).is_ok()
}

/// Wire: [u16 chunk_count BE][per chunk: u16 data_len BE + interleaved codeword]
pub fn protect(payload: &[u8]) -> Vec<u8> {
    let mut chunks: Vec<(usize, Vec<u8>)> = Vec::new();
    let mut off = 0;
    while off < payload.len() {
        let end = (off + MAX_RS_DATA).min(payload.len());
        let data_len = end - off;
        let cw = encode_chunk(&payload[off..end]);
        chunks.push((data_len, interleave(&cw, INTERLEAVE)));
        off = end;
    }
    let mut out = (chunks.len() as u16).to_be_bytes().to_vec();
    for (data_len, interleaved) in chunks {
        out.extend_from_slice(&(data_len as u16).to_be_bytes());
        out.extend_from_slice(&interleaved);
    }
    out
}

pub fn unprotect(blob: &[u8]) -> Option<Vec<u8>> {
    if blob.len() < 2 {
        return None;
    }
    let count = u16::from_be_bytes([blob[0], blob[1]]) as usize;
    let mut pos = 2usize;
    let mut payload = Vec::new();
    for _ in 0..count {
        if pos + 2 > blob.len() {
            return None;
        }
        let data_len = u16::from_be_bytes([blob[pos], blob[pos + 1]]) as usize;
        pos += 2;
        let npar = rs_parity_len(data_len);
        let total = data_len + npar;
        let pad = (INTERLEAVE - (total % INTERLEAVE)) % INTERLEAVE;
        let ilen = total + pad;
        if pos + ilen > blob.len() {
            return None;
        }
        let mut codeword = deinterleave(&blob[pos..pos + ilen], INTERLEAVE, total);
        pos += ilen;
        if !decode_chunk(&mut codeword, data_len) {
            return None;
        }
        payload.extend_from_slice(&codeword[..data_len]);
    }
    Some(payload)
}

pub fn protected_len(payload_len: usize) -> usize {
    let mut off = 0;
    let mut total = 2usize;
    while off < payload_len {
        let data_len = (off + MAX_RS_DATA).min(payload_len) - off;
        let npar = rs_parity_len(data_len);
        let pad = (INTERLEAVE - ((data_len + npar) % INTERLEAVE)) % INTERLEAVE;
        total += 2 + data_len + npar + pad;
        off += data_len;
    }
    total
}
