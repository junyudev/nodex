use super::test_support::*;
use nodex_core_contracts::{AdapterKind, sources::*, workspace::*};
use serde_json::json;
fn config() -> GitHubSourceConfig {
    GitHubSourceConfig {
        host: "github.com".into(),
        account_login: "alice".into(),
        account_id: "1".into(),
        credential_ref: "gh:github.com:alice".into(),
        repositories: vec![SourceRepository {
            id: "10".into(),
            name: "alice/repo".into(),
            enabled: true,
        }],
        discovery: SourceDiscovery {
            assigned: true,
            review_requests: true,
            mentions: true,
        },
    }
}
fn command(value: SourceCommand) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::Source { command: value }
}
fn setup() -> TestWorkspace {
    let w = seeded_workspace();
    apply(
        &w.module,
        "configure",
        command(SourceCommand::ConfigureSource {
            source_id: "github".into(),
            expected_revision: 0,
            enabled: true,
            config: config(),
        }),
    );
    claim(&w, "lease");
    w
}
fn claim(w: &TestWorkspace, token: &str) {
    apply(
        &w.module,
        &format!("claim-{token}"),
        command(SourceCommand::ClaimSourcePartition {
            source_id: "github".into(),
            config_revision: 1,
            partition: "repo:10".into(),
            lease_token: token.into(),
            lease_duration_ms: 120000,
        }),
    );
}
fn query(w: &TestWorkspace, query: SourceRead) -> SourceReadValue {
    let ProjectWorkspaceReadValue::Sources { value } =
        read(&w.module, ProjectWorkspaceRead::Sources { read: query })
    else {
        panic!()
    };
    value
}
fn cursor(w: &TestWorkspace) -> SourcePosition {
    let SourceReadValue::Positions { mut positions } = query(
        w,
        SourceRead::Positions {
            source_id: "github".into(),
            after_partition: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    positions.remove(0)
}
fn thread() -> ExternalThread {
    ExternalThread {
        id: "github:github.com:10:1".into(),
        host: "github.com".into(),
        repository_id: "10".into(),
        repository: "alice/repo".into(),
        number: 1,
        kind: ExternalThreadKind::Issue,
        url: "https://github.com/alice/repo/issues/1".into(),
        title: "Task".into(),
        state: "open".into(),
        head: None,
        draft: false,
        observation_revision: 0,
        observations: Default::default(),
    }
}
fn ingest(w: &TestWorkspace, revision: i64, token: &str) -> SourceCommand {
    let p = cursor(w);
    let SourceReadValue::Threads { threads } = query(
        w,
        SourceRead::Threads {
            host: "github.com".into(),
            repository_id: "10".into(),
            after_id: None,
            limit: 1,
        },
    ) else {
        panic!()
    };
    let current_thread = threads.into_iter().next().unwrap_or_else(thread);
    SourceCommand::IngestSourceBatch {
        source_id: "github".into(),
        config_revision: 1,
        partition: "repo:10".into(),
        expected_position: revision,
        lease_token: token.into(),
        threads: vec![current_thread],
        triggers: vec![SourceTriggerInput {
            semantic_key: "github:github.com:10:comment:2:v1".into(),
            kind: "comment".into(),
            occurred_at_ms: p.cursor.watermark_ms + 1,
            actor_login: "bob".into(),
            actor_class: SourceActorClass::Person,
            thread_id: thread().id,
            text: Some("Hello".into()),
            metadata: json!({}),
            url: thread().url,
        }],
        next_position: p.cursor,
        next_poll_at_ms: 0,
        quarantine: vec![],
    }
}
#[test]
fn sources_dedupe_and_cas_commit_facts_with_position() {
    let w = setup();
    apply(&w.module, "batch1", command(ingest(&w, 0, "lease")));
    apply(&w.module, "batch2", command(ingest(&w, 1, "lease")));
    let SourceReadValue::Triggers { triggers } = query(
        &w,
        SourceRead::Triggers {
            thread_url: thread().url,
            before_id: None,
            limit: 10,
        },
    ) else {
        panic!()
    };
    assert_eq!(triggers.len(), 1);
    assert_eq!(triggers[0].disposition, "recorded");
    assert_eq!(cursor(&w).revision, 2);
    assert!(
        w.module
            .apply(
                &context(),
                request("stale", command(ingest(&w, 0, "lease")))
            )
            .is_err()
    );
    assert_eq!(cursor(&w).revision, 2);
    assert!(
        w.module
            .apply(
                &context(),
                request("other", command(ingest(&w, 2, "other")))
            )
            .is_err()
    );
}
#[test]
fn sources_baseline_excludes_history_and_configuration_fences_lease() {
    let w = setup();
    let mut batch = ingest(&w, 0, "lease");
    if let SourceCommand::IngestSourceBatch {
        ref mut triggers, ..
    } = batch
    {
        triggers[0].occurred_at_ms = 1;
    }
    apply(&w.module, "baseline", command(batch));
    assert!(cursor(&w).baseline);
    let SourceReadValue::Triggers { triggers } = query(
        &w,
        SourceRead::Triggers {
            thread_url: thread().url,
            before_id: None,
            limit: 10,
        },
    ) else {
        panic!()
    };
    assert!(triggers.is_empty());
    apply(
        &w.module,
        "disable",
        command(SourceCommand::ConfigureSource {
            source_id: "github".into(),
            expected_revision: 1,
            enabled: false,
            config: config(),
        }),
    );
    assert!(
        w.module
            .apply(&context(), request("late", command(ingest(&w, 1, "lease"))))
            .is_err()
    );
}
#[test]
fn sources_configuration_and_ingestion_are_not_agent_capabilities() {
    let w = setup();
    let mut agent = context();
    agent.adapter = AdapterKind::Agent;
    for cmd in [
        SourceCommand::ConfigureSource {
            source_id: "github".into(),
            expected_revision: 1,
            enabled: false,
            config: config(),
        },
        ingest(&w, 0, "lease"),
    ] {
        let error = w
            .module
            .apply(&agent, request("agent", command(cmd)))
            .unwrap_err();
        assert_eq!(
            error.code,
            nodex_core_contracts::CoreErrorCode::Unauthorized
        );
    }
}
#[test]
fn sources_reject_agent_attribution_even_on_a_persons_receipt_replay() {
    let w = setup();
    let mut agent = context();
    agent.adapter = AdapterKind::ElectronHost;
    agent.agent_attribution = Some(nodex_core_contracts::BoundAgentAttribution {
        session_id: "chat".into(),
        backend: nodex_core_contracts::agent::AgentBackendKind::Codex,
    });
    let error = w
        .module
        .apply(
            &agent,
            request(
                "configure",
                command(SourceCommand::ConfigureSource {
                    source_id: "github".into(),
                    expected_revision: 0,
                    enabled: true,
                    config: config(),
                }),
            ),
        )
        .unwrap_err();
    assert_eq!(
        error.code,
        nodex_core_contracts::CoreErrorCode::Unauthorized
    );
}
#[test]
fn sources_share_semantic_deduplication_across_overlapping_connections() {
    let w = setup();
    apply(
        &w.module,
        "second-source",
        command(SourceCommand::ConfigureSource {
            source_id: "second".into(),
            expected_revision: 0,
            enabled: true,
            config: config(),
        }),
    );
    apply(
        &w.module,
        "second-lease",
        command(SourceCommand::ClaimSourcePartition {
            source_id: "second".into(),
            config_revision: 1,
            partition: "repo:10".into(),
            lease_token: "second-token".into(),
            lease_duration_ms: 120000,
        }),
    );
    let SourceReadValue::Positions { positions } = query(
        &w,
        SourceRead::Positions {
            source_id: "second".into(),
            after_partition: None,
            limit: 1,
        },
    ) else {
        panic!()
    };
    let boundary = positions[0].cursor.watermark_ms;
    let mut first = ingest(&w, 0, "lease");
    if let SourceCommand::IngestSourceBatch {
        triggers,
        next_position,
        ..
    } = &mut first
    {
        triggers[0].occurred_at_ms = boundary + 1;
        next_position.watermark_ms = boundary;
    }
    apply(&w.module, "first", command(first));
    let mut batch = ingest(&w, 0, "second-token");
    if let SourceCommand::IngestSourceBatch {
        ref mut source_id,
        ref mut triggers,
        ref mut next_position,
        ..
    } = batch
    {
        *source_id = "second".into();
        triggers[0].occurred_at_ms = boundary + 1;
        *next_position = positions[0].cursor.clone();
    }
    apply(&w.module, "second-ingest", command(batch));
    let SourceReadValue::Triggers { triggers } = query(
        &w,
        SourceRead::Triggers {
            thread_url: thread().url,
            before_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    assert_eq!(triggers.len(), 1);
}

#[test]
fn sources_failures_open_once_and_success_resolves() {
    let w = setup();
    for index in 1..=4 {
        apply(
            &w.module,
            &format!("failure{index}"),
            command(SourceCommand::RecordSourceFailure {
                source_id: "github".into(),
                config_revision: 1,
                partition: None,
                lease_token: None,
                problem_kind: "poll_failed".into(),
                evidence: json!({"reason":"logged_out"}),
                retry_at_ms: 0,
            }),
        );
        let SourceReadValue::OpenProblems { problems } = query(
            &w,
            SourceRead::OpenProblems {
                source_id: None,
                after_id: None,
                limit: 100,
            },
        ) else {
            panic!()
        };
        assert_eq!(problems.len(), usize::from(index >= 3));
    }
    apply(
        &w.module,
        "success",
        command(SourceCommand::RecordSourceSuccess {
            source_id: "github".into(),
            config_revision: 1,
            partition: None,
            lease_token: None,
        }),
    );
    let SourceReadValue::OpenProblems { problems } = query(
        &w,
        SourceRead::OpenProblems {
            source_id: None,
            after_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    assert!(problems.is_empty());
}
#[test]
fn sources_lease_expiry_and_transaction_rollback_preserve_position() {
    let w = setup();
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "collision",
                    command(SourceCommand::ClaimSourcePartition {
                        source_id: "github".into(),
                        config_revision: 1,
                        partition: "repo:10".into(),
                        lease_token: "other".into(),
                        lease_duration_ms: 10000
                    })
                )
            )
            .is_err()
    );
    w.kernel
        .writer()
        .call(|c| {
            c.execute("UPDATE source_positions SET lease_expires_at_ms=0", [])?;
            Ok(())
        })
        .unwrap();
    assert!(
        w.module
            .apply(
                &context(),
                request("expired", command(ingest(&w, 0, "lease")))
            )
            .is_err()
    );
    claim(&w, "replacement");
    let mut batch = ingest(&w, 0, "replacement");
    if let SourceCommand::IngestSourceBatch {
        ref mut triggers, ..
    } = batch
    {
        triggers[0].thread_id = "absent".into();
    }
    assert!(
        w.module
            .apply(&context(), request("invalid", command(batch)))
            .is_err()
    );
    assert_eq!(cursor(&w).revision, 0);
    let SourceReadValue::Threads { threads } = query(
        &w,
        SourceRead::Threads {
            host: "github.com".into(),
            repository_id: "10".into(),
            after_id: None,
            limit: 10,
        },
    ) else {
        panic!()
    };
    assert!(threads.is_empty());
}

#[test]
fn sources_ingestion_resolves_poll_health_before_lease_release() {
    let w = setup();
    for i in 0..3 {
        let token = if i == 0 {
            "lease".into()
        } else {
            format!("attempt-{i}")
        };
        if i > 0 {
            claim(&w, &token);
        }
        apply(
            &w.module,
            &format!("failure-{i}"),
            command(SourceCommand::RecordSourceFailure {
                source_id: "github".into(),
                config_revision: 1,
                partition: Some("repo:10".into()),
                lease_token: Some(token),
                problem_kind: "poll_failed".into(),
                evidence: json!({"reason":"credential"}),
                retry_at_ms: 0,
            }),
        );
    }
    assert_eq!(cursor(&w).consecutive_failures, 3);
    let problems = || {
        let SourceReadValue::OpenProblems { problems } = query(
            &w,
            SourceRead::OpenProblems {
                source_id: None,
                after_id: None,
                limit: 100,
            },
        ) else {
            panic!()
        };
        problems
    };
    assert_eq!(problems().len(), 1);
    claim(&w, "recovered");
    apply(
        &w.module,
        "recovered-batch",
        command(ingest(&w, 0, "recovered")),
    );
    assert_eq!(cursor(&w).consecutive_failures, 0);
    assert!(problems().is_empty());
    assert_eq!(cursor(&w).lease_token.as_deref(), Some("recovered"));
}

#[test]
fn sources_are_library_owned_without_a_project_catalog() {
    let w = library_only_workspace();
    let mut person = context();
    person.project_id = None;
    w.module
        .apply(
            &person,
            request(
                "projectless-source",
                command(SourceCommand::ConfigureSource {
                    source_id: "source".into(),
                    expected_revision: 0,
                    enabled: true,
                    config: config(),
                }),
            ),
        )
        .unwrap();
    let SourceReadValue::Sources { sources } = query(
        &w,
        SourceRead::Sources {
            after_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    assert_eq!(sources.len(), 1);
}

#[test]
fn sources_configuration_rejects_plaintext_credentials() {
    let mut value = serde_json::to_value(config()).unwrap();
    value["token"] = json!("plaintext");
    assert!(serde_json::from_value::<GitHubSourceConfig>(value).is_err());
}

#[test]
fn sources_fence_shared_thread_observations_before_recording_or_advancing() {
    let w = setup();
    let mut batch = ingest(&w, 0, "lease");
    if let SourceCommand::IngestSourceBatch { threads, .. } = &mut batch {
        threads[0].observations.insert(
            "check:4:abc".into(),
            SourceObservation {
                fingerprint: "failure".into(),
                revision: 1,
            },
        );
    }
    let mut stale = batch.clone();
    apply(&w.module, "shared-thread-first", command(batch));
    if let SourceCommand::IngestSourceBatch {
        expected_position, ..
    } = &mut stale
    {
        *expected_position = 1;
    }
    assert!(
        w.module
            .apply(&context(), request("stale-thread", command(stale)))
            .is_err()
    );
    assert_eq!(cursor(&w).revision, 1);
    let SourceReadValue::Threads { threads } = query(
        &w,
        SourceRead::Threads {
            host: "github.com".into(),
            repository_id: "10".into(),
            after_id: None,
            limit: 1,
        },
    ) else {
        panic!()
    };
    assert_eq!(threads[0].observation_revision, 1);
    assert_eq!(threads[0].observations["check:4:abc"].revision, 1);
}

#[test]
fn sources_configuration_preserves_the_server_poll_deadline() {
    let w = setup();
    let mut batch = ingest(&w, 0, "lease");
    let deadline = cursor(&w).cursor.watermark_ms + 120000;
    if let SourceCommand::IngestSourceBatch {
        next_poll_at_ms, ..
    } = &mut batch
    {
        *next_poll_at_ms = deadline;
    }
    apply(&w.module, "deadline", command(batch));
    apply(
        &w.module,
        "refresh-settings",
        command(SourceCommand::ConfigureSource {
            source_id: "github".into(),
            expected_revision: 1,
            enabled: true,
            config: config(),
        }),
    );
    assert_eq!(cursor(&w).next_poll_at_ms, deadline);
    assert!(cursor(&w).lease_token.is_none());
}

#[test]
fn sources_quarantine_evidence_without_fabricating_poll_failures() {
    let w = setup();
    let mut batch = ingest(&w, 0, "lease");
    if let SourceCommand::IngestSourceBatch { quarantine, .. } = &mut batch {
        quarantine.push(json!({"path":"comments","hash":"bad-item","item":"malformed"}));
    }
    apply(&w.module, "quarantine", command(batch));
    let SourceReadValue::OpenProblems { problems } = query(
        &w,
        SourceRead::OpenProblems {
            source_id: None,
            after_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    assert_eq!(problems.len(), 1);
    assert_eq!(problems[0].kind, "source_failing");
    assert_eq!(problems[0].consecutive_failures, 1);
    assert_eq!(cursor(&w).consecutive_failures, 0);
    assert_eq!(cursor(&w).revision, 1);
}

#[test]
fn sources_new_repositories_get_an_immutable_first_enable_boundary() {
    let w = setup();
    let first = cursor(&w).cursor.baseline_at_ms;
    let mut changed = config();
    changed.repositories.push(SourceRepository {
        id: "20".into(),
        name: "alice/other".into(),
        enabled: true,
    });
    apply(
        &w.module,
        "new-repository",
        command(SourceCommand::ConfigureSource {
            source_id: "github".into(),
            expected_revision: 1,
            enabled: true,
            config: changed,
        }),
    );
    let SourceReadValue::Positions { positions } = query(
        &w,
        SourceRead::Positions {
            source_id: "github".into(),
            after_partition: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    assert_eq!(positions[0].cursor.baseline_at_ms, first);
    assert!(positions[1].cursor.baseline_at_ms >= first);
    assert!(!positions[1].baseline);
    let mut batch = ingest(&w, 0, "lease");
    if let SourceCommand::IngestSourceBatch {
        config_revision,
        next_position,
        ..
    } = &mut batch
    {
        *config_revision = 2;
        next_position.baseline_at_ms = first - 1;
    }
    apply(
        &w.module,
        "new-config-lease",
        command(SourceCommand::ClaimSourcePartition {
            source_id: "github".into(),
            config_revision: 2,
            partition: "repo:10".into(),
            lease_token: "lease".into(),
            lease_duration_ms: 120000,
        }),
    );
    assert!(
        w.module
            .apply(&context(), request("moved-baseline", command(batch)))
            .is_err()
    );
    assert_eq!(cursor(&w).cursor.baseline_at_ms, first);
}

#[path = "thread_follows_tests.rs"]
mod follows;
