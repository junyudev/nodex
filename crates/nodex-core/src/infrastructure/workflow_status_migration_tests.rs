use super::*;
use crate::infrastructure::sqlite::open_writer;
use crate::infrastructure::store::SqliteStoreKernel;
use nodex_core_contracts::library::{
    LibraryIntent, LibraryPageLifecycleMutation, LibraryPageWorkflowStatus,
};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, LIBRARY_CONTRACT_VERSION, LibraryId, ModuleApplyRequest,
    ProfileId, StoreEpoch,
};
use serde::Serialize;
use tempfile::{TempDir, tempdir};

fn key(kind: &str, value: &impl Serialize) -> String {
    format!(
        "{kind}_{}",
        hex::encode(Sha256::digest(serde_json::to_vec(value).unwrap()))
    )
}

fn operation_id(label: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    format!(
        "nodexop:v1:{now}:{}:{label}:{}",
        now + 7 * 24 * 60 * 60 * 1000,
        random_uuid_v7().unwrap()
    )
}

fn predecessor() -> (TempDir, Connection) {
    let home = tempdir().unwrap();
    fs::write(
        home.path().join("nodex.db"),
        include_bytes!("../../tests/fixtures/store-v191.db"),
    )
    .unwrap();
    let mut connection = open_writer(&home.path().join("nodex.db")).unwrap();
    with_schema_rebuild_transaction(&mut connection, |connection| {
        for step in MIGRATION_STEPS
            .iter()
            .filter(|step| step.from_revision >= 191 && step.to_revision <= 196)
        {
            (step.apply)(
                connection,
                &MigrationContext {
                    source_revision: step.from_revision,
                    target_revision: step.to_revision,
                    source_schema_fingerprint: published_format(step.from_revision)?
                        .schema_fingerprint,
                    target_schema_fingerprint: published_format(step.to_revision)?
                        .schema_fingerprint,
                    backup_name: "fixture.db".into(),
                    completed_at_unix_ms: 1,
                },
            )?;
        }
        Ok(())
    })
    .unwrap();
    (home, connection)
}

