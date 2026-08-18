//! Receiver session wrapper around the AF2 state machine.
//!
//! Provides the shared API consumed by the JNI (Android) and C-ABI (Windows)
//! native bindings.

use af2::{Af2Receiver, FinalStreamVerifier, IngestEvent};
use crate::ingest_status::pack;
use std::collections::HashMap;

/// A receiver session driven by AF2.
pub struct ReceiverSession {
    inner: Af2Receiver,
    frames_seen: u64,
    received_symbols: u32,
    session_mismatch_streak: u32,
    last_chunk: Option<(u32, Vec<u8>)>,
    completed_chunks: HashMap<u32, Vec<u8>>,
    /// Chunks that ever reached ChunkReady, INCLUDING ones the host released
    /// via [`ReceiverSession::forget_chunk`] — completion is defined by this
    /// ledger, not by what is still resident.
    completed_count: u32,
    final_verifier: Option<FinalStreamVerifier>,
}

fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

impl Default for ReceiverSession {
    fn default() -> Self {
        Self::new()
    }
}

impl ReceiverSession {
    pub fn new() -> Self {
        Self {
            inner: Af2Receiver::new(),
            frames_seen: 0,
            received_symbols: 0,
            session_mismatch_streak: 0,
            last_chunk: None,
            completed_chunks: HashMap::new(),
            completed_count: 0,
            final_verifier: None,
        }
    }

    pub fn new_pending(_unused_sid: u128) -> Self {
        Self::new()
    }

    /// Ingest a frame. Returns packed status word via [`crate::ingest_status::pack`].
    pub fn ingest(&mut self, frame_bytes: &[u8]) -> u64 {
        self.frames_seen += 1;
        self.last_chunk = None;
        match self.inner.ingest(frame_bytes) {
            Ok(IngestEvent::RootLocked) => {
                self.session_mismatch_streak = 0;
                pack(self.is_complete(), true, false, false, 0, self.received_symbols)
            }
            Ok(IngestEvent::RootMismatch { streak }) => {
                self.session_mismatch_streak = streak;
                pack(self.is_complete(), false, false, false, streak, self.received_symbols)
            }
            Ok(IngestEvent::Relocked) => {
                self.session_mismatch_streak = 0;
                self.received_symbols = 0;
                self.completed_chunks.clear();
                self.completed_count = 0;
                self.last_chunk = None;
                self.final_verifier = None;
                // The explicit relock bit is the ONLY signal hosts may use to
                // discard transfer artifacts (MetaBound/InstanceSwitched can
                // legitimately carry received_symbols == 0 right after a
                // §12 resume).
                pack(false, true, false, false, 0, 0) | crate::ingest_status::RELOCKED_BIT
            }
            Ok(IngestEvent::MetaBound { .. }) => {
                pack(self.is_complete(), true, false, false, 0, self.received_symbols)
            }
            Ok(IngestEvent::InstanceSwitched) => {
                // New Broadcast Instance of the SAME transfer: the chunk ledger
                // (completed_chunks / completed_count) stays valid — canonical
                // chunks are identical across instances. last_chunk survives so
                // a host that has not drained it yet still can.
                pack(self.is_complete(), true, false, false, 0, self.received_symbols)
            }
            Ok(IngestEvent::SymbolAccepted) => {
                self.received_symbols = self.received_symbols.saturating_add(1);
                pack(self.is_complete(), true, false, false, 0, self.received_symbols)
            }
            Ok(IngestEvent::ManifestReady) => {
                self.received_symbols = self.received_symbols.saturating_add(1);
                // §11: re-verify chunks that completed BEFORE the Manifest
                // against the now-known chunk hash table; mismatched ones are
                // evicted from the ledger (the sender's next epoch re-supplies
                // them). Without this, a chunk whose META raw_hash was
                // self-consistent but contradicts the Manifest would be
                // materialized at publish time.
                self.reverify_against_manifest();
                pack(self.is_complete(), true, true, false, 0, self.received_symbols)
            }
            Ok(IngestEvent::ChunkReady { index, raw }) => {
                self.received_symbols = self.received_symbols.saturating_add(1);
                if self.completed_chunks.insert(index, raw.clone()).is_none() {
                    // A replayed chunk can complete twice after a relock; only
                    // novel completions advance the ledger.
                    self.completed_count = self.completed_count.saturating_add(1);
                }
                self.last_chunk = Some((index, raw));
                pack(self.is_complete(), true, false, true, 0, self.received_symbols)
            }
            Ok(IngestEvent::MetaRejected | IngestEvent::ChunkRejected | IngestEvent::Dropped) => {
                pack(
                    self.is_complete(),
                    false,
                    false,
                    false,
                    self.session_mismatch_streak,
                    self.received_symbols,
                )
            }
            Err(_) => crate::ingest_status::INGEST_ERROR,
        }
    }

