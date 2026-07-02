//! AFGrid mode word (2 bytes).

pub const MODE_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModeWord(pub u16);

impl ModeWord {
    pub const DEFAULT: Self = Self(0x0800);

    pub fn to_bytes(self) -> [u8; 2] {
        self.0.to_be_bytes()
    }

    pub fn from_bytes(bytes: [u8; 2]) -> Self {
        Self(u16::from_be_bytes(bytes))
    }

    pub fn is_supported(self) -> bool {
        self.0 == Self::DEFAULT.0
    }
}
