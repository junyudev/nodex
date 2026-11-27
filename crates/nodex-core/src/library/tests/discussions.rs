use super::agent_surface::Fixture;
use super::*;
use nodex_core_contracts::Actor;
use nodex_core_contracts::agent::AgentPreparedExecution;
use nodex_core_contracts::discussions::*;
use nodex_core_contracts::document::DocumentBlockOperation as ContractDocumentBlockOperation;
use nodex_core_contracts::document::{
    AgentDocumentSemanticMutation, DocumentSemanticCommand, OwnedDocumentRead,
    OwnedDocumentReadValue,
};
use nodex_core_contracts::library::MemberRole;
use nodex_core_contracts::team::{EnrollmentRequest, InviteRequest, ListenerInfo, SessionRequest};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const PAGE: &str = "page:target";
const DOC: &str = "document:target";
const TARGET: &str = "page:destination";
const TARGET_DOC: &str = "document:destination";

fn read(f: &Fixture, read: LibraryRead) -> LibraryReadValue {
    f.library
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                read,
            },
        )
        .unwrap()
        .value
}
fn show(f: &Fixture, id: &str) -> DiscussionDetail {
    let LibraryReadValue::Discussion { value } = read(
        f,
        LibraryRead::Discussion {
            discussion_id: id.into(),
            provenance: None,
        },
    ) else {
        panic!("Discussion receipt")
    };
    value
}
fn write(
    f: &Fixture,
    actor: &BoundModuleContext,
    id: &str,
    command: DiscussionCommand,
) -> Result<LibraryApplyOutcome, CoreError> {
    f.library.apply(
        actor,
        ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: id.into(),
            store_epoch: StoreEpoch("epoch-1".into()),
            intent: LibraryIntent::Discussion {
                command: Box::new(command),
                authorization: None,
            },
        },
    )
}
fn value(outcome: LibraryApplyOutcome) -> DiscussionCommandResult {
    outcome.committed.value.discussion.unwrap()
}
fn comment_value(outcome: LibraryApplyOutcome) -> DiscussionComment {
    let DiscussionCommandResult::Comment { value } = value(outcome) else {
        panic!("Comment receipt")
    };
    *value
}
fn comment(body: &str) -> DiscussionCommentDraft {
    DiscussionCommentDraft {
        body: body.into(),
        to_nodex: false,
        ask_kind: None,
        ask_agent: None,
        requested_session_id: None,
        verdict: None,
        suggested_edit: None,
        question_for: None,
    }
}
fn create(anchor: DiscussionAnchor, draft: DiscussionCommentDraft) -> DiscussionCommand {
    DiscussionCommand::Create {
        page_id: PAGE.into(),
        discussion_id: None,
        first_comment_id: None,
        anchor,
        text_range: None,
        quote: None,
        first_comment: Box::new(draft),
    }
}
fn create_id(outcome: LibraryApplyOutcome) -> String {
    let DiscussionCommandResult::Discussion { value } = value(outcome) else {
        panic!("Discussion receipt")
    };
    value.id
}

fn doc_write(
    f: &Fixture,
    actor: &BoundModuleContext,
    operation: &str,
    document: &str,
    commands: Vec<ContractDocumentBlockOperation>,
) -> Result<crate::document::OwnedDocumentApplyOutcome, CoreError> {
    let head = document_heads(&f.kernel, &[document]).pop().unwrap();
    OwnedDocumentModule::new("profile-1", "library-1", &f.kernel).apply(
        actor,
        ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: operation.into(),
            store_epoch: StoreEpoch("epoch-1".into()),
            intent: OwnedDocumentIntent::ApplyOperationBatch {
                document_id: document.into(),
                generation: head.generation,
                expected_head_seq: head.expected_head_seq,
                operations: commands,
                actor: Value::Null,
            },
        },
    )
}
fn root(f: &Fixture) -> String {
    f.kernel.readers().read_default(|connection| {
        Ok(connection.query_row("SELECT block_id FROM document_block_index WHERE document_id=?1 ORDER BY ordinal LIMIT 1", [DOC], |row| row.get(0))?)
    }).unwrap()
}
fn update(id: &str, text: Value) -> ContractDocumentBlockOperation {
    ContractDocumentBlockOperation::UpdateBlock {
        block_id: id.into(),
        patch: nodex_core_contracts::document::DocumentBlockUpdatePatch {
            block_type: None,
            props: None,
            unset_content: false,
            content: nodex_core_contracts::document::DocumentOptionalValue::Value { value: text },
        },
    }
}

fn agent_patch(f: &Fixture, operation: &str, old: &str, new: &str) {
    let head = document_heads(&f.kernel, &[DOC]).pop().unwrap();
    let context = f.execution_context();
    let docs = OwnedDocumentModule::new("profile-1", "library-1", &f.kernel);
    let mutation = AgentDocumentSemanticMutation {
        document_id: DOC.into(),
        generation: head.generation,
        expected_head_seq: head.expected_head_seq,
        commands: vec![DocumentSemanticCommand::PatchBody {
            old_fragment: old.into(),
            new_fragment: new.into(),
            expected_matches: Some(1),
            expected_etag: None,
        }],
    };
    let prepared = docs
        .read(
            &context,
            ModuleReadRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                read: OwnedDocumentRead::PrepareAgentSemanticMutation {
                    operation_id: operation.into(),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    authorization: Box::new(f.authorization.clone()),
                    mutation: Box::new(mutation.clone()),
                },
            },
        )
        .expect("prepare Agent patch");
    let nodex_core_contracts::document::OwnedDocumentReadValue::AgentSemanticMutationPreparation {
        preparation,
        ..
    } = prepared.value
    else {
        panic!("preparation")
    };
    docs.apply(
        &context,
        ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: operation.into(),
            store_epoch: StoreEpoch("epoch-1".into()),
            intent: OwnedDocumentIntent::ExecutePreparedAgentSemanticMutation {
                authorization: Box::new(AgentPreparedExecution {
                    authorization: f.authorization.clone(),
                    token: preparation.token,
                }),
                mutation: Box::new(mutation),
            },
        },
    )
    .expect("Agent patch");
}

