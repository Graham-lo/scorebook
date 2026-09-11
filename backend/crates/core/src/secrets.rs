//! Secret values are deliberately neither Debug nor Serialize.
use crate::ports::AppFuture;
pub struct SecretBytes(pub zeroize::Zeroizing<Vec<u8>>);
pub trait SecretStore: Send + Sync {
    fn load(&self, reference: String) -> AppFuture<'_, SecretBytes>;
    fn store(&self, reference: String, value: SecretBytes) -> AppFuture<'_, ()>;
}
