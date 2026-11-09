//! Fail-closed semantic admission for the remote Member adapter. New commands
//! require an explicit decision here before the network can reach them.
use crate::{AdapterKind, BoundModuleContext, CoreError, CoreErrorCode, CoreErrorRecovery};
use serde::Serialize;
pub fn authorize(
    context: &BoundModuleContext,
    module: &str,
    command: &impl Serialize,
) -> Result<(), CoreError> {
    if context.adapter != AdapterKind::RemoteMember {
        return Ok(());
    }
    let Some(principal) = &context.principal else {
        return Err(denied());
    };
    if principal.space_id != context.library_id.0 {
        return Err(denied());
    }
    let encoded = serde_json::to_value(command).map_err(|_| denied())?;
    let kind = encoded
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let allowed = match module {
        "library_read" => matches!(
            kind,
            "metadata"
                | "local_member"
                | "members"
                | "files"
                | "file"
                | "file_presentation"
                | "file_usages"
                | "file_versions"
                | "page_file_inventory"
                | "resolve_page_file"
                | "children"
                | "standalone_roots"
                | "path"
                | "catalog"
                | "move_destinations"
                | "page_relocation_destinations"
                | "page_mention_destination"
                | "page_detail"
                | "page_content"
                | "page_target"
                | "page_key_target"
                | "page_ownership_path"
                | "page_location"
                | "canvas_target"
                | "view_location"
                | "page_lifecycle_preflight"
                | "search"
                | "project_page_search"
                | "project_page_search_facets"
                | "project_page_search_metadata"
                | "page_reference_candidates"
                | "page_backlinks"
                | "page_history"
        ),
        "library_apply" => matches!(
            kind,
            "put_page_file_entry"
                | "apply_page_file_entries"
                | "transfer_page_file_entry"
                | "apply_file_change"
                | "create_page"
                | "create_page_mention"
                | "create_pages_from_text"
                | "create_page_from_text"
                | "create_database"
                | "create_canvas"
                | "rename_canvas"
                | "move_canvas"
                | "duplicate_canvas"
                | "delete_canvas"
                | "copy_page"
                | "duplicate_page"
                | "move_page"
                | "delete_page"
                | "move_block"
                | "archive_resource"
                | "restore_resource"
                | "apply_page_lifecycle"
                | "apply_block_property_mutation"
                | "apply_page_metadata_properties"
                | "apply_structural_edit"
                | "reverse_structural_edit"
                | "transfer_blocks"
                | "undo_block_transfer"
                | "undo_page_relocation"
        ),
        "database_read" => matches!(
            kind,
            "view_personal_preferences"
                | "view_collapsed_occurrences"
                | "work_context"
                | "catalog_window"
                | "database"
                | "page_key_prefix_preview"
                | "page_key_namespace"
                | "data_source_window"
                | "data_source"
                | "property_window"
                | "option_window"
                | "page_layout"
                | "view_descriptor_window"
                | "view"
                | "data_source_query"
                | "view_window"
                | "list_window"
                | "view_groups"
                | "view_context"
                | "rows_by_id"
                | "row_detail"
                | "ready_work"
                | "blocking"
                | "prerequisites"
                | "relation_target_window"
                | "relation_candidate_window"
        ),
        "database_apply" => matches!(
            kind,
            "put_view_personal_preferences"
                | "set_view_occurrence_disclosure"
                | "configure"
                | "rename_page_key_prefix"
                | "put_property"
                | "move_property"
                | "change_property_type"
                | "duplicate_property"
                | "restore_property"
                | "permanently_delete_property"
                | "delete_property"
                | "put_option"
                | "move_option"
                | "delete_option"
                | "delete_option_and_clear_values"
                | "put_page_layout_entry"
                | "edit_property_values"
                | "transfer_page"
                | "put_view"
                | "duplicate_view"
                | "change_view_layout"
                | "move_view"
                | "delete_view"
                | "position_page"
                | "position_pages"
                | "set_task_parent"
                | "move_list_occurrences"
                | "undo_list_occurrence_move"
                | "reverse_data_edit"
        ),
        "query_read" => matches!(kind, "schema" | "query" | "displayed_view_query"),
        "workspace_read" if kind == "sources" => matches!(
            encoded
                .get("read")
                .and_then(|read| read.get("kind"))
                .and_then(|kind| kind.as_str()),
            Some(
                "sources"
                    | "positions"
                    | "threads"
                    | "triggers"
                    | "open_problems"
                    | "known_pull_requests"
                    | "page_follows"
                    | "deliveries"
            )
        ),
        "workspace_read" => matches!(
            kind,
            "inbox_routing_consent"
                | "inbox_turn_notifications"
                | "activity_window"
                | "execution_holds"
                | "effective_execution_hold"
                | "page_workspace"
                | "page_turn"
                | "page_turns"
                | "page_work_launch"
                | "read_coordinator"
                | "read_managed_session"
                | "read_managed_sessions"
                | "project_bootstrap"
                | "project_window"
                | "project"
                | "project_activity_summaries"
                | "session_linked_page_summaries"
                | "session_sidebar_placements"
                | "page_chat_activity_summaries"
                | "page_chat_window"
                | "session_window"
                | "task_window"
                | "sidebar_overview"
                | "sidebar_section_window"
                | "sidebar_section_item_window"
                | "builtin_sidebar_order"
                | "sidebar_section_placement"
                | "session"
                | "session_start"
                | "inbox_entry"
                | "inbox_summary"
                | "inbox_counts"
                // A Member's Dock counts their own unread chats in the Space.
                | "unread_chat_count"
                | "inbox_window"
                | "inbox_chat_targets"
                | "inbox_message_edit"
                | "session_member_actions"
        ),
        // Agent-authored context and Host interruption delivery never become Member commands.
        "workspace_apply"
            if matches!(
                kind,
                "write_turn_note"
                    | "answer_inbox_question"
                    | "hand_back_message"
                    | "bind_chat_inbound"
            ) =>
        {
            false
        }
        "workspace_apply" if kind == "source" => {
            encoded
                .get("command")
                .and_then(|c| c.get("kind"))
                .and_then(|k| k.as_str())
                == Some("retry_problem")
        }
        // Core ingress additionally requires the exact live Host launch proof: a phone's new chat,
        // or a Member's fork, side chat or saved side chat through the Space host.
        // Only the Member's own side chat, through the exact live Host call that closes it.
        "workspace_apply" if kind == "delete_session" => true,
        // Accepted messages additionally require their exact live execution-owner delivery proof;
        // renaming and archiving require the chat's owner or a Space Owner. Unread state,
        // pins and reminders are the requesting Member's own.
        "workspace_apply" if kind == "mutate_session" => {
            matches!(
                encoded
                    .get("intent")
                    .and_then(|intent| intent.get("kind"))
                    .and_then(|kind| kind.as_str()),
                Some(
                    "set_unread"
                        | "set_pinned"
                        | "set_reminder"
                        | "record_user_message"
                        | "set_archived"
                        | "rename"
                )
            )
        }
        // A Member opens a default draft of their own; Core keeps each Member's draft theirs.
        "workspace_apply" => matches!(
            kind,
            "move_session"
                | "ensure_default_draft_session"
                | "reorder_pinned_sessions"
                | "set_inbox_routing_consent"
                | "claim_turn_notification"
                | "reply_to_page_turn"
                | "pause_work"
                | "resume_work"
                | "start_page_work"
                | "accept_page_work"
                | "send_inbox_message"
                | "keep_inbox_entries"
                | "set_inbox_entry_state"
                | "set_inbox_entry_kind"
                | "set_inbox_entry_important"
                | "edit_inbox_message"
                | "undo_inbox_decision"
                | "revise_inbox_message"
        ),
        "document_read" => matches!(
            kind,
            "recovery"
                | "descriptor"
                | "sync_yjs"
                | "fetch_update"
                | "list_versions"
                | "get_version"
        ),
        "document_apply" => matches!(
            kind,
            "capture_recovery"
                | "resolve_recovery"
                | "prepare_owner"
                | "apply_yjs_update"
                | "apply_semantic_mutation"
                | "apply_operation_batch"
                | "replace_from_markdown"
                | "apply_canvas_mutation"
                | "create_checkpoint"
                | "restore_version"
        ),
        "automation_read" => matches!(
            kind,
            "due_work"
                | "automation_decisions"
                | "automation_notification_policy"
                | "automations"
                | "automation"
                | "automation_for_execution"
                | "leases"
                | "run"
                | "runs"
                | "inbox"
                | "occurrences"
                | "reminder_leases"
                | "reminder_snoozes"
        ),
        "automation_apply" => {
            matches!(
                kind,
                "create_automation"
                    | "set_automation_status"
                    | "update_automation"
                    | "delete_automation"
                    | "dispatch_now"
            )
        }
        _ => false,
    };
    if !allowed {
        return Err(denied());
    }
    Ok(())
}
fn denied() -> CoreError {
    CoreError {
        code: CoreErrorCode::Unauthorized,
        message: "This operation is not admitted for remote membership".into(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

#[cfg(test)]
mod inbox_tests {
    use super::*;
    use crate::library::MemberRole;
    use crate::{LibraryId, ProfileId, RemotePrincipal};
    use serde_json::json;

    fn remote(role: MemberRole) -> BoundModuleContext {
        BoundModuleContext {
            actor: crate::Actor::Service {
                kind: crate::ServiceKind::Maintenance,
            },
            authorizing_member_id: None,
            profile_id: ProfileId("profile".into()),
            library_id: LibraryId("space".into()),
            project_id: None,
            connection_id: "connection".into(),
            adapter: AdapterKind::RemoteMember,
            principal: Some(RemotePrincipal {
                space_id: "space".into(),
                member_id: "person".into(),
                device_id: "device".into(),
                session_id: "session".into(),
                role,
            }),
            agent_attribution: None,
            editor_history_owner: None,
        }
    }
    #[test]
    fn chat_changes_reach_core_while_host_bookkeeping_stays_local() {
        let context = remote(MemberRole::Member);
        let session = |intent: &str| {
            authorize(
                &context,
                "workspace_apply",
                &json!({"kind":"mutate_session","session_id":"chat","intent":{"kind":intent}}),
            )
        };
        // Core's writer decides whether this Member may change the chat itself.
        for intent in [
            "rename",
            "set_archived",
            "set_unread",
            "set_pinned",
            "set_reminder",
        ] {
            assert!(session(intent).is_ok(), "{intent}");
        }
        for kind in [
            "move_session",
            "reorder_pinned_sessions",
            "ensure_default_draft_session",
        ] {
            assert!(authorize(&context, "workspace_apply", &json!({"kind":kind})).is_ok());
        }
        for intent in [
            "set_fallback_title",
            "link_thread",
            "unlink_thread",
            "consume_reminder",
            "complete_reminder_delivery",
        ] {
            assert_eq!(
                session(intent).unwrap_err().code,
                CoreErrorCode::Unauthorized,
                "{intent}"
            );
        }
    }
    #[test]
                json!({"kind":"create_agent_runtime_session","side_chat_source_session_id":"other-chat"}),
    fn remote_inbox_admission_keeps_person_actions_separate_from_host_and_agent_commands() {
        for role in [MemberRole::Member, MemberRole::Owner] {
            let context = remote(role);
            for kind in [
                "inbox_window",
                "inbox_entry",
                "inbox_summary",
                "inbox_counts",
            ] {
                assert!(
                    authorize(&context, "workspace_read", &json!({"kind":kind})).is_ok(),
                    "{kind}"
                );
            }
            for kind in [
                "reply_to_page_turn",
                "accept_page_work",
                "start_page_work",
                "claim_turn_notification",
                "set_inbox_routing_consent",
            ] {
                assert!(
                    authorize(&context, "workspace_apply", &json!({"kind":kind})).is_ok(),
                    "{kind}"
                );
            }
            for kind in [
                "hand_back_message",
                "record_chat_delivery",
                "bind_chat_inbound",
                "write_turn_note",
                "answer_inbox_question",
                "settle_page_work_launch",
                "agent_command",
                "future_inbox_command",
            ] {
                assert_eq!(
                    authorize(&context, "workspace_apply", &json!({"kind":kind}))
                        .unwrap_err()
                        .code,
                    CoreErrorCode::Unauthorized,
                    "{kind}"
                );
            }
            assert_eq!(
                authorize(
                    &context,
                    "workspace_read",
                    &crate::workspace::ProjectWorkspaceRead::ChatMessageInbound {
                        session_id: "chat".into(),
                        run_id: "run".into()
                    }
                )
                .unwrap_err()
                .code,
                CoreErrorCode::Unauthorized
            );
            assert!(
                authorize(
                    &context,
                    "workspace_read",
                    &crate::workspace::ProjectWorkspaceRead::InboxTurnNotifications
                )
                .is_ok()
            );
        }
    }
    #[test]
    fn remote_activity_and_problem_fixes_do_not_grant_sender_authority() {
        for role in [MemberRole::Member, MemberRole::Owner] {
            let context = remote(role);
            assert!(
                authorize(
                    &context,
                    "workspace_read",
                    &json!({"kind":"activity_window"})
                )
                .is_ok()
            );
            assert!(
                authorize(
                    &context,
                    "workspace_apply",
                    &json!({"kind":"source","command":{"kind":"retry_problem"}})
                )
                .is_ok()
            );
            for kind in [
                "reply_to_origin",
                "claim_channel_send",
                "settle_channel_send",
                "record_thread_delivery_failure",
            ] {
                assert_eq!(
                    authorize(
                        &context,
                        "workspace_apply",
                        &json!({"kind":"source","command":{"kind":kind}})
                    )
                    .unwrap_err()
                    .code,
                    CoreErrorCode::Unauthorized
                );
            }
            assert_eq!(
                authorize(
                    &context,
                    "workspace_read",
                    &json!({"kind":"sources","read":{"kind":"channel_outbox"}})
                )
                .unwrap_err()
                .code,
                CoreErrorCode::Unauthorized
            );
        }
    }

    #[test]
    fn remote_automation_access_preserves_source_reads_without_granting_producer_authority() {
        for role in [MemberRole::Member, MemberRole::Owner] {
            let context = remote(role);
            for kind in ["automations", "automation", "automation_decisions", "runs"] {
                assert!(authorize(&context, "automation_read", &json!({"kind":kind})).is_ok());
            }
            for kind in [
                "create_automation",
                "update_automation",
                "delete_automation",
                "set_automation_status",
                "dispatch_now",
            ] {
                // The Automation writer checks its exact Owner and current mode after admission.
                assert!(authorize(&context, "automation_apply", &json!({"kind":kind})).is_ok());
            }
            for kind in ["sources", "page_follows", "deliveries", "open_problems"] {
                assert!(
                    authorize(
                        &context,
                        "workspace_read",
                        &json!({"kind":"sources","read":{"kind":kind}})
                    )
                    .is_ok()
                );
            }
            for kind in [
                "claim_due",
                "begin_run",
                "complete_lease",
                "reschedule_automation",
                "agent_command",
            ] {
                assert_eq!(
                    authorize(&context, "automation_apply", &json!({"kind":kind}))
                        .unwrap_err()
                        .code,
                    CoreErrorCode::Unauthorized
                );
            }
        }
    }
}