fn text(content: &str) -> Value {
    json!([{"type":"text","text":content,"styles":{}}])
}

#[test]
fn discussion_follows_marked_words_through_agent_patch_and_page_transfer() {
    let f = Fixture::projectless();
    let block = root(&f);
    doc_write(
        &f,
        &context(),
        "seed-words",
        DOC,
        vec![update(&block, text("Before marked words after"))],
    )
    .unwrap();
    let mut create = create(
        DiscussionAnchor::Text {
            block_id: block.clone(),
        },
        comment("Discuss the selection."),
    );
    let DiscussionCommand::Create { text_range, .. } = &mut create else {
        unreachable!()
    };
    *text_range = Some(DiscussionTextRange {
        from: 7,
        to: 19,
        expected_text: "marked words".into(),
    });
    let id = create_id(write(&f, &context(), "text-discussion", create).unwrap());
    assert_eq!(show(&f, &id).discussion.quote, "marked words");

    agent_patch(
        &f,
        "agent-paragraph",
        "Before marked words after",
        "Start marked words end",
    );
    let discussion = show(&f, &id).discussion;
    assert_eq!(
        discussion.anchor,
        DiscussionAnchor::Text {
            block_id: block.clone()
        }
    );
    assert_eq!(discussion.anchor_state, DiscussionAnchorState::Live);

    f.apply(
        "destination",
        LibraryIntent::CreatePage {
            page_id: TARGET.into(),
            document_id: TARGET_DOC.into(),
            title: "Destination".into(),
            parent: LibraryWriteParent::Library { before: None },
        },
    );
    f.apply(
        "transfer-mark",
        LibraryIntent::TransferBlocks {
            intent: LibraryBlockTransferLogicalIntent {
                actor: Value::Null,
                mode: LibraryBlockTransferMode::Move,
                root_block_ids: vec![block.clone()],
                causal_dependencies: document_heads(&f.kernel, &[DOC, TARGET_DOC]),
                source: LibraryBlockTransferSource::Page {
                    page_id: PAGE.into(),
                },
                target: LibraryBlockTransferTarget::Page {
                    page_id: TARGET.into(),
                    parent_block_id: None,
                    before_block_id: None,
                },
                promotion_policy:
                    nodex_core_contracts::library::LibraryPagePromotionPolicy::Literal,
            },
        },
    );
    let moved = show(&f, &id);
    assert_eq!(moved.discussion.page_id, TARGET);
    assert_eq!(moved.discussion.anchor_state, DiscussionAnchorState::Live);
    assert_eq!(moved.comments.len(), 1);

    doc_write(
        &f,
        &context(),
        "remove-original",
        TARGET_DOC,
        vec![update(&block, text("Gone"))],
    )
    .unwrap();
    let orphan = show(&f, &id);
    assert_eq!(
        orphan.discussion.anchor_state,
        DiscussionAnchorState::Orphaned
    );
    assert_eq!(orphan.discussion.quote, "marked words");
}

#[test]
fn mark_and_discussion_creation_converge_in_either_order() {
    let f = Fixture::projectless();
    let block = root(&f);
    let discussion_id = "019b1000-1000-7000-8000-000000000001".to_owned();
    let first_comment_id = "019b1000-1000-7000-8000-000000000002".to_owned();
    for (index, mark_first) in [false, true].into_iter().enumerate() {
        let id = format!("{}{}", &discussion_id[..35], index + 1);
        let comment_id = format!("{}{}", &first_comment_id[..35], index + 3);
        let add_mark = || {
            doc_write(&f, &context(), &format!("mark:{index}"), DOC, vec![update(
            &block, json!([{"type":"text","text":"selection","styles":{"comment":{"threadId":id,"orphan":false}}}]),
        )]).unwrap()
        };
        if mark_first {
            add_mark();
        }
        let create = DiscussionCommand::Create {
            page_id: PAGE.into(),
            discussion_id: Some(id.clone()),
            first_comment_id: Some(comment_id.clone()),
            anchor: DiscussionAnchor::Text {
                block_id: block.clone(),
            },
            text_range: None,
            quote: Some("selection".into()),
            first_comment: Box::new(comment("Late anchor")),
        };
        assert_eq!(
            create_id(write(&f, &context(), &format!("row:{index}"), create.clone()).unwrap()),
            id
        );
        let expected = if mark_first {
            DiscussionAnchorState::Live
        } else {
            DiscussionAnchorState::Orphaned
        };
        assert_eq!(show(&f, &id).discussion.anchor_state, expected);
        if !mark_first {
            add_mark();
        }
        let replay = write(&f, &context(), &format!("fresh-request:{index}"), create).unwrap();
        assert!(!replay.committed.receipt.did_mutate);
        let live = show(&f, &id);
        assert_eq!(live.discussion.anchor_state, DiscussionAnchorState::Live);
        assert_eq!(
            live.comments
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            [comment_id]
        );
    }
}

