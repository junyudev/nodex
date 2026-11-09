//! What each Member's desktops last said about their person, for the Space host's phone
//! notifications. Reports are ephemeral: they expire, and a restart forgets them, so a Member
//! nobody vouches for counts as away and a guess never silences their phones.
use super::*;
use nodex_core_contracts::{RemotePrincipal, team::*};
use std::collections::HashMap;

/// A report counts for this long after it arrives; desktops send one every 30 seconds.
const REPORT_LIFETIME: Duration = Duration::from_secs(90);
/// No more reports than this many Devices are kept, expired ones first to go.
const MAX_REPORTS: usize = 4_096;
/// Longer than this without input is far past any away threshold.
const MAX_IDLE_MS: u32 = 24 * 60 * 60 * 1_000;

struct Report {
    principal: RemotePrincipal,
    received: Instant,
    /// Time since the person last used this Device, as it was when the report arrived.
    idle: Option<Duration>,
}

#[derive(Default)]
pub(crate) struct MemberPresenceRegistry {
    reports: Mutex<HashMap<String, Report>>,
}

impl MemberPresenceRegistry {
    fn record(&self, principal: RemotePrincipal, idle: Option<Duration>, now: Instant) -> bool {
        let Ok(mut reports) = self.reports.lock() else {
            return false;
        };
        if reports.len() >= MAX_REPORTS && !reports.contains_key(&principal.device_id) {
            reports.retain(|_, report| now.duration_since(report.received) < REPORT_LIFETIME);
            if reports.len() >= MAX_REPORTS {
                return false;
            }
        }
        reports.insert(
            principal.device_id.clone(),
            Report {
                principal,
                received: now,
                idle,
            },
        );
        true
    }

    /// The least time since one of the Member's Devices that vouches for them now was used: a
    /// fresh report, with an unlocked screen, from a Device and session that are still active.
    fn idle(
        &self,
        member: &str,
        now: Instant,
        active: impl Fn(&RemotePrincipal) -> bool,
    ) -> Option<Duration> {
        let reports = self.reports.lock().ok()?;
        reports
            .values()
            .filter(|report| {
                report.principal.member_id == member
                    && now.duration_since(report.received) < REPORT_LIFETIME
            })
            .filter_map(|report| {
                let idle = report.idle?;
                active(&report.principal).then(|| idle + now.duration_since(report.received))
            })
            .min()
    }
}

/// A Member's own Device reports its person's presence; it cannot report for another Device.
pub(crate) async fn report(
    State(state): State<Arc<ServerState>>,
    principal: Option<Extension<RemotePrincipal>>,
    Json(report): Json<MemberPresenceReport>,
) -> Result<Json<bool>, ApiError> {
    let Some(Extension(principal)) = principal else {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "A verified Member is required",
        ));
    };
    if report.idle_ms.is_some_and(|idle| idle > MAX_IDLE_MS) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Presence idle time exceeds its bound",
        ));
    }
    let idle = report
        .idle_ms
        .map(|idle| Duration::from_millis(idle.into()));
    Ok(Json(state.member_presence.record(
        principal,
        idle,
        Instant::now(),
    )))
}

/// The local Host reads a Member's presence under its lease; revoked Devices never count.
pub(crate) async fn read(
    State(state): State<Arc<ServerState>>,
    remote: Option<Extension<remote::RemotePeer>>,
    Json(request): Json<MemberPresenceRequest>,
) -> Result<Json<MemberPresence>, ApiError> {
    if remote.is_some() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "The local Host is required",
        ));
    }
    state.host_bridge.check_lease(&request.token)?;
    let reader = state.clone();
    let idle = tokio::task::spawn_blocking(move || {
        reader
            .member_presence
            .idle(&request.member_id, Instant::now(), |principal| {
                reader.membership.active(principal)
            })
    })
    .await
    .map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Member presence is unavailable",
        )
    })?;
    Ok(Json(MemberPresence {
        idle_ms: idle.map(|idle| u64::try_from(idle.as_millis()).unwrap_or(u64::MAX)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodex_core_contracts::library::MemberRole;

    fn device(member: &str, device: &str) -> RemotePrincipal {
        RemotePrincipal {
            space_id: "space".into(),
            member_id: member.into(),
            device_id: device.into(),
            session_id: format!("session:{device}"),
            role: MemberRole::Member,
        }
    }

    #[test]
    fn a_member_is_present_while_one_live_desktop_vouches_for_them() {
        let registry = MemberPresenceRegistry::default();
        let start = Instant::now();
        let all = |_: &RemotePrincipal| true;
        assert_eq!(registry.idle("alice", start, all), None);
        registry.record(
            device("alice", "laptop"),
            Some(Duration::from_secs(40)),
            start,
        );
        registry.record(device("alice", "desk"), Some(Duration::from_secs(5)), start);
        // A locked screen vouches for nobody, and another Member's desktop says nothing of Alice.
        registry.record(device("alice", "locked"), None, start);
        registry.record(device("bob", "bob-desk"), Some(Duration::ZERO), start);
        let later = start + Duration::from_secs(10);
        assert_eq!(
            registry.idle("alice", later, all),
            Some(Duration::from_secs(15))
        );
        // A revoked Device's report never counts.
        assert_eq!(
            registry.idle("alice", later, |principal| principal.device_id != "desk"),
            Some(Duration::from_secs(50))
        );
        // Without a newer report, presence lapses.
        assert_eq!(registry.idle("alice", start + REPORT_LIFETIME, all), None);
        // A newer report from the same Device replaces the old one.
        registry.record(device("alice", "desk"), None, later);
        assert_eq!(
            registry.idle("alice", later, all),
            Some(Duration::from_secs(50))
        );
    }
}
