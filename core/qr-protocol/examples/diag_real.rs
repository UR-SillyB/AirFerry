//! 用真机 profile 数据复现定位逻辑，离线调试。
fn main() {
    // 第二帧 profile（码居中但小）
    let row: [u32; 20] = [0,0,0,2,23,20,22,24,19,24,21,24,22,22,25,9,0,0,0,0];
    let col: [u32; 20] = [0,0,25,23,25,24,25,24,23,18,23,20,22,3,0,0,0,5,0,0];
    let frac = 0.12f64;
    let roi = 20;
    // 定位：>= 12% 的行/列外接矩形
    let row_is: Vec<bool> = row.iter().map(|&c| (c as f64) / 100.0 >= frac).collect();
    let col_is: Vec<bool> = col.iter().map(|&c| (c as f64) / 100.0 >= frac).collect();
    let y0 = row_is.iter().position(|&b| b);
    let y1 = row_is.iter().rposition(|&b| b).map(|i| i + 1);
    let x0 = col_is.iter().position(|&b| b);
    let x1 = col_is.iter().rposition(|&b| b).map(|i| i + 1);
    println!("row_is: {:?}", row_is);
    println!("col_is: {:?}", col_is);
    println!("y0={:?} y1={:?} x0={:?} x1={:?}", y0, y1, x0, x1);
    match (x0, x1, y0, y1) {
        (Some(x0), Some(x1), Some(y0), Some(y1)) => {
            let w = x1 - x0;
            let h = y1 - y0;
            let s = w.min(h);
            let cx = x0 + (w - s) / 2;
            let cy = y0 + (h - s) / 2;
            println!("定位码区: x0={} x1={} y0={} y1={} w={} h={} sq={} cx={} cy={}", x0, x1, y0, y1, w, h, s, cx, cy);
            println!("码区占 ROI: {:.0}% x {:.0}%", w as f64/roi as f64*100.0, h as f64/roi as f64*100.0);
            // 如果码区是 12×11，但 side=227，csq=11
            // 采样时 blk = csq/side = 11/227 ≈ 0 → max(1) = 1
            // 即每个模块只取 1 个源像素！局部 Otsu 在 1×1 块上无意义。
            let side = 227;
            let blk = (s * (roi as usize / 20) / side).max(1); // 转换回实际像素
            println!("side={} blk(源像素/模块)={}", side, blk);
            println!("问题：码区 {} 个 ROI 单元 → 实际约 {} 像素 → /{} side = {} 像素/模块",
                s, s * (1008/20), side, s * (1008/20) / side);
        }
        _ => println!("定位失败"),
    }
}