#[test]
fn discussion_lifecycle_and_ask_queue_are_durable() {
    let f = Fixture::projectless();
    let owner: String = f
        .kernel
        .readers()
        .read_default(|c| crate::infrastructure::actors::local_member(c, "library-1"))
        .unwrap();
    let mut first = comment(&format!("Can you check with <nodex://members/{owner}>?"));
    first.to_nodex = true;
    first.ask_kind = Some(DiscussionAskKind::Check);
    first.requested_session_id = Some("preferred-session".into());
    first.ask_agent = Some(DiscussionAskAgent {
        provider_instance_id: "codex-1".into(),
        model: "model".into(),
        options: json!({"effort":"high"}),
    });
    let result = write(&f, &context(), "ask", create(DiscussionAnchor::Page, first)).unwrap();
    let event = result.event.as_ref().expect("durable queue event");
    assert!(
        matches!(&event.payload, nodex_core_contracts::CoreModuleEventPayload::Library(event)
        if event.kind == nodex_core_contracts::library::LibraryEventKind::DiscussionAskQueued)
    );
    let id = create_id(result);
    let f = f.restart();
    let LibraryReadValue::QueuedDiscussionAsks { value: queue } = read(
        &f,
        LibraryRead::QueuedDiscussionAsks {
            cursor: None,
            limit: Some(1),
        },
    ) else {
        panic!("queued Ask window")
    };
    let first = queue.items[0].comment.clone();
    assert_eq!(first.mentions, vec![owner]);
    assert_eq!(
        first.ask.as_ref().unwrap().requested_session_id.as_deref(),
        Some("preferred-session")
    );
    let advance = |operation, from, to, session, run| {
        write(
            &f,
            &context(),
            operation,
            DiscussionCommand::UpdateAsk {
                comment_id: first.id.clone(),
                expected_state: from,
                state: to,
                session_id: session,
                run_id: run,
                agent: None,
            },
        )
    };
    use DiscussionAskState::*;
    assert_eq!(
        advance("skip", Queued, Answered, None, None)
            .unwrap_err()
            .code,
        CoreErrorCode::RevisionConflict
    );
    advance(
        "working",
        Queued,
        Working,
        Some("session".into()),
        Some("run".into()),
    )
    .unwrap();
    advance("fail", Working, Failed, None, None).unwrap();
    let retry = comment_value(advance("retry", Failed, Queued, None, None).unwrap())
        .ask
        .unwrap();
    assert_eq!(retry.state, Queued);
    assert_eq!(retry.run_id, None);
    assert_eq!(
        retry.requested_session_id.as_deref(),
        Some("preferred-session")
    );

    let query = crate::query::QueryModule::new("profile-1", "library-1", &f.kernel);
    let result = query
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: nodex_core_contracts::query::QUERY_CONTRACT_VERSION,
                read: nodex_core_contracts::query::QueryRead::Query {
                    query: nodex_core_contracts::sql::SqlQuery {
                        scope: Default::default(),
                        sql: "SELECT d.anchor_kind,d.waiting_for_nodex,c.ask_kind,c.ask_state
                      FROM discussions d JOIN comments c ON c.discussion_id=d.id"
                            .into(),
                        parameters: BTreeMap::new(),
                    },
                },
            },
        )
        .unwrap();
    let nodex_core_contracts::query::QueryReadValue::Query { value } = result.value else {
        panic!("SQL rows")
    };
    assert_eq!(
        value.rows,
        vec![vec![
            json!("page"),
            json!(1),
            json!("check"),
            json!("queued")
        ]]
    );

    let answer = comment_value(
        write(
            &f,
            &context(),
            "reply",
            DiscussionCommand::Reply {
                discussion_id: id.clone(),
                comment: Box::new(comment("An answer.")),
            },
        )
        .unwrap(),
    );
    let answer = comment_value(
        write(
            &f,
            &context(),
            "edit",
            DiscussionCommand::Edit {
                comment_id: answer.id,
                body: "Updated answer.".into(),
            },
        )
        .unwrap(),
    );
    assert!(answer.edited_at.is_some());
    assert_eq!(answer.body, "Updated answer.");
    write(
        &f,
        &context(),
        "delete",
        DiscussionCommand::Delete {
            comment_id: answer.id,
        },
    )
    .unwrap();
    write(
        &f,
        &context(),
        "resolve",
        DiscussionCommand::Resolve {
            discussion_id: id.clone(),
        },
    )
    .unwrap();
    let resolved = show(&f, &id);
    assert_eq!(resolved.discussion.status, DiscussionStatus::Resolved);
    assert!(
        resolved
            .comments
            .iter()
            .any(|comment| comment.deleted_at.is_some())
    );
    write(
        &f,
        &context(),
        "reopen",
        DiscussionCommand::Reopen {
            discussion_id: id.clone(),
        },
    )
    .unwrap();
    assert_eq!(show(&f, &id).discussion.status, DiscussionStatus::Open);
}

#[test]
fn suggestions_are_compare_and_apply_and_run_revert_reports_interleaving() {
    let f = Fixture::projectless();
    let root = root(&f);
    doc_write(
        &f,
        &context(),
        "original",
        DOC,
        vec![update(&root, text("Original"))],
    )
    .unwrap();
    let id = create_id(
        write(
            &f,
            &context(),
            "discussion",
            create(DiscussionAnchor::Page, comment("Review")),
        )
        .unwrap(),
    );
    let suggestion = |op: &str, replacement| {
        let mut suggested = comment("Change the wording.");
        suggested.suggested_edit = Some(SuggestedEditDraft {
            block_ids: vec![root.clone()],
            new_markdown: replacement,
            expected_old_markdown: None,
        });
        comment_value(
            write(
                &f,
                &context(),
                op,
                DiscussionCommand::Reply {
                    discussion_id: id.clone(),
                    comment: Box::new(suggested),
                },
            )
            .unwrap(),
        )
    };
    let stale = suggestion("old-suggestion", "Candidate".into());
    agent_patch(&f, "run-writes", "Original", "Agent's revision");
    let stale = comment_value(
        write(
            &f,
            &context(),
            "try-stale",
            DiscussionCommand::Accept {
                comment_id: stale.id,
            },
        )
        .unwrap(),
    );
    assert_eq!(
        stale.suggested_edit.unwrap().state,
        SuggestedEditState::Stale
    );

    let good = suggestion("fresh-suggestion", "Human decides".into());
    let good = comment_value(
        write(
            &f,
            &context(),
            "accept",
            DiscussionCommand::Accept {
                comment_id: good.id,
            },
        )
        .unwrap(),
    );
    assert_eq!(
        good.suggested_edit.unwrap().state,
        SuggestedEditState::Accepted
    );

    let receipt = value(
        write(
            &f,
            &context(),
            "revert",
            DiscussionCommand::RevertRun {
                page_id: PAGE.into(),
                run_id: f.authorization.provenance.authority.turn_id.clone(),
            },
        )
        .unwrap(),
    );
    let DiscussionCommandResult::RunRevert {
        reverted,
        conflicts,
    } = receipt
    else {
        panic!("revert receipt")
    };
    assert!(reverted.is_empty());
    assert_eq!(
        conflicts,
        vec![RunRevertConflict {
            block_id: root,
            reason: "changed_since_run".into()
        }]
    );
}

#[test]
fn accepting_a_suggested_edit_replaces_the_paragraph_tail_exactly() {
    assert_suggested_edit_applies(
        "Compare four more weeks of usage and review how people move between entry points.",
        "Compare four more weeks of usage and review how people move between channels in December.",
        None,
    );
}

