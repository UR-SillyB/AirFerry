//! Live-handle registry shared by the raw FFI surfaces (C-ABI, JNI).
//!
//! `Box::into_raw` handles cross the ABI as bare pointers, so a double
//! destroy, a use-after-destroy, or a forged value was straight undefined
//! behavior: the callee could not distinguish a live allocation from a freed
//! or never-issued one. Every pointer this crate hands out is now recorded
//! here together with its byte length (0 for opaque session handles), and the
//! destroy/free paths consult the registry first:
//!
//! - double destroy / foreign pointer → silent no-op (the allocation is
//!   untouched, so nothing is freed twice);
//! - use-after-destroy / forged handle on an accessor → the caller's
//!   null-handle error path instead of a raw dereference;
//! - buffer frees use the *registered* length, so a host passing a
//!   mismatched length can no longer size the deallocation wrong.
//!
//! The registry does NOT make concurrent misuse safe: hosts still serialize
//! calls per handle (the documented contract). It converts the stateless
//! misuse classes from UB into graceful failures. The map is expected to stay
//! tiny (a handful of sessions plus one-shot buffers), so a `Mutex<HashMap>`
//! costs ~100 ns per call — noise even on the per-frame ingest path.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn registry() -> &'static Mutex<HashMap<usize, usize>> {
    static REGISTRY: OnceLock<Mutex<HashMap<usize, usize>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record a handle (or a buffer handed to the host) with its byte length —
/// `0` for opaque session handles, the exact allocation length for buffers
/// that the host frees via a `(ptr, len)` pair. Returns `ptr` unchanged so
/// create paths stay one expression.
pub fn register<T>(ptr: *mut T, len: usize) -> *mut T {
    registry().lock().expect("ffi handle registry poisoned").insert(ptr as usize, len);
    ptr
}

/// True while `ptr` is a pointer this crate issued and has not yet released.
/// Null is never live.
pub fn is_live<T>(ptr: *const T) -> bool {
    !ptr.is_null() && registry().lock().expect("ffi handle registry poisoned").contains_key(&(ptr as usize))
}

/// Atomically withdraw `ptr`. `Some(len)` when it was live — the caller may
/// now release the allocation (buffers with the REGISTERED length, which may
/// differ from any host-supplied one). `None` for null / already-destroyed /
/// foreign pointers, which must not be touched.
pub fn take<T>(ptr: *mut T) -> Option<usize> {
    if ptr.is_null() {
        return None;
    }
    registry()
        .lock()
        .expect("ffi handle registry poisoned")
        .remove(&(ptr as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_and_double_destroy() {
        let boxed = Box::new(7u32);
        let ptr = register(Box::into_raw(boxed), 0);
        assert!(is_live(ptr));
        assert_eq!(take(ptr), Some(0));
        assert!(!is_live(ptr));
        // Second take: no-op signal, the caller must not free again.
        assert_eq!(take(ptr), None);
    }

    #[test]
    fn null_and_foreign_pointers_are_never_live() {
        assert!(!is_live(std::ptr::null::<u8>()));
        let foreign = 7usize as *mut u8;
        assert!(!is_live(foreign));
        assert_eq!(take(foreign), None);
    }

    #[test]
    fn registered_length_survives_host_length_confusion() {
        let buf = vec![1u8, 2, 3, 4];
        let len = buf.len();
        let ptr = register(buf.into_boxed_slice().as_mut_ptr(), len);
        // The authoritative length comes from the registry, not the caller.
        assert_eq!(take(ptr), Some(len));
    }
}
