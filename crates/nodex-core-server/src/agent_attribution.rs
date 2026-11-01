//! Agent attribution credentials. The desktop Host verifies an Agent execution and
//! asks Core to vouch for its product Session; Core signs that claim with a key that
//! never leaves this process. A caller presenting the credential makes content
//! changes that name the Session's Agent. Restarting Core retires every credential;
//! the Host issues a fresh one for each Agent Turn.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use nodex_core_contracts::BoundAgentAttribution;
use nodex_core_contracts::agent::AgentBackendKind;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const PREFIX: &str = "nxa1";
/// Longer than any one Turn; a credential left in a shell binding expires on its own.
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_CREDENTIAL_BYTES: usize = 1_024;

pub(crate) struct AgentAttributionKey([u8; 32]);

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Claim {
    session_id: String,
    backend: AgentBackendKind,
    issued_at: u64,
}

impl AgentAttributionKey {
    pub(crate) fn generate() -> Result<Self, getrandom::Error> {
        let mut key = [0_u8; 32];
        getrandom::fill(&mut key)?;
        Ok(Self(key))
    }

    fn mac(&self) -> Hmac<Sha256> {
        Hmac::<Sha256>::new_from_slice(&self.0).expect("HMAC accepts a 32-byte key")
    }

    pub(crate) fn issue(&self, session_id: &str, backend: AgentBackendKind) -> String {
        self.issue_at(session_id, backend, now_seconds())
    }

    fn issue_at(&self, session_id: &str, backend: AgentBackendKind, issued_at: u64) -> String {
        let claim = Claim {
            session_id: session_id.to_owned(),
            backend,
            issued_at,
        };
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claim).expect("claims always encode"));
        let mut mac = self.mac();
        mac.update(PREFIX.as_bytes());
        mac.update(b".");
        mac.update(payload.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{PREFIX}.{payload}.{signature}")
    }

    /// The attributed Session, or None for a credential this Core did not issue,
    /// one that was altered, or one past its age.
    pub(crate) fn verify(&self, credential: &str) -> Option<BoundAgentAttribution> {
        self.verify_at(credential, now_seconds())
    }

    fn verify_at(&self, credential: &str, now: u64) -> Option<BoundAgentAttribution> {
        if credential.len() > MAX_CREDENTIAL_BYTES {
            return None;
        }
        let mut parts = credential.split('.');
        let (Some(PREFIX), Some(payload), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        let mut mac = self.mac();
        mac.update(PREFIX.as_bytes());
        mac.update(b".");
        mac.update(payload.as_bytes());
        mac.verify_slice(&URL_SAFE_NO_PAD.decode(signature).ok()?)
            .ok()?;
        let claim: Claim = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
        let age = now.checked_sub(claim.issued_at)?;
        (age <= MAX_AGE.as_secs()).then_some(BoundAgentAttribution {
            session_id: claim.session_id,
            backend: claim.backend,
        })
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attribution(session_id: &str, backend: AgentBackendKind) -> BoundAgentAttribution {
        BoundAgentAttribution {
            session_id: session_id.to_owned(),
            backend,
        }
    }

    #[test]
    fn verifies_only_unaltered_credentials_from_the_same_core_within_their_age() {
        let key = AgentAttributionKey::generate().unwrap();
        let issued = key.issue_at("session-a", AgentBackendKind::Claude, 1_000);
        assert_eq!(
            key.verify_at(&issued, 1_000),
            Some(attribution("session-a", AgentBackendKind::Claude))
        );
        assert_eq!(
            key.verify_at(&issued, 1_000 + MAX_AGE.as_secs()),
            Some(attribution("session-a", AgentBackendKind::Claude))
        );
        assert_eq!(key.verify_at(&issued, 1_001 + MAX_AGE.as_secs()), None);
        assert_eq!(key.verify_at(&issued, 999), None);

        let other_core = AgentAttributionKey::generate().unwrap();
        assert_eq!(other_core.verify_at(&issued, 1_000), None);

        let [prefix, _, signature] = issued.split('.').collect::<Vec<_>>()[..] else {
            panic!("credential has three parts");
        };
        let forged_payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&Claim {
                session_id: "session-b".to_owned(),
                backend: AgentBackendKind::Claude,
                issued_at: 1_000,
            })
            .unwrap(),
        );
        for forged in [
            format!("{prefix}.{forged_payload}.{signature}"),
            format!("nxa2.{}", issued.split_once('.').unwrap().1),
            format!("{issued}.extra"),
            issued.replace('.', ""),
            String::new(),
            "x".repeat(MAX_CREDENTIAL_BYTES + 1),
        ] {
            assert_eq!(key.verify_at(&forged, 1_000), None, "{forged}");
        }
    }
}