#[test]
fn accepting_a_suggested_edit_inside_a_marked_run_keeps_the_surviving_anchor() {
    assert_suggested_edit_applies(
        "Please **keep the OLD text**.",
        "Please **keep the NEW text**.",
        Some((7, "keep the OLD text", "keep the  text")),
    );
}

#[test]
fn accepting_a_suggested_edit_after_a_mention_keeps_the_mention() {
    assert_suggested_edit_applies(
        "See <nodex://pages/page%3Atarget> for entry points.",
        "See <nodex://pages/page%3Atarget> for channels in December.",
        None,
    );
}

#[test]
fn accepting_a_suggested_edit_after_cjk_and_emoji_preserves_the_text() {
    assert_suggested_edit_applies(
        "分析🧭の entry points.",
        "分析🧭の channels in December.",
        None,
    );
}

fn assert_suggested_edit_applies(
    original: &str,
    replacement: &str,
    marked: Option<(u32, &str, &str)>,
) {
    let f = Fixture::projectless();
    let block = root(&f);
    let parsed = crate::domain::markdown::parse_markdown(original).unwrap();
    let mut body =
        crate::domain::markdown::materialize_markdown_blocks_with_ids(&parsed, &mut || {
            block.clone()
        })
        .unwrap();
    doc_write(
        &f,
        &context(),
        "original",
        DOC,
        vec![update(&block, body.remove(0).content.unwrap())],
    )
    .unwrap();

    let marked_discussion = marked.map(|(from, quote, retained_quote)| {
        let mut command = create(
            DiscussionAnchor::Text {
                block_id: block.clone(),
            },
            comment("Keep this part of the paragraph."),
        );
        let DiscussionCommand::Create { text_range, .. } = &mut command else {
            unreachable!()
        };
        *text_range = Some(DiscussionTextRange {
            from,
            to: from + quote.encode_utf16().count() as u32,
            expected_text: quote.into(),
        });
        (
            create_id(write(&f, &context(), "mark-text", command).unwrap()),
            retained_quote,
        )
    });

    let mut draft = comment("Update the paragraph.");
    draft.suggested_edit = Some(SuggestedEditDraft {
        block_ids: vec![block.clone()],
        new_markdown: replacement.into(),
        expected_old_markdown: Some(original.into()),
    });
    let discussion = create_id(
        write(
            &f,
            &context(),
            "suggest-tail",
            create(DiscussionAnchor::Page, draft),
        )
        .unwrap(),
    );
    let suggested = show(&f, &discussion).comments.remove(0);
    let edit = suggested.suggested_edit.unwrap();
    assert_eq!(edit.old_markdown, original);
    assert_eq!(edit.new_markdown, replacement);
    let accepted = comment_value(
        write(
            &f,
            &context(),
            "accept-tail",
            DiscussionCommand::Accept {
                comment_id: suggested.id,
            },
        )
        .unwrap(),
    );
    assert_eq!(
        accepted.suggested_edit.unwrap().state,
        SuggestedEditState::Accepted
    );

    let snapshot = OwnedDocumentModule::new("profile-1", "library-1", &f.kernel)
        .read(
            &f.execution_context(),
            ModuleReadRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                read: OwnedDocumentRead::AgentSemanticSnapshot {
                    store_epoch: StoreEpoch("epoch-1".into()),
                    authorization: Box::new(f.authorization.clone()),
                    document_id: DOC.into(),
                    target_block_id: PAGE.into(),
                    prepare_title: false,
                    prepare_body: false,
                    block_guards: vec![],
                    max_depth: None,
                    cursor: None,
                    limit: None,
                },
            },
        )
        .unwrap();
    let OwnedDocumentReadValue::AgentSemanticSnapshot { snapshot } = snapshot.value else {
        panic!("Page content snapshot")
    };
    assert_eq!(snapshot.markdown.trim_end(), replacement);
    assert_eq!(snapshot.blocks.len(), 1);
    assert_eq!(snapshot.blocks[0].block_id, block);
    if let Some((id, quote)) = marked_discussion {
        let content = snapshot.blocks[0].content.as_ref().unwrap();
        assert_eq!(
            crate::document::discussion_marks::quote(content, &id),
            quote
        );
        assert_eq!(
            show(&f, &id).discussion.anchor_state,
            DiscussionAnchorState::Live
        );
    }
}

