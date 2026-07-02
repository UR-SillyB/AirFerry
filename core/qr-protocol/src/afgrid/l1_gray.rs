//! L1: grayscale → module grid (border-aware crop + adaptive threshold).

use super::layout::BORDER;

fn otsu_threshold(gray: &[u8]) -> u8 {
    let mut hist = [0u32; 256];
    for &p in gray {
        hist[p as usize] += 1;
    }
    let total = gray.len() as u32;
    if total == 0 {
        return 128;
    }
    let mut sum = 0u64;
    for (i, &c) in hist.iter().enumerate() {
        sum += i as u64 * c as u64;
    }
    let mut sum_b = 0u64;
    let mut w_b = 0u32;
    let mut max_var = 0f64;
    let mut threshold = 128u8;
    for t in 0..256 {
        w_b += hist[t];
        if w_b == 0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f == 0 {
            break;
        }
        sum_b += t as u64 * hist[t] as u64;
        let m_b = sum_b as f64 / w_b as f64;
        let m_f = (sum - sum_b) as f64 / w_f as f64;
        let var = w_b as f64 * w_f as f64 * (m_b - m_f).powi(2);
        if var > max_var {
            max_var = var;
            threshold = t as u8;
        }
    }
    threshold
}

/// Crop to central square covering most of the frame (screen QR is centered).
fn central_square_bounds(w: usize, h: usize) -> (usize, usize, usize) {
    let side = w.min(h) * 85 / 100;
    let x0 = (w - side) / 2;
    let y0 = (h - side) / 2;
    (x0, y0, side)
}

pub fn sample_modules(gray: &[u8], width: usize, height: usize, side: usize) -> Vec<u8> {
    if width == height && width == side {
        let mut min_p = 255u8;
        let mut max_p = 0u8;
        for &p in gray {
            min_p = min_p.min(p);
            max_p = max_p.max(p);
        }
        let thresh = ((min_p as u16 + max_p as u16) / 2) as u8;
        return gray
            .iter()
            .map(|&p| if p < thresh { 1 } else { 0 })
            .collect();
    }
    let (x0, y0, sq) = central_square_bounds(width, height);
    let mut patch = Vec::with_capacity(sq * sq);
    for row in 0..sq {
        let sy = y0 + row;
        let base = sy * width;
        for col in 0..sq {
            patch.push(gray[base + x0 + col]);
        }
    }
    let mut min_p = 255u8;
    let mut max_p = 0u8;
    for &p in &patch {
        min_p = min_p.min(p);
        max_p = max_p.max(p);
    }
    let thresh = if max_p.saturating_sub(min_p) > 200 {
        (min_p as u16 + max_p as u16) / 2
    } else {
        otsu_threshold(&patch) as u16
    } as u8;
    let mut modules = vec![0u8; side * side];
    for y in 0..side {
        for x in 0..side {
            let sx = x * sq / side;
            let sy = y * sq / side;
            let idx = sy * sq + sx;
            modules[y * side + x] = if patch[idx] < thresh { 1 } else { 0 };
        }
    }
    modules
}

pub fn estimate_side_from_bbox(module_count_hint: usize) -> usize {
    module_count_hint.max(8 + 2 * BORDER)
}
