//! Durable retry-key admission. Product mutations retain their own receipts.
use nodex_core_contracts::actor::Actor;
use nodex_core_contracts::workspace::{
    AppToolOperationIdentity, AppToolOperationRequest, RETRY_KEY_MAX_SCALARS,
};
use nodex_core_contracts::{AdapterKind, BoundModuleContext, CoreErrorRecovery};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::domain::identity::random_uuid_v7;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};
use crate::infrastructure::writer::StoreWriter;

use crate::infrastructure::module_receipts::RECEIPT_RETENTION_MS as WINDOW_MS;

const PRUNE_BATCH: i64 = 128;

pub(super) fn admit(
    writer: &StoreWriter,
    library_id: &str,
    context: &BoundModuleContext,
    request: AppToolOperationRequest,
) -> Result<AppToolOperationIdentity, StoreError> {
    let library_id = library_id.to_owned();
    let context = context.clone();
    writer.call(move |connection| with_immediate_transaction(connection, |transaction| {
        let (caller, command) = retry_scope(transaction, &library_id, &context, &request)?;
        if !(1..=RETRY_KEY_MAX_SCALARS).contains(&request.idempotency_key.chars().count()) {
            return Err(StoreError::new(StoreErrorCode::InvalidInput,
                "Idempotency key must contain 1 to 128 Unicode scalar values", false));
        }
        if request.tool_name.is_empty() || request.tool_name.len() > 128
            || request.request_hash.len() != 64
            || !request.request_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(StoreError::new(StoreErrorCode::InvalidInput, "Invalid application tool admission", false));
        }
        let now: i64 = transaction.query_row(
            "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)", [], |row| row.get(0),
        )?;
        transaction.execute(
            "DELETE FROM app_tool_operations WHERE rowid IN (
               SELECT rowid FROM app_tool_operations WHERE expires_at_ms <= ?1
               ORDER BY expires_at_ms LIMIT ?2
             )",
            params![now, PRUNE_BATCH],
        )?;
        // Core's writer transaction is the durable arbitration seam. Key lookup, argument binding,
        // and clock admission commit together, so later Turns, restarts and concurrent duplicates
        // reuse the first host-issued identity for its entire window without trusting model time.
        let key_hash = hex::encode(Sha256::digest(request.idempotency_key.as_bytes()));
        // A separate namespace keeps existing MCP bindings readable, including keys that
        // happen to look like a digest.
        let hashed_caller = format!("retry:{caller}");
        let mut retained = read_binding(transaction, &hashed_caller, &command, &key_hash, now)?;
        if retained.is_none() && request.provenance.is_some() {
            retained = read_binding(transaction, &caller, &command, &request.idempotency_key, now)?;
        }
        if let Some((identity, fingerprint)) = retained {
            if fingerprint != request.request_hash {
                return Err(StoreError::new(StoreErrorCode::IdempotencyKeyReused,
                    "This key is bound to different arguments; use a new key for a new intent.", false)
                    .with_recovery(CoreErrorRecovery::UseNewIdempotencyKey));
            }
            return Ok(identity);
        }
        let identity = AppToolOperationIdentity {
            operation_id: format!("nodexop:v1:{now}:{}:app.retry:{}", now + WINDOW_MS, random_uuid_v7().map_err(|_| StoreError::new(StoreErrorCode::Internal, "Operation entropy is unavailable", false))?),
            accepted_at_ms: now,
            expires_at_ms: now + WINDOW_MS,
            replay: None,
        };
        transaction.execute(
            "INSERT INTO app_tool_operations(caller_identity,tool_name,idempotency_key,request_hash,operation_id,accepted_at_ms,expires_at_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(caller_identity,tool_name,idempotency_key) DO UPDATE SET
               request_hash=excluded.request_hash, operation_id=excluded.operation_id,
               accepted_at_ms=excluded.accepted_at_ms, expires_at_ms=excluded.expires_at_ms
             WHERE app_tool_operations.expires_at_ms <= ?6",
            params![hashed_caller, command, key_hash, request.request_hash,
                identity.operation_id, identity.accepted_at_ms, identity.expires_at_ms],
        )?;
        Ok(identity)
    }))
}