#[test]
fn pending_replacement_reanchors_discussion_to_inserted_blocks() {
    let f = Fixture::projectless();
    let block = root(&f);
    let id = create_id(
        write(
            &f,
            &context(),
            "pending-discussion",
            create(DiscussionAnchor::Page, comment("Make a chart")),
        )
        .unwrap(),
    );
    doc_write(
        &f,
        &context(),
        "pending",
        DOC,
        vec![ContractDocumentBlockOperation::UpdateBlock {
            block_id: block,
            patch: nodex_core_contracts::document::DocumentBlockUpdatePatch {
                block_type: Some("pending".into()),
                props: Some(BTreeMap::from([
                    ("intent".into(), json!("Make a chart")),
                    ("discussion".into(), json!(id)),
                ])),
                content: nodex_core_contracts::document::DocumentOptionalValue::Absent,
                unset_content: true,
            },
        }],
    )
    .unwrap();
    agent_patch(
        &f,
        "answer",
        &format!(r#"::pending{{intent="Make a chart" discussion="{id}"}}"#),
        "The chart\n\nIts findings",
    );
    let active = show(&f, &id).discussion;
    let DiscussionAnchor::Blocks { block_ids } = active.anchor else {
        panic!("replacement block anchor")
    };
    assert_eq!(block_ids.len(), 2);
    assert_eq!(active.anchor_state, DiscussionAnchorState::Live);
    let LibraryReadValue::DiscussionBlockWriters { items } = read(
        &f,
        LibraryRead::DiscussionBlockWriters {
            page_id: PAGE.into(),
        },
    ) else {
        panic!("Block writers")
    };
    for block in block_ids {
        let writer = items
            .iter()
            .find(|writer| writer.block_id == block)
            .unwrap();
        assert!(
            matches!(&writer.actor, Actor::Agent { run_id: Some(run), .. } if run == "turn:actor")
        );
    }
}

#[test]
fn commenter_and_its_agent_can_suggest_but_cannot_write_page_content() {
    let f = Fixture::projectless();
    let block = root(&f);
    doc_write(
        &f,
        &context(),
        "set-body",
        DOC,
        vec![update(&block, text("Original"))],
    )
    .unwrap();
    let membership =
        crate::library::membership::LibraryMembership::new(&f.kernel, "library-1".into());
    let invite = membership
        .invite(
            InviteRequest {
                role: MemberRole::Commenter,
                member_id: None,
            },
            ListenerInfo {
                peer_policy: Default::default(),
                routes: vec![],
                url: "https://localhost".into(),
                fingerprint: "test".into(),
            },
        )
        .unwrap();
    let enrolled = membership
        .enroll(EnrollmentRequest {
            form_factor: Default::default(),
            code: invite.code,
            device_label: "Laptop".into(),
            display_name: "Reviewer".into(),
        })
        .unwrap();
    let session = membership
        .session(SessionRequest {
            device_credential: enrolled.device_credential,
        })
        .unwrap();
    let principal = membership.authenticate(&session.session_token).unwrap();
    assert_eq!(principal.role, MemberRole::Commenter);
    let member = BoundModuleContext {
        adapter: AdapterKind::RemoteMember,
        principal: Some(principal.clone()),
        ..context()
    };
    let session_id: String = f
        .kernel
        .readers()
        .read_default(|c| {
            crate::infrastructure::actors::turn_session(c, &f.authorization.provenance)
        })
        .unwrap();
    let captured_id = session_id.clone();
    let caller = principal.member_id.clone();
    let run_id = f.authorization.provenance.authority.turn_id.clone();
    let captured_run = run_id.clone();
    f.kernel
        .writer()
        .call(move |c| {
            c.execute(
                "INSERT INTO session_run_members(session_id,run_id,member_id) VALUES (?1,?2,?3)",
                params![captured_id, captured_run, caller],
            )?;
            Ok(())
        })
        .unwrap();
    let agent = BoundModuleContext {
        adapter: AdapterKind::Agent,
        agent_attribution: Some(nodex_core_contracts::BoundAgentAttribution {
            session_id,
            run_id: Some(run_id),
            driver: "codex".into(),
        }),
        ..context()
    };
    let id = create_id(
        write(
            &f,
            &member,
            "review",
            create(DiscussionAnchor::Page, comment("Review.")),
        )
        .unwrap(),
    );
    let document = OwnedDocumentModule::new("profile-1", "library-1", &f.kernel);
    let read = |read| {
        document
            .read(
                &member,
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read,
                },
            )
            .unwrap()
            .value
    };
    let OwnedDocumentReadValue::Descriptor { descriptor } = read(OwnedDocumentRead::Descriptor {
        owner_block_id: PAGE.into(),
    }) else {
        panic!("Commenter can read the Page descriptor")
    };
    let sync = || {
        read(OwnedDocumentRead::SyncYjs {
            document_id: DOC.into(),
            state_vector: vec![0],
            history_after_head_seq: None,
        })
    };
    let OwnedDocumentReadValue::YjsSync {
        descriptor: synced,
        update: full_state,
        ..
    } = sync()
    else {
        panic!("Commenter can read the Page's Yjs content")
    };
    assert_eq!(synced, descriptor);
    let nodex_core_contracts::document::OwnedDocumentSyncDescriptor::Yjs { state_vector } =
        &descriptor.sync
    else {
        panic!("Page is a Yjs Document")
    };
    let attempted = crate::document::prepare_document_operation_update(
        DOC,
        crate::document::BlockDocumentSchema::PageV4,
        &full_state,
        state_vector.as_slice(),
        &[crate::document::DocumentBlockOperation::UpdateBlock {
            block_id: block.clone(),
            patch: crate::document::DocumentBlockUpdatePatch {
                content: Some(text("Unauthorized Yjs edit")),
                ..Default::default()
            },
        }],
        false,
    )
    .unwrap();
    for (index, actor) in [&member, &agent].into_iter().enumerate() {
        let apply = |operation: &str, intent| {
            document.apply(
                actor,
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: format!("{operation}-{index}"),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent,
                },
            )
        };
        assert_eq!(
            apply(
                "prepare-denied",
                OwnedDocumentIntent::PrepareOwner {
                    owner_block_id: PAGE.into(),
                }
            )
            .unwrap_err()
            .code,
            CoreErrorCode::Unauthorized
        );
        assert_eq!(
            apply(
                "yjs-denied",
                OwnedDocumentIntent::ApplyYjsUpdate {
                    document_id: DOC.into(),
                    generation: descriptor.generation,
                    base_head_seq: descriptor.head_seq,
                    update_id: format!("yjs-denied-{index}"),
                    touched_block_ids: vec![block.clone()],
                    update: attempted.update_v1.clone(),
                }
            )
            .unwrap_err()
            .code,
            CoreErrorCode::Unauthorized
        );

        assert_eq!(
            doc_write(
                &f,
                actor,
                &format!("denied-{index}"),
                DOC,
                vec![update(&block, text("No"))]
            )
            .unwrap_err()
            .code,
            CoreErrorCode::Unauthorized
        );
        assert_eq!(
            write(
                &f,
                actor,
                &format!("setting-denied-{index}"),
                DiscussionCommand::SetPageSetting {
                    page_id: PAGE.into(),
                    nodex_answers_questions: true
                }
            )
            .unwrap_err()
            .code,
            CoreErrorCode::Unauthorized
        );
        let mut suggestion = comment("Try this wording.");
        suggestion.suggested_edit = Some(SuggestedEditDraft {
            block_ids: vec![block.clone()],
            new_markdown: "Suggested".into(),
            expected_old_markdown: None,
        });
        let authored = comment_value(
            write(
                &f,
                actor,
                &format!("suggest-{index}"),
                DiscussionCommand::Reply {
                    discussion_id: id.clone(),
                    comment: Box::new(suggestion),
                },
            )
            .unwrap(),
        );
        assert_eq!(
            authored.author.member_id(),
            Some(principal.member_id.as_str())
        );
        assert_eq!(
            write(
                &f,
                actor,
                &format!("accept-denied-{index}"),
                DiscussionCommand::Accept {
                    comment_id: authored.id
                }
            )
            .unwrap_err()
            .code,
            CoreErrorCode::Unauthorized
        );
    }
    let OwnedDocumentReadValue::YjsSync {
        descriptor: after,
        update,
        ..
    } = sync()
    else {
        panic!("Page remains readable after denied writes")
    };
    assert_eq!(after, descriptor);
    assert_eq!(update, full_state);
}