    pub fn is_complete(&self) -> bool {
        if let Some(r) = self.inner.root() {
            self.completed_count >= r.chunk_count && r.chunk_count > 0
        } else {
            false
        }
    }

    /// Index of the chunk completed by the most recent ChunkReady frame
    /// (None if no chunk completed yet, or after the host released it).
    pub fn last_completed_chunk_index(&self) -> Option<u32> {
        self.last_chunk.as_ref().map(|(i, _)| *i)
    }

    /// Release a chunk the host has persisted. Completion tracking is
    /// unaffected (the ledger counts every ChunkReady), so memory stays
    /// bounded by one chunk while [`ReceiverSession::assemble_chunk`]
    /// simply returns None for released indices.
    pub fn forget_chunk(&mut self, index: u32) -> bool {
        self.completed_chunks.remove(&index).is_some()
    }

    /// Verify a staged raw chunk against the ROOT-bound Manifest table (§11).
    pub fn verify_chunk(&self, index: u32, raw: &[u8]) -> bool {
        self.inner.verify_chunk(index, raw)
    }

    /// Run the §13 ⑧⑨ integrity chain over the reassembled canonical stream.
    pub fn verify_final_stream(&self, stream: &[u8]) -> bool {
        self.inner.verify_final_stream(stream).is_ok()
    }

    /// Begin bounded-memory §13 ⑧⑨ verification.
    pub fn final_verify_begin(&mut self) -> bool {
        match self.inner.final_stream_verifier() {
            Ok(v) => {
                self.final_verifier = Some(v);
                true
            }
            Err(_) => {
                self.final_verifier = None;
                false
            }
        }
    }

    /// Feed the next contiguous canonical-stream block into the final gate.
    pub fn final_verify_feed(&mut self, bytes: &[u8]) -> bool {
        let Some(v) = self.final_verifier.as_mut() else {
            return false;
        };
        if v.feed(bytes).is_err() {
            self.final_verifier = None;
            return false;
        }
        true
    }

    /// Finish bounded-memory §13 ⑧⑨ verification.
    pub fn final_verify_finish(&mut self) -> bool {
        self.final_verifier
            .take()
            .is_some_and(|v| v.finish().is_ok())
    }

    /// Restore session state from stored ROOT frame bytes + completed chunk indices.
    /// Returns false (leaving the session untouched) when the stored ROOT fails
    /// the full parse + id-binding path.
    pub fn resume(&mut self, root_frame_bytes: &[u8], completed: &[u32]) -> bool {
        self.final_verifier = None;
        match self.inner.resume(root_frame_bytes, completed) {
            Ok(accepted) => {
                // Only indices actually inside the transfer count (af2 drops
                // out-of-range entries silently — the ledger must not).
                self.completed_count = accepted as u32;
                true
            }
            Err(_) => false,
        }
    }

    /// §11 re-verification pass over the resident completed chunks. Chunks the
    /// host already released via [`forget_chunk`] are NOT resident here; hosts
    /// re-verify those against their spill via the `verify_chunk` FFI before
    /// publishing.
    fn reverify_against_manifest(&mut self) {
        let evicted: Vec<u32> = self
            .completed_chunks
            .iter()
            .filter(|(index, raw)| !self.inner.verify_chunk(**index, raw))
            .map(|(index, _)| *index)
            .collect();
        for index in evicted {
            self.completed_chunks.remove(&index);
            self.invalidate_chunk(index);
            self.completed_count = self.completed_count.saturating_sub(1);
            if self.last_chunk.as_ref().is_some_and(|(i, _)| *i == index) {
                self.last_chunk = None;
            }
        }
    }

