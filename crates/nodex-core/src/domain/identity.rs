use sha2::{Digest, Sha256};

pub(crate) fn random_uuid_v7() -> Result<String, getrandom::Error> {
    let timestamp_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX);
    let mut bytes = [0_u8; 16];
    bytes[..6].copy_from_slice(&timestamp_ms.to_be_bytes()[2..]);
    getrandom::fill(&mut bytes[6..])?;
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

pub(crate) fn stable_uuid_v7(namespace: &str, role: &str, source_id: &str) -> String {
    let digest = Sha256::digest(format!("{namespace}\0{role}\0{source_id}").as_bytes());
    let hex = digest
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

#[cfg(test)]
mod tests {
    use super::{random_uuid_v7, stable_uuid_v7};

    #[test]
    fn allocates_random_uuid_v7_identities() {
        let first = random_uuid_v7().expect("UUID-v7 identity");
        let second = random_uuid_v7().expect("UUID-v7 identity");
        assert_ne!(first, second);
        assert_eq!(first.len(), 36);
        assert_eq!(&first[14..15], "7");
        assert!(matches!(&first[19..20], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn derives_stable_role_separated_uuid_v7_identities() {
        let first = stable_uuid_v7("operation-1", "database", "project-1");
        assert_eq!(
            first,
            stable_uuid_v7("operation-1", "database", "project-1")
        );
        assert_ne!(first, stable_uuid_v7("operation-1", "view", "project-1"));
        assert_eq!(first.len(), 36);
        assert_eq!(&first[14..15], "7");
        assert_eq!(&first[19..20], "8");
    }
}