#[test]
fn ask_reservation_survives_restart_and_stop_settles_once() {
    let f = Fixture::projectless();
    f.workspace_apply(
        "bind-other-chat",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            pending_historical_run_id: None,
            decision_run: None,
            session_id: "someone-elses-chat".into(),
            project_id: None,
            title: "Another Member's chat".into(),
            initial_page_ids: vec![],
            agent_selection: None,
            runtime_id: "runtime".into(),
            runtime_thread_id: "other-thread".into(),
            launch_request_id: "other-launch".into(),
            side_chat_source_session_id: None,
        },
    );
    f.kernel.writer().call(|c| {
        c.execute("UPDATE libraries SET space_kind='team' WHERE id='library-1'", [])?;
        c.execute("INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES('another','library-1','Another Member','active','member')", [])?;
        c.execute("UPDATE session_requesting_members SET member_id='another' WHERE session_id='someone-elses-chat'", [])?;
        Ok(())
    }).unwrap();
    let mut draft = comment("Check this claim");
    draft.to_nodex = true;
    draft.requested_session_id = Some("someone-elses-chat".into());
    let discussion = create_id(
        write(
            &f,
            &context(),
            "start",
            create(DiscussionAnchor::Page, draft),
        )
        .unwrap(),
    );
    let id = show(&f, &discussion).comments[0].id.clone();
    let session = "0195cb9d-b200-7a00-a000-000000000001";
    let message = "page-ask:first-attempt";
    let reserve = DiscussionCommand::ReserveAsk {
        comment_id: id.clone(),
        message_id: message.into(),
        new_session_id: session.into(),
        agent: None,
    };
    let working = comment_value(write(&f, &context(), "reserve", reserve.clone()).unwrap());
    assert_eq!(
        working.ask.as_ref().unwrap().session_id.as_deref(),
        Some(session)
    );
    let f = f.restart();
    let launch_id = working
        .ask
        .as_ref()
        .unwrap()
        .dispatch
        .as_ref()
        .unwrap()
        .launch_id
        .as_ref()
        .unwrap();
    let bind_ask_chat = |initial_page_ids| ProjectWorkspaceIntent::CreateAgentRuntimeSession {
        pending_historical_run_id: None,
        decision_run: None,
        session_id: session.into(),
        project_id: None,
        title: "Ask from Page".into(),
        initial_page_ids,
        agent_selection: None,
        runtime_id: "runtime".into(),
        runtime_thread_id: "ask-thread".into(),
        launch_request_id: launch_id.clone(),
        side_chat_source_session_id: None,
    };
    let workspace = ProjectWorkspaceModule::new("profile-1", "library-1", &f.kernel).unwrap();
    let rejected = workspace.apply(
        &f.execution_context(),
        ModuleApplyRequest {
            contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
            operation_id: "bind-as-page-work".into(),
            store_epoch: StoreEpoch("epoch-1".into()),
            intent: bind_ask_chat(vec![PAGE.into()]),
        },
    );
    assert!(rejected.is_err());
    f.workspace_apply("bind-ask-chat", bind_ask_chat(vec![]));
    let LibraryReadValue::QueuedDiscussionAsks { value: window } = read(
        &f,
        LibraryRead::QueuedDiscussionAsks {
            cursor: None,
            limit: None,
        },
    ) else {
        panic!("Ask queue")
    };
    assert_eq!(window.items[0].comment.ask, working.ask);
    assert_eq!(
        comment_value(write(&f, &context(), "reserve", reserve).unwrap()).ask,
        working.ask
    );
    let observed = comment_value(
        write(
            &f,
            &context(),
            "observe",
            DiscussionCommand::ObserveAsk {
                comment_id: id.clone(),
                message_id: message.into(),
                run_id: "run:first".into(),
                waiting: true,
            },
        )
        .unwrap(),
    );
    assert_eq!(observed.ask.unwrap().state, DiscussionAskState::NeedsYou);
    let stopped = comment_value(
        write(
            &f,
            &context(),
            "stop",
            DiscussionCommand::StopAsk {
                comment_id: id.clone(),
            },
        )
        .unwrap(),
    );
    assert!(stopped.ask.unwrap().dispatch.unwrap().stop_requested);
    let settle = DiscussionCommand::SettleAsk {
        comment_id: id.clone(),
        message_id: message.into(),
        run_id: Some("run:first".into()),
        state: DiscussionAskState::Stopped,
        fallback: format!("I stopped this Ask. <nodex://sessions/{session}>"),
    };
    for _ in 0..2 {
        let stopped = comment_value(write(&f, &context(), "settle", settle.clone()).unwrap())
            .ask
            .unwrap();
        assert_eq!(stopped.state, DiscussionAskState::Stopped);
        assert_eq!(stopped.run_id.as_deref(), Some("run:first"));
    }
    let detail = show(&f, &discussion);
    assert_eq!(detail.comments.len(), 2);
    assert_eq!(
        detail.comments[1].author.member_id(),
        detail.comments[0].author.member_id()
    );
    assert!(detail.comments[1].body.contains(session));
    let retried = comment_value(
        write(
            &f,
            &context(),
            "retry",
            DiscussionCommand::UpdateAsk {
                comment_id: id,
                expected_state: DiscussionAskState::Stopped,
                state: DiscussionAskState::Queued,
                session_id: None,
                run_id: None,
                agent: None,
            },
        )
        .unwrap(),
    )
    .ask
    .unwrap();
    assert!(retried.dispatch.is_none());
    assert!(retried.run_id.is_none());
    let reused = comment_value(
        write(
            &f,
            &context(),
            "reserve-retry",
            DiscussionCommand::ReserveAsk {
                comment_id: detail.comments[0].id.clone(),
                message_id: "page-ask:second-attempt".into(),
                new_session_id: "0195cb9d-b200-7a00-a000-000000000002".into(),
                agent: None,
            },
        )
        .unwrap(),
    )
    .ask
    .unwrap();
    assert_eq!(reused.session_id.as_deref(), Some(session));
    assert_eq!(reused.dispatch.as_ref().unwrap().launch_id, None);
}