    /// Evict one chunk from BOTH ledgers (engine map + core chunk_done), so
    /// the sender's next epoch can re-supply it. Also exposed for hosts that
    /// re-verify spilled chunks via the FFI. `completed_count` follows the
    /// eviction — otherwise a host-side invalidation followed by the chunk's
    /// re-completion could never re-declare completion.
    pub fn invalidate_chunk(&mut self, index: u32) -> bool {
        let removed_engine = self.completed_chunks.remove(&index).is_some();
        let removed_core = self.inner.invalidate_chunk(index);
        if removed_engine || removed_core {
            self.completed_count = self.completed_count.saturating_sub(1);
            if self.last_chunk.as_ref().is_some_and(|(i, _)| *i == index) {
                self.last_chunk = None;
            }
        }
        removed_engine || removed_core
    }

    pub fn snapshot_json(&self) -> String {
        match self.inner.root() {
            Some(r) => {
                let tid_hex: String = r.transfer().iter().map(|b| format!("{b:02x}")).collect();
                let cid_hex: String = r.content_id.iter().map(|b| format!("{b:02x}")).collect();
                // Canonical ROOT frame re-encode (deterministic: same record,
                // same T ⇒ byte-identical to the wire frame that locked the
                // session). Hosts persist it in their §12 ledger and feed it
                // back through `resume` after a restart.
                let root_frame_hex = af2::Af2Frame {
                    frame_type: af2::FrameType::Root,
                    object_id: r.transfer(),
                    sbn: 0,
                    esi: 0,
                    body: r.encode().unwrap_or_default(),
                    t: self.inner.symbol_size(),
                }
                .to_bytes()
                .map(|b| b.iter().map(|x| format!("{x:02x}")).collect::<String>())
                .unwrap_or_default();
                let mut entries_json = String::from("[");
                if let Some(m) = self.inner.manifest() {
                    // §7.2 save-time sanitization: hosts materialize with
                    // `save_path`; canonical `path` stays the verification
                    // identity. Windows-safe component rules are also used on
                    // Android: ContentStore/SAF exports may target FAT/exFAT or
                    // cloud providers whose filename rules are stricter than
                    // Android's internal ext4 storage. Using the same portable
                    // save-name set also makes collision disambiguation
                    // deterministic across all three receiver hosts.
                    let windows_rules = cfg!(windows)
                        || cfg!(target_arch = "wasm32")
                        || cfg!(target_os = "android");
                    let paths: Vec<&str> = m.entries.iter().map(|e| e.path.as_str()).collect();
                    let save_paths = af2::sanitize_save_paths(&paths, windows_rules);
                    for (i, (e, save)) in m.entries.iter().zip(save_paths.iter()).enumerate() {
                        if i > 0 {
                            entries_json.push(',');
                        }
                        entries_json.push_str(&format!(
                            r#"{{"kind":{},"path":"{}","save_path":"{}","offset":{},"size":{}}}"#,
                            e.kind,
                            escape_json(&e.path),
                            escape_json(save),
                            e.content_offset,
                            e.content_size
                        ));
                    }
                }
                entries_json.push(']');
                format!(
                    concat!(
                        r#"{{"schema_version":2,"meta_confirmed":true,"transfer_id_hex":"{}","#,
                        r#""content_id_hex":"{}","root_frame_hex":"{}","total_raw_size":{},"#,
                        r#""entry_count":{},"chunk_count":{},"chunk_raw_size":{},"symbol_size":{},"#,
                        r#""legacy_peer_frames":{},"entries":{}}}"#
                    ),
                    tid_hex,
                    cid_hex,
                    root_frame_hex,
                    r.total_raw_size,
                    r.entry_count,
                    r.chunk_count,
                    r.chunk_raw_size,
                    self.inner.symbol_size(),
                    self.inner.legacy_peer_frames(),
                    entries_json,
                )
            }
            None => {
                r#"{"schema_version":2,"meta_confirmed":false,"transfer_id_hex":"","content_id_hex":"","root_frame_hex":"","total_raw_size":0,"entry_count":0,"chunk_count":0,"chunk_raw_size":0,"symbol_size":0,"legacy_peer_frames":0,"entries":[]}"#.to_string()
            }
        }
    }

