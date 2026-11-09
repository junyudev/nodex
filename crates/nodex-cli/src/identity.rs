use sha2::{Digest, Sha256};

/// A retry with the same idempotency key must name the same Page, so identities derive from it.
pub(crate) fn stable_entity_id(operation_id: &str, role: &str) -> String {
    let hex = Sha256::digest(format!("{role}\0{operation_id}").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{}-{}-7{}-8{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..15],
        &hex[15..18],
        &hex[18..30],
    )
}