#[test]
fn asks_use_requested_conversations_without_page_work() {
    let f = Fixture::projectless();
    let fresh = "0195cb9d-b200-7a00-a000-000000000001";
    use nodex_core_contracts::workspace::{NodexDecisionRunInput, NodexDecisionRunKind};
    for (chat, pages, decision_run, expected) in [
        ("linked-chat", vec![PAGE.into()], None, fresh),
        ("ordinary-chat", vec![], None, "ordinary-chat"),
        (
            "decision-chat",
            vec![],
            Some(NodexDecisionRunInput {
                kind: NodexDecisionRunKind::Routing,
                request_id: "routing-request".into(),
                generation: 1,
            }),
            fresh,
        ),
    ] {
        f.workspace_apply(
            &format!("bind-{chat}"),
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                pending_historical_run_id: None,
                decision_run,
                session_id: chat.into(),
                project_id: None,
                title: "Conversation".into(),
                initial_page_ids: pages,
                agent_selection: None,
                runtime_id: "runtime".into(),
                runtime_thread_id: format!("thread:{chat}"),
                launch_request_id: format!("launch:{chat}"),
                side_chat_source_session_id: None,
            },
        );
        let mut draft = comment("Check this claim");
        draft.to_nodex = true;
        draft.requested_session_id = Some(chat.into());
        let discussion = create_id(
            write(
                &f,
                &context(),
                &format!("start-{chat}"),
                create(DiscussionAnchor::Page, draft),
            )
            .unwrap(),
        );
        let reserved = comment_value(
            write(
                &f,
                &context(),
                &format!("reserve-{chat}"),
                DiscussionCommand::ReserveAsk {
                    comment_id: show(&f, &discussion).comments[0].id.clone(),
                    message_id: format!("page-ask:{chat}"),
                    new_session_id: fresh.into(),
                    agent: None,
                },
            )
            .unwrap(),
        );
        assert_eq!(reserved.ask.unwrap().session_id.as_deref(), Some(expected));
    }
}

#[test]
fn auto_answer_and_discussion_inbox_use_the_eligible_members() {
    let f = Fixture::projectless();
    let local = f
        .kernel
        .readers()
        .read_default(|c| crate::infrastructure::actors::local_member(c, "library-1"))
        .unwrap();
    write(
        &f,
        &context(),
        "auto-answer",
        DiscussionCommand::SetPageSetting {
            page_id: PAGE.into(),
            nodex_answers_questions: true,
        },
    )
    .unwrap();
    let mut direct = comment("Could you explain?");
    direct.question_for = Some(local.clone());
    for (operation, draft, auto) in [
        ("question", comment("How is this calculated？"), true),
        ("statement", comment("A helpful reference."), false),
        ("direct", direct, false),
        (
            "mention",
            comment(&format!("<nodex://members/{local}> Can you check?")),
            false,
        ),
    ] {
        let id = create_id(
            write(
                &f,
                &context(),
                operation,
                create(DiscussionAnchor::Page, draft),
            )
            .unwrap(),
        );
        let item = &show(&f, &id).comments[0];
        assert_eq!(item.ask.is_some(), auto);
        if let Some(ask) = &item.ask {
            assert_eq!(ask.requester_id.as_deref(), Some(local.as_str()));
        }
    }
    let LibraryReadValue::DiscussionInbox { value: window } = read(
        &f,
        LibraryRead::DiscussionInbox {
            cursor: None,
            limit: Some(10),
        },
    ) else {
        panic!("Discussion Inbox")
    };
    assert_eq!(window.items.len(), 1);
    assert_eq!(window.items[0].reason, DiscussionInboxReason::NeedsYou);
    assert_eq!(window.items[0].excerpt, "Could you explain?");
}

fn discussion_inbox(f: &Fixture) -> Vec<DiscussionInboxEntry> {
    let LibraryReadValue::DiscussionInbox { value } = read(
        f,
        LibraryRead::DiscussionInbox {
            cursor: None,
            limit: None,
        },
    ) else {
        panic!("Discussion Inbox")
    };
    value.items
}

fn inbox_suggestion(f: &Fixture, discussion: &str, operation: &str) -> DiscussionComment {
    let mut draft = comment("A suggested clarification.");
    draft.suggested_edit = Some(SuggestedEditDraft {
        block_ids: vec![root(f)],
        new_markdown: "Clarified text.".into(),
        expected_old_markdown: None,
    });
    comment_value(
        write(
            f,
            &context(),
            operation,
            DiscussionCommand::Reply {
                discussion_id: discussion.into(),
                comment: Box::new(draft),
            },
        )
        .unwrap(),
    )
}

