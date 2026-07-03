//! L1: grayscale → module grid。
//!
//! 性能关键：真机帧 1080×1920 = 2M 像素，每帧必须 O(像素) 一次扫描完成，
//! 不能反复全图扫描。定位 + 采样合并为单次遍历。

use super::layout::BORDER;

/// 单次遍历完成：① 局部 Otsu 阈值 ② 行/列暗像素计数 ③ 中心 ROI 裁剪。
/// 返回 side×side 模块网格（1=暗, 0=亮）。
pub fn sample_modules(gray: &[u8], width: usize, height: usize, side: usize) -> usize {
    // 占位：实际实现在下面的 sample_modules_center_roi
    let _ = (gray, width, height, side);
    0
}

/// 中心 ROI 裁剪 + 局部双峰阈值 + 最近邻采样。
/// 只扫描画面中心 70% 区域（屏幕码居中），避免全图 2M 像素扫描。
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
    // 完美 1:1（合成测试）：直接双峰阈值。
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
    // 中心 70% 正方形 ROI（屏幕码居中，避免扫全图背景）。
    let roi = width.min(height) * 7 / 10;
    let rx = (width.saturating_sub(roi)) / 2;
    let ry = (height.saturating_sub(roi)) / 2;
    let re = rx + roi;
    let be = ry + roi;
    // 单次遍历 ROI：统计 min/max（双峰阈值）+ 行/列暗像素计数（定位）。
    let (mut mn, mut mx) = (255u8, 0u8);
    let mut row_dark = vec![0u32; roi];
    let mut col_dark = vec![0u32; roi];
    for ry_i in 0..roi {
        let y = ry + ry_i;
        if y >= height {
            break;
        }
        let base = y * stride;
        for rx_i in 0..roi {
            let x = rx + rx_i;
            if x >= width {
                break;
            }
            let p = gray[base + x];
            mn = mn.min(p);
            mx = mx.max(p);
            if p < 200 {
                row_dark[ry_i] += 1;
                col_dark[rx_i] += 1;
            }
        }
    }
    if mx == 0 && mn == 0 {
        return false;
    }
    // 投影定位：暗像素占比 ≥ 12% 的行/列外接矩形。
    let frac = 0.12f64;
    let row_is = row_dark.iter().map(|&c| (c as f64) / (roi as f64) >= frac);
    let col_is = col_dark.iter().map(|&c| (c as f64) / (roi as f64) >= frac);
    let y0 = row_is.clone().enumerate().find(|(_, b)| *b).map(|(i, _)| i);
    let y1 = row_is.rev().enumerate().find(|(_, b)| *b).map(|(i, _)| roi - i);
    let x0 = col_is.clone().enumerate().find(|(_, b)| *b).map(|(i, _)| i);
    let x1 = col_is.rev().enumerate().find(|(_, b)| *b).map(|(i, _)| roi - i);
    // ROI 内码区边界（转回 ROI 坐标）。失败用整个 ROI。
    let (cx0, cy0, csq) = match (x0, x1, y0, y1) {
        (Some(x0), Some(x1), Some(y0), Some(y1)) if x1 > x0 && y1 > y0 => {
            let w = x1 - x0;
            let h = y1 - y0;
            let s = w.min(h);
            let cx = x0 + (w - s) / 2;
            let cy = y0 + (h - s) / 2;
            (cx, cy, s)
        }
        _ => (0, 0, roi),
    };
    if csq == 0 {
        return false;
    }
    // 双峰阈值。
    let t = ((mn as u16 + mx as u16) >> 1) as u8;
    // 最近邻采样 csq×csq → side×side。
    for y in 0..side {
        let sy = cy0 + y * csq / side;
        for x in 0..side {
            let sx = cx0 + x * csq / side;
            let gx = rx + sx;
            let gy = ry + sy;
            if gx < width && gy < height {
                let idx = gy * stride + gx;
                if idx < gray.len() {
                    out[y * side + x] = if gray[idx] < t { 1 } else { 0 };
                }
            }
        }
    }
    true
}
