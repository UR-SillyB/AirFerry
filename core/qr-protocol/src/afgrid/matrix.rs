//! Flat module grid compatible with QR `QrMatrix`.

#[derive(Debug, Clone)]
pub struct AfMatrix {
    pub modules: Vec<bool>,
    pub size: usize,
}

impl AfMatrix {
    pub fn new(size: usize) -> Self {
        Self {
            modules: vec![false; size * size],
            size,
        }
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, dark: bool) {
        self.modules[y * self.size + x] = dark;
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize) -> bool {
        self.modules[y * self.size + x]
    }

    pub fn paint_border(&mut self) {
        let s = self.size;
        if s < 3 {
            return;
        }
        for x in 0..s {
            self.set(x, 0, true);
            self.set(x, s - 1, (x % 2) == 0);
        }
        for y in 0..s {
            self.set(0, y, true);
            self.set(s - 1, y, (y % 2) == 0);
        }
        self.set(0, s - 1, true);
        self.set(s - 1, 0, false);
    }
}
