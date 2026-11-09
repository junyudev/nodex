//! Activity describes committed outcomes; labels are hydrated only for the selected window.
use nodex_core_contracts::sources::*;
use serde_json::Value;

pub(super) struct Labels {
    pub page_title: Option<String>,
    pub page_key: Option<String>,
    pub chat_title: Option<String>,
    pub project_title: Option<String>,
    pub automation_name: Option<String>,
    /// Whose request an automatic start answered, as the reader reads it: "your" or "Alice’s".
    pub requester: Option<String>,
}
/// An automatic start names whose request it answered, relative to the reader.
fn on_request(automatic: bool, requester: Option<&str>) -> String {
    match requester {
        Some(requester) if automatic => format!(" on {requester} request"),
        _ => String::new(),
    }
}
fn line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn quoted(text: &str) -> String {
    format!("“{}”", line(text))
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
fn stage(value: &str) -> &str {
    match value {
        "triage" => "Triage",
        "plan" => "Planned",
        "doing" => "In Progress",
        "review" => "In Review",
        "done" => "Done",
        "canceled" => "Canceled",
        _ => "its current stage",
    }
}
fn thread_subject(thread: &Value) -> Option<ActivitySubject> {
    let repository = thread["repository"].as_str()?;
    let number = thread["number"].as_u64()?;
    Some(ActivitySubject::Thread {
        url: thread["url"].as_str()?.into(),
        label: format!("{repository} #{number}"),
    })
}
fn event_object(event: &Value) -> String {
    let person = text(event, "actor_login");
    if text(event, "actor_class") != "person" {
        return format!("a bot {}", event_noun(event));
    }
    if text(event, "kind") == "review" {
        return format!("a review by @{person}");
    }
    format!("@{person}’s {}", event_noun(event))
}
fn event_noun(event: &Value) -> &str {
    match text(event, "kind") {
        "review" => "review",
        "comment" => "comment",
        "review_comment" => "review comment",
        "check" => "check",
        "status" => "status update",
        "mention" | "mentioned" | "discovery_mentions" => "mention",
        "assigned" | "assignment" | "discovery_assigned" => "assignment",
        "review_requested" | "review_request" | "discovery_review_requests" => "review request",
        "opened" | "ready_for_review" | "merged" | "closed" => "PR update",
        _ => "update",
    }
}
fn event_reason(event: &Value, thread: &Value) -> String {
    let number = thread["number"]
        .as_u64()
        .map(|n| n.to_string())
        .unwrap_or_else(|| "?".into());
    let action = match text(event, "kind") {
        "opened" => "opened",
        "ready_for_review" => "marked ready",
        "merged" => "merged",
        "closed" => "closed without merging",
        "review" => "received changes requested",
        _ => "updated",
    };
    format!("PR #{number} {action}")
}
/// A handled message names what was decided for it and where it went; one fact per decision.
fn handled_message(
    row: &mut ActivityRow,
    labels: &Labels,
    message: &str,
    project: &str,
) -> rusqlite::Result<()> {
    let action = &row.evidence["action"];
    let request = on_request(
        row.evidence["confirmed_by"] == "nodex",
        labels.requester.as_deref(),
    );
    let chat = labels
        .chat_title
        .as_deref()
        .filter(|title| !title.trim().is_empty());
    let subject = quoted(message);
    row.description = match text(&row.evidence, "disposition") {
        "chat" => match text(action, "type") {
            "execute_decision" => format!(
                "Started {}",
                quoted(labels.automation_name.as_deref().unwrap_or(message))
            ),
            "new_chat" => format!("Sent {subject} to a new chat{request}"),
            _ => match chat {
                Some(chat) => format!("Sent {subject} to {}{request}", quoted(chat)),
                None => format!("Sent {subject} to a chat{request}"),
            },
        },
        "filed" => format!("Filed {subject} in {project}"),
        "kept" => format!("Kept {subject}"),
        "done" if text(action, "type") == "plan" => {
            let cards = action["steps"].as_u64().unwrap_or_default();
            format!(
                "Planned {cards} {} from {subject}",
                if cards == 1 { "card" } else { "cards" }
            )
        }
        "done" if row.evidence["answered"] == true => format!("Answered {subject}"),
        "done" => format!("Marked {subject} done"),
        "open" => format!("Returned {subject} to the Inbox"),
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    if let Some(session_id) = row.session_id.as_ref() {
        row.subject = Some(ActivitySubject::Chat {
            session_id: session_id.clone(),
            label: line(chat.unwrap_or("Chat")),
        });
    }
    Ok(())
}
fn problem(row: &mut ActivityRow, resolved: bool, page: &str) -> rusqlite::Result<()> {
    let kind = text(&row.evidence, "kind");
    let count = row.evidence["count"].as_u64().unwrap_or(1);
    let quarantined = text(&row.evidence, "scope").contains(":quarantine:");
    let (description, reason) = match (kind, resolved) {
        ("source_failing", false) if quarantined => {
            ("Could not read a GitHub update".into(), row.reason.clone())
        }
        ("source_failing", true) if quarantined => ("Read the GitHub update".into(), None),
        ("source_failing", false) => (
            "GitHub could not be checked".into(),
            Some(format!(
                "Unreachable for {count} {}",
                if count == 1 { "check" } else { "checks" }
            )),
        ),
        ("source_failing", true) => ("GitHub is reachable again".into(), None),
        ("credential_invalid", false) => (
            "GitHub could not connect".into(),
            Some("The selected account needs to reconnect".into()),
        ),
        ("credential_invalid", true) => ("Reconnected GitHub".into(), None),
        ("delivery_failing", false) => (
            format!("Could not deliver an update to {page}"),
            Some(format!(
                "Failed {count} {}",
                if count == 1 { "attempt" } else { "attempts" }
            )),
        ),
        ("delivery_failing", true) => (format!("Delivered the update to {page}"), None),
        ("delivery_unresolved", false) => (
            format!("Could not deliver an update to {page}"),
            Some("The card has no active chat".into()),
        ),
        ("delivery_unresolved", true) => (format!("Found a chat for {page}"), None),
        ("channel_failing", false) => (
            format!("Could not send the reply for {page}"),
            row.reason.clone(),
        ),
        ("channel_failing", true) => (format!("Sent the reply for {page}"), None),
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    row.description = description;
    row.reason = reason;
    Ok(())
}
pub(super) fn present(row: &mut ActivityRow, labels: &Labels) -> rusqlite::Result<()> {
    let message = labels
        .page_title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Untitled");
    let page = labels.page_key.clone().unwrap_or_else(|| quoted(message));
    let chat = labels
        .chat_title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(message);
    let project = labels.project_title.as_deref().unwrap_or("the Project");
    row.subject = row.page_id.as_ref().map(|id| ActivitySubject::Page {
        page_id: id.clone(),
        label: labels.page_key.clone().unwrap_or_else(|| line(message)),
    });
    let kind = row.id.split(':').next().unwrap_or_default();
    match kind {
        "assessment" => {
            let name = labels.automation_name.as_deref().unwrap_or("Automation");
            let outcome = if row.evidence["error"].is_string() {
                "Could not assess"
            } else if row.evidence["matched"] == false {
                "Did not match"
            } else {
                match if text(&row.evidence, "mode") == "dry_run" {
                    "dry_run"
                } else {
                    text(&row.evidence, "admission_mode")
                } {
                    "dry_run" => "Would have started",
                    "ask_first" => "Proposed",
                    _ => "Started",
                }
            };
            row.description = format!("{outcome} {}", quoted(name));
            row.subject = Some(ActivitySubject::Automation {
                automation_id: text(&row.evidence, "automation_id").into(),
                label: line(name),
            });
        }
        "automation" | "automation-settlement" => {
            let name = labels.automation_name.as_deref().unwrap_or("Automation");
            let outcome = if kind == "automation-settlement" {
                match text(&row.evidence, "status") {
                    "skipped" => "Skipped",
                    "withdrawn" => "Withdrew",
                    "failed" => "Could not run",
                    _ => return Err(rusqlite::Error::InvalidQuery),
                }
            } else {
                match text(&row.evidence, "mode") {
                    "dry_run" => "Would have started",
                    "ask_first" if row.evidence["manual"] == true => "Started",
                    "ask_first" => "Proposed",
                    "run" => "Started",
                    _ => return Err(rusqlite::Error::InvalidQuery),
                }
            };
            row.description = format!("{outcome} {}", quoted(name));
            row.subject = Some(ActivitySubject::Automation {
                automation_id: text(&row.evidence, "automation_id").into(),
                label: line(name),
            });
        }
        "message" => handled_message(row, labels, message, project)?,
        "launch" => {
            row.description = format!(
                "{} {}{}",
                if row.reason.is_some() {
                    "Could not start"
                } else {
                    "Started"
                },
                quoted(chat),
                on_request(
                    row.evidence["automatic"] == true,
                    labels.requester.as_deref()
                )
            );
            row.subject = row
                .session_id
                .as_ref()
                .map(|id| ActivitySubject::Chat {
                    session_id: id.clone(),
                    label: line(chat),
                })
                .or(row.subject.take());
        }
        "note" => row.description = format!("Noted on {page}"),
        // A chat that was the wrong destination sends its message back, as the Inbox row says.
        "handback" => row.description = format!("Sent {} back", quoted(message)),
        "milestone" => {
            let moved = row.evidence["moved"] == 1;
            row.description = if moved {
                format!(
                    "Moved {page} to {}",
                    stage(text(&row.evidence, "destination"))
                )
            } else {
                format!("Left {page} in {}", stage(text(&row.evidence, "stage")))
            };
            if moved {
                row.reason = Some(event_reason(
                    &row.evidence["event"],
                    &row.evidence["thread"],
                ));
            }
        }
        "trigger" | "delivery" => {
            let event = &row.evidence["event"];
            let object = event_object(event);
            let thread = thread_subject(&row.evidence["thread"]);
            let label = match &thread {
                Some(ActivitySubject::Thread { label, .. }) => label.as_str(),
                _ => "GitHub",
            };
            row.description = if kind == "trigger" {
                match text(&row.evidence, "disposition") {
                    "followed" => match text(&row.evidence, "delivery_state") {
                        "accepted" => {
                            row.reason = None;
                            format!("Delivered {object} to {}", quoted(chat))
                        }
                        "unresolved" => format!("Could not deliver {object} to {page}"),
                        "suppressed" => format!("Ignored {object} on {label}"),
                        "rejected" => format!("Failed to deliver {object} to {}", quoted(chat)),
                        _ => format!("Queued {object} for {}", quoted(chat)),
                    },
                    "intake" => format!("Sent {object} to the Inbox"),
                    _ => format!("Ignored {object} on {label}"),
                }
            } else {
                match text(&row.evidence, "state") {
                    "accepted" => {
                        row.reason = None;
                        format!("Delivered {object} to {}", quoted(chat))
                    }
                    "suppressed" => format!("Ignored {object} on {label}"),
                    "unresolved" => format!("Could not deliver {object} to {page}"),
                    "rejected" => format!("Failed to deliver {object} to {}", quoted(chat)),
                    _ => format!("Queued {object} for {}", quoted(chat)),
                }
            };
            row.subject = thread.or(row.subject.take());
        }
        "channel" => {
            let thread = thread_subject(&row.evidence["thread"]);
            let label = match &thread {
                Some(ActivitySubject::Thread { label, .. }) => label.as_str(),
                _ => "GitHub",
            };
            row.description = match text(&row.evidence, "state") {
                "sent" => format!("Replied on {label}"),
                "failed" | "dropped" => format!("Could not reply on {label}"),
                "sending" => format!("Started sending a reply on {label}"),
                _ => format!("Queued a reply on {label}"),
            };
            row.subject = thread.or(row.subject.take());
        }
        "problem-open" | "problem-resolved" => {
            problem(row, kind == "problem-resolved", &page)?;
            if row.page_id.is_none() {
                row.subject =
                    row.evidence["source_id"]
                        .as_str()
                        .map(|source_id| ActivitySubject::Source {
                            source_id: source_id.into(),
                            label: "GitHub".into(),
                        });
            }
        }
        _ => return Err(rusqlite::Error::InvalidQuery),
    }
    row.reason = row.reason.take().map(|reason| match reason.as_str() {
        "closed_work" => "The card is Done or Canceled".into(),
        "missing_active_chat" => "The card has no active chat".into(),
        "runtime_unavailable" => "The chat is unavailable".into(),
        "page_unavailable" => "The card is no longer active".into(),
        _ => line(&reason),
    });
    row.description = line(&row.description);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn row(kind: &str, mut evidence: Value) -> ActivityRow {
        evidence.as_object_mut().unwrap().entry("thread").or_insert(json!({"repository":"owner/repo","number":12,"url":"https://github.com/owner/repo/pull/12"}));
        ActivityRow {
            id: format!("{kind}:fact"),
            at: "2026-11-06T00:00:00Z".into(),
            subject: None,
            description: String::new(),
            reason: Some("A reason".into()),
            page_id: Some("page".into()),
            session_id: Some("chat".into()),
            url: Some("https://github.com/owner/repo/pull/12#issuecomment-7".into()),
            evidence,
            category: "all".into(),
            message: None,
        }
    }
    fn labels() -> Labels {
        Labels {
            page_title: Some("Fix navigation".into()),
            page_key: Some("NODEX-3".into()),
            chat_title: Some("Keyboard navigation".into()),
            project_title: Some("Nodex".into()),
            automation_name: Some("Daily\nreview".into()),
            requester: Some("your".into()),
        }
    }
    #[test]
    fn automation_decisions_name_the_frozen_automation_and_prioritize_settled_outcomes() {
        for (mode, expected) in [
            ("dry_run", "Would have started “Daily review”"),
            ("ask_first", "Proposed “Daily review”"),
            ("run", "Started “Daily review”"),
        ] {
            let evidence =
                json!({"automation_id":"automation:review","mode":mode,"status":"completed"});
            let mut decision = row("automation", evidence.clone());
            present(&mut decision, &labels()).unwrap();
            assert_eq!(decision.description, expected);
            assert_eq!(decision.reason.as_deref(), Some("A reason"));
            assert_eq!(
                decision.subject,
                Some(ActivitySubject::Automation {
                    automation_id: "automation:review".into(),
                    label: "Daily review".into(),
                })
            );
            for (status, expected) in [
                ("skipped", "Skipped “Daily review”"),
                ("withdrawn", "Withdrew “Daily review”"),
                ("failed", "Could not run “Daily review”"),
            ] {
                let mut evidence = evidence.clone();
                evidence["status"] = json!(status);
                let mut decision = row("automation-settlement", evidence);
                present(&mut decision, &labels()).unwrap();
                assert_eq!(decision.description, expected);
            }
        }
    }
    #[test]
    fn a_handled_message_is_one_fact_naming_what_was_decided_and_where_it_went() {
        let cases = [
            (
                "chat",
                json!({"type":"send_to_chat","session_id":"chat"}),
                "Sent “Fix navigation” to “Keyboard navigation”",
            ),
            (
                "chat",
                json!({"type":"new_chat"}),
                "Sent “Fix navigation” to a new chat",
            ),
            (
                "chat",
                json!({"type":"execute_decision","decision_id":"dispatch"}),
                "Started “Daily review”",
            ),
            (
                "filed",
                json!({"type":"move_to_project","project_id":"project"}),
                "Filed “Fix navigation” in Nodex",
            ),
            ("kept", json!({"type":"keep"}), "Kept “Fix navigation”"),
            ("kept", json!({"type":null}), "Kept “Fix navigation”"),
            (
                "done",
                json!({"type":"plan","steps":3}),
                "Planned 3 cards from “Fix navigation”",
            ),
            ("done", json!({"type":null}), "Marked “Fix navigation” done"),
            (
                "answered",
                json!({"type":null}),
                "Answered “Fix navigation”",
            ),
            (
                "open",
                json!({"type":null}),
                "Returned “Fix navigation” to the Inbox",
            ),
        ];
        for (disposition, action, expected) in cases {
            let answered = disposition == "answered";
            let disposition = if answered { "done" } else { disposition };
            let mut row = row(
                "message",
                json!({"disposition":disposition,"action":action,"answered":answered}),
            );
            if disposition != "chat" {
                row.session_id = None;
            }
            present(&mut row, &labels()).unwrap();
            assert_eq!(row.description, expected);
            assert_eq!(row.reason.as_deref(), Some("A reason"));
            let expected_subject = if disposition == "chat" {
                ActivitySubject::Chat {
                    session_id: "chat".into(),
                    label: "Keyboard navigation".into(),
                }
            } else {
                ActivitySubject::Page {
                    page_id: "page".into(),
                    label: "NODEX-3".into(),
                }
            };
            assert_eq!(row.subject, Some(expected_subject));
        }
        let mut started = row(
            "message",
            json!({"disposition":"chat","action":{"type":"new_chat"},"confirmed_by":"nodex"}),
        );
        present(&mut started, &labels()).unwrap();
        assert_eq!(
            started.description,
            "Sent “Fix navigation” to a new chat on your request"
        );
    }
    #[test]
    fn facts_name_the_event_object_and_separate_its_reason() {
        let event = json!({"kind":"review","actor_login":"bob","actor_class":"person","url":"https://github.com/owner/repo/pull/12"});
        for (kind, evidence, expected) in [
            (
                "launch",
                json!({"automatic":false}),
                "Started “Keyboard navigation”",
            ),
            (
                "launch",
                json!({"automatic":true}),
                "Started “Keyboard navigation” on your request",
            ),
            ("note", json!({}), "Noted on NODEX-3"),
            ("handback", json!({}), "Sent “Fix navigation” back"),
            (
                "trigger",
                json!({"disposition":"followed","delivery_state":"accepted","event":event}),
                "Delivered a review by @bob to “Keyboard navigation”",
            ),
            (
                "trigger",
                json!({"disposition":"intake","event":{"kind":"discovery_mentions","actor_login":"alice","actor_class":"person"}}),
                "Sent @alice’s mention to the Inbox",
            ),
            (
                "trigger",
                json!({"disposition":"recorded","event":{"kind":"comment","actor_class":"bot"}}),
                "Ignored a bot comment on owner/repo #12",
            ),
            (
                "delivery",
                json!({"state":"accepted","event":event}),
                "Delivered a review by @bob to “Keyboard navigation”",
            ),
            (
                "channel",
                json!({"state":"sent"}),
                "Replied on owner/repo #12",
            ),
            (
                "channel",
                json!({"state":"pending"}),
                "Queued a reply on owner/repo #12",
            ),
            (
                "channel",
                json!({"state":"sending"}),
                "Started sending a reply on owner/repo #12",
            ),
            (
                "channel",
                json!({"state":"failed"}),
                "Could not reply on owner/repo #12",
            ),
            (
                "channel",
                json!({"state":"dropped"}),
                "Could not reply on owner/repo #12",
            ),
        ] {
            let mut row = row(kind, evidence);
            if kind == "launch" {
                row.reason = None;
            }
            present(&mut row, &labels()).unwrap();
            assert_eq!(row.description, expected);
            if kind == "delivery" {
                assert!(row.reason.is_none());
            }
        }
        let mut moved = row(
            "milestone",
            json!({"moved":1,"destination":"review","stage":"review","thread":{"number":42},"event":{"kind":"opened","url":"https://github.com/owner/repo/pull/42"}}),
        );
        present(&mut moved, &labels()).unwrap();
        assert_eq!(moved.description, "Moved NODEX-3 to In Review");
        assert_eq!(moved.reason.as_deref(), Some("PR #42 opened"));
        moved.evidence["moved"] = json!(0);
        moved.evidence["stage"] = json!("doing");
        moved.reason = Some("A person moved it".into());
        present(&mut moved, &labels()).unwrap();
        assert_eq!(moved.description, "Left NODEX-3 in In Progress");
        assert_eq!(moved.reason.as_deref(), Some("A person moved it"));
    }
    #[test]
    fn problems_name_failure_and_recovery_for_every_kind() {
        for (kind, opened, resolved) in [
            (
                "source_failing",
                "GitHub could not be checked",
                "GitHub is reachable again",
            ),
            (
                "credential_invalid",
                "GitHub could not connect",
                "Reconnected GitHub",
            ),
            (
                "delivery_failing",
                "Could not deliver an update to NODEX-3",
                "Delivered the update to NODEX-3",
            ),
            (
                "delivery_unresolved",
                "Could not deliver an update to NODEX-3",
                "Found a chat for NODEX-3",
            ),
            (
                "channel_failing",
                "Could not send the reply for NODEX-3",
                "Sent the reply for NODEX-3",
            ),
        ] {
            for (fact, expected) in [("problem-open", opened), ("problem-resolved", resolved)] {
                let mut row = row(fact, json!({"kind":kind,"count":3,"source_id":"github"}));
                present(&mut row, &labels()).unwrap();
                assert_eq!(row.description, expected);
                if kind == "source_failing" && fact == "problem-open" {
                    assert_eq!(row.reason.as_deref(), Some("Unreachable for 3 checks"));
                }
            }
        }
    }
    #[test]
    fn subjects_prefer_keys_and_preserve_real_chat_and_thread_targets() {
        let mut note = row("note", json!({}));
        present(&mut note, &labels()).unwrap();
        assert_eq!(
            note.subject,
            Some(ActivitySubject::Page {
                page_id: "page".into(),
                label: "NODEX-3".into()
            })
        );
        let mut labels = labels();
        labels.page_key = None;
        labels.page_title = Some("Fix\nnavigation".into());
        present(&mut note, &labels).unwrap();
        assert_eq!(
            note.subject,
            Some(ActivitySubject::Page {
                page_id: "page".into(),
                label: "Fix navigation".into()
            })
        );
        let mut channel = row("channel", json!({"state":"sent"}));
        channel.url = Some("https://github.com/owner/repo/actions/runs/99".into());
        present(&mut channel, &labels).unwrap();
        assert_eq!(
            channel.subject,
            Some(ActivitySubject::Thread {
                url: "https://github.com/owner/repo/pull/12".into(),
                label: "owner/repo #12".into()
            })
        );
        let mut source = row(
            "problem-open",
            json!({"kind":"source_failing","count":3,"source_id":"github"}),
        );
        source.page_id = None;
        present(&mut source, &labels).unwrap();
        assert_eq!(
            source.subject,
            Some(ActivitySubject::Source {
                source_id: "github".into(),
                label: "GitHub".into()
            })
        );
    }
}
