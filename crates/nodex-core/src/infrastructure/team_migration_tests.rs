//! Upgrading published v202 storage through the single Team migration (v203 -> v204) carries
//! forward each Space's Owner, Automations from Scheduled tasks, Work and Assignee, workflow
//! Status labels, historical attribution and each Page's first Turn.
use super::*;

use crate::infrastructure::sqlite::open_writer;
use nodex_platform::test_support::tempdir;
use serde_json::{Value, json};

fn migrate(connection: &mut Connection) {
    with_schema_rebuild_transaction(connection, |c| migrate_v202_to_current(c, "team.db")).unwrap();
    validate_schema_identity(connection, CURRENT_STORE_REVISION).unwrap();
}

/// The frozen v202 schema with one Space and the singleton rows a released Store carries.
fn predecessor() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(include_str!("../../tests/fixtures/schema-v202.sql"))
        .unwrap();
    validate_schema_identity(&connection, 202).unwrap();
    connection.execute_batch("INSERT INTO profiles VALUES('profile','today','today'); INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES('library','profile','today','today'); INSERT INTO core_automation_runtime_metadata VALUES(1,'unchanged-salt',1);").unwrap();
    connection.execute_batch("INSERT INTO core_store_metadata(id,schema_owner,projection_event_v2_floor) VALUES(1,'rust_core',1); INSERT INTO nodex_agent_token_keys(id,key_material) VALUES(1,randomblob(32)); INSERT INTO block_retention_state(id,maintenance_revision,updated_at_ms) VALUES(1,0,1); INSERT INTO operational_journal_state(id,operation_identity_cutover_at,updated_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));").unwrap();
    connection
}

fn page(connection: &Connection, id: &str) {
    connection.execute("INSERT INTO blocks(id,library_id,type,created_at,updated_at) VALUES(?1,'library','page','today','today')",[id]).unwrap();
    connection.execute("INSERT INTO documents(id,library_id,schema_key,schema_version,created_at,updated_at) VALUES(?1,'library','page',1,'today','today')",[format!("doc:{id}")]).unwrap();
    connection
        .execute(
            "INSERT INTO block_documents VALUES(?1,?2,'library','today')",
            params![id, format!("doc:{id}")],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO pages(block_id,library_id,document_id,parent_kind,parent_id,created_at,updated_at) VALUES(?1,'library',?2,'library','library','today','today')",
            params![id, format!("doc:{id}")],
        )
        .unwrap();
}

fn task(connection: &Connection, id: &str, kind: &str, status: &str, launch: &str) {
    connection.execute("INSERT INTO codex_scheduled_automations(automation_id,kind,status,target_session_id,name,prompt,rrule,model,cwds_json,execution_environment,next_run_at,last_run_at,created_at,updated_at,definition_revision,launch) VALUES(?1,?2,?3,?4,?1,'Saved action','FREQ=MINUTELY;INTERVAL=5','model','[]','local',123456,123000,1,2,7,?5)",params![id,kind,status,if kind=="heartbeat"{Some("continued-session")}else{None},launch]).unwrap();
}

