//! L1: grayscale → module grid.
//!
//! 定位策略：AFGrid 的顶边框 + 左边框是全黑实心条（L 角），底/右边框是
//! 交替时序边。我们用**行列投影**定位码区：
//!   1. 对灰度图二值化（全图 Otsu）；
//!   2. 行投影（每行黑像素数）→ 找连续黑带，即上下边界；
//!   3. 列投影 → 找左右边界；
//!   4. 在定位到的矩形区内用局部 Otsu 逐模块采样。
//!
//! 相比「全帧均值阈值」，投影法对「屏幕只占画面一部分 + 周围环境光」鲁棒：
//! 阈值由投影统计决定，而非全帧亮度均值。

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

/// 二值化全图：黑=1，白=0。
fn binarize(gray: &[u8], thresh: u8) -> Vec<u8> {
    gray.iter().map(|&p| if p < thresh { 1 } else { 0 }).collect()
}

/// 行投影 + 列投影，返回 (row_sum, col_sum)。
fn projections(bin: &[u8], w: usize, h: usize) -> (Vec<u32>, Vec<u32>) {
    let mut row_sum = vec![0u32; h];
    let mut col_sum = vec![0u32; w];
    for y in 0..h {
        let base = y * w;
        for x in 0..w {
            if bin[base + x] != 0 {
                row_sum[y] += 1;
                col_sum[x] += 1;
            }
        }
    }
    (row_sum, col_sum)
}

/// 在投影里找「密集黑带」的起止：扫描超过 `threshold` 像素的连续段，取最长。
fn find_dense_band(proj: &[u32], threshold: u32) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    let mut best_len = 0usize;
    let mut start = 0usize;
    let mut in_band = false;
    for (i, &v) in proj.iter().enumerate() {
        if v >= threshold {
            if !in_band {
                start = i;
                in_band = true;
            }
        } else if in_band {
            let len = i - start;
            if len > best_len {
                best_len = len;
                best = Some((start, i));
            }
            in_band = false;
        }
    }
    if in_band {
        let len = proj.len() - start;
        if len > best_len {
            best = Some((start, proj.len()));
        }
    }
    best
}

/// 投影法定位码区 → 返回 (x0, y0, w, h)。失败回退中心 85%。
///
/// 按行/列统计暗像素占比（p < 200），码区明显高于纯白背景。
pub fn locate(gray: &[u8], w: usize, h: usize) -> (usize, usize, usize, usize) {
    const DARK: u8 = 200;
    const MIN_FRAC: f64 = 0.12;

    let mut row_dark = vec![0u32; h];
    let mut col_dark = vec![0u32; w];
    for y in 0..h {
        let base = y * w;
        for x in 0..w {
            if gray[base + x] < DARK {
                row_dark[y] += 1;
                col_dark[x] += 1;
            }
        }
    }
    let row_is_code: Vec<bool> = row_dark
        .iter()
        .map(|&c| (c as f64) / (w as f64) >= MIN_FRAC)
        .collect();
    let col_is_code: Vec<bool> = col_dark
        .iter()
        .map(|&c| (c as f64) / (h as f64) >= MIN_FRAC)
        .collect();
    // 外接矩形：所有码区行/列的首尾（避免时序边造成单像素“最长段”错误）
    let y0 = row_is_code.iter().position(|&b| b);
    let y1 = row_is_code.iter().rposition(|&b| b).map(|i| i + 1);
    let x0 = col_is_code.iter().position(|&b| b);
    let x1 = col_is_code.iter().rposition(|&b| b).map(|i| i + 1);
    match (y0, y1, x0, x1) {
        (Some(y0), Some(y1), Some(x0), Some(x1)) if y1 > y0 && x1 > x0 => {
            (x0, y0, x1 - x0, y1 - y0)
        }
        _ => {
            let side = w.min(h) * 85 / 100;
            ((w - side) / 2, (h - side) / 2, side, side)
        }
    }
}

/// 在布尔「暗」标记序列里找最长连续 true 段。
fn find_dark_band(dark: &[bool]) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    let mut best_len = 0usize;
    let mut start = 0usize;
    let mut in_band = false;
    for (i, &d) in dark.iter().enumerate() {
        if d {
            if !in_band {
                start = i;
                in_band = true;
            }
        } else if in_band {
            let len = i - start;
            if len > best_len {
                best_len = len;
                best = Some((start, i));
            }
            in_band = false;
        }
    }
    if in_band {
        let len = dark.len() - start;
        if len > best_len {
            best = Some((start, dark.len()));
        }
    }
    best
}

/// 在定位到的码区内采样为 side×side 模块网格。
pub fn sample_modules(gray: &[u8], width: usize, height: usize, side: usize) -> Vec<u8> {
    if width == height && width == side {
        // 完美 1:1（合成测试 / 精确对齐）：用 (min+max)/2 双峰中点。
        // AFGrid 边框大量黑色会拉偏 Otsu，双峰中点对高对比图更稳。
        let mut min_p = 255u8;
        let mut max_p = 0u8;
        for &p in gray {
            min_p = min_p.min(p);
            max_p = max_p.max(p);
        }
        let thresh = ((min_p as u16 + max_p as u16) / 2) as u8;
        return binarize(gray, thresh);
    }
    // 1. 投影法定位码区
    let (x0, y0, rw, rh) = locate(gray, width, height);
    // 2. 在码区内取正方形（取较短边，居中）
    let sq = rw.min(rh);
    let cx = x0 + (rw - sq) / 2;
    let cy = y0 + (rh - sq) / 2;
    // 3. 提取码区灰度 patch
    let mut patch = Vec::with_capacity(sq * sq);
    for row in 0..sq {
        let sy = cy + row;
        if sy >= height {
            break;
        }
        let base = sy * width;
        for col in 0..sq {
            let sx = cx + col;
            if sx >= width {
                break;
            }
            patch.push(gray[base + sx]);
        }
    }
    if patch.is_empty() {
        return vec![0u8; side * side];
    }
    // 4. 双峰中点阈值（码区 patch 高对比，比 Otsu 更稳）
    let mut min_p = 255u8;
    let mut max_p = 0u8;
    for &p in &patch {
        min_p = min_p.min(p);
        max_p = max_p.max(p);
    }
    let thresh = ((min_p as u16 + max_p as u16) / 2) as u8;
    // 5. 最近邻采样到 side×side
    let mut modules = vec![0u8; side * side];
    for y in 0..side {
        for x in 0..side {
            let sx = x * sq / side;
            let sy = y * sq / side;
            let idx = sy * sq + sx;
            if idx < patch.len() {
                modules[y * side + x] = if patch[idx] < thresh { 1 } else { 0 };
            }
        }
    }
    modules
}

#[allow(dead_code)]
pub fn estimate_side_from_bbox(module_count_hint: usize) -> usize {
    module_count_hint.max(8 + 2 * BORDER)
}