fn read_binding(
    connection: &rusqlite::Connection,
    caller: &str,
    command: &str,
    key: &str,
    now: i64,
) -> Result<Option<(AppToolOperationIdentity, String)>, StoreError> {
    Ok(connection.query_row(
        "SELECT operation_id, accepted_at_ms, expires_at_ms, request_hash FROM app_tool_operations
         WHERE caller_identity=?1 AND tool_name=?2 AND idempotency_key=?3 AND expires_at_ms>?4",
        params![caller, command, key, now],
        |row| {
            let identity = AppToolOperationIdentity {
                operation_id: row.get(0)?,
                accepted_at_ms: row.get(1)?,
                expires_at_ms: row.get(2)?,
                replay: None,
            };
            Ok((identity, row.get(3)?))
        },
    ).optional()?)
}

fn retry_scope(
    connection: &rusqlite::Connection,
    library_id: &str,
    context: &BoundModuleContext,
    request: &AppToolOperationRequest,
) -> Result<(String, String), StoreError> {
    if let Some(provenance) = &request.provenance {
        super::agent_command::admit_read_caller(connection, library_id, context, provenance)?;
        if context.agent_attribution.is_some() || request.tool_name.starts_with("cli.") {
            return Err(unauthorized_admission());
        }
        let authority = &provenance.authority;
        let session_id = if let Some(runtime) = &authority.runtime {
            Some(runtime.session_id.clone())
        } else {
            connection
                .query_row(
                    "SELECT session_id FROM project_session_threads WHERE thread_id=?1",
                    [&authority.root_thread_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        };
        let caller = session_id.map_or_else(
            || format!("native:{}", authority.root_thread_id),
            |id| format!("session:{id}"),
        );
        return Ok((caller, request.tool_name.clone()));
    }
    if context.adapter != AdapterKind::NativeCli {
        return Err(unauthorized_admission());
    }
    let caller = match &context.actor {
        Actor::Agent { session_id, .. } => format!("session:{session_id}"),
        Actor::Member { member_id } => format!("member:{member_id}"),
        Actor::Service { .. } => return Err(unauthorized_admission()),
    };
    Ok((caller, format!("cli.{}", request.tool_name)))
}

fn unauthorized_admission() -> StoreError {
    StoreError::new(
        StoreErrorCode::Unauthorized,
        "Retry admission requires a verified caller",
        false,
    )
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
            provenance: Some(AgentTurnProvenance {
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
            }),
            tool_name: "send_message_to_session".into(),
            idempotency_key: key.into(),
            request_hash: "a".repeat(64),
            replay_module: None,
        }
    }
    fn setup() -> super::super::test_support::TestWorkspace {
        let workspace = seeded_workspace();
        apply(
            &workspace.module,
            "launch:root",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                agent_selection: None,
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
        later.provenance.as_mut().unwrap().authority.turn_id = "run:later".into();
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
                agent_selection: None,
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
        other_caller
            .provenance
            .as_mut()
            .unwrap()
            .authority
            .root_thread_id = "thread:other".into();
        other_caller
            .provenance
            .as_mut()
            .unwrap()
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
            agent_selection: None,
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
                        provenance: Box::new(admission.provenance.clone().unwrap()),
                        intent: Box::new(intent.clone()),
                    },
                ),
            )
            .unwrap();
        admission.provenance.as_mut().unwrap().authority.turn_id = "run:later".into();
        let retry = workspace
            .module
            .apply(
                &context(),
                super::super::test_support::request(
                    &identity.operation_id,
                    ProjectWorkspaceIntent::AgentCommand {
                        provenance: Box::new(admission.provenance.unwrap()),
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
    fn cli_retry_keys_are_opaque_and_scoped_to_the_verified_actor() {
        let workspace = setup();
        let mut cli = context();
        cli.adapter = AdapterKind::NativeCli;
        cli.actor = Actor::Member {
            member_id: "member:local".into(),
        };
        for key in [
            " ",
            " /:",
            "nodexop:v1:broken",
            "cli-1-reorg",
            &"😀".repeat(128),
        ] {
            let mut request = request(key);
            request.provenance = None;
            request.tool_name = "backup create".into();
            let member = workspace
                .module
                .admit_app_tool_operation(&cli, request.clone())
                .unwrap();
            let mut previous = member.operation_id;
            for session_id in ["session:root", "session:other"] {
                let agent = BoundModuleContext {
                    actor: Actor::Agent {
                        session_id: session_id.into(),
                        run_id: Some("run:one".into()),
                        on_behalf_of: "member:local".into(),
                    },
                    ..cli.clone()
                };
                let admitted = workspace
                    .module
                    .admit_app_tool_operation(&agent, request.clone())
                    .unwrap();
                assert_ne!(admitted.operation_id, previous);
                previous = admitted.operation_id.clone();
                let mut later = agent.clone();
                later.connection_id = "another-connection".into();
                let Actor::Agent { run_id, .. } = &mut later.actor else {
                    unreachable!()
                };
                *run_id = Some("run:later".into());
                assert_eq!(
                    workspace
                        .module
                        .admit_app_tool_operation(&later, request.clone())
                        .unwrap(),
                    admitted
                );
            }
        }
        let mut invalid = request(&"😀".repeat(129));
        invalid.provenance = None;
        assert_eq!(
            workspace
                .module
                .admit_app_tool_operation(&cli, invalid)
                .unwrap_err()
                .code,
            CoreErrorCode::InvalidInput
        );
    }

    #[test]
    fn expired_retry_bindings_are_pruned_and_readmitted_with_fresh_operation_ids() {
        let workspace = setup();
        let admit = |request| {
            workspace
                .module
                .admit_app_tool_operation(&context(), request)
                .unwrap()
        };
        let count = || {
            workspace
                .kernel
                .writer()
                .call(|connection| {
                    Ok(connection.query_row(
                        "SELECT count(*) FROM app_tool_operations",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?)
                })
                .unwrap()
        };
        let mut request = request("expiry");
        request.tool_name = "create_session".into();
        let first = admit(request.clone());
        let execute = |identity: &AppToolOperationIdentity, id: &str| {
            workspace
                .module
                .apply(
                    &context(),
                    super::super::test_support::request(
                        &identity.operation_id,
                        ProjectWorkspaceIntent::AgentCommand {
                            provenance: Box::new(request.provenance.clone().unwrap()),
                            intent: Box::new(ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                                agent_selection: None,
                                coordinator: false,
                                side_chat_source_session_id: None,
                                session_id: format!("session:{id}"),
                                project_id: None,
                                title: "New task".into(),
                                initial_page_ids: vec![],
                                runtime_id: "runtime".into(),
                                runtime_thread_id: format!("thread:{id}"),
                                launch_request_id: identity.operation_id.clone(),
                            }),
                        },
                    ),
                )
                .unwrap()
        };
        assert!(
            !execute(&first, "first")
                .committed
                .receipt
                .mutation
                .duplicate
        );
        let expire = || {
            workspace
                .kernel
                .writer()
                .call(|connection| {
                    connection.execute("UPDATE app_tool_operations SET expires_at_ms=0 WHERE tool_name='fork_session'", [])?;
                    Ok(())
                })
                .unwrap()
        };
        for batch in 0..4 {
            for n in 0..(PRUNE_BATCH + 1) {
                admit(AppToolOperationRequest {
                    tool_name: "fork_session".into(),
                    idempotency_key: format!("{batch}:{n}"),
                    ..request.clone()
                });
            }
            assert_eq!(count(), PRUNE_BATCH + 2);
            expire();
        }
        workspace.kernel.writer().call(|connection| {
            connection.execute("UPDATE app_tool_operations SET expires_at_ms=1 WHERE tool_name='create_session'", [])?;
            Ok(())
        }).unwrap();
        // The batch cannot remove every row immediately. Re-admission must still replace
        // a specifically requested expired binding, including one outside that batch.
        let second = admit(request.clone());
        assert_ne!(second.operation_id, first.operation_id);
        assert!(
            !execute(&second, "second")
                .committed
                .receipt
                .mutation
                .duplicate
        );
        assert_eq!(count(), 2);
        assert_eq!(admit(request.clone()), second);
        assert_eq!(count(), 1);
        let mut invalid = request;
        invalid
            .provenance
            .as_mut()
            .unwrap()
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
