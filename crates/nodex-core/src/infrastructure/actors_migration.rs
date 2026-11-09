//! Historical attribution is inferred only from retained Core evidence. Migration
//! decoders stay here; current writes use the Actor contract exclusively.
use super::{actors, sqlite::StoreError};
use nodex_core_contracts::{Actor, ServiceKind};
use rusqlite::{Connection, OptionalExtension, params};

fn historical(
    c: &Connection,
    library: &str,
    operation: &str,
    kind: &str,
) -> Result<Actor, StoreError> {
    let member = actors::local_member(c, library)?;
    let agent:Option<(String,Option<String>)>=c.query_row("SELECT link.session_id,call.turn_id FROM nodex_agent_call_receipts call JOIN nodex_agent_turn_authorities authority ON authority.thread_id=call.thread_id AND authority.turn_id=call.turn_id JOIN project_session_threads link ON link.thread_id=authority.root_thread_id WHERE call.mutation_id=?1 AND call.status='committed' AND call.authority_fingerprint=authority.authority_fingerprint AND authority.library_id=?2",params![operation,library],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((session_id, run_id)) = agent {
        let on_behalf_of =
            crate::library::members::requester_owner_for_session(c, library, &session_id)?
                .unwrap_or(member);
        return Ok(Actor::Agent {
            session_id,
            run_id,
            on_behalf_of,
        });
    }
    let service = if kind.contains("source")
        || kind.contains("channel")
        || kind.contains("thread_delivery")
    {
        Some(ServiceKind::Sources)
    } else if matches!(
        kind,
        "begin_run"
            | "resume_run_admission"
            | "bind_run_session"
            | "bind_run_message"
            | "set_run_session_title"
            | "complete_run_for_review"
            | "set_run_inbox_item"
            | "settle_interrupted_runs"
            | "reschedule_definition"
    ) || kind.contains("claim_due")
        || kind.contains("automation_assessment")
        || kind.contains("automation_decision")
        || kind.contains("complete_lease")
        || kind.contains("fail_lease")
    {
        Some(ServiceKind::Automations)
    } else if kind == "idle_edit"
        || kind.contains("maintenance")
        || kind.contains("compaction")
        || kind.contains("baseline")
        || kind.contains("store_migration")
    {
        Some(ServiceKind::Maintenance)
    } else if kind.contains("routing")
        || kind.contains("suggestion")
        || kind.contains("inbox_dispatch")
    {
        Some(ServiceKind::InboxRouting)
    } else if kind.contains("notification") || kind.contains("reminder_delivery") {
        Some(ServiceKind::Notifications)
    } else if kind.contains("session_execution")
        || kind.contains("work_events")
        || kind.contains("app_server")
        || kind.contains("subagent")
    {
        Some(ServiceKind::AgentRuntime)
    } else {
        None
    };
    Ok(
        service.map_or(Actor::Member { member_id: member }, |kind| Actor::Service {
            kind,
        }),
    )
}

pub(super) fn backfill(c: &Connection) -> Result<(), StoreError> {
    let receipts=c.prepare("SELECT receipt.module_name,receipt.operation_id,library.id,receipt.operation_kind,receipt.committed_at FROM (SELECT module_name,operation_id,profile_id,operation_kind,committed_at FROM core_module_receipts UNION ALL SELECT module_name,operation_id,profile_id,operation_kind,committed_at FROM detached_module_receipts) receipt JOIN libraries library ON library.profile_id=receipt.profile_id")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (module, operation, library, kind, at) in receipts {
        let actor = historical(c, &library, &operation, &kind)?;
        c.execute("INSERT OR IGNORE INTO mutation_actors(module_name,operation_id,library_id,actor_json,committed_at) VALUES(?1,?2,?3,?4,?5)",params![module,operation,library,actors::encode(&actor)?,at])?;
    }
    let commit_guard: String = c.query_row(
        "SELECT sql FROM sqlite_schema WHERE name='local_commit_actor_is_immutable'",
        [],
        |r| r.get(0),
    )?;
    c.execute_batch("DROP TRIGGER local_commit_actor_is_immutable")?;
    c.execute("UPDATE local_commits SET actor_json=COALESCE((SELECT actor_json FROM mutation_actors WHERE operation_id=local_commits.operation_id LIMIT 1),json_object('type','member','member_id',(SELECT member_id FROM local_profile_members LIMIT 1)))",[])?;
    c.execute_batch(&commit_guard)?;
    let file_guard: String = c.query_row(
        "SELECT sql FROM sqlite_schema WHERE name='library_files_validate_update'",
        [],
        |r| r.get(0),
    )?;
    c.execute_batch("DROP TRIGGER library_files_validate_update")?;
    c.execute("UPDATE library_files SET created_by_actor_json=COALESCE((SELECT evidence.actor_json FROM file_versions version JOIN mutation_actors evidence ON evidence.operation_id=version.operation_id AND evidence.module_name='library' WHERE version.file_id=library_files.file_id AND version.version=1),CASE WHEN created_by_actor_id LIKE 'store-migration:%' THEN json_object('type','service','kind','maintenance') ELSE json_object('type','member','member_id',(SELECT member_id FROM local_profile_members WHERE library_id=library_files.library_id)) END)",[])?;
    c.execute_batch(&file_guard)?;
    let trigger: String = c.query_row(
        "SELECT sql FROM sqlite_schema WHERE name='file_versions_reject_update'",
        [],
        |r| r.get(0),
    )?;
    c.execute_batch("DROP TRIGGER file_versions_reject_update")?;
    c.execute("UPDATE file_versions SET actor_json=COALESCE((SELECT actor_json FROM mutation_actors WHERE operation_id=file_versions.operation_id AND module_name='library'),CASE WHEN actor_id LIKE 'store-migration:%' THEN json_object('type','service','kind','maintenance') ELSE json_object('type','member','member_id',(SELECT member_id FROM local_profile_members WHERE library_id=file_versions.library_id)) END)",[])?;
    c.execute_batch(&trigger)?;
    c.execute("UPDATE inbox_entries SET author_member_id=CASE WHEN source_kind='automation' THEN (SELECT owner_member_id FROM automations WHERE automation_id=source_automation_id) ELSE (SELECT member_id FROM local_profile_members WHERE library_id=inbox_entries.library_id) END,actor_json=CASE source_kind WHEN 'github' THEN json_object('type','service','kind','sources') WHEN 'automation' THEN json_object('type','service','kind','automations') WHEN 'agent' THEN json_object('type','agent','session_id',source_session_id,'run_id',source_turn_id,'on_behalf_of',(SELECT member_id FROM local_profile_members WHERE library_id=inbox_entries.library_id)) ELSE json_object('type','member','member_id',(SELECT member_id FROM local_profile_members WHERE library_id=inbox_entries.library_id)) END",[])?;
    for table in ["document_versions", "block_mutations"] {
        let trigger_name = if table == "document_versions" {
            "document_versions_are_immutable"
        } else {
            "block_mutations_are_immutable"
        };
        let immutable = c.query_row(
            "SELECT sql FROM sqlite_schema WHERE name=?1",
            [trigger_name],
            |r| r.get::<_, String>(0),
        )?;
        c.execute_batch(&format!("DROP TRIGGER {trigger_name}"))?;
        let rows = if table == "document_versions" {
            c.prepare("SELECT version.version_id,document.library_id,COALESCE(version.source_mutation_id,version.version_id),version.cause FROM document_versions version JOIN documents document ON document.id=version.document_id")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            c.prepare("SELECT mutation.mutation_id,COALESCE(project.library_id,(SELECT id FROM libraries LIMIT 1)),mutation.mutation_id,mutation.mutation_kind FROM block_mutations mutation LEFT JOIN projects project ON project.id=mutation.project_id")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, library, operation, kind) in rows {
            let actor = historical(c, &library, &operation, &kind)?;
            let column = if table == "document_versions" {
                "version_id"
            } else {
                "mutation_id"
            };
            c.execute(
                &format!("UPDATE {table} SET actor_json=?1 WHERE {column}=?2"),
                params![actors::encode(&actor)?, id],
            )?;
        }
        c.execute_batch(&immutable)?;
    }
    let guard: String = c.query_row(
        "SELECT sql FROM sqlite_schema WHERE name='block_relocations_are_immutable'",
        [],
        |r| r.get(0),
    )?;
    c.execute_batch("DROP TRIGGER block_relocations_are_immutable")?;
    let relocations = c
        .prepare("SELECT id,library_id,request_json FROM block_relocations")?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, library, raw) in relocations {
        let actor = historical(c, &library, &id, "block_relocation")?;
        let mut request: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
            StoreError::new(
                super::sqlite::StoreErrorCode::StoreCorrupt,
                "Relocation evidence is invalid",
                false,
            )
        })?;
        request["actor"] = serde_json::to_value(actor).map_err(|_| {
            StoreError::new(
                super::sqlite::StoreErrorCode::Internal,
                "Actor encoding failed",
                false,
            )
        })?;
        c.execute(
            "UPDATE block_relocations SET request_json=?1 WHERE id=?2",
            params![request.to_string(), id],
        )?;
    }
    c.execute_batch(&guard)?;
    let sessions=c.prepare("SELECT session.id,library.id,session.created_at FROM project_sessions session LEFT JOIN projects project ON project.id=session.project_id JOIN libraries library ON library.id=COALESCE(project.library_id,(SELECT id FROM libraries LIMIT 1))")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (session, library, at) in sessions {
        let member = crate::library::members::requester_owner_for_session(c, &library, &session)?
            .unwrap_or(actors::local_member(c, &library)?);
        c.execute("INSERT INTO session_requesting_members(session_id,message_id,member_id,accepted_at) VALUES(?1,?1||':existing',?2,?3)",params![session,member,at])?;
    }
    Ok(())
}
