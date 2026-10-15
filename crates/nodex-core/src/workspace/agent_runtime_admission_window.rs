//! Active execution identities are streamed in bounded pages; revoked rows remain tombstones.
use nodex_core_contracts::{
    BoundModuleContext,
    collection::{CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest},
    workspace::{
        ProjectWorkspaceAgentRuntimeAdmission, ProjectWorkspaceAgentRuntimeNativeSessionIdentity,
        ProjectWorkspaceAgentRuntimeNativeSource, ProjectWorkspaceAgentRuntimeTurnIdentity,
    },
};
use rusqlite::{Connection, params};

use super::{agent_runtime_authority::require_host, session_mutation::validate_id};
use crate::infrastructure::{
    collection_window::{WindowCandidate, assemble, normalize_request},
    cursor::{self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue},
    sqlite::{StoreError, StoreErrorCode},
};

#[allow(clippy::too_many_arguments)]
pub(super) fn read_window(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    commit_head: i64,
    runtime_id: &str,
    lease_id: &str,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceAgentRuntimeAdmission>, StoreError> {
    require_host(context)?;
    validate_id("runtime_id", runtime_id)?;
    validate_id("lease_id", lease_id)?;
    let normalized = normalize_request(request)?;
    let fingerprint =
        cursor::query_fingerprint(&("agent_runtime_admission_v1", runtime_id, lease_id))?;
    let subject = CollectionCursorSubject {
        kind: "agent_runtime_admission",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|cursor| cursor::decode(connection, cursor, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward {
                return Err(invalid("Admission cursor direction is incompatible"));
            }
            let [
                KeysetValue::Integer {
                    value: kind @ (0 | 1),
                },
            ] = coordinate.values.as_slice()
            else {
                return Err(invalid("Admission cursor coordinate is incompatible"));
            };
            Ok((*kind, coordinate.stable_id))
        })
        .transpose()?
        .unwrap_or((0, String::new()));
    let maximum = normalized.first + 1;
    let mut candidates = Vec::with_capacity(maximum);
    if after.0 == 0 {
        let mut statement = connection.prepare(
            "SELECT runtime_thread_id,runtime_run_id,native_provider_session_id,native_generation,authority_turn_id \
             FROM nodex_agent_runtime_turn_admissions \
             WHERE runtime_id=?1 AND runtime_lease_id=?2 AND active=1 AND authority_turn_id>?3 \
             ORDER BY authority_turn_id LIMIT ?4")?;
        let rows = statement.query_map(
            params![runtime_id, lease_id, after.1, maximum as i64],
            |row| {
                Ok(WindowCandidate {
                    item: ProjectWorkspaceAgentRuntimeAdmission::Run {
                        identity: ProjectWorkspaceAgentRuntimeTurnIdentity {
                            runtime_id: runtime_id.into(),
                            lease_id: lease_id.into(),
                            thread_id: row.get(0)?,
                            run_id: row.get(1)?,
                        },
                        native_source: ProjectWorkspaceAgentRuntimeNativeSource {
                            provider_session_id: row.get(2)?,
                            native_generation: row.get(3)?,
                        },
                    },
                    coordinate: KeysetCoordinate {
                        values: vec![KeysetValue::Integer { value: 0 }],
                        stable_id: row.get(4)?,
                    },
                })
            },
        )?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    if candidates.len() < maximum {
        let mut statement = connection.prepare(
            "SELECT runtime_thread_id,provider_session_id,native_generation,incarnation_id \
             FROM nodex_agent_runtime_native_session_admissions \
             WHERE runtime_id=?1 AND runtime_lease_id=?2 AND active=1 AND incarnation_id>?3 \
             ORDER BY incarnation_id LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![
                runtime_id,
                lease_id,
                if after.0 == 1 { after.1.as_str() } else { "" },
                (maximum - candidates.len()) as i64
            ],
            |row| {
                let incarnation_id: String = row.get(3)?;
                Ok(WindowCandidate {
                    item: ProjectWorkspaceAgentRuntimeAdmission::NativeSession {
                        identity: ProjectWorkspaceAgentRuntimeNativeSessionIdentity {
                            runtime_id: runtime_id.into(),
                            lease_id: lease_id.into(),
                            thread_id: row.get(0)?,
                            provider_session_id: row.get(1)?,
                            native_generation: row.get(2)?,
                            incarnation_id: incarnation_id.clone(),
                        },
                    },
                    coordinate: KeysetCoordinate {
                        values: vec![KeysetValue::Integer { value: 1 }],
                        stable_id: incarnation_id,
                    },
                })
            },
        )?;
        candidates.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    assemble(
        candidates,
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )
}
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{
        TestWorkspace, apply, context, read, request, seeded_workspace,
    };
    use super::*;
    use nodex_core_contracts::{
        AdapterKind, CoreErrorCode, ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION,
        workspace::{ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue},
    };
    fn bind(workspace: &TestWorkspace) {
        apply(
            &workspace.module,
            "bind",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                session_id: "session".into(),
                replacement_default_session_id: "default".into(),
                project_id: Some("project:default".into()),
                title: "Task".into(),
                initial_page_ids: Vec::new(),
                runtime_id: "runtime".into(),
                runtime_thread_id: "thread".into(),
                launch_request_id: "launch".into(),
            },
        );
    }
    fn run(run_id: &str, lease_id: &str) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::AdmitAgentRuntimeTurnAuthority {
            session_id: "session".into(),
            identity: ProjectWorkspaceAgentRuntimeTurnIdentity {
                runtime_id: "runtime".into(),
                thread_id: "thread".into(),
                run_id: run_id.into(),
                lease_id: lease_id.into(),
            },
            native_source: ProjectWorkspaceAgentRuntimeNativeSource {
                provider_session_id: "provider".into(),
                native_generation: 1,
            },
            parent: None,
        }
    }
    fn native() -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::AdmitAgentRuntimeNativeSessionAuthority {
            session_id: "session".into(),
            identity: ProjectWorkspaceAgentRuntimeNativeSessionIdentity {
                runtime_id: "runtime".into(),
                thread_id: "thread".into(),
                lease_id: "lease".into(),
                provider_session_id: "provider".into(),
                native_generation: 1,
                incarnation_id: "incarnation".into(),
            },
        }
    }
    fn page(
        workspace: &TestWorkspace,
        lease: &str,
        after: Option<String>,
        first: u32,
    ) -> CollectionWindow<ProjectWorkspaceAgentRuntimeAdmission> {
        let ProjectWorkspaceReadValue::AgentRuntimeAdmissionWindow { admissions } = read(
            &workspace.module,
            ProjectWorkspaceRead::AgentRuntimeAdmissionWindow {
                runtime_id: "runtime".into(),
                lease_id: lease.into(),
                window: CollectionWindowRequest {
                    after,
                    first: Some(first),
                },
            },
        ) else {
            panic!("Admission window");
        };
        admissions
    }
    #[test]
    fn active_roster_is_bounded_and_cursor_survives_revocation_between_pages() {
        let workspace = seeded_workspace();
        bind(&workspace);
        for index in 0..207 {
            apply(
                &workspace.module,
                &format!("run:{index}"),
                run(&format!("run:{index}"), "lease"),
            );
        }
        apply(
            &workspace.module,
            "other-lease",
            run("run:other", "other-lease"),
        );
        apply(&workspace.module, "native", native());
        let first = page(&workspace, "lease", None, 200);
        assert_eq!(first.items.len(), 200);
        let cursor = first.next_cursor.expect("remaining admissions");
        let ProjectWorkspaceAgentRuntimeAdmission::Run { identity, .. } = &first.items[0] else {
            panic!("Runs precede native actors");
        };
        apply(
            &workspace.module,
            "revoke",
            ProjectWorkspaceIntent::RevokeAgentRuntimeTurnAuthority {
                identity: identity.clone(),
            },
        );
        let second = page(&workspace, "lease", Some(cursor.clone()), 200);
        assert_eq!(second.items.len(), 8);
        assert!(second.next_cursor.is_none());
        assert!(matches!(
            second.items.last(),
            Some(ProjectWorkspaceAgentRuntimeAdmission::NativeSession { .. })
        ));
        let mut ids = first
            .items
            .into_iter()
            .chain(second.items)
            .map(|entry| match entry {
                ProjectWorkspaceAgentRuntimeAdmission::Run { identity, .. } => identity.run_id,
                ProjectWorkspaceAgentRuntimeAdmission::NativeSession { identity } => {
                    identity.incarnation_id
                }
            })
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 208);
        let foreign = workspace
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::AgentRuntimeAdmissionWindow {
                        runtime_id: "runtime".into(),
                        lease_id: "other-lease".into(),
                        window: CollectionWindowRequest {
                            after: Some(cursor),
                            first: Some(200),
                        },
                    },
                },
            )
            .unwrap_err();
        assert_eq!(foreign.code, CoreErrorCode::InvalidInput);
        apply(
            &workspace.module,
            "close-source",
            ProjectWorkspaceIntent::RevokeAgentRuntimeNativeSourceAuthorities {
                runtime_id: "runtime".into(),
                lease_id: "lease".into(),
                native_source: ProjectWorkspaceAgentRuntimeNativeSource {
                    provider_session_id: "provider".into(),
                    native_generation: 1,
                },
            },
        );
        assert!(page(&workspace, "lease", None, 200).items.is_empty());
        assert_eq!(page(&workspace, "other-lease", None, 200).items.len(), 1);
    }
    #[test]
    fn native_actors_continue_from_the_same_page_order_and_only_host_can_enumerate() {
        let workspace = seeded_workspace();
        bind(&workspace);
        apply(&workspace.module, "run", run("run", "lease"));
        apply(&workspace.module, "native", native());
        let first = page(&workspace, "lease", None, 1);
        assert!(matches!(
            first.items[0],
            ProjectWorkspaceAgentRuntimeAdmission::Run { .. }
        ));
        let next = page(&workspace, "lease", first.next_cursor, 1);
        assert!(matches!(
            next.items[0],
            ProjectWorkspaceAgentRuntimeAdmission::NativeSession { .. }
        ));
        assert!(next.next_cursor.is_none());
        let mut cli = context();
        cli.adapter = AdapterKind::NativeCli;
        let error = workspace
            .module
            .read(
                &cli,
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::AgentRuntimeAdmissionWindow {
                        runtime_id: "runtime".into(),
                        lease_id: "lease".into(),
                        window: CollectionWindowRequest::default(),
                    },
                },
            )
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::Unauthorized);
        let mut revoke = native();
        let ProjectWorkspaceIntent::AdmitAgentRuntimeNativeSessionAuthority { identity, .. } =
            &mut revoke
        else {
            unreachable!()
        };
        workspace
            .module
            .apply(
                &context(),
                request(
                    "retire",
                    ProjectWorkspaceIntent::RevokeAgentRuntimeNativeSessionAuthority {
                        identity: identity.clone(),
                    },
                ),
            )
            .unwrap();
        assert_eq!(page(&workspace, "lease", None, 200).items.len(), 1);
    }
}