fn local_member(connection: &Connection, library: &str) -> String {
    connection
        .query_row(
            "SELECT member_id FROM local_profile_members WHERE library_id=?1",
            [library],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn personal_space_keeps_one_active_owner_across_member_changes() {
    let mut connection = Connection::open_in_memory().unwrap();
    install_current_schema(&mut connection).unwrap();
    connection.execute_batch("INSERT INTO profiles VALUES('personal-profile','today','today'); INSERT INTO profiles VALUES('team-profile','today','today');
      INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES('personal','personal-profile','today','today');
      INSERT INTO libraries(id,profile_id,created_at,updated_at,space_kind) VALUES('team','team-profile','today','today','team');
      INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES('moving','team','Member','active','member');").unwrap();
    let local_role: String = connection
        .query_row(
            "SELECT role FROM members WHERE library_id='personal'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(local_role, "owner");
    for rejected in [
        "INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES('second','personal','Other','active','owner')",
        "UPDATE members SET role='member' WHERE library_id='personal'",
        "UPDATE members SET lifecycle='removed' WHERE library_id='personal'",
        "DELETE FROM members WHERE library_id='personal'",
        "UPDATE members SET library_id='personal' WHERE id='moving'",
        "UPDATE libraries SET space_kind='personal' WHERE id='team'",
    ] {
        assert!(connection.execute(rejected, []).is_err(), "{rejected}");
    }
    connection.execute_batch("UPDATE libraries SET space_kind='team' WHERE id='personal';
      INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES('second','personal','Other','active','member');").unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM members WHERE library_id='personal'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
}

#[test]
fn text_assignees_become_the_local_member_and_every_page_gains_work() {
    let mut connection = predecessor();
    connection.execute_batch("INSERT INTO profiles VALUES('other-profile','today','today'); INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES('other-library','other-profile','today','today');
      INSERT INTO blocks(id,library_id,type,created_at,updated_at) VALUES('database','library','database','today','today');
      INSERT INTO database_containers(block_id,library_id,name,created_at,updated_at) VALUES('database','library','Tasks','today','today');
      INSERT INTO data_sources(id,library_id,home_database_block_id,name,schema_key,rank_key,created_at,updated_at) VALUES('source','library','database','Tasks','nodex.data-source','a','today','today');
      INSERT INTO data_source_properties(data_source_id,id,name,value_type,rank_key,created_at,updated_at) VALUES('source','assignee','Assignee','text','a','today','today');
      INSERT INTO data_source_page_layouts VALUES('source',1,'today','today');
      INSERT INTO data_source_page_layout_entries VALUES('source','assignee','a','always_show');").unwrap();
    connection.execute("INSERT INTO database_views(id,database_block_id,data_source_id,name,layout,config_json,rank_key,created_at,updated_at) VALUES('view','database','source','Assigned','list',?1,'a','today','today')",[json!({"rules":{"filter":{"kind":"group","operator":"and","children":[{"kind":"clause","propertyId":"assignee","operator":"text_is","value":"Alex"},{"kind":"clause","propertyId":"title","operator":"text_contains","value":"Alex"}]}}}).to_string()]).unwrap();
    connection.execute("INSERT INTO database_view_personal_preferences VALUES('profile','view',?1,1,'today','today')",[json!({"rules_override":{"advanced_filter":{"kind":"clause","propertyId":"assignee","operator":"text_is_not","value":"Alex"}}}).to_string()]).unwrap();
    for (id, text) in [
        ("empty", None),
        ("text", Some("Alex")),
        ("whitespace", Some("  ")),
        ("null", None),
        ("dormant", Some("Former name")),
    ] {
        page(&connection, id);
        if id != "dormant" {
            connection.execute("UPDATE pages SET parent_kind='data_source',parent_id='source' WHERE block_id=?1",[id]).unwrap();
        }
        connection.execute("INSERT INTO data_source_page_memberships(id,data_source_id,page_block_id,created_at,removed_at) VALUES(?1,'source',?1,'today',?2)",params![id,if id=="dormant" {Some("today")} else {None}]).unwrap();
        connection.execute("INSERT INTO data_source_property_values(data_source_id,membership_id,property_id,value_type,value_json,updated_at) VALUES('source',?1,'assignee','text',?2,'today')",params![id,json!(text).to_string()]).unwrap();
    }
    migrate(&mut connection);
    let local = local_member(&connection, "library");
    let owner = crate::library::default_owner_name();
    assert_eq!(
        connection
            .prepare("SELECT display_name,role,lifecycle,revision FROM members ORDER BY library_id")
            .unwrap()
            .query_map([], |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?
            )))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap(),
        vec![(owner, "owner".to_owned(), "active".to_owned(), 1); 2]
    );
    let work = |id: &str| -> Value {
        let encoded: String = connection
            .query_row(
                "SELECT value_json FROM block_properties WHERE block_id=?1 AND property_key='work'",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        let value: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(
            value.to_string(),
            encoded,
            "Intrinsic state has canonical JSON encoding"
        );
        value
    };
    for id in ["empty", "text", "whitespace", "null", "dormant"] {
        assert_eq!(work(id)["owner"], local);
        assert_eq!(work(id)["auto_start"], false);
    }
    // A text Assignee named the Space's one person, even on a dormant membership.
    for id in ["text", "dormant"] {
        assert_eq!(
            work(id)["assignee"],
            json!({"kind":"member","member_id":local})
        );
    }
    for id in ["empty", "whitespace", "null"] {
        assert_eq!(work(id)["assignee"], Value::Null);
    }
    let view: String = connection
        .query_row(
            "SELECT config_json FROM database_views WHERE id='view'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let view: Value = serde_json::from_str(&view).unwrap();
    assert_eq!(
        view["rules"]["filter"]["children"][0]["value"],
        json!({"kind":"member","member_id":local})
    );
    assert_eq!(view["rules"]["filter"]["children"][0]["operator"], "equals");
    assert_eq!(view["rules"]["filter"]["children"][1]["value"], "Alex");
    let (preference_owner, preferences): (String, String) = connection
        .query_row(
            "SELECT member_id,preferences_json FROM database_view_personal_preferences WHERE view_id='view'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(preference_owner, local);
    let preferences: Value = serde_json::from_str(&preferences).unwrap();
    assert_eq!(
        preferences["rules_override"]["advanced_filter"]["operator"],
        "not_equals"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT (SELECT count(*) FROM data_source_properties WHERE id='assignee'),(SELECT count(*) FROM data_source_property_values WHERE property_id='assignee')",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            )
            .unwrap(),
        (0, 0)
    );
    page(&connection, "fresh");
    assert_eq!(
        work("fresh"),
        json!({"owner":local,"assignee":null,"auto_start":false})
    );
    connection.execute_batch("INSERT INTO profiles VALUES('fresh-profile','today','today'); INSERT INTO libraries(id,profile_id,created_at,updated_at) VALUES('fresh-library','fresh-profile','today','today');").unwrap();
    let member: (String,String,i64) = connection.query_row("SELECT member.display_name,member.lifecycle,member.revision FROM members member JOIN local_profile_members local ON local.member_id=member.id WHERE local.profile_id='fresh-profile' AND local.library_id='fresh-library'",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    assert_eq!(member, ("Owner".into(), "active".into(), 1));
}

#[test]
fn assignee_grouped_disclosures_reset_and_other_view_state_moves_to_the_member() {
    let mut connection = predecessor();
    connection.execute_batch(r#"INSERT INTO blocks(id,library_id,type,created_at,updated_at) VALUES('database','library','database','today','today');
      INSERT INTO database_containers(block_id,library_id,name,created_at,updated_at) VALUES('database','library','Tasks','today','today');
      INSERT INTO data_sources(id,library_id,home_database_block_id,name,schema_key,rank_key,created_at,updated_at) VALUES('source','library','database','Tasks','nodex.data-source','a','today','today');
      INSERT INTO database_views(id,database_block_id,data_source_id,name,layout,config_json,rank_key,created_at,updated_at) VALUES('grouped','database','source','By person','board','{"presentation":{"group":{"propertyId":"assignee"}}}','a','today','today'),('plain','database','source','All','list','{}','b','today','today');
      INSERT INTO database_view_collapsed_occurrences VALUES('profile','grouped','group','GROUP_alex','today'),('profile','plain','page','ITEM_kept','today');"#).unwrap();
    migrate(&mut connection);
    let local = local_member(&connection, "library");
    let collapsed = connection
        .prepare("SELECT member_id,view_id,occurrence_key FROM database_view_collapsed_occurrences")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(collapsed, [(local, "plain".into(), "ITEM_kept".into())]);
}

#[test]
fn default_workflow_stages_take_their_new_names_and_every_registry_gains_canceled() {
    let home = tempdir().unwrap();
    nodex_platform::private_fs::write(
        home.path().join("nodex.db"),
        include_bytes!("../../tests/fixtures/store-v191.db"),
    )
    .unwrap();
    let mut connection = open_writer(&home.path().join("nodex.db")).unwrap();
    with_schema_rebuild_transaction(&mut connection, |c| {
        for step in MIGRATION_STEPS
            .iter()
            .filter(|step| step.from_revision >= 191 && step.to_revision <= 202)
        {
            (step.apply)(
                c,
                &MigrationContext {
                    source_revision: step.from_revision,
                    target_revision: step.to_revision,
                    source_schema_fingerprint: published_format(step.from_revision)?
                        .schema_fingerprint,
                    target_schema_fingerprint: published_format(step.to_revision)?
                        .schema_fingerprint,
                    backup_name: "stages.db".into(),
                    completed_at_unix_ms: 1,
                },
            )?;
        }
        Ok(())
    })
    .unwrap();
    validate_schema_identity(&connection, 202).unwrap();
    let source: String = connection
        .query_row(
            "SELECT data_source_id FROM data_source_properties WHERE id='status' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let page: String = connection
        .query_row(
            "SELECT page_block_id FROM data_source_page_memberships LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let old = json!({"options":[{"id":"triage","name":"Triage"},{"id":"plan","name":"Plan","color":"blue"},{"id":"doing","name":"Doing"},{"id":"review","name":"Review"},{"id":"done","name":"Done"}]});
    for (id, lifecycle, custom) in [
        ("stage:active", "active", false),
        ("stage:archived", "archived", false),
        ("stage:deleted", "deleted", false),
        ("stage:dormant", "active", false),
        ("stage:custom", "active", true),
    ] {
        connection.execute("INSERT INTO data_sources(id,library_id,home_database_block_id,name,schema_key,lifecycle,rank_key,created_at,updated_at) SELECT ?1,library_id,home_database_block_id,?1,schema_key,?2,?1,created_at,updated_at FROM data_sources WHERE id=?3",params![id,lifecycle,source]).unwrap();
        let mut config = old.clone();
        if custom {
            config["options"][1]["name"] = json!("Next up");
            config["options"][2]["name"] = json!("Crafting");
            config["options"][3]["name"] = json!("Verdict");
        }
        connection.execute("INSERT INTO data_source_properties(data_source_id,id,name,value_type,config_json,rank_key,lifecycle,created_at,updated_at) VALUES(?1,'status','Status','select',?2,'a',?3,'today','today')",params![id,config.to_string(),if lifecycle=="deleted" {"deleted"} else {"active"}]).unwrap();
    }
    connection.execute("INSERT INTO data_source_page_memberships(id,data_source_id,page_block_id,created_at,removed_at) VALUES('stage:dormant-membership','stage:dormant',?1,'today','today')",[page]).unwrap();
    migrate(&mut connection);
    for id in [
        "stage:active",
        "stage:archived",
        "stage:deleted",
        "stage:dormant",
        "stage:custom",
    ] {
        let raw:String=connection.query_row("SELECT config_json FROM data_source_properties WHERE data_source_id=?1 AND id='status'",[id],|r|r.get(0)).unwrap();
        let config: Value = serde_json::from_str(&raw).unwrap();
        let options = config["options"].as_array().unwrap();
        assert_eq!(options.len(), 6);
        assert_eq!(options[5], json!({"id":"canceled","name":"Canceled"}));
        assert_eq!(options[1]["color"], "blue");
        let names = if id == "stage:custom" {
            ["Next up", "Crafting", "Verdict"]
        } else {
            ["Todo", "In Progress", "In Review"]
        };
        for (option, name) in options[1..4].iter().zip(names) {
            assert_eq!(option["name"], name);
        }
    }
}

#[test]
fn every_page_derives_its_first_turn_without_pending_work() {
    let mut connection = predecessor();
    page(&connection, "page");
    migrate(&mut connection);
    let turns = crate::workspace::page_turn::turns(&connection, &["page".into()]).unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].reason, None);
    assert!(!turns[0].episode.is_empty());
    assert_eq!(
        connection
            .query_row(
                "SELECT (SELECT count(*) FROM page_turn_dirty),(SELECT count(*) FROM page_turn_notification_intents WHERE claimed_at IS NULL)",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            )
            .unwrap(),
        (0, 0)
    );
}

#[test]
fn historical_actors_come_from_verified_provenance_and_personal_state_moves_to_the_member() {
    let mut c = predecessor();
    // Historical storage is the boundary here; public-operation correctness is
    // exercised separately by the two-Member HTTPS scenario.
    c.execute_batch(r#"BEGIN;
      INSERT INTO projects(id,library_id,name,created,updated) VALUES('project','library','Work','today','today');
      INSERT INTO blocks(id,library_id,type,created_at,updated_at) VALUES('database','library','database','today','today'),('page','library','page','today','today');
      INSERT INTO database_containers(block_id,library_id,name,created_at,updated_at) VALUES('database','library','Work','today','today');
      INSERT INTO data_sources(id,library_id,home_database_block_id,name,schema_key,rank_key,created_at,updated_at) VALUES('source','library','database','Work','custom','a','today','today');
      INSERT INTO database_views(id,database_block_id,data_source_id,name,layout,rank_key,created_at,updated_at) VALUES('view','database','source','Work','board','a','today','today');
      INSERT INTO documents(id,library_id,schema_key,schema_version,created_at,updated_at) VALUES('document','library','page',1,'today','today');
      INSERT INTO block_documents VALUES('page','document','library','today');
      INSERT INTO pages(block_id,library_id,document_id,parent_kind,parent_id,created_at,updated_at) VALUES('page','library','document','library','library','today','today');
      INSERT INTO project_sessions(id,no_thread_fallback_title,created_at,updated_at,activity_at,unread) VALUES('chat','Work','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',1793491200000,1);
      INSERT INTO codex_threads(thread_id,created_at,updated_at,recency_at,linked_at) VALUES('thread',1,1,1,'2026-11-01T00:00:00.000Z');
      INSERT INTO project_session_threads VALUES('chat','thread','2026-11-01T00:00:00.000Z');
      INSERT INTO database_view_personal_preferences VALUES('profile','view','{}',2,'today','today');
      INSERT INTO database_view_collapsed_occurrences VALUES('profile','view','page','ITEM_occurrence','today');
    "#).unwrap();
    for (operation, kind, module) in [
        ("person", "file_create", "library"),
        ("agent", "agent_write", "library"),
        ("maintenance", "idle_edit", "owned_document"),
        ("automations", "begin_run", "automation"),
    ] {
        c.execute("INSERT INTO core_module_receipts(module_name,operation_id,profile_id,adapter_kind,operation_kind,store_epoch,request_hash,result_json,committed_at) VALUES(?1,?2,'profile','native_cli',?3,'epoch',?4,'{}','today')",params![module,operation,kind,"a".repeat(64)]).unwrap();
    }
    c.execute("INSERT INTO nodex_agent_turn_authorities VALUES('thread','run','thread','library','profile','epoch',?1,2,'today')",["a".repeat(64)]).unwrap();
    c.execute("INSERT INTO nodex_agent_call_receipts(call_identity,thread_id,turn_id,call_id,project_id,tool,request_hash,mutation_id,authority_fingerprint,provenance_version,status,created_at,updated_at) VALUES(?1,'thread','run','call','project','write',?1,'agent',?1,1,'committed','today','today')",["a".repeat(64)]).unwrap();
    c.execute(
        "INSERT INTO managed_blobs VALUES(?1,?1,1,'today')",
        ["b".repeat(64)],
    )
    .unwrap();
    c.execute("INSERT INTO file_versions(file_id,version,library_id,blob_hash,mime_type,byte_length,actor_id,operation_id,occurred_at) VALUES('file',1,'library',?1,'text/plain',1,'project','agent','today')",["b".repeat(64)]).unwrap();
    c.execute_batch("INSERT INTO library_files(file_id,library_id,default_name,head_version,revision,lifecycle,created_by_actor_id,created_at,updated_at) VALUES('file','library','report.txt',1,1,'live','project','today','today'); INSERT INTO page_file_entries(page_id,library_id,file_id,logical_path,path_key,attached_by_json,attached_at) VALUES('page','library','file','report.txt','report.txt','{\"kind\":\"agent\",\"session_id\":\"chat\",\"backend\":\"codex\"}','2026-11-01T00:00:00Z');").unwrap();
    c.execute_batch("COMMIT").unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    migrate(&mut c);
    let member = local_member(&c, "library");
    let actor = |sql: &str| {
        serde_json::from_str::<nodex_core_contracts::Actor>(
            &c.query_row(sql, [], |r| r.get::<_, String>(0)).unwrap(),
        )
        .unwrap()
    };
    assert_eq!(
        actor("SELECT actor_json FROM mutation_actors WHERE operation_id='person'"),
        nodex_core_contracts::Actor::Member {
            member_id: member.clone()
        }
    );
    let expected = nodex_core_contracts::Actor::Agent {
        session_id: "chat".into(),
        run_id: Some("run".into()),
        on_behalf_of: member.clone(),
    };
    assert_eq!(
        actor("SELECT actor_json FROM mutation_actors WHERE operation_id='agent'"),
        expected
    );
    assert_eq!(
        actor("SELECT created_by_actor_json FROM library_files WHERE file_id='file'"),
        expected
    );
    assert_eq!(
        actor("SELECT actor_json FROM file_versions WHERE file_id='file'"),
        expected
    );
    for (operation, kind) in [
        (
            "maintenance",
            nodex_core_contracts::ServiceKind::Maintenance,
        ),
        (
            "automations",
            nodex_core_contracts::ServiceKind::Automations,
        ),
    ] {
        assert_eq!(
            actor(&format!(
                "SELECT actor_json FROM mutation_actors WHERE operation_id='{operation}'"
            )),
            nodex_core_contracts::Actor::Service { kind }
        );
    }
    assert!(
        matches!(actor("SELECT attached_by_json FROM page_file_entries"),nodex_core_contracts::Actor::Agent {on_behalf_of,..} if on_behalf_of==member)
    );
    for sql in [
        "SELECT member_id FROM member_session_unread",
        "SELECT member_id FROM database_view_personal_preferences",
        "SELECT member_id FROM database_view_collapsed_occurrences",
        "SELECT member_id FROM session_requesting_members WHERE session_id='chat'",
    ] {
        assert_eq!(
            c.query_row(sql, [], |r| r.get::<_, String>(0)).unwrap(),
            member
        );
    }
}

#[test]
fn automations_keep_clock_targets_timing_states_and_jitter() {
    let mut connection = predecessor();
    task(&connection, "cron", "cron", "ACTIVE", "automatic");
    task(&connection, "heartbeat", "heartbeat", "PAUSED", "ask");
    task(&connection, "deleted", "cron", "DELETED", "automatic");
    migrate(&mut connection);
    let owner = local_member(&connection, "library");
    for (id, status, mode, target) in [
        ("cron", "ACTIVE", "run", None),
        (
            "heartbeat",
            "PAUSED",
            "ask_first",
            Some("continued-session"),
        ),
        ("deleted", "DELETED", "run", None),
    ] {
        let row:(String,String,Option<String>,i64,i64,i64,String,String,String)=connection.query_row("SELECT status,mode,target_session_id,next_run_at,last_run_at,automation_revision,jitter_salt,timezone,owner_member_id FROM automations WHERE automation_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?))).unwrap();
        assert_eq!(
            (row.0.as_str(), row.1.as_str(), row.2.as_deref()),
            (status, mode, target)
        );
        assert_eq!((row.3, row.4, row.5), (123456, 123000, 7));
        assert_eq!(row.6, "unchanged-salt");
        assert_eq!(row.7, iana_time_zone::get_timezone().unwrap());
        assert_eq!(row.8, owner);
    }
    assert_eq!(connection.query_row("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN('codex_scheduled_automations','core_automation_firings','core_automation_leases','core_automation_runs','core_automation_runtime_metadata')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    with_schema_rebuild_transaction(&mut connection, rewind_current_to_v202).unwrap();
    validate_schema_identity(&connection, 202).unwrap();
}

#[test]
fn automations_keep_reviewed_ask_messages_proposals_and_coalesced_times() {
    let mut connection = predecessor();
    task(&connection, "ask", "cron", "ACTIVE", "ask");
    connection.execute_batch("INSERT INTO documents(id,library_id,schema_key,schema_version,created_at,updated_at) VALUES('document','library','page',1,'today','today'); INSERT INTO blocks(id,library_id,type,created_at,updated_at) VALUES('page','library','page','today','today'); INSERT INTO block_documents VALUES('page','document','library','today'); INSERT INTO pages(block_id,library_id,document_id,parent_kind,parent_id,created_at,updated_at) VALUES('page','library','document','library','library','today','today'); INSERT INTO inbox_entries(page_id,library_id,seq,submitted_at,source_kind,source_label,current_proposal_id,source_automation_id,source_dispatch_id,updated_at) VALUES('page','library',1,'today','scheduled_task','Ask','proposal','ask','dispatch:ask','today'); INSERT INTO inbox_proposals(proposal_id,library_id,origin,state,action_json,summary,basis_json,created_at,updated_at) VALUES('proposal','library','schedule','open','{\"type\":\"run_task\",\"automation_id\":\"ask\",\"dispatch_id\":\"dispatch:ask\",\"agent\":null}','Run Ask','[]','today','today'); INSERT INTO core_automation_firings(dispatch_id,automation_id,status,waiting_in_inbox,page_id,first_scheduled_for_ms,last_scheduled_for_ms,missed_count,hold_basis_json,admission_prompt,created_at_ms,updated_at_ms) VALUES('dispatch:ask','ask','held',1,'page',1000,2000,3,'{}',NULL,10,20); INSERT INTO document_materializations(document_id,generation,projected_seq,markdown,plain_text,preview,block_tree_json,updated_at,materialization_derivation_version) VALUES('document',1,0,'The instructions edited for this run','The instructions edited for this run','The instructions edited for this run','[]','today',5);").unwrap();
    migrate(&mut connection);
    assert_eq!(
        connection
            .query_row(
                "SELECT automation_name FROM automation_decisions WHERE dispatch_id='dispatch:ask'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "ask"
    );
    connection
        .execute(
            "UPDATE automations SET name='Renamed Automation' WHERE automation_id='ask'",
            [],
        )
        .unwrap();
    let changed = connection
        .execute(
            "UPDATE automation_decisions SET automation_name='Renamed Automation' WHERE dispatch_id='dispatch:ask'",
            [],
        )
        .unwrap_err();
    assert_eq!(
        changed.sqlite_error_code(),
        Some(rusqlite::ErrorCode::ConstraintViolation)
    );
    let row:(String,String,i64,i64,i64,Option<String>)=connection.query_row("SELECT dispatch_id,page_id,first_scheduled_for_ms,last_scheduled_for_ms,missed_count,admission_prompt FROM automation_decisions WHERE automation_id='ask'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap();
    assert_eq!(
        row,
        ("dispatch:ask".into(), "page".into(), 1000, 2000, 3, None)
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT markdown FROM document_materializations WHERE document_id='document'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "The instructions edited for this run"
    );
    let (origin, action, actor): (String, String, String) = connection
        .query_row(
            "SELECT origin,action_json,actor_json FROM inbox_proposals WHERE proposal_id='proposal'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(origin, "automation");
    let action: Value = serde_json::from_str(&action).unwrap();
    assert_eq!(action["type"], "execute_decision");
    assert_eq!(action["decision_id"], "dispatch:ask");
    assert!(action.get("dispatch_id").is_none());
    assert!(action.get("automation_id").is_none());
    assert_eq!(
        serde_json::from_str::<Value>(&actor).unwrap(),
        json!({"type":"service","kind":"inbox_routing"})
    );
    let (source_kind, source_automation, author): (String, String, String) = connection
        .query_row(
            "SELECT source_kind,source_automation_id,author_member_id FROM inbox_entries WHERE page_id='page'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (source_kind, source_automation, author),
        (
            "automation".to_owned(),
            "ask".to_owned(),
            local_member(&connection, "library")
        )
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM automation_decision_triggers WHERE dispatch_id='dispatch:ask'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
}

#[test]
fn a_confirmed_proposal_was_confirmed_by_its_person() {
    let mut connection = predecessor();
    page(&connection, "page");
    connection.execute_batch("INSERT INTO inbox_entries(page_id,library_id,seq,submitted_at,source_kind,current_proposal_id,updated_at) VALUES('page','library',1,'today','user','confirmed','today'); INSERT INTO inbox_proposals(proposal_id,library_id,origin,state,action_json,summary,basis_json,created_at,updated_at,confirmed_at,dispatch_session_id) VALUES('confirmed','library','user','completed','{\"type\":\"new_chat\"}','Start','[]','today','today','today','chat');").unwrap();
    migrate(&mut connection);
    let member = local_member(&connection, "library");
    let (by, actor, confirmed): (String, String, String) = connection
        .query_row(
            "SELECT confirmed_by,actor_json,confirmed_actor_json FROM inbox_proposals WHERE proposal_id='confirmed'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(by, "user");
    for actor in [actor, confirmed] {
        assert_eq!(
            serde_json::from_str::<Value>(&actor).unwrap(),
            json!({"type":"member","member_id":member})
        );
    }
}

#[test]
fn handled_messages_become_their_first_activity_facts() {
    let mut connection = predecessor();
    // Each released message, its state, its outcome, and the proposal its Inbox still holds.
    let messages = [
        (
            "chat",
            "open",
            Some("chat"),
            Some(("completed", "new_chat")),
        ),
        (
            "closed",
            "done",
            Some("chat"),
            Some(("completed", "send_to_chat")),
        ),
        (
            "filed",
            "kept",
            Some("moved"),
            Some(("completed", "move_to_project")),
        ),
        ("kept", "kept", Some("kept"), None),
        ("done", "done", Some("done"), None),
        ("returned", "open", None, Some(("completed", "keep"))),
        (
            "uncertain",
            "open",
            None,
            Some(("dispatching", "send_to_chat")),
        ),
        ("waiting", "open", None, None),
    ];
    for (seq, (id, state, outcome, proposal)) in messages.into_iter().enumerate() {
        page(&connection, id);
        connection.execute("INSERT INTO inbox_entries(page_id,library_id,seq,submitted_at,source_kind,state,outcome,current_proposal_id,updated_at) VALUES(?1,'library',?2,'2026-11-01T00:00:00.000Z','user',?3,?4,CASE WHEN ?5 THEN 'proposal:'||?1 END,'2026-11-03T00:00:00.000Z')",params![id,seq as i64+1,state,outcome,proposal.is_some()]).unwrap();
        if let Some((proposal_state, action)) = proposal {
            connection.execute("INSERT INTO inbox_proposals(proposal_id,library_id,origin,state,action_json,summary,rationale,basis_json,created_at,updated_at,confirmed_at,dispatch_session_id,failure_kind,failure_message) VALUES('proposal:'||?1,'library','agent',?2,json_object('type',?3),'Route','Because it fits','[]','2026-11-01T00:00:00.000Z','2026-11-02T00:00:00.000Z','2026-11-02T00:00:00.000Z','chat',CASE WHEN ?1='uncertain' THEN 'unknown' END,CASE WHEN ?1='uncertain' THEN 'Delivery is awaiting confirmation' END)",params![id,proposal_state,action]).unwrap();
            connection.execute("INSERT INTO inbox_proposal_pages(proposal_id,page_id,position) VALUES('proposal:'||?1,?1,0)",[id]).unwrap();
        }
    }
    migrate(&mut connection);
    let member = local_member(&connection, "library");
    let facts = connection
        .prepare("SELECT page_id,disposition,proposal_id,at,actor_json FROM intake_dispositions ORDER BY at,id")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                serde_json::from_str::<Value>(&r.get::<_, String>(4)?).unwrap(),
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let routed = "2026-11-02T00:00:00.000Z";
    let handled = "2026-11-03T00:00:00.000Z";
    let actor = json!({"type":"member","member_id":member});
    assert_eq!(
        facts,
        [
            ("chat", "chat", Some("proposal:chat"), routed),
            ("closed", "chat", Some("proposal:closed"), routed),
            ("filed", "filed", Some("proposal:filed"), routed),
            ("closed", "done", None, handled),
            ("kept", "kept", None, handled),
            ("done", "done", None, handled),
        ]
        .map(|(page, disposition, proposal, at)| (
            page.to_owned(),
            disposition.to_owned(),
            proposal.map(str::to_owned),
            at.to_owned(),
            actor.clone(),
        ))
    );
    // Only handled messages have facts; Activity reads each as a message fact.
    let shown: i64 = connection
        .query_row(
            "SELECT count(*) FROM activity_facts WHERE category='messages'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(shown, 6);
}

#[test]
fn automations_keep_inflight_leases_and_terminal_run_history() {
    let mut connection = predecessor();
    task(&connection, "auto", "cron", "ACTIVE", "automatic");
    connection.execute_batch("INSERT INTO core_automation_leases(lease_id,automation_id,dispatch_id,definition_revision,scheduled_for_ms,attempt,status,claimed_at_ms,expires_at_ms,purpose) VALUES('lease:flight','auto','dispatch:flight',7,1000,3,'claimed',20,90000,'run'); INSERT INTO core_automation_leases(lease_id,automation_id,dispatch_id,definition_revision,scheduled_for_ms,attempt,status,claimed_at_ms,expires_at_ms,settled_at_ms,purpose) VALUES('lease:history','auto','dispatch:history',6,900,1,'completed',1,1000,50,'run'); INSERT INTO core_automation_runs(run_id,automation_id,session_id,status,created_at,updated_at,admission_hash,dispatch_id,inbox_summary,read_at) VALUES('run:history','auto','session:history','ACCEPTED',10,50,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','dispatch:history','Retained result',60);").unwrap();
    migrate(&mut connection);
    let lease:(String,String,i64,i64,String)=connection.query_row("SELECT lease_id,dispatch_id,attempt,expires_at_ms,status FROM automation_execution_leases WHERE lease_id='lease:flight'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    assert_eq!(
        lease,
        (
            "lease:flight".into(),
            "dispatch:flight".into(),
            3,
            90000,
            "claimed".into()
        )
    );
    let history:(String,String,String,String,i64)=connection.query_row("SELECT run_id,session_id,status,inbox_summary,read_at FROM automation_execution_runs WHERE run_id='run:history'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    assert_eq!(
        history,
        (
            "run:history".into(),
            "session:history".into(),
            "ACCEPTED".into(),
            "Retained result".into(),
            60
        )
    );
    for (dispatch, status) in [
        ("dispatch:flight", "admitted"),
        ("dispatch:history", "completed"),
    ] {
        let (decided, actor): (String, String) = connection
            .query_row(
                "SELECT status,actor_json FROM automation_decisions WHERE dispatch_id=?1",
                [dispatch],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(decided, status);
        assert_eq!(
            serde_json::from_str::<Value>(&actor).unwrap(),
            json!({"type":"service","kind":"automations"})
        );
    }
    let snapshot: String = connection
        .query_row(
            "SELECT frozen_action_json FROM automation_decisions WHERE dispatch_id='dispatch:flight'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let automation: nodex_core_contracts::automation::Automation =
        serde_json::from_str(&snapshot).unwrap();
    assert_eq!(automation.automation_id, "auto");
    assert_eq!(automation.automation_revision, 7);
}

#[test]
fn a_migrated_unbound_run_resumes_with_its_original_identity_and_message() {
    use nodex_core_contracts::automation::{AUTOMATION_CONTRACT_VERSION, AutomationIntent};
    use nodex_core_contracts::{
        AdapterKind, BoundModuleContext, LibraryId, ModuleApplyRequest, ProfileId, StoreEpoch,
    };
    let mut c = predecessor();
    task(&c, "auto", "cron", "ACTIVE", "automatic");
    c.execute("UPDATE codex_scheduled_automations SET notification_policy='failed_runs_only' WHERE automation_id='auto'",[]).unwrap();
    let run = crate::automation::clock::stable_execution_identity(
        "run",
        &json!(["auto", "dispatch:resume", 0]),
    );
    let message = crate::automation::clock::stable_execution_identity(
        "message",
        &json!(["auto", "dispatch:resume", 0]),
    );
    let hash = crate::document::sha256(
        &serde_json::to_vec(&(
            &run,
            "auto",
            Some("dispatch:resume"),
            None::<String>,
            Some("Retained launch"),
            None::<String>,
        ))
        .unwrap(),
    );
    c.execute("INSERT INTO core_automation_leases(lease_id,automation_id,dispatch_id,definition_revision,scheduled_for_ms,attempt,status,claimed_at_ms,expires_at_ms,purpose) VALUES('lease:resume','auto','dispatch:resume',7,1000,1,'claimed',1,9999999999999,'run')",[]).unwrap();
    c.execute("INSERT INTO core_automation_runs(run_id,automation_id,status,session_title,created_at,updated_at,admission_hash,dispatch_id) VALUES(?1,'auto','IN_PROGRESS','Retained launch',1,1,?2,'dispatch:resume')",params![run,hash]).unwrap();
    migrate(&mut c);
    assert_eq!(
        c.query_row(
            "SELECT message_id FROM automation_execution_runs WHERE run_id=?1",
            [&run],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        message
    );
    c.execute_batch("INSERT INTO block_store_metadata(id,store_epoch,created_at,updated_at) VALUES(1,'epoch','today','today')").unwrap();
    crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(&c)
        .unwrap();
    let home = tempdir().unwrap();
    let mut file = open_writer(&home.path().join("nodex.db")).unwrap();
    {
        let backup = rusqlite::backup::Backup::new(&c, &mut file).unwrap();
        backup
            .run_to_completion(1024, std::time::Duration::ZERO, None)
            .unwrap();
    }
    drop(file);
    let kernel = crate::infrastructure::store::SqliteStoreKernel::open_test(home.path()).unwrap();
    let module = crate::automation::AutomationModule::new("profile", "library", &kernel);
    let context = BoundModuleContext {
        actor: nodex_core_contracts::Actor::Service {
            kind: nodex_core_contracts::ServiceKind::Maintenance,
        },
        authorizing_member_id: None,
        profile_id: ProfileId("profile".into()),
        library_id: LibraryId("library".into()),
        project_id: None,
        adapter: AdapterKind::Test,
        connection_id: "test".into(),
        principal: None,
        agent_attribution: None,
        editor_history_owner: None,
    };
    let policy = module
        .read(
            &context,
            nodex_core_contracts::ModuleReadRequest {
                contract_version: AUTOMATION_CONTRACT_VERSION,
                read:
                    nodex_core_contracts::automation::AutomationRead::AutomationNotificationPolicy {
                        message_id: message.clone(),
                    },
            },
        )
        .unwrap();
    assert!(matches!(
        policy.value,
        nodex_core_contracts::automation::AutomationReadValue::AutomationNotificationPolicy {
            policy: Some(
                nodex_core_contracts::automation::AutomationNotificationPolicy::FailedRunsOnly
            )
        }
    ));
    let request = ModuleApplyRequest {
        contract_version: AUTOMATION_CONTRACT_VERSION,
        operation_id: "resume".into(),
        store_epoch: StoreEpoch("epoch".into()),
        intent: AutomationIntent::BeginRun {
            agent_selection: None,
            run_id: run.clone(),
            automation_id: "auto".into(),
            dispatch_id: Some("dispatch:resume".into()),
            session_id: None,
            session_title: Some("Retained launch".into()),
            source_cwd: None,
            message_id: Some(message),
            notification_policy: Some(
                nodex_core_contracts::automation::AutomationNotificationPolicy::FailedRunsOnly,
            ),
        },
    };
    let resumed = module.apply(&context, request.clone()).unwrap();
    assert_eq!(resumed.committed.value.runs[0].run_id, run);
    assert!(resumed.committed.value.runs[0].page_id.is_some());
    assert!(
        module
            .apply(&context, request)
            .unwrap()
            .committed
            .receipt
            .mutation
            .duplicate
    );
}

#[test]
fn automations_retire_only_stale_unstarted_auto_claims() {
    let mut c = predecessor();
    task(&c, "auto", "cron", "ACTIVE", "automatic");
    c.execute_batch("INSERT INTO core_automation_leases(lease_id,automation_id,dispatch_id,definition_revision,scheduled_for_ms,attempt,status,claimed_at_ms,expires_at_ms,purpose) VALUES('stale','auto','stale-dispatch',6,1000,1,'claimed',20,9999999999999,'run');").unwrap();
    migrate(&mut c);
    let row: (String, String) = c
        .query_row(
            "SELECT status,reason_code FROM automation_execution_leases WHERE lease_id='stale'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("cancelled".into(), "automation_changed".into()));
    let (status,action,authority):(String,String,String)=c.query_row("SELECT status,frozen_action_json,frozen_authority_json FROM automation_decisions WHERE dispatch_id='stale-dispatch'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(status, "failed");
    let action: Value = serde_json::from_str(&action).unwrap();
    let authority: Value = serde_json::from_str(&authority).unwrap();
    assert_eq!(action["automation_revision"], 7);
    assert_eq!(authority["automation_revision"], 6);
    assert_eq!(action["snapshot_provenance"], "retained_definition");
    assert_eq!(authority["configuration_revision"], 7);
}
