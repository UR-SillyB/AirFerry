//! L1: grayscale → module grid。
//!
//! 真机策略：中心 ROI → 投影定位码区 → **逐模块局部 Otsu 阈值**采样。
//! 逐模块 Otsu 解决「亮屏幕码 + 暗环境」的全局阈值失效问题：
//! 每个模块只看自己那块小区域的灰度分布，不受环境光影响。

use super::layout::BORDER;

/// 占位（保留旧 API 兼容，实际用 sample_center_roi）。
pub fn sample_modules(gray: &[u8], width: usize, height: usize, side: usize) -> usize {
    let _ = (gray, width, height, side);
    0
}

/// 单遍历 ROI：统计行/列暗像素计数 + 直方图（用于定位后逐模块 Otsu）。
struct RoiStats {
    row_dark: Vec<u32>,
    col_dark: Vec<u32>,
}

fn scan_roi(gray: &[u8], stride: usize, rx: usize, ry: usize, roi: usize, w: usize, h: usize) -> RoiStats {
    let mut row_dark = vec![0u32; roi];
    let mut col_dark = vec![0u32; roi];
    for ry_i in 0..roi {
        let y = ry + ry_i;
        if y >= h { break; }
        let base = y * stride;
        if base >= gray.len() { break; }
        for rx_i in 0..roi {
            let x = rx + rx_i;
            if x >= w { break; }
            let idx = base + x;
            if idx >= gray.len() { break; }
            if gray[idx] < 128 {
                row_dark[ry_i] += 1;
                col_dark[rx_i] += 1;
            }
        }
    }
    RoiStats { row_dark, col_dark }
}

/// 对 gray 中 (gx, gy) 起始的 blk×blk 像素块算 Otsu 阈值。
/// 局部 Otsu：只看这个模块自己那块区域，不受环境光影响。
fn local_otsu(gray: &[u8], stride: usize, gx: usize, gy: usize, blk: usize, w: usize, h: usize) -> u8 {
    let mut hist = [0u32; 256];
    let mut count = 0u32;
    for dy in 0..blk {
        let y = gy + dy;
        if y >= h { break; }
        let base = y * stride;
        for dx in 0..blk {
            let x = gx + dx;
            if x >= w { break; }
            let idx = base + x;
            if idx < gray.len() {
                hist[gray[idx] as usize] += 1;
                count += 1;
            }
        }
    }
    if count == 0 { return 128; }
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
        if w_b == 0 { continue; }
        let w_f = count - w_b;
        if w_f == 0 { break; }
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

/// 中心 ROI 裁剪 + 投影定位 + **逐模块局部 Otsu** 采样。
pub fn sample_center_roi(
    gray: &[u8],
    width: usize,
    height: usize,
    stride: usize,
    side: usize,
    out: &mut [u8],
) -> bool {
    let stride = if stride == 0 { width } else { stride };
    if width == 0 || height == 0 || side < 8 || out.len() < side * side {
        return false;
    }
    // 完美 1:1（合成测试）：双峰阈值。
    if width == height && width == side {
        let (mut mn, mut mx) = (255u8, 0u8);
        for &p in gray {
            mn = mn.min(p);
            mx = mx.max(p);
        }
        let t = ((mn as u16 + mx as u16) >> 1) as u8;
        for (i, &p) in gray.iter().enumerate() {
            out[i] = if p < t { 1 } else { 0 };
        }
        return true;
    }
    // 中心 70% 正方形 ROI。
    let roi = width.min(height) * 7 / 10;
    if roi < 8 { return false; }
    let rx = (width.saturating_sub(roi)) / 2;
    let ry = (height.saturating_sub(roi)) / 2;
    // ① 扫描 ROI 统计行/列暗像素（定位用）。
    let stats = scan_roi(gray, stride, rx, ry, roi, width, height);
    // ② 投影定位：暗像素占比 ≥ 12% 的行/列外接矩形。
    let frac = 0.12f64;
    let row_is: Vec<bool> = stats.row_dark.iter().map(|&c| (c as f64) / (roi as f64) >= frac).collect();
    let col_is: Vec<bool> = stats.col_dark.iter().map(|&c| (c as f64) / (roi as f64) >= frac).collect();
    let y0 = row_is.iter().position(|&b| b);
    let y1 = row_is.iter().rposition(|&b| b).map(|i| i + 1);
    let x0 = col_is.iter().position(|&b| b);
    let x1 = col_is.iter().rposition(|&b| b).map(|i| i + 1);
    let (cx0, cy0, csq) = match (x0, x1, y0, y1) {
        (Some(x0), Some(x1), Some(y0), Some(y1)) if x1 > x0 && y1 > y0 => {
            let cw = x1 - x0;
            let ch = y1 - y0;
            let s = cw.min(ch);
            (x0 + (cw - s) / 2, y0 + (ch - s) / 2, s)
        }
        _ => (0, 0, roi),
    };
    if csq < 8 { return false; }
    // ③ 逐模块局部 Otsu 采样。
    // 每个目标模块对应的源像素块大小。
    let blk = (csq / side).max(1);
    for y in 0..side {
        let sy = cy0 + y * csq / side;
        let gy = ry + sy;
        for x in 0..side {
            let sx = cx0 + x * csq / side;
            let gx = rx + sx;
            let t = local_otsu(gray, stride, gx, gy, blk, width, height);
            // 模块中心像素值 vs 局部阈值
            let cy2 = gy + blk / 2;
            let cx2 = gx + blk / 2;
            if cx2 < width && cy2 < height {
                let idx = cy2 * stride + cx2;
                if idx < gray.len() {
                    out[y * side + x] = if gray[idx] < t { 1 } else { 0 };
                }
            }
        }
    }
    true
}