    pub fn progress(&self) -> crate::Progress {
        let root = self.inner.root();
        // Symbol totals are estimates from the observed wire T: the exact
        // per-chunk K is only known while a chunk META is live, and chunk
        // compression shrinks the encoded size, so raw-size/T is an upper
        // bound that keeps decoded_fraction honest.
        let t = {
            let s = self.inner.symbol_size();
            (if s == 0 { 1024 } else { s }) as u32
        };
        let est_symbols = |chunks: u32| -> u32 {
            root.map(|r| {
                u32::try_from(
                    (u64::from(chunks) * u64::from(r.chunk_raw_size)).div_ceil(u64::from(t)),
                )
                .unwrap_or(u32::MAX)
            })
            .unwrap_or(0)
        };
        let total_symbols = root
            .map(|r| {
                u32::try_from(r.total_raw_size.div_ceil(u64::from(t))).unwrap_or(u32::MAX)
            })
            .unwrap_or(0);
        let decoded_symbols = est_symbols(self.completed_count).min(total_symbols);
        crate::Progress {
            decoded_symbols,
            total_symbols,
            symbol_size: t,
            received_symbols: self.received_symbols,
            frames_seen: self.frames_seen,
            frames_duplicate: 0,
            frames_corrupt: 0,
            decoded_blocks: self.completed_count,
            total_blocks: root.map(|r| r.chunk_count).unwrap_or(0),
            meta_confirmed: root.is_some(),
            session_mismatch_streak: self.session_mismatch_streak,
        }
    }

    pub fn assemble_chunk(&mut self, index: u32) -> Option<Vec<u8>> {
        self.completed_chunks.get(&index).cloned()
    }

