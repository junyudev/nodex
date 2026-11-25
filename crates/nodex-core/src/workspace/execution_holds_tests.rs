use super::test_support::*;
use nodex_core_contracts::{AdapterKind, CoreErrorCode, workspace::*};
const PAGE: &str = "019d0000-0000-7000-8000-000000000091";
fn setup() -> TestWorkspace {
    let w = seeded_workspace();
    create_project(&w.module, "project", "project:work");
    apply(
        &w.module,
        "page",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: PAGE.into(),
            document_id: "019d0000-0000-7000-8000-000000000092".into(),
            title: "Work".into(),
        },
    );
    w
}
fn holds(w: &TestWorkspace) -> Vec<ExecutionHold> {
    match read(
        &w.module,
        ProjectWorkspaceRead::EffectiveExecutionHold {
            target: ExecutionHoldTarget::Page {
                page_id: PAGE.into(),
            },
        },
    ) {
        ProjectWorkspaceReadValue::EffectiveExecutionHold { holds } => holds,
        _ => panic!("hold read"),
    }
}
#[test]
fn hold_union_replays_and_clearing_child_preserves_parent() {
    let w = setup();
    let page = ExecutionHoldScope::Page {
        page_id: PAGE.into(),
    };
    let project = ExecutionHoldScope::Project {
        project_id: "project:work".into(),
    };
    let first = w
        .module
        .apply(
            &context(),
            request(
                "pause-page",
                ProjectWorkspaceIntent::PauseWork {
                    scope: page.clone(),
                },
            ),
        )
        .unwrap();
    let original = holds(&w);
    assert_eq!(original.len(), 1);
    let retry = w
        .module
        .apply(
            &context(),
            request(
                "pause-page",
                ProjectWorkspaceIntent::PauseWork {
                    scope: page.clone(),
                },
            ),
        )
        .unwrap();
    assert!(retry.committed.receipt.mutation.duplicate);
    assert_eq!(first.committed.value, retry.committed.value);
    assert_eq!(original, holds(&w));
    apply(
        &w.module,
        "pause-again",
        ProjectWorkspaceIntent::PauseWork {
            scope: page.clone(),
        },
    );
    assert_eq!(original, holds(&w));
    apply(
        &w.module,
        "pause-project",
        ProjectWorkspaceIntent::PauseWork {
            scope: project.clone(),
        },
    );
    apply(
        &w.module,
        "pause-space",
        ProjectWorkspaceIntent::PauseWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    assert_eq!(holds(&w).len(), 3);
    apply(
        &w.module,
        "resume-page",
        ProjectWorkspaceIntent::ResumeWork { scope: page },
    );
    assert_eq!(holds(&w).len(), 2);
    apply(
        &w.module,
        "resume-project",
        ProjectWorkspaceIntent::ResumeWork { scope: project },
    );
    assert_eq!(holds(&w).len(), 1);
    apply(
        &w.module,
        "resume-space",
        ProjectWorkspaceIntent::ResumeWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    assert!(holds(&w).is_empty());
    let r = w
        .module
        .apply(
            &context(),
            request(
                "resume-space",
                ProjectWorkspaceIntent::ResumeWork {
                    scope: ExecutionHoldScope::Space,
                },
            ),
        )
        .unwrap();
    assert!(r.committed.receipt.mutation.duplicate);
}
#[test]
fn only_person_adapters_may_pause_or_resume() {
    let w = setup();
    for adapter in [AdapterKind::Agent, AdapterKind::LoopbackHttp] {
        let mut ctx = context();
        ctx.adapter = adapter;
        for intent in [
            ProjectWorkspaceIntent::PauseWork {
                scope: ExecutionHoldScope::Space,
            },
            ProjectWorkspaceIntent::ResumeWork {
                scope: ExecutionHoldScope::Space,
            },
        ] {
            assert_eq!(
                w.module
                    .apply(&ctx, request("denied", intent))
                    .unwrap_err()
                    .code,
                CoreErrorCode::Unauthorized
            );
        }
    }
    let mut ctx = context();
    ctx.adapter = AdapterKind::NativeCli;
    w.module
        .apply(
            &ctx,
            request(
                "cli",
                ProjectWorkspaceIntent::PauseWork {
                    scope: ExecutionHoldScope::Space,
                },
            ),
        )
        .unwrap();
    assert_eq!(holds(&w).len(), 1);
}
