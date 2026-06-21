//! Resume / checkpoint state.
//!
//! The receiver can serialize its progress so that, after an app restart, it
//! can recognise the same session id (from incoming frames) and reload the
//! per-block received-symbol sets. RaptorQ state itself is rebuilt by feeding
//! the saved symbols back into a fresh decoder.
//!
//! Format: serde JSON (feature-gated). When the `serde` feature is off, the
//! structs still exist but `[de]serialize` are unavailable.

use qr_protocol::frame::SessionIdRaw;
use raptorq_core::ObjectMeta;
use std::collections::HashSet;
use std::vec::Vec;

/// Persistable receiver state.
#[derive(Debug, Clone)]
pub struct ResumeState {
    pub session_id: SessionIdRaw,
    pub meta: ObjectMeta,
    /// Per-block set of received ESIs.
    pub received: Vec<HashSet<u32>>,
    /// Stored symbol bytes, keyed by flat index = sbn*K_max + esi (simple).
    pub symbols: Vec<(u32, u32, Vec<u8>)>,
}

#[cfg(feature = "serde")]
mod serde_impl {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::collections::HashSet;

    #[derive(Serialize, Deserialize)]
    struct SerResume {
        session_id: SessionIdRaw,
        meta: ObjectMeta,
        received: Vec<Vec<u32>>,
        symbols: Vec<(u32, u32, Vec<u8>)>,
    }

    impl ResumeState {
        pub fn to_json(&self) -> serde_json::Result<String> {
            let ser = SerResume {
                session_id: self.session_id,
                meta: self.meta.clone(),
                received: self.received.iter().map(|s| s.iter().copied().collect()).collect(),
                symbols: self.symbols.clone(),
            };
            serde_json::to_string(&ser)
        }

        pub fn from_json(s: &str) -> serde_json::Result<Self> {
            let ser: SerResume = serde_json::from_str(s)?;
            let received = ser
                .received
                .into_iter()
                .map(|v| v.into_iter().collect::<HashSet<u32>>())
                .collect();
            Ok(Self {
                session_id: ser.session_id,
                meta: ser.meta,
                received,
                symbols: ser.symbols,
            })
        }
    }
}