    /// Reassemble all chunks in order into the full canonical stream.
    pub fn assemble_all(&self) -> Option<Vec<u8>> {
        let root = self.inner.root()?;
        if self.completed_count < root.chunk_count {
            return None;
        }
        let mut out = Vec::with_capacity(root.total_raw_size as usize);
        for i in 0..root.chunk_count {
            let chunk = self.completed_chunks.get(&i)?;
            out.extend_from_slice(chunk);
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use af2::frame::{Af2Frame, FrameType};
    use af2::id::{hash, object_id, KIND_FILE};
    use af2::meta::{ObjectMetaRecord, FEC_ID_RAPTORQ, ROLE_CHUNK};
    use af2::receiver::object_meta_from_oti;
    use af2::sender::{Af2Sender, SenderConfig};

    /// IngestStatus bits mirror ingest_status::pack.
    fn bits(word: u64) -> (bool, bool, bool, bool) {
        (
            word & 1 != 0,                // complete
            word >> 1 & 1 != 0,           // accepted
            word >> 2 & 1 != 0,           // manifest_ready
            word >> 3 & 1 != 0,           // chunk_ready
        )
    }

    /// Craft a self-consistent CHUNK object whose raw bytes (Y) differ from
    /// what the real Manifest's chunk table will announce (X): it passes the
    /// META-time binding and the raw_hash check at completion time, and only
    /// the post-manifest re-verification can catch it.
    fn craft_foreign_chunk_frames(
        tid: [u8; 16],
        y: &[u8],
        t: usize,
    ) -> (Vec<u8>, Vec<Vec<u8>>) {
        let (codec, encoded) = af2::chunk::encode_chunk(y);
        let enc = raptorq::Encoder::with_defaults(&encoded, t as u16);
        let oti = enc.get_config().serialize();
        let meta_obj = object_meta_from_oti(&oti, 32 << 20).unwrap();
        let encoded_hash = hash(&encoded);
        let oid = object_id(
            &tid,
            ROLE_CHUNK,
            0,
            codec,
            FEC_ID_RAPTORQ,
            &meta_obj.oti_bytes,
            &encoded_hash,
        );
        let record = ObjectMetaRecord {
            role: ROLE_CHUNK,
            transfer_id: tid,
            object_index: 0,
            codec_id: codec,
            fec_id: FEC_ID_RAPTORQ,
            oti: meta_obj.oti_bytes,
            raw_hash: hash(y),
            encoded_hash,
            extensions: vec![],
        };
        let meta_frame = Af2Frame {
            frame_type: FrameType::ObjectMeta,
            object_id: oid,
            sbn: 0,
            esi: 0,
            body: record.encode().unwrap(),
            t,
        }
        .to_bytes()
        .unwrap();
        let symbols = enc
            .get_encoded_packets(0)
            .iter()
            .map(|pkt| {
                Af2Frame {
                    frame_type: FrameType::Symbol,
                    object_id: oid,
                    sbn: pkt.payload_id().source_block_number(),
                    esi: pkt.payload_id().encoding_symbol_id(),
                    body: pkt.data().to_vec(),
                    t,
                }
                .to_bytes()
                .unwrap()
            })
            .collect();
        (meta_frame, symbols)
    }

    #[test]
    fn resumed_session_first_meta_is_not_relock() {
        // Regression (§12): after resume() the received-symbol counter is 0, so
        // the first ACCEPTED frame of the resumed session — always a
        // MANIFEST/CHUNK META, since same-transfer ROOTs are dropped — carries
        // exactly the `accepted && received_symbols == 0` signature hosts
        // historically misread as RELOCK, destroying the resumed spill/ledger.
        // The explicit RELOCKED_BIT must be the only discriminator.
        let mut sender = Af2Sender::new(
            vec![
                (KIND_FILE, "a.bin".to_string(), vec![0x41u8; 2_000_000]),
                (KIND_FILE, "b.bin".to_string(), vec![0x42u8; 500_000]),
            ],
            SenderConfig {
                chunk_raw_size: 1 << 20,
                ..SenderConfig::default()
            },
        )
        .unwrap();
        let root = sender.next_frame().unwrap(); // bootstrap ROOT

        // Fresh lock: accepted, no relock bit.
        let mut session = ReceiverSession::new();
        let word = session.ingest(&root);
        assert!(word & (1 << 1) != 0, "fresh ROOT locks + accepts");
        assert_eq!(word & crate::ingest_status::RELOCKED_BIT, 0);

        // §12 resume into a fresh session with one ledger bit.
        let mut resumed = ReceiverSession::new();
        assert!(resumed.resume(&root, &[0]));

        // Duplicate same-transfer ROOT: dropped, never a relock.
        let word = resumed.ingest(&root);
        assert_eq!(word & (1 << 1), 0, "duplicate ROOT must be dropped");
        assert_eq!(word & crate::ingest_status::RELOCKED_BIT, 0);

        // Feed the broadcast: the first accepted frame must NOT set the relock
        // bit even though its received count is still 0 — and the resumed
        // transfer must still be able to complete.
        let mut saw_first_accepted = false;
        let mut completed = false;
        for _ in 0..20_000 {
            let word = resumed.ingest(&sender.next_frame().unwrap());
            if !saw_first_accepted && word & (1 << 1) != 0 {
                saw_first_accepted = true;
                assert_eq!(
                    (word >> 32) & 0xFFFF_FFFF,
                    0,
                    "first accepted frame after resume still has a zero counter"
                );
                assert_eq!(
                    word & crate::ingest_status::RELOCKED_BIT,
                    0,
                    "MetaBound after resume must NOT look like a relock"
                );
            }
            if word & 1 != 0 {
                completed = true;
                break;
            }
        }
        assert!(saw_first_accepted);
        assert!(completed, "resumed session (chunk 0 from ledger) must complete");

        // A genuinely foreign transfer must set the bit — after the ≥3-frame
        // mismatch debounce (a single foreign ROOT only counts a streak).
        let mut foreign = Af2Sender::new(
            vec![(KIND_FILE, "z.bin".to_string(), vec![0x5Au8; 3000])],
            SenderConfig {
                chunk_raw_size: 1 << 20,
                ..SenderConfig::default()
            },
        )
        .unwrap();
        let foreign_root = foreign.next_frame().unwrap();
        let mut word = 0;
        for _ in 0..3 {
            word = resumed.ingest(&foreign_root);
        }
        assert!(word & (1 << 1) != 0, "foreign ROOT relocks + accepts");
        assert_ne!(
            word & crate::ingest_status::RELOCKED_BIT,
            0,
            "genuine relock must set RELOCKED_BIT"
        );
    }

    #[test]
    fn manifest_ready_evicts_and_resupplies_poisoned_chunk() {
        let x = vec![0x58u8; 3000];
        let y = vec![0x59u8; 3000];
        let mut sender = Af2Sender::new(
            vec![(KIND_FILE, "x.bin".to_string(), x.clone())],
            SenderConfig::default(),
        )
        .unwrap();

        let mut session = ReceiverSession::new();
        // 1. Lock via the sender's first frame (bootstrap ROOT).
        let (complete, accepted, _, _) = bits(session.ingest(&sender.next_frame().unwrap()));
        assert!(accepted && !complete);

        // 2. Complete the POISONED chunk (Y) before any manifest arrives.
        let (meta_frame, symbols) = craft_foreign_chunk_frames(sender.transfer_id(), &y, 1024);
        let (_, _, _, chunk_ready) = bits(session.ingest(&meta_frame));
        assert!(!chunk_ready);
        let mut poisoned_done = false;
        for f in &symbols {
            let (complete, _, _, chunk_ready) = bits(session.ingest(f));
            if chunk_ready {
                poisoned_done = true;
                assert!(complete, "1/1 chunks done ⇒ complete even pre-manifest");
                break;
            }
        }
        assert!(poisoned_done);
        assert_eq!(session.assemble_chunk(0).as_deref(), Some(y.as_slice()));

        // 3. Keep feeding the real broadcast until the Manifest arrives.
        let mut manifest_seen = false;
        for _ in 0..4000 {
            let (complete, _, manifest_ready, _) = bits(session.ingest(&sender.next_frame().unwrap()));
            if manifest_ready {
                manifest_seen = true;
                // §11: the poisoned chunk must be evicted from BOTH ledgers.
                assert!(!complete, "eviction must drop completion");
                assert!(session.assemble_chunk(0).is_none());
                break;
            }
        }
        assert!(manifest_seen, "recurring manifest interleave must deliver the manifest");

        // 4. The sender's next epoch re-supplies the real chunk (X) — the core
        //    chunk_done bit was invalidated, so the META binds again.
        let mut recovered = false;
        for _ in 0..8000 {
            let (complete, _, _, chunk_ready) = bits(session.ingest(&sender.next_frame().unwrap()));
            if chunk_ready {
                assert_eq!(session.assemble_chunk(0).as_deref(), Some(x.as_slice()));
                assert!(complete);
                recovered = true;
                break;
            }
        }
        assert!(recovered, "evicted chunk must be re-supplied and complete");

        // 5. Final gate over the reassembled stream.
        let stream = session.assemble_all().unwrap();
        assert_eq!(stream, x);
        assert!(session.verify_final_stream(&stream));
    }

    #[test]
    fn complete_before_manifest_stays_recoverable_while_ingesting() {
        // Host contract (§11/§13): the core may announce is_complete() while
        // the Manifest is still undecoded — a §12 resume whose ledger already
        // holds every chunk, or a small transfer whose last chunk beats the
        // manifest interleave. Hosts must NOT stop ingesting on that first
        // complete=true: verify_chunk stays false (no Manifest table) and the
        // snapshot carries no entry table, so staging can only fail. Keeping
        // the feed alive delivers the Manifest (recurring META + interleave
        // symbols), completion persists, and staging then succeeds.
        let data = vec![0x5Au8; 3000];
        let mut sender = Af2Sender::new(
            vec![(KIND_FILE, "race.bin".to_string(), data.clone())],
            SenderConfig::default(),
        )
        .unwrap();
        let root_frame = sender.next_frame().unwrap(); // bootstrap ROOT

        // §12 resume with every chunk already committed: complete, no manifest.
        let mut session = ReceiverSession::new();
        assert!(session.resume(&root_frame, &[0]));
        assert!(session.is_complete(), "1/1 ledger chunks ⇒ complete pre-manifest");
        assert!(
            !session.snapshot_json().contains("\"entries\":[{"),
            "snapshot has no entry table before the manifest decodes"
        );
        assert!(
            !session.verify_chunk(0, &data),
            "verify_chunk is false without the manifest — staging must wait"
        );

        // The host keeps ingesting (the fixed behavior): the manifest arrives…
        let mut manifest_ready = false;
        for _ in 0..4000 {
            let f = sender.next_frame().unwrap();
            let (_, _, manifest, _) = bits(session.ingest(&f));
            if manifest {
                manifest_ready = true;
                break;
            }
        }
        assert!(manifest_ready, "the recurring manifest interleave must deliver it");
        // …completion persists across the wait, and staging is now possible.
        assert!(session.is_complete(), "completion must survive the manifest wait");
        assert!(session.verify_chunk(0, &data));
        assert!(session.verify_final_stream(&data));
    }

    #[test]
    fn resume_restores_completion_state() {
        let data = vec![0x77u8; 2500];
        let mut sender = Af2Sender::new(
            vec![(KIND_FILE, "r.bin".to_string(), data)],
            SenderConfig::default(),
        )
        .unwrap();
        let root_frame = sender.next_frame().unwrap(); // bootstrap ROOT
        let mut session = ReceiverSession::new();
        assert!(session.resume(&root_frame, &[0]));
        assert!(session.is_complete(), "ledger says 1/1");
        assert!(
            session.assemble_chunk(0).is_none(),
            "resumed chunks are host-persisted, not resident"
        );
        // Tampered resume input is rejected wholesale.
        let mut bad = root_frame.clone();
        let n = bad.len();
        bad[n - 5] ^= 0xFF;
        let mut fresh = ReceiverSession::new();
        assert!(!fresh.resume(&bad, &[0]));
    }

    #[test]
    fn snapshot_root_frame_hex_round_trips_into_resume() {
        // The ledger persists the snapshot's canonical ROOT re-encode; feeding
        // it back through resume() must lock byte-identically.
        let data = vec![0x66u8; 2500];
        let mut sender = Af2Sender::new(
            vec![(KIND_FILE, "hex.bin".to_string(), data)],
            SenderConfig::default(),
        )
        .unwrap();
        let root_frame = sender.next_frame().unwrap();
        let mut session = ReceiverSession::new();
        session.ingest(&root_frame);
        let snap = session.snapshot_json();
        assert!(snap.contains("\"root_frame_hex\":\""));
        let hex = snap
            .split("\"root_frame_hex\":\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or_default();
        assert!(!hex.is_empty());
        let decoded: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        assert_eq!(decoded, root_frame, "canonical re-encode must be byte-identical");
        let mut resumed = ReceiverSession::new();
        assert!(resumed.resume(&decoded, &[]));
    }

    #[test]
    fn host_invalidate_chunk_decrements_completion() {
        // The host-side spill re-verification failure path: invalidate must
        // drop completion so a re-supplied chunk can complete again (the
        // pre-fix engine kept completed_count, wedging completion true).
        let data = vec![0x11u8; 2500];
        let mut sender = Af2Sender::new(
            vec![(KIND_FILE, "inv.bin".to_string(), data)],
            SenderConfig::default(),
        )
        .unwrap();
        let mut session = ReceiverSession::new();
        session.ingest(&sender.next_frame().unwrap()); // lock
        let mut completed = false;
        for _ in 0..8000 {
            let f = sender.next_frame().unwrap();
            let (_, _, _, chunk_ready) = bits(session.ingest(&f));
            if chunk_ready {
                completed = true;
                break;
            }
        }
        assert!(completed, "chunk must complete");
        assert!(session.is_complete());
        // Host drained + forgot the chunk, then re-verification failed.
        session.forget_chunk(0);
        assert!(session.invalidate_chunk(0));
        assert!(!session.is_complete(), "invalidation must drop completion");
        // Re-supply: the sender's next epoch replays the chunk's META +
        // source symbols; completion must be reachable again.
        let mut recompleted = false;
        for _ in 0..12_000 {
            let (complete, _, _, chunk_ready) = bits(session.ingest(&sender.next_frame().unwrap()));
            if chunk_ready {
                assert!(complete, "re-supplied chunk must complete again");
                recompleted = true;
                break;
            }
        }
        assert!(recompleted);
    }
}