fn json_column(connection: &Connection, sql: &str) -> Value {
    let raw: String = connection.query_row(sql, [], |row| row.get(0)).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn v196_workflow_vocabulary_preserves_values_views_preferences_and_occurrence_identity() {
    for customized in [false, true] {
        let (home, mut connection) = predecessor();
        let (profile, _source, view, page): (String,String,String,String) = connection.query_row(
            "SELECT library.profile_id,membership.data_source_id,view.id,membership.page_block_id FROM data_source_page_memberships membership JOIN database_views view ON view.data_source_id=membership.data_source_id JOIN libraries library ON library.id=(SELECT library_id FROM data_sources WHERE id=membership.data_source_id) LIMIT 1", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).unwrap();
        let snapshots: Vec<Vec<u8>> = connection
            .prepare(
                "SELECT snapshot_update FROM document_snapshots ORDER BY document_id,snapshot_seq",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let old_page_key = key(
            "ITEM",
            &(vec![Some("build"), None], Vec::<String>::new(), &page),
        );
        let new_page_key = key(
            "ITEM",
            &(vec![Some("doing"), None], Vec::<String>::new(), &page),
        );
        let old_group_key = key("GROUP", &"ship");
        let new_group_key = key("GROUP", &"done");
        with_schema_rebuild_transaction(&mut connection, |connection| {
            let names = if customized { ("Making progress","Accepted") } else { ("Build","Ship") };
            let options = json!({"options":[{"id":"triage","name":"Triage"},{"id":"plan","name":"Plan"},{"id":"build","name":names.0,"color":"blue"},{"id":"review","name":"Review"},{"id":"ship","name":names.1,"color":"green"}]});
            connection.execute("UPDATE data_source_properties SET config_json=?1 WHERE id='status'", [options.to_string()])?;
            connection.execute("UPDATE data_source_property_values SET value_json='\"build\"' WHERE property_id IN ('status','assignee')", [])?;
            connection.execute("UPDATE page_read_model SET view_group_key='build',database_values_json=json_set(database_values_json,'$.status','build','$.assignee','build') WHERE membership_id IS NOT NULL", [])?;
            connection.execute("INSERT INTO data_source_page_memberships(id,data_source_id,page_block_id,revision,created_at,removed_at,completed_at) SELECT 'membership:removed',data_source_id,(SELECT block_id FROM pages WHERE parent_kind='library' LIMIT 1),7,created_at,created_at,created_at FROM data_source_page_memberships LIMIT 1", [])?;
            connection.execute("INSERT INTO data_source_property_values(data_source_id,membership_id,property_id,value_type,value_json,revision,updated_at) SELECT data_source_id,'membership:removed','status','select','\"ship\"',4,updated_at FROM data_source_properties WHERE id='status'", [])?;
            let mut config = json_column(connection,"SELECT config_json FROM database_views LIMIT 1");
            config["rules"]["propertyFilters"] = json!([{"filterId":"filter:status","clause":{"kind":"clause","propertyId":"status","operator":"select_is","value":"build"}}]);
            config["rules"]["advancedFilter"] = json!({"kind":"group","operator":"and","children":[{"kind":"clause","propertyId":"status","operator":"select_is_not","value":"ship"},{"kind":"clause","propertyId":"assignee","operator":"text_contains","value":"build"}]});
            config["presentation"]["conditionalColors"] = json!([{"ruleId":"color:status","propertyId":"status","operator":"select_is","value":"ship","colorSource":"fixed","color":"green"}]);
            connection.execute("UPDATE database_views SET layout='list',config_json=?1 WHERE id=?2", params![config.to_string(),view])?;
            let prefs = json!({"rules_override":{"advanced_filter":{"kind":"filter","filter":{"kind":"clause","propertyId":"status","operator":"select_is","value":"ship"}}},"presentation_override":{}});
            connection.execute("INSERT INTO database_view_personal_preferences(profile_id,view_id,preferences_json,revision,created_at,updated_at) VALUES (?1,?2,?3,3,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')", params![profile,view,prefs.to_string()])?;
            for (kind, occurrence) in [("group",old_group_key.as_str()),("group","GROUP_\"build\""),("page",old_page_key.as_str())] {
                connection.execute("INSERT INTO database_view_collapsed_occurrences VALUES (?1,?2,?3,?4,'2026-01-01T00:00:00.000Z')", params![profile,view,kind,occurrence])?;
            }
            let mut other = config.clone();
            other["presentation"]["group"] = json!({"propertyId":"assignee"});
            for id in ["view:personal","view:text"] {
                connection.execute("INSERT INTO database_views SELECT ?1,database_block_id,data_source_id,?1,'list',?2,revision,rank_key,lifecycle,created_at,updated_at FROM database_views WHERE id=?3",params![id,other.to_string(),view])?;
                connection.execute("INSERT INTO database_view_collapsed_occurrences VALUES (?1,?2,'group','GROUP_\"ship\"','2026-01-01T00:00:00.000Z')",params![profile,id])?;
            }
            let mut subgroup = other;
            subgroup["presentation"]["subgroup"] = json!({"propertyId":"status"});
            connection.execute("INSERT INTO database_views SELECT 'view:subgroup',database_block_id,data_source_id,'Subgroup','list',?1,revision,rank_key,lifecycle,created_at,updated_at FROM database_views WHERE id=?2",params![subgroup.to_string(),view])?;
            let subgroup_key = key("ITEM", &(vec![Some("build"),Some("build")],Vec::<String>::new(),&page));
            connection.execute("INSERT INTO database_view_collapsed_occurrences VALUES (?1,'view:subgroup','page',?2,'2026-01-01T00:00:00.000Z')",params![profile,subgroup_key])?;
            // A stale target can already have the new spelling; merging keeps it collapsed.
            connection.execute("INSERT INTO database_view_collapsed_occurrences VALUES (?1,?2,'group',?3,'2026-01-02T00:00:00.000Z')",params![profile,view,new_group_key])?;
            connection.execute("INSERT INTO database_views SELECT 'view:inactive',database_block_id,data_source_id,'Deleted','list',config_json,revision,rank_key,'deleted',created_at,updated_at FROM database_views WHERE id=?1",[&view])?;
            connection.execute("UPDATE database_view_order_state SET phase='retired',active_generation=NULL,pending_generation=NULL,import_enabled=0 WHERE view_id='view:inactive'",[])?;
            connection.execute("INSERT INTO database_view_collapsed_occurrences VALUES (?1,'view:inactive','page',?2,'2026-01-01T00:00:00.000Z')",params![profile,old_page_key])?;
            let personal = json!({"rules_override":{},"presentation_override":{"group":{"kind":"property","property_id":"status"}}});
            connection.execute("INSERT INTO database_view_personal_preferences(profile_id,view_id,preferences_json,revision,created_at,updated_at) VALUES (?1,'view:personal',?2,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",params![profile,personal.to_string()])?;
            Ok(())
        }).unwrap();
        validate_schema_identity(&connection, 196).unwrap();
        let result = prepare_profile_store(&mut connection, home.path()).unwrap();
        assert_eq!(result.migrated_from_version, Some(196));
        assert_eq!(result.schema_version, CURRENT_STORE_REVISION);
        let config = json_column(
            &connection,
            "SELECT config_json FROM data_source_properties WHERE id='status'",
        );
        assert_eq!(
            config["options"][2],
            json!({"id":"doing","name":if customized {"Making progress"} else {"Doing"},"color":"blue"})
        );
        assert_eq!(
            config["options"][4],
            json!({"id":"done","name":if customized {"Accepted"} else {"Done"},"color":"green"})
        );
        assert_eq!(
            json_column(
                &connection,
                "SELECT value_json FROM data_source_property_values WHERE property_id='status' AND membership_id<>'membership:removed'"
            ),
            json!("doing")
        );
        assert_eq!(
            json_column(
                &connection,
                "SELECT value_json FROM data_source_property_values WHERE membership_id='membership:removed'"
            ),
            json!("done")
        );
        assert_eq!(
            json_column(
                &connection,
                "SELECT value_json FROM data_source_property_values WHERE property_id='assignee'"
            ),
            json!("build")
        );
        let values = json_column(
            &connection,
            "SELECT database_values_json FROM page_read_model WHERE membership_id IS NOT NULL",
        );
        assert_eq!(values["status"], "doing");
        assert_eq!(values["assignee"], "build");
        assert_eq!(
            connection
                .query_row(
                    "SELECT view_group_key FROM page_read_model WHERE membership_id IS NOT NULL",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "doing"
        );
        let view_config: String = connection
            .query_row(
                "SELECT config_json FROM database_views WHERE id=?1",
                [&view],
                |row| row.get(0),
            )
            .unwrap();
        let config: Value = serde_json::from_str(&view_config).unwrap();
        assert_eq!(
            config["rules"]["propertyFilters"][0]["clause"]["value"],
            "doing"
        );
        assert_eq!(
            config["rules"]["advancedFilter"]["children"][0]["value"],
            "done"
        );
        assert_eq!(
            config["rules"]["advancedFilter"]["children"][1]["value"],
            "build"
        );
        assert_eq!(
            config["presentation"]["conditionalColors"][0]["value"],
            "done"
        );
        let pref: String = connection
            .query_row(
                "SELECT preferences_json FROM database_view_personal_preferences WHERE view_id=?1",
                [&view],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&pref).unwrap()["rules_override"]["advanced_filter"]["filter"]
                ["value"],
            "done"
        );
        let keys: Vec<(String, String)> = connection
            .prepare("SELECT view_id,occurrence_key FROM database_view_collapsed_occurrences")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(keys.contains(&(view.clone(), new_group_key)));
        assert!(keys.contains(&(view.clone(), new_page_key)));
        assert!(keys.contains(&(view.clone(), "GROUP_\"doing\"".into())));
        assert!(keys.contains(&("view:personal".into(), "GROUP_\"done\"".into())));
        assert!(keys.contains(&("view:text".into(), "GROUP_\"ship\"".into())));
        assert!(keys.iter().all(|(view, _)| view != "view:inactive"));
        let new_subgroup_key = key(
            "ITEM",
            &(
                vec![Some("build"), Some("doing")],
                Vec::<String>::new(),
                &page,
            ),
        );
        assert!(keys.contains(&("view:subgroup".into(), new_subgroup_key)));

        let after: Vec<Vec<u8>> = connection
            .prepare(
                "SELECT snapshot_update FROM document_snapshots ORDER BY document_id,snapshot_seq",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(snapshots, after);
        assert_eq!(connection.query_row("SELECT revision FROM data_source_property_values WHERE membership_id='membership:removed'",[],|row|row.get::<_,i64>(0)).unwrap(),4);
        assert_eq!(connection.query_row("SELECT count(*) FROM core_store_migration_history WHERE source_revision=196 AND target_revision=197",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        let evidence = json_column(
            &connection,
            "SELECT evidence_json FROM core_store_migration_history WHERE target_revision=197",
        );
        assert_eq!(evidence["collapsed_occurrences"], 6);
        assert_eq!(
            prepare_profile_store(&mut connection, home.path())
                .unwrap()
                .migrated_from_version,
            None
        );
        assert_eq!(
            fs::read_dir(home.path().join("backups/core-migrations"))
                .unwrap()
                .count(),
            1
        );
    }
}

#[test]
fn v196_deleted_pages_keep_readable_restore_evidence_and_verified_receipts() {
    let (home, mut connection) = predecessor();
    // Author a canonical delete, then encode its exact v196 workflow vocabulary.
    prepare_profile_store(&mut connection, home.path()).unwrap();
    drop(connection);
    let kernel = SqliteStoreKernel::open_test(home.path()).unwrap();
    let (profile,library,epoch,page,metadata,parent):(String,String,String,String,i64,i64)=kernel.readers().read_default(|connection|Ok(connection.query_row("SELECT library.profile_id,library.id,(SELECT store_epoch FROM block_store_metadata),page.block_id,block.metadata_revision,block.placement_revision FROM pages page JOIN blocks block ON block.id=page.block_id JOIN libraries library ON library.id=page.library_id WHERE page.parent_kind='data_source' LIMIT 1",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))?)).unwrap();
    kernel.writer().call(|connection| {
        with_immediate_transaction(connection,|connection| {
            let owns_context = super::super::legacy_visibility_migration::enter_migration_maintenance_context(connection)?;
            connection.execute("UPDATE data_source_property_values SET value_json='\"doing\"' WHERE property_id='status'",[])?;
            connection.execute("UPDATE page_read_model SET database_values_json=json_set(database_values_json,'$.status','doing'),view_group_key='doing' WHERE membership_id IS NOT NULL",[])?;
            super::super::legacy_visibility_migration::leave_migration_maintenance_context(connection,owns_context)?;
            Ok(())
        })
    }).unwrap();
    let context = BoundModuleContext {
        editor_history_owner: None,
        agent_attribution: None,
        profile_id: ProfileId(profile.clone()),
        library_id: LibraryId(library.clone()),
        project_id: None,
        connection_id: "workflow-migration".into(),
        adapter: AdapterKind::Test,
    };
    let module = crate::library::LibraryModule::new(&profile, &library, &kernel);
    let delete_operation = operation_id("workflow-delete");
    let deleted = module
        .apply(
            &context,
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: delete_operation.clone(),
                store_epoch: StoreEpoch(epoch.clone()),
                intent: LibraryIntent::ApplyPageLifecycle {
                    mutation: Box::new(LibraryPageLifecycleMutation::DeletePage {
                        page_id: page.clone(),
                        expected_metadata_revision: metadata,
                        expected_parent_revision: parent,
                        parent_document_head: None,
                    }),
                },
            },
        )
        .unwrap();
    let deleted = deleted.committed.value.page_lifecycle.unwrap();
    let mut membership = deleted.delete_evidence.unwrap().membership.unwrap();
    assert_eq!(membership.status, LibraryPageWorkflowStatus::Doing);
    drop(module);
    drop(kernel);
    let mut connection = open_writer(&home.path().join("nodex.db")).unwrap();
    with_schema_rebuild_transaction(&mut connection,|connection| {
        connection.execute("UPDATE data_source_property_values SET value_json='\"build\"' WHERE property_id='status'",[])?;
        let raw:String=connection.query_row("SELECT result_json FROM core_module_receipts WHERE operation_id=?1",[&delete_operation],|row|row.get(0))?;
        let mut result:Value=serde_json::from_str(&raw).unwrap();
        result["value"]["page_lifecycle"]["delete_evidence"]["membership"]["status"]=json!("build");
        let raw=result.to_string();
        connection.execute("UPDATE core_module_receipts SET result_json=?1 WHERE operation_id=?2",params![raw,delete_operation])?;
        let commit:i64=connection.query_row("SELECT local_commit_seq FROM core_module_receipts WHERE operation_id=?1",[&delete_operation],|row|row.get(0))?;
        super::super::local_commit::refresh_migrated_receipt(connection,commit,&hex::encode(Sha256::digest(raw.as_bytes())))?;
        connection.execute("DELETE FROM core_store_migration_history WHERE target_revision>=197", [])?;
        connection.execute("UPDATE data_source_properties SET config_json=replace(replace(replace(replace(config_json,'\"doing\"','\"build\"'),'\"done\"','\"ship\"'),'\"Doing\"','\"Build\"'),'\"Done\"','\"Ship\"') WHERE id='status'", [])?;
        // v198 added chat reminders; a v196 Store has none of their schema.
        connection.execute_batch(
            "DROP TRIGGER project_session_archive_cancels_reminder;
             DROP TABLE project_session_user_message_receipts;
             DROP TABLE project_session_reminder_deliveries;
             DROP INDEX idx_project_sessions_reminder;
             ALTER TABLE project_sessions DROP COLUMN remind_at;",
        )?;
        connection.pragma_update(None,"user_version",196)?;
        Ok(())
    }).unwrap();
    prepare_profile_store(&mut connection, home.path()).unwrap();
    let commit: i64 = connection
        .query_row(
            "SELECT local_commit_seq FROM core_module_receipts WHERE operation_id=?1",
            [&delete_operation],
            |row| row.get(0),
        )
        .unwrap();
    let manifest = super::super::local_commit::read_manifest(&connection, commit).unwrap();
    let raw: String = connection
        .query_row(
            "SELECT result_json FROM core_module_receipts WHERE operation_id=?1",
            [&delete_operation],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        manifest.receipt.result_hash,
        hex::encode(Sha256::digest(raw.as_bytes()))
    );
    drop(connection);
    let kernel = SqliteStoreKernel::open(home.path()).unwrap();
    let module = crate::library::LibraryModule::new(&profile, &library, &kernel);
    membership.status = LibraryPageWorkflowStatus::Doing;
    module
        .apply(
            &context,
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: operation_id("workflow-restore"),
                store_epoch: StoreEpoch(epoch),
                intent: LibraryIntent::ApplyPageLifecycle {
                    mutation: Box::new(LibraryPageLifecycleMutation::RestorePage {
                        page_id: page,
                        delete_operation_id: delete_operation.clone(),
                        expected_metadata_revision: deleted.metadata_revision,
                        expected_parent_revision: deleted.parent_revision,
                        membership: Some(membership),
                        before_block_id: None,
                        parent_document_head: None,
                    }),
                },
            },
        )
        .unwrap();
}