fn set_inbox_fixture_author(f: &Fixture, comment_id: &str, actor: Actor) {
    let comment_id = comment_id.to_owned();
    f.kernel
        .writer()
        .call(move |c| {
            c.execute(
                "UPDATE page_discussion_comments SET author_json=?1 WHERE id=?2",
                params![serde_json::to_string(&actor).unwrap(), comment_id],
            )?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn owners_only_receive_inbox_suggestions_from_someone_else() {
    let f = Fixture::projectless();
    let owner = f
        .kernel
        .readers()
        .read_default(|c| crate::infrastructure::actors::local_member(c, "library-1"))
        .unwrap();
    let other = "other-member";
    let work = json!({"owner": owner, "assignee": null, "auto_start": false}).to_string();
    f.kernel
        .writer()
        .call(move |c| {
            c.execute("UPDATE libraries SET space_kind='team' WHERE id='library-1'", [])?;
            c.execute(
                "INSERT INTO members(id,library_id,display_name,lifecycle,role)
                 VALUES (?1,'library-1','Other Member','active','member')",
                [other],
            )?;
            c.execute(
                "INSERT INTO block_properties(block_id,library_id,property_key,value_type,value_json,revision,updated_at)
                 VALUES (?1,'library-1','work','json',?2,1,?3)
                 ON CONFLICT(block_id,property_key) DO UPDATE SET value_json=excluded.value_json",
                params![PAGE, work, NOW],
            )?;
            Ok(())
        })
        .unwrap();

    let mut expected = Vec::new();
    for (operation, author, recipient) in [
        (
            "own-member",
            Actor::Member {
                member_id: owner.clone(),
            },
            false,
        ),
        (
            "other-member",
            Actor::Member {
                member_id: other.into(),
            },
            true,
        ),
        (
            "own-agent",
            Actor::Agent {
                session_id: "session:own".into(),
                run_id: None,
                on_behalf_of: owner.clone(),
            },
            false,
        ),
        (
            "other-agent",
            Actor::Agent {
                session_id: "session:other".into(),
                run_id: None,
                on_behalf_of: other.into(),
            },
            true,
        ),
    ] {
        let discussion = create_id(
            write(
                &f,
                &context(),
                operation,
                create(DiscussionAnchor::Page, comment("Review this Page.")),
            )
            .unwrap(),
        );
        let suggestion = inbox_suggestion(&f, &discussion, &format!("suggest-{operation}"));
        set_inbox_fixture_author(&f, &suggestion.id, author);
        let suggestion_id = suggestion.id.clone();
        f.kernel
            .writer()
            .call(move |c| {
                c.execute(
                    "UPDATE page_discussion_comments SET created_at='2000-01-01T00:00:00.000Z'
                 WHERE discussion_id=?1 AND id<>?2",
                    params![discussion, suggestion_id],
                )?;
                Ok(())
            })
            .unwrap();
        if recipient {
            expected.push(suggestion.id);
        }
    }

    let items = discussion_inbox(&f);
    let mut ids = items
        .iter()
        .map(|item| item.comment_id.clone())
        .collect::<Vec<_>>();
    expected.sort();
    ids.sort();
    assert_eq!(ids, expected);
    assert!(
        items
            .iter()
            .all(|item| item.reason == DiscussionInboxReason::SuggestedEdit)
    );
}

fn answered_ask(f: &Fixture) -> String {
    let block = root(f);
    doc_write(
        f,
        &context(),
        "body",
        DOC,
        vec![update(&block, text("Original"))],
    )
    .unwrap();
    let mut ask = comment("Could you check this?");
    ask.to_nodex = true;
    let discussion =
        create_id(write(f, &context(), "ask", create(DiscussionAnchor::Page, ask)).unwrap());
    let request = show(f, &discussion).comments.remove(0);
    let session = "session:answer";
    let run = "run:answer";
    for (operation, expected_state, state) in [
        (
            "start-answer",
            DiscussionAskState::Queued,
            DiscussionAskState::Working,
        ),
        (
            "settle-answer",
            DiscussionAskState::Working,
            DiscussionAskState::Answered,
        ),
    ] {
        write(
            f,
            &context(),
            operation,
            DiscussionCommand::UpdateAsk {
                comment_id: request.id.clone(),
                expected_state,
                state,
                session_id: Some(session.into()),
                run_id: Some(run.into()),
                agent: None,
            },
        )
        .unwrap();
    }
    let answer = comment_value(
        write(
            f,
            &context(),
            "answer",
            DiscussionCommand::Reply {
                discussion_id: discussion.clone(),
                comment: Box::new(comment("I checked it.")),
            },
        )
        .unwrap(),
    );
    set_inbox_fixture_author(
        f,
        &answer.id,
        Actor::Agent {
            session_id: session.into(),
            run_id: Some(run.into()),
            on_behalf_of: request.author.member_id().unwrap().into(),
        },
    );
    let answer_id = answer.id.clone();
    let discussion_id = discussion.clone();
    f.kernel
        .writer()
        .call(move |c| {
            // Fix the earlier activity times so the deciding write is later even on a fast clock.
            c.execute(
                "UPDATE page_discussion_comments SET created_at=CASE id
                   WHEN ?1 THEN '2000-01-01T00:00:01.000Z' ELSE '2000-01-01T00:00:00.000Z' END
                 WHERE discussion_id=?2",
                params![answer_id, discussion_id],
            )?;
            Ok(())
        })
        .unwrap();

    let inbox = discussion_inbox(f);
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].comment_id, answer.id);
    assert_eq!(inbox[0].reason, DiscussionInboxReason::Answered);
    discussion
}

#[test]
fn accepting_a_suggested_edit_clears_an_answered_ask_from_the_inbox() {
    let f = Fixture::projectless();
    let discussion = answered_ask(&f);
    let comment_id = inbox_suggestion(&f, &discussion, "suggest").id;
    let decided = comment_value(
        write(
            &f,
            &context(),
            "accept",
            DiscussionCommand::Accept { comment_id },
        )
        .unwrap(),
    );
    assert_eq!(
        decided.suggested_edit.unwrap().state,
        SuggestedEditState::Accepted
    );
    assert!(discussion_inbox(&f).is_empty());
}

#[test]
fn rejecting_a_suggested_edit_clears_an_answered_ask_from_the_inbox() {
    let f = Fixture::projectless();
    let discussion = answered_ask(&f);
    let comment_id = inbox_suggestion(&f, &discussion, "suggest").id;
    let decided = comment_value(
        write(
            &f,
            &context(),
            "reject",
            DiscussionCommand::Reject { comment_id },
        )
        .unwrap(),
    );
    assert_eq!(
        decided.suggested_edit.unwrap().state,
        SuggestedEditState::Rejected
    );
    assert!(discussion_inbox(&f).is_empty());
}

#[test]
fn replying_clears_an_answered_ask_from_the_inbox() {
    let f = Fixture::projectless();
    let discussion_id = answered_ask(&f);
    write(
        &f,
        &context(),
        "reply",
        DiscussionCommand::Reply {
            discussion_id,
            comment: Box::new(comment("Thanks, that answers it.")),
        },
    )
    .unwrap();
    assert!(discussion_inbox(&f).is_empty());
}
