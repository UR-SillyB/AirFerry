//! Frame bytes → 2D module matrix (AFGrid when `afgrid` feature is on, else QR).

use qr_protocol::qr_render::QrMatrix;
use qr_protocol::Error;

pub fn encode_frame_matrix(frame_bytes: &[u8]) -> Result<QrMatrix, Error> {
    #[cfg(feature = "afgrid")]
    {
        return qr_protocol::afgrid::encode(frame_bytes);
    }
    #[cfg(not(feature = "afgrid"))]
    {
        qr_protocol::qr_render::encode(frame_bytes)
    }
}
