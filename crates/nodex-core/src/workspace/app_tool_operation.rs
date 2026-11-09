//! Durable host admission for model-chosen retry keys; product mutations retain their own receipts.
use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::workspace::{AppToolOperationIdentity, AppToolOperationRequest};
use rusqlite::{OptionalExtension, params};

use crate::domain::identity::random_uuid_v7;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};
use crate::infrastructure::writer::StoreWriter;

use crate::infrastructure::module_receipts::RECEIPT_RETENTION_MS as WINDOW_MS;

pub(super) fn admit(
    writer: &StoreWriter,
    library_id: &str,
    context: &BoundModuleContext,
    request: AppToolOperationRequest,
) -> Result<AppToolOperationIdentity, StoreError> {
    let library_id = library_id.to_owned();
    let context = context.clone();
    writer.call(move |connection| with_immediate_transaction(connection, |transaction| {
        super::agent_command::admit_read_caller(transaction, &library_id, &context, &request.provenance)?;
        if !(1..=128).contains(&request.idempotency_key.encode_utf16().count())
            || request.tool_name.is_empty() || request.tool_name.len() > 128
            || request.request_hash.len() != 64
            || !request.request_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(StoreError::new(StoreErrorCode::InvalidInput, "Invalid application tool admission", false));
        }
        let authority = &request.provenance.authority;
        let session_id = if let Some(runtime) = &authority.runtime {
            Some(runtime.session_id.clone())
        } else {
            transaction.query_row("SELECT session_id FROM project_session_threads WHERE thread_id=?1",
                [&authority.root_thread_id], |row| row.get::<_, String>(0)).optional()?
        };
        let caller = session_id.map_or_else(|| format!("native:{}", authority.root_thread_id), |id| format!("session:{id}"));
        let now: i64 = transaction.query_row(
            "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)", [], |row| row.get(0),
        )?;
        // Core's writer transaction is the durable arbitration seam. Key lookup, argument binding,
        // and clock admission commit together, so later Turns, restarts and concurrent duplicates
        // reuse the first host-issued identity for its entire window without trusting model time.
        let retained = transaction.query_row(
            "SELECT operation_id, accepted_at_ms, expires_at_ms, request_hash FROM app_tool_operations
             WHERE caller_identity=?1 AND tool_name=?2 AND idempotency_key=?3 AND expires_at_ms>?4",
            params![caller, request.tool_name, request.idempotency_key, now],
            |row| Ok((AppToolOperationIdentity { operation_id: row.get(0)?, accepted_at_ms: row.get(1)?, expires_at_ms: row.get(2)? }, row.get::<_, String>(3)?)),
        ).optional()?;
        if let Some((identity, fingerprint)) = retained {
            if fingerprint != request.request_hash {
                return Err(StoreError::new(StoreErrorCode::IdempotencyKeyReused,
                    "idempotencyKey is already bound to different arguments; reuse it only for an identical retry", false));
            }
            return Ok(identity);
        }
        transaction.execute("DELETE FROM app_tool_operations WHERE rowid IN
            (SELECT rowid FROM app_tool_operations WHERE expires_at_ms<=?1 LIMIT 256)", [now])?;
        let identity = AppToolOperationIdentity {
            operation_id: format!("nodexop:v1:{now}:{}:app.tool:{}", now + WINDOW_MS, random_uuid_v7().map_err(|_| StoreError::new(StoreErrorCode::Internal, "Operation entropy is unavailable", false))?),
            accepted_at_ms: now,
            expires_at_ms: now + WINDOW_MS,
        };
        transaction.execute(
            "INSERT INTO app_tool_operations(caller_identity,tool_name,idempotency_key,request_hash,operation_id,accepted_at_ms,expires_at_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(caller_identity,tool_name,idempotency_key) DO UPDATE SET
             request_hash=excluded.request_hash,operation_id=excluded.operation_id,
             accepted_at_ms=excluded.accepted_at_ms,expires_at_ms=excluded.expires_at_ms",
            params![caller, request.tool_name, request.idempotency_key, request.request_hash,
                identity.operation_id, identity.accepted_at_ms, identity.expires_at_ms],
        )?;
        Ok(identity)
    }))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{apply, context, seeded_workspace};
    use super::*;
    use nodex_core_contracts::CoreErrorCode;
    use nodex_core_contracts::agent::AgentTurnProvenance;
    use nodex_core_contracts::workspace::{
        ProjectWorkspaceAgentRuntimeAuthority, ProjectWorkspaceAgentRuntimeTurnKind,
        ProjectWorkspaceIntent, ProjectWorkspaceTurnAuthority,
    };

    fn request(key: &str) -> AppToolOperationRequest {
        AppToolOperationRequest {
            provenance: AgentTurnProvenance {
                profile_id: "profile-1".into(),
                authority: ProjectWorkspaceTurnAuthority {
                    thread_id: "thread:root".into(),
                    turn_id: "run:one".into(),
                    root_thread_id: "thread:root".into(),
                    actor_project_id: Some("project:default".into()),
                    library_id: "library-1".into(),
                    store_epoch: "epoch-1".into(),
                    runtime: Some(ProjectWorkspaceAgentRuntimeAuthority {
                        session_id: "session:root".into(),
                        runtime_id: "runtime".into(),
                        turn_kind: ProjectWorkspaceAgentRuntimeTurnKind::Run,
                    }),
                },
            },
            tool_name: "send_message_to_session".into(),
            idempotency_key: key.into(),
            request_hash: "a".repeat(64),
        }
    }
    fn setup() -> super::super::test_support::TestWorkspace {
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "launch:root",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                coordinator: false,
                side_chat_source_session_id: None,
                session_id: "session:root".into(),
                project_id: Some("project:default".into()),
                title: "Caller".into(),
                initial_page_ids: vec![],
                runtime_id: "runtime".into(),
                runtime_thread_id: "thread:root".into(),
                launch_request_id: "launch:root".into(),
            },
        );
        workspace
    }

    #[test]
    fn app_tool_operation_retries_are_atomic_across_turns_and_restart() {
        let workspace = setup();
        let request = request("06d6709c-45e7-4b37-8c26-74e9d64c5aa1");
        let identities = std::thread::scope(|scope| {
            let tasks = (0..8)
                .map(|_| {
                    let module = &workspace.module;
                    let request = request.clone();
                    scope.spawn(move || {
                        module
                            .admit_app_tool_operation(&context(), request)
                            .unwrap()
                    })
                })
                .collect::<Vec<_>>();
            tasks
                .into_iter()
                .map(|task| task.join().unwrap())
                .collect::<Vec<_>>()
        });
        let first = &identities[0];
        assert!(identities.iter().all(|identity| identity == first));
        assert_eq!(first.expires_at_ms - first.accepted_at_ms, WINDOW_MS);
        assert!(first.accepted_at_ms > 1_000_000_000_000);
        let mut later = request.clone();
        later.provenance.authority.turn_id = "run:later".into();
        assert_eq!(
            workspace
                .module
                .admit_app_tool_operation(&context(), later.clone())
                .unwrap(),
            *first
        );
        let home = workspace._directory.path().to_path_buf();
        drop(workspace.module);
        drop(workspace.kernel);
        let kernel = crate::infrastructure::store::SqliteStoreKernel::open_test(&home).unwrap();
        let reopened =
            super::super::ProjectWorkspaceModule::new("profile-1", "library-1", &kernel).unwrap();
        assert_eq!(
            reopened
                .admit_app_tool_operation(&context(), later)
                .unwrap(),
            *first
        );
    }

    #[test]
    fn app_tool_operation_rejects_argument_collisions_and_isolates_tools_and_callers() {
        let workspace = setup();
        let request = request(" retry / 任意 🦉 ");
        let first = workspace
            .module
            .admit_app_tool_operation(&context(), request.clone())
            .unwrap();
        let mut changed = request.clone();
        changed.request_hash = "b".repeat(64);
        let error = workspace
            .module
            .admit_app_tool_operation(&context(), changed)
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::IdempotencyKeyReused);
        assert!(error.message.contains("different arguments"));
        let mut other_tool = request.clone();
        other_tool.tool_name = "fork_session".into();
        assert_ne!(
            workspace
                .module
                .admit_app_tool_operation(&context(), other_tool)
                .unwrap()
                .operation_id,
            first.operation_id
        );
        apply(
            &workspace.module,
            "launch:other",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                coordinator: false,
                side_chat_source_session_id: None,
                session_id: "session:other".into(),
                project_id: Some("project:default".into()),
                title: "Other".into(),
                initial_page_ids: vec![],
                runtime_id: "runtime".into(),
                runtime_thread_id: "thread:other".into(),
                launch_request_id: "launch:other".into(),
            },
        );
        let mut other_caller = request;
        other_caller.provenance.authority.root_thread_id = "thread:other".into();
        other_caller
            .provenance
            .authority
            .runtime
            .as_mut()
            .unwrap()
            .session_id = "session:other".into();
        assert_ne!(
            workspace
                .module
                .admit_app_tool_operation(&context(), other_caller)
                .unwrap()
                .operation_id,
            first.operation_id
        );
    }

    #[test]
    fn app_tool_operation_session_creation_replays_across_turns_without_another_session() {
        let workspace = setup();
        let mut admission = request("create-session");
        admission.tool_name = "create_session".into();
        let identity = workspace
            .module
            .admit_app_tool_operation(&context(), admission.clone())
            .unwrap();
        let intent = ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            coordinator: false,
            side_chat_source_session_id: None,
            session_id: "session:new".into(),
            project_id: None,
            title: "New task".into(),
            initial_page_ids: vec![],
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread:new".into(),
            launch_request_id: identity.operation_id.clone(),
        };
        let first = workspace
            .module
            .apply(
                &context(),
                super::super::test_support::request(
                    &identity.operation_id,
                    ProjectWorkspaceIntent::AgentCommand {
                        provenance: Box::new(admission.provenance.clone()),
                        intent: Box::new(intent.clone()),
                    },
                ),
            )
            .unwrap();
        admission.provenance.authority.turn_id = "run:later".into();
        let retry = workspace
            .module
            .apply(
                &context(),
                super::super::test_support::request(
                    &identity.operation_id,
                    ProjectWorkspaceIntent::AgentCommand {
                        provenance: Box::new(admission.provenance),
                        intent: Box::new(intent),
                    },
                ),
            )
            .unwrap();
        assert!(!first.committed.receipt.mutation.duplicate);
        assert!(retry.committed.receipt.mutation.duplicate);
        assert_eq!(retry.committed.value, first.committed.value);
    }

    #[test]
    fn app_tool_operation_reclaims_only_expired_identities_and_checks_current_authority() {
        let workspace = setup();
        let request = request("expiry");
        let first = workspace
            .module
            .admit_app_tool_operation(&context(), request.clone())
            .unwrap();
        workspace
            .kernel
            .writer()
            .call(|connection| {
                connection.execute("UPDATE app_tool_operations SET expires_at_ms=0", [])?;
                Ok(())
            })
            .unwrap();
        let second = workspace
            .module
            .admit_app_tool_operation(&context(), request.clone())
            .unwrap();
        assert_ne!(first.operation_id, second.operation_id);
        let mut invalid = request;
        invalid
            .provenance
            .authority
            .runtime
            .as_mut()
            .unwrap()
            .session_id = "unbound".into();
        assert_eq!(
            workspace
                .module
                .admit_app_tool_operation(&context(), invalid)
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
    }
}
