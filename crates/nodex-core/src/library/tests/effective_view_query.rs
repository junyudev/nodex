use super::agent_surface::{Fixture, actor_context};
use super::*;
use crate::query::QueryModule;
use nodex_core_contracts::QUERY_CONTRACT_VERSION;
use nodex_core_contracts::agent::{
    AgentResourceAccessOverlay, AgentResourceAccessOverlayKind, AgentResourceAccessOverlayScope,
};
use nodex_core_contracts::database::{
    DatabaseDisplayedViewSelection, DatabaseEffectiveViewCoordinate, DatabaseObservedOccurrence,
    DatabaseObservedRowCondition, DatabasePropertySchema, DatabasePropertySetDelta,
    DatabaseRelationCardinality, DatabaseTaskParentPage, DatabaseViewDefinition,
    DatabaseViewFilter, DatabaseViewFilterGroupOperator, DatabaseViewFilterOperator,
    DatabaseViewHierarchyOverrideInput,
};
use nodex_core_contracts::library::{
    LibraryAgentCreatePageDraft, LibraryAgentCreatePagesRequest, LibraryAgentPageDestination,
    LibraryResourceTarget,
};
use nodex_core_contracts::query::{
    DatabaseDisplayedViewQueryCoverage, DatabaseDisplayedViewQueryResult, QueryRead, QueryReadValue,
};
use nodex_core_contracts::sql::{SqlQuery, SqlScope};
use nodex_core_contracts::workspace::{ProjectWorkspaceRead, ProjectWorkspaceReadValue};
use serde_json::{Value, json};

const DATABASE: &str = "01980000-0000-7000-8000-000000000011";
const SOURCE: &str = "01980000-0000-7000-8000-000000000012";
const VIEW: &str = "01980000-0000-7000-8000-000000000013";
const FOREIGN_DATABASE: &str = "01980000-0000-7000-8000-000000000021";
const FOREIGN_SOURCE: &str = "01980000-0000-7000-8000-000000000022";
const FOREIGN_VIEW: &str = "01980000-0000-7000-8000-000000000023";

struct ViewFixture {
    base: Fixture,
    database: DatabaseModule,
    query: QueryModule,
}

impl ViewFixture {
    fn new(full: bool) -> Self {
        Self::with_base(Fixture::new(full))
    }
    fn with_base(base: Fixture) -> Self {
        base.workspace_apply(
            "writer-project",
            ProjectWorkspaceIntent::CreateProject {
                project_id: "project:writer".into(),
                name: "Fixture writer".into(),
                description: String::new(),
                appearance: None,
                source_roots: vec!["/workspace/fixture".into()],
                page_key_prefix: None,
            },
        );
        base.apply(
            "view-database",
            LibraryIntent::CreateDatabase {
                database_id: DATABASE.into(),
                data_source_id: SOURCE.into(),
                view_id: VIEW.into(),
                name: "Observed Tasks".into(),
                parent: LibraryWriteParent::Library { before: None },
            },
        );
        Self {
            database: DatabaseModule::new("profile-1", "library-1", &base.kernel),
            query: QueryModule::new("profile-1", "library-1", &base.kernel),
            base,
        }
    }
    fn coordinate(&self) -> DatabaseEffectiveViewCoordinate {
        let DatabaseReadValue::View { value: view } = self.db_read(DatabaseRead::View {
            view_id: VIEW.into(),
        }) else {
            panic!("View")
        };
        let DatabaseReadValue::DataSource { value: source } =
            self.db_read(DatabaseRead::DataSource {
                data_source_id: SOURCE.into(),
            })
        else {
            panic!("Source")
        };
        DatabaseEffectiveViewCoordinate {
            database_id: DATABASE.into(),
            data_source_id: SOURCE.into(),
            view_id: VIEW.into(),
            expected_view_revision: view.revision,
            expected_schema_revision: source.data_source.schema_revision,
            expected_preferences_revision: None,
            preferences_override: DatabaseViewPreferencesOverrideInput::default(),
            search_query: String::new(),
        }
    }
    fn db_read(&self, read: DatabaseRead) -> DatabaseReadValue {
        self.database
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read,
                },
            )
            .unwrap()
            .value
    }
    fn db_apply(&self, operation: &str, intent: DatabaseIntent) {
        self.database
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: operation.into(),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent: vec![intent],
                },
            )
            .unwrap();
    }
    fn rows(
        &self,
        operation: &str,
        source: &str,
        drafts: Vec<LibraryAgentCreatePageDraft>,
    ) -> Vec<String> {
        if source == SOURCE || source == FOREIGN_SOURCE {
            self.base.apply(
                if source == SOURCE {
                    "writer-access"
                } else {
                    "writer-foreign-access"
                },
                LibraryIntent::GrantProjectAccess {
                    project_id: "project:writer".into(),
                    target: LibraryResourceTarget::Database {
                        database_id: if source == SOURCE {
                            DATABASE.into()
                        } else {
                            FOREIGN_DATABASE.into()
                        },
                    },
                    access: LibraryAccess::ReadWrite,
                },
            );
        }
        let mut result = Vec::new();
        for (index, pages) in drafts.chunks(16).enumerate() {
            let response = self
                .base
                .library
                .apply(
                    &BoundModuleContext {
                        project_id: Some(ProjectId("project:writer".into())),
                        ..context()
                    },
                    ModuleApplyRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        operation_id: format!("{operation}:{index}"),
                        store_epoch: StoreEpoch("epoch-1".into()),
                        intent: LibraryIntent::CreatePagesFromNfm {
                            request: LibraryAgentCreatePagesRequest {
                                destination: LibraryAgentPageDestination::DataSource {
                                    data_source_id: source.into(),
                                    values: vec![],
                                    view_id: None,
                                    group_key: None,
                                    at: None,
                                },
                                pages: pages.to_vec(),
                                include_block_ids: false,
                                include_etags: false,
                            },
                        },
                    },
                )
                .unwrap();
            result.extend(
                response
                    .committed
                    .value
                    .agent_create_pages
                    .unwrap()
                    .pages
                    .into_iter()
                    .map(|page| page.page_id),
            );
        }
        result
    }
    fn titles(&self, titles: &[&str]) -> Vec<String> {
        self.rows(
            "rows",
            SOURCE,
            titles.iter().map(|title| draft(title)).collect(),
        )
    }
    fn read(
        &self,
        authorization: &AgentExecutionAuthorization,
        coordinate: DatabaseEffectiveViewCoordinate,
        selection: DatabaseDisplayedViewSelection,
    ) -> Result<DatabaseDisplayedViewQueryResult, CoreError> {
        let response = self.query.read(
            &BoundModuleContext {
                adapter: AdapterKind::Agent,
                ..self.base.execution_context()
            },
            ModuleReadRequest {
                contract_version: QUERY_CONTRACT_VERSION,
                read: QueryRead::AgentDisplayedViewQuery {
                    authorization: Box::new(authorization.clone()),
                    coordinate: Box::new(coordinate),
                    projection_property_ids: None,
                    selection,
                },
            },
        )?;
        let QueryReadValue::DisplayedViewQuery { value } = response.value else {
            panic!("displayed result")
        };
        Ok(value)
    }
    fn complete(
        &self,
        coordinate: DatabaseEffectiveViewCoordinate,
    ) -> DatabaseDisplayedViewQueryResult {
        self.read(
            &self.base.authorization,
            coordinate,
            DatabaseDisplayedViewSelection::Effective { limit: None },
        )
        .unwrap()
    }
    fn overlay(&self, call_scoped: bool) -> AgentExecutionAuthorization {
        let mut authorization = self.base.authorization.clone();
        authorization.resource_access = Some(AgentResourceAccessOverlay {
            kind: AgentResourceAccessOverlayKind::Consent,
            scope: if call_scoped {
                AgentResourceAccessOverlayScope::Call
            } else {
                AgentResourceAccessOverlayScope::Task
            },
            thread_id: call_scoped.then(|| authorization.provenance.authority.thread_id.clone()),
            turn_id: call_scoped.then(|| authorization.provenance.authority.turn_id.clone()),
            call_id: call_scoped.then(|| authorization.call_id.clone()),
            root_thread_id: authorization.provenance.authority.root_thread_id.clone(),
            actor_project_id: authorization
                .provenance
                .authority
                .actor_project_id
                .clone()
                .expect("Project consent fixture"),
            library_id: "library-1".into(),
            store_epoch: "epoch-1".into(),
            grants: vec![AgentResourceGrantSpec {
                root: AgentResourceGrantRoot::Database {
                    database_id: DATABASE.into(),
                },
                access: AgentProjectResourceAccess::Read,
                library_actions: vec![],
            }],
            persist_resulting_page_grants: false,
        });
        authorization
    }
    fn property(&self, id: &str, schema: DatabasePropertySchema) {
        self.db_apply(
            &format!("property:{id}"),
            DatabaseIntent::PutProperty {
                data_source_id: SOURCE.into(),
                property_id: id.into(),
                expected_data_source_revision: self.coordinate().expected_schema_revision,
                expected_property_revision: 0,
                name: id.into(),
                schema,
                before_property_id: None,
            },
        );
    }
    fn preferences(
        &self,
        expected_revision: i64,
        preferences: &DatabaseViewPreferencesOverrideInput,
    ) {
        self.db_apply(
            &format!("preferences:{expected_revision}"),
            DatabaseIntent::PutViewPersonalPreferences {
                view_id: VIEW.into(),
                expected_revision,
                rules_override: preferences.rules_override.clone(),
                presentation_override: preferences.presentation_override.clone(),
            },
        );
    }
    fn definition(&self) -> DatabaseViewDefinition {
        let DatabaseReadValue::View { value } = self.db_read(DatabaseRead::View {
            view_id: VIEW.into(),
        }) else {
            panic!("View")
        };
        value.definition
    }
}

fn draft(title: &str) -> LibraryAgentCreatePageDraft {
    LibraryAgentCreatePageDraft {
        title_markdown: title.into(),
        nfm: String::new(),
        values: vec![],
    }
}
fn column(result: &DatabaseDisplayedViewQueryResult, name: &str) -> Vec<Value> {
    let index = result
        .result
        .columns
        .iter()
        .position(|column| column == name)
        .unwrap();
    result
        .result
        .rows
        .iter()
        .map(|row| row[index].clone())
        .collect()
}
fn objects(result: &DatabaseDisplayedViewQueryResult) -> Vec<BTreeMap<String, Value>> {
    result
        .result
        .rows
        .iter()
        .map(|row| {
            result
                .result
                .columns
                .iter()
                .cloned()
                .zip(row.iter().cloned())
                .collect()
        })
        .collect()
}
fn observed(row: &BTreeMap<String, Value>, list: bool) -> DatabaseObservedOccurrence {
    let text = |name: &str| row[name].as_str().unwrap().to_owned();
    let integer = |name: &str| row[name].as_i64().unwrap();
    DatabaseObservedOccurrence {
        occurrence_key: list.then(|| text("occurrence_id")),
        page_id: text("page_id"),
        group_path: serde_json::from_str(row["group_path"].as_str().unwrap()).unwrap(),
        ancestor_page_ids: serde_json::from_str(row["ancestor_page_ids"].as_str().unwrap())
            .unwrap(),
        condition: DatabaseObservedRowCondition {
            metadata_revision: integer("metadata_revision"),
            parent_revision: integer("parent_revision"),
            document_id: text("document_id"),
            document_generation: integer("document_generation"),
            document_head_seq: integer("document_head_seq"),
            membership_id: text("membership_id"),
            membership_revision: integer("membership_revision"),
            database_value_revisions: serde_json::from_str(
                row["value_revisions"].as_str().unwrap(),
            )
            .unwrap(),
            position_revision: row["position_revision"].as_i64(),
            rank_key: row["rank_key"].as_str().map(str::to_owned),
        },
    }
}

#[test]
fn effective_queries_authorize_exact_targets_and_reject_forged_or_revoked_access() {
    let fixture = ViewFixture::new(false);
    fixture.titles(&["Alpha", "Beta"]);
    let selection = DatabaseDisplayedViewSelection::Effective { limit: None };
    assert_eq!(
        fixture
            .read(
                &fixture.base.authorization,
                fixture.coordinate(),
                selection.clone()
            )
            .unwrap_err()
            .code,
        CoreErrorCode::Unauthorized
    );
    for call_scoped in [false, true] {
        let authorization = fixture.overlay(call_scoped);
        assert_eq!(
            fixture
                .read(&authorization, fixture.coordinate(), selection.clone())
                .unwrap()
                .result
                .returned_count,
            2
        );
        if call_scoped {
            let mut wrong_call = authorization;
            wrong_call.call_id = "call:other".into();
            assert_eq!(
                fixture
                    .read(&wrong_call, fixture.coordinate(), selection.clone())
                    .unwrap_err()
                    .code,
                CoreErrorCode::Unauthorized
            );
        }
    }
    for field in ["epoch", "scope", "root", "profile"] {
        let mut forged = fixture.overlay(false);
        match field {
            "epoch" => forged.provenance.authority.store_epoch = "wrong".into(),
            "scope" => {
                forged.provenance.authority.scope = ProjectWorkspaceTurnAuthorityScope::Library
            }
            "root" => forged.provenance.authority.root_thread_id = "wrong".into(),
            _ => forged.provenance.profile_id = "wrong".into(),
        }
        assert_eq!(
            fixture
                .read(&forged, fixture.coordinate(), selection.clone())
                .unwrap_err()
                .code,
            if field == "root" {
                CoreErrorCode::NotFound
            } else {
                CoreErrorCode::Unauthorized
            },
            "forged {field}"
        );
    }
    fixture.base.grant(
        "grant-view",
        LibraryResourceTarget::Database {
            database_id: DATABASE.into(),
        },
    );
    assert_eq!(
        fixture.complete(fixture.coordinate()).result.returned_count,
        2
    );
    fixture.base.apply(
        "revoke-view",
        LibraryIntent::SetProjectAccess {
            target: LibraryResourceTarget::Database {
                database_id: DATABASE.into(),
            },
            changes: vec![LibraryProjectAccessChange {
                project_id: "project:default".into(),
                access: None,
                expected_revision: Some(1),
            }],
        },
    );
    assert_eq!(
        fixture
            .read(&fixture.base.authorization, fixture.coordinate(), selection)
            .unwrap_err()
            .code,
        CoreErrorCode::Unauthorized
    );
}

#[test]
fn full_access_queries_exact_views_without_expanding_the_public_sql_universe() {
    let fixture = ViewFixture::new(true);
    fixture.titles(&["Full-access target"]);
    assert_eq!(
        fixture.complete(fixture.coordinate()).result.returned_count,
        1
    );
    let response = fixture
        .query
        .read(
            &BoundModuleContext {
                adapter: AdapterKind::Agent,
                ..actor_context()
            },
            ModuleReadRequest {
                contract_version: QUERY_CONTRACT_VERSION,
                read: QueryRead::AgentQuery {
                    provenance: Box::new(fixture.base.authorization.provenance.clone()),
                    query: SqlQuery {
                        scope: SqlScope::default(),
                        sql: "SELECT title FROM pages".into(),
                        parameters: BTreeMap::new(),
                    },
                },
            },
        )
        .unwrap();
    let QueryReadValue::Query { value } = response.value else {
        panic!("SQL")
    };
    assert!(value.rows.is_empty());
}

#[test]
fn projectless_agent_authority_queries_exact_views_but_requires_project_for_sql() {
    let fixture = ViewFixture::with_base(Fixture::projectless(false));
    fixture.titles(&["Projectless target"]);
    assert_eq!(
        fixture.complete(fixture.coordinate()).result.returned_count,
        1
    );
    let error = fixture
        .query
        .read(
            &fixture.base.execution_context(),
            ModuleReadRequest {
                contract_version: QUERY_CONTRACT_VERSION,
                read: QueryRead::AgentQuery {
                    provenance: Box::new(fixture.base.authorization.provenance.clone()),
                    query: SqlQuery {
                        scope: SqlScope::default(),
                        sql: "SELECT title FROM pages".into(),
                        parameters: BTreeMap::new(),
                    },
                },
            },
        )
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::Unauthorized);
}

#[test]
fn effective_queries_bind_saved_schema_and_committed_personal_rule_revisions() {
    let fixture = ViewFixture::new(true);
    fixture.titles(&["Alpha", "Beta", "Gamma"]);
    let saved = fixture.coordinate();
    let preferences = DatabaseViewPreferencesOverrideInput {
        rules_override: DatabaseViewRulesOverrideInput {
            sorts: Some(vec![DatabaseViewSortInput {
                field: DatabaseViewSortFieldInput::Title,
                direction: DatabaseViewSortDirectionInput::Desc,
                nulls: DatabaseViewNullOrderInput::Last,
            }]),
            ..Default::default()
        },
        ..Default::default()
    };
    fixture.preferences(0, &preferences);
    let mut personal = saved.clone();
    personal.expected_preferences_revision = Some(1);
    personal.preferences_override = preferences.clone();
    assert_eq!(
        column(&fixture.complete(personal.clone()), "title"),
        vec![json!("Gamma"), json!("Beta"), json!("Alpha")]
    );
    // A saved-only surface is independent of another surface's Profile preferences.
    assert_eq!(fixture.complete(saved.clone()).result.returned_count, 3);
    for change in ["view", "schema", "preferences", "rules"] {
        let mut stale = personal.clone();
        match change {
            "view" => stale.expected_view_revision += 1,
            "schema" => stale.expected_schema_revision += 1,
            "preferences" => stale.expected_preferences_revision = Some(0),
            _ => stale.preferences_override = Default::default(),
        }
        assert_eq!(
            fixture
                .read(
                    &fixture.base.authorization,
                    stale,
                    DatabaseDisplayedViewSelection::Effective { limit: None }
                )
                .unwrap_err()
                .code,
            CoreErrorCode::RevisionConflict
        );
    }
    fixture.preferences(1, &DatabaseViewPreferencesOverrideInput::default());
    assert_eq!(
        fixture
            .read(
                &fixture.base.authorization,
                personal,
                DatabaseDisplayedViewSelection::Effective { limit: None }
            )
            .unwrap_err()
            .code,
        CoreErrorCode::RevisionConflict
    );
    fixture.property("p_extra001", DatabasePropertySchema::Text);
    assert_eq!(
        fixture
            .read(
                &fixture.base.authorization,
                saved,
                DatabaseDisplayedViewSelection::Effective { limit: None }
            )
            .unwrap_err()
            .code,
        CoreErrorCode::RevisionConflict
    );
}

#[test]
fn complete_captured_rules_match_shared_filters_and_personal_list_sort() {
    let fixture = ViewFixture::new(true);
    fixture.titles(&["needle a", "needle z", "other"]);
    fixture.db_apply(
        "list-layout",
        DatabaseIntent::ChangeViewLayout {
            database_id: DATABASE.into(),
            view_id: VIEW.into(),
            expected_revision: fixture.coordinate().expected_view_revision,
            layout: DatabaseViewLayout::List,
        },
    );
    let captured: DatabaseViewPreferencesOverrideInput = serde_json::from_value(json!({
        "rules_override": {
            "property_filters": [{"filterId":"01a07f1c-cb02-7456-8e8c-1145e321eb35","clause":{"kind":"clause","propertyId":"status","operator":"select_is","value":"triage"}}],
            "advanced_filter":{"kind":"none"},
            "sorts":[{"field":{"kind":"title"},"direction":"desc","nulls":"last"}]
        },
        "presentation_override": {
            "group":{"kind":"none"}, "subgroup":{"kind":"none"}, "group_direction":"asc",
            "completion":{"range":"all","order_by_recency":false},
            "hierarchy":{"show_sub_pages":true,"nested_sub_pages":false},
            "display":{"fields":[{"kind":"property","property_id":"status"},{"kind":"property","property_id":"priority"},{"kind":"property","property_id":"estimate"},{"kind":"property","property_id":"tags"}],
            "property_order":["status","priority","estimate","tags","due_date","scheduled_start","scheduled_end","assignee","task_parent"],"show_empty_groups":false,"show_description":false}
        }
    })).unwrap();
    let mut definition = fixture.definition();
    assert!(definition.presentation.display.property_order.is_empty());
    definition.rules.property_filters = captured.rules_override.property_filters.clone().unwrap();
    definition.rules.sorts = serde_json::from_value(
        json!([{"field":{"kind":"title"},"direction":"asc","nulls":"last"}]),
    )
    .unwrap();
    definition.presentation.group = None;
    definition.presentation.subgroup = None;
    fixture.db_apply(
        "shared-filter",
        DatabaseIntent::PutView {
            database_id: DATABASE.into(),
            data_source_id: SOURCE.into(),
            view_id: VIEW.into(),
            expected_revision: fixture.coordinate().expected_view_revision,
            name: "Observed List".into(),
            layout: DatabaseViewLayout::List,
            definition,
            is_default: true,
            before_view_id: None,
        },
    );
    fixture.preferences(
        0,
        &DatabaseViewPreferencesOverrideInput {
            rules_override: DatabaseViewRulesOverrideInput {
                sorts: captured.rules_override.sorts.clone(),
                ..Default::default()
            },
            ..Default::default()
        },
    );
    let mut coordinate = fixture.coordinate();
    coordinate.expected_preferences_revision = Some(1);
    coordinate.preferences_override = captured;
    coordinate.search_query = "needle".into();
    assert_eq!(
        column(&fixture.complete(coordinate), "title"),
        vec![json!("needle z"), json!("needle a")]
    );
}

#[test]
fn captured_property_order_preserves_overrides_and_completes_fields_before_source_order() {
    let fixture = ViewFixture::new(true);
    fixture.titles(&["Observed"]);
    let mut definition = fixture.definition();
    definition.presentation.display.property_order = vec!["estimate".into()];
    fixture.db_apply(
        "shared-property-order",
        DatabaseIntent::PutView {
            database_id: DATABASE.into(),
            data_source_id: SOURCE.into(),
            view_id: VIEW.into(),
            expected_revision: fixture.coordinate().expected_view_revision,
            name: "Ordered fields".into(),
            layout: DatabaseViewLayout::List,
            definition,
            is_default: true,
            before_view_id: None,
        },
    );
    for (revision, partial_order, expected_order) in [
        (
            0,
            None,
            vec![
                "estimate",
                "tags",
                "status",
                "priority",
                "due_date",
                "scheduled_start",
                "scheduled_end",
                "assignee",
                "task_parent",
            ],
        ),
        (
            1,
            Some(vec!["priority", "estimate"]),
            vec![
                "priority",
                "estimate",
                "tags",
                "status",
                "due_date",
                "scheduled_start",
                "scheduled_end",
                "assignee",
                "task_parent",
            ],
        ),
    ] {
        let sparse = DatabaseViewPreferencesOverrideInput {
            presentation_override: DatabaseViewPresentationOverrideInput {
                display: Some(DatabaseViewLayoutDisplayOverrideInput {
                    fields: Some(
                        vec!["tags", "status"]
                            .into_iter()
                            .map(|id| {
                                nodex_core_contracts::database::DatabaseViewFieldInput::Property {
                                    property_id: id.into(),
                                }
                            })
                            .collect(),
                    ),
                    property_order: partial_order
                        .map(|ids| ids.into_iter().map(str::to_owned).collect()),
                    show_empty_groups: None,
                    show_description: None,
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        fixture.preferences(revision, &sparse);
        let mut coordinate = fixture.coordinate();
        coordinate.expected_preferences_revision = Some(revision + 1);
        coordinate.preferences_override = sparse;
        coordinate
            .preferences_override
            .presentation_override
            .display
            .as_mut()
            .unwrap()
            .property_order = Some(expected_order.into_iter().map(str::to_owned).collect());
        assert_eq!(
            fixture.complete(coordinate.clone()).result.returned_count,
            1
        );
        coordinate
            .preferences_override
            .presentation_override
            .display
            .as_mut()
            .unwrap()
            .property_order
            .as_mut()
            .unwrap()
            .swap(0, 1);
        assert_eq!(
            fixture
                .read(
                    &fixture.base.authorization,
                    coordinate,
                    DatabaseDisplayedViewSelection::Effective { limit: None }
                )
                .unwrap_err()
                .code,
            CoreErrorCode::RevisionConflict
        );
    }
}

#[test]
fn effective_queries_are_complete_beyond_a_window_and_mark_explicit_limits() {
    let fixture = ViewFixture::new(true);
    fixture.rows(
        "many",
        SOURCE,
        (0..205)
            .map(|index| draft(&format!("Item {index:03}")))
            .collect(),
    );
    let complete = fixture.complete(fixture.coordinate());
    assert_eq!(complete.result.returned_count, 205);
    assert_eq!(complete.total_effective_occurrences, 205);
    assert_eq!(
        complete.coverage,
        DatabaseDisplayedViewQueryCoverage::EffectiveComplete
    );
    let limited = fixture
        .read(
            &fixture.base.authorization,
            fixture.coordinate(),
            DatabaseDisplayedViewSelection::Effective { limit: Some(10) },
        )
        .unwrap();
    assert_eq!(limited.result.returned_count, 10);
    assert_eq!(limited.total_effective_occurrences, 205);
    assert_eq!(
        limited.coverage,
        DatabaseDisplayedViewQueryCoverage::EffectiveLimited { limit: 10 }
    );
    let mut search = fixture.coordinate();
    search.search_query = "item 204".into();
    assert_eq!(
        column(&fixture.complete(search), "title"),
        vec![json!("Item 204")]
    );
}

#[test]
fn observed_rows_require_the_captured_membership_document_and_value_conditions() {
    let fixture = ViewFixture::new(true);
    fixture.property("p_text0001", DatabasePropertySchema::Text);
    fixture.property("p_hidden01", DatabasePropertySchema::Text);
    fixture.rows(
        "observed",
        SOURCE,
        vec![LibraryAgentCreatePageDraft {
            values: vec![
                LibraryPageCopyValue {
                    property_id: "p_text0001".into(),
                    value: json!("before"),
                },
                LibraryPageCopyValue {
                    property_id: "p_hidden01".into(),
                    value: json!("hidden before"),
                },
            ],
            ..draft("Observed")
        }],
    );
    let preferences = DatabaseViewPreferencesOverrideInput {
        presentation_override: DatabaseViewPresentationOverrideInput {
            display: Some(DatabaseViewLayoutDisplayOverrideInput {
                fields: Some(vec![
                    nodex_core_contracts::database::DatabaseViewFieldInput::Property {
                        property_id: "p_text0001".into(),
                    },
                ]),
                property_order: None,
                show_empty_groups: None,
                show_description: None,
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    fixture.preferences(0, &preferences);
    let mut coordinate = fixture.coordinate();
    coordinate.expected_preferences_revision = Some(1);
    coordinate.preferences_override = preferences;
    let original = fixture.complete(coordinate.clone());
    let mut row = observed(&objects(&original)[0], false);
    assert!(
        !row.condition
            .database_value_revisions
            .contains_key("p_hidden01")
    );
    // A mounted row can retain a loaded Property omitted from this query's output.
    row.condition
        .database_value_revisions
        .insert("p_hidden01".into(), 1);
    let selection = DatabaseDisplayedViewSelection::Observed {
        occurrences: vec![row.clone()],
    };
    assert_eq!(
        fixture
            .read(
                &fixture.base.authorization,
                coordinate.clone(),
                selection.clone()
            )
            .unwrap()
            .result
            .returned_count,
        1
    );
    for field in ["membership", "document", "head", "metadata", "position"] {
        let mut stale = row.clone();
        match field {
            "membership" => stale.condition.membership_revision += 1,
            "document" => stale.condition.document_generation += 1,
            "head" => stale.condition.document_head_seq += 1,
            "metadata" => stale.condition.metadata_revision += 1,
            _ => stale.condition.rank_key = Some("wrong".into()),
        }
        assert_eq!(
            fixture
                .read(
                    &fixture.base.authorization,
                    coordinate.clone(),
                    DatabaseDisplayedViewSelection::Observed {
                        occurrences: vec![stale]
                    }
                )
                .unwrap_err()
                .code,
            CoreErrorCode::RevisionConflict
        );
    }
    fixture.db_apply(
        "edit-value",
        DatabaseIntent::EditPropertyValues {
            edits: vec![DatabasePropertyValueMutation {
                expected_membership_revision: Some(row.condition.membership_revision),
                address: DatabasePagePropertyAddress {
                    data_source_id: SOURCE.into(),
                    page_id: row.page_id,
                    property_id: "p_hidden01".into(),
                },
                edit: DatabasePropertyValueEdit::Replace {
                    expected_value_revision: row.condition.database_value_revisions["p_hidden01"],
                    value: DatabasePropertyValueInput::Text {
                        value: "after".into(),
                    },
                },
            }],
        },
    );
    assert_eq!(
        fixture
            .read(&fixture.base.authorization, coordinate, selection)
            .unwrap_err()
            .code,
        CoreErrorCode::RevisionConflict
    );
}

#[test]
fn effective_search_uses_displayed_text_option_labels_and_current_page_keys() {
    let fixture = ViewFixture::new(true);
    fixture.property("p_choice01", DatabasePropertySchema::Select);
    fixture.db_apply(
        "choice-option",
        DatabaseIntent::PutOption {
            data_source_id: SOURCE.into(),
            property_id: "p_choice01".into(),
            option_id: "o_choice01".into(),
            name: "Cobalt".into(),
            color: None,
            expected_property_revision: 1,
        },
    );
    fixture.rows(
        "search",
        SOURCE,
        vec![
            LibraryAgentCreatePageDraft {
                title_markdown: "Café Résumé".into(),
                nfm: "- Distributed queues\n".into(),
                values: vec![LibraryPageCopyValue {
                    property_id: "p_choice01".into(),
                    value: json!("o_choice01"),
                }],
            },
            draft("Other task"),
        ],
    );
    let preferences = DatabaseViewPreferencesOverrideInput {
        presentation_override: DatabaseViewPresentationOverrideInput {
            display: Some(DatabaseViewLayoutDisplayOverrideInput {
                fields: Some(vec![
                    nodex_core_contracts::database::DatabaseViewFieldInput::Property {
                        property_id: "p_choice01".into(),
                    },
                ]),
                property_order: None,
                show_empty_groups: None,
                show_description: None,
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    fixture.preferences(0, &preferences);
    let mut coordinate = fixture.coordinate();
    coordinate.expected_preferences_revision = Some(1);
    coordinate.preferences_override = preferences;
    for search in [
        "\u{feff}CAFÉ\u{00a0}queues\u{3000}",
        "cobalt",
        "RÉSUMÉ distributed",
    ] {
        let mut searched = coordinate.clone();
        searched.search_query = search.into();
        assert_eq!(
            column(&fixture.complete(searched), "title"),
            vec![json!("Café Résumé")]
        );
    }
    let mut option_identity = coordinate.clone();
    option_identity.search_query = "o_choice01".into();
    assert_eq!(fixture.complete(option_identity).result.returned_count, 0);
    let workspace =
        ProjectWorkspaceModule::new("profile-1", "library-1", &fixture.base.kernel).unwrap();
    let ProjectWorkspaceReadValue::Project { project } = workspace
        .read(
            &actor_context(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::Project {
                    project_id: "project:writer".into(),
                },
            },
        )
        .unwrap()
        .value
    else {
        panic!("writer Project")
    };
    let DatabaseReadValue::View { value: keyed_view } = fixture.db_read(DatabaseRead::View {
        view_id: project.default_database_view_id.unwrap(),
    }) else {
        panic!("keyed View")
    };
    fixture.rows(
        "keyed-row",
        &keyed_view.data_source_id,
        vec![draft("Keyed task")],
    );
    let DatabaseReadValue::DataSource {
        value: keyed_source,
    } = fixture.db_read(DatabaseRead::DataSource {
        data_source_id: keyed_view.data_source_id.clone(),
    })
    else {
        panic!("keyed Source")
    };
    let keyed_coordinate = DatabaseEffectiveViewCoordinate {
        database_id: keyed_view.database_id,
        data_source_id: keyed_view.data_source_id,
        view_id: keyed_view.view_id,
        expected_view_revision: keyed_view.revision,
        expected_schema_revision: keyed_source.data_source.schema_revision,
        expected_preferences_revision: None,
        preferences_override: Default::default(),
        search_query: String::new(),
    };
    let rows = objects(&fixture.complete(keyed_coordinate.clone()));
    let page_key = rows
        .iter()
        .find(|row| row["title"] == "Keyed task")
        .unwrap()["page_key"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut explicit = keyed_coordinate;
    explicit.search_query = format!("#{}", page_key.replace('-', "").to_lowercase());
    assert_eq!(
        column(&fixture.complete(explicit), "title"),
        vec![json!("Keyed task")]
    );
}

#[test]
fn effective_queries_redact_relation_targets_and_authorize_filter_dependencies() {
    let fixture = ViewFixture::new(false);
    fixture.base.apply(
        "foreign",
        LibraryIntent::CreateDatabase {
            database_id: FOREIGN_DATABASE.into(),
            data_source_id: FOREIGN_SOURCE.into(),
            view_id: FOREIGN_VIEW.into(),
            name: "Foreign".into(),
            parent: LibraryWriteParent::Library { before: None },
        },
    );
    fixture.property(
        "p_rel00001",
        DatabasePropertySchema::Relation {
            target_data_source_id: FOREIGN_SOURCE.into(),
            cardinality: DatabaseRelationCardinality::Many,
        },
    );
    let targets = fixture.rows(
        "targets",
        FOREIGN_SOURCE,
        vec![draft("Visible friend"), draft("Restricted secret")],
    );
    let owner = fixture.titles(&["Linked task"])[0].clone();
    fixture.db_apply(
        "link-targets",
        DatabaseIntent::EditPropertyValues {
            edits: vec![DatabasePropertyValueMutation {
                expected_membership_revision: None,
                address: DatabasePagePropertyAddress {
                    data_source_id: SOURCE.into(),
                    page_id: owner,
                    property_id: "p_rel00001".into(),
                },
                edit: DatabasePropertyValueEdit::PatchSet {
                    delta: DatabasePropertySetDelta::Relation {
                        add_page_ids: targets.clone(),
                        remove_edge_ids: vec![],
                    },
                },
            }],
        },
    );
    fixture.base.grant(
        "visible-target",
        LibraryResourceTarget::Page {
            page_id: targets[0].clone(),
        },
    );
    let authorization = fixture.overlay(false);
    let result = fixture
        .read(
            &authorization,
            fixture.coordinate(),
            DatabaseDisplayedViewSelection::Effective { limit: None },
        )
        .unwrap();
    let values: Value =
        serde_json::from_str(column(&result, "values")[0].as_str().unwrap()).unwrap();
    let preview = &values["p_rel00001"]["value"];
    assert_eq!(preview["total_count"], 2);
    assert_eq!(preview["restricted_count"], 1);
    assert_eq!(preview["targets"].as_array().unwrap().len(), 1);
    assert_eq!(preview["targets"][0]["title"], "Visible friend");
    let encoded = serde_json::to_string(&result).unwrap();
    assert!(!encoded.contains(&targets[1]));
    assert!(!encoded.contains("Restricted secret"));
    for (search, count) in [("visible friend", 1), ("restricted secret", 0)] {
        let mut coordinate = fixture.coordinate();
        coordinate.search_query = search.into();
        assert_eq!(
            fixture
                .read(
                    &authorization,
                    coordinate,
                    DatabaseDisplayedViewSelection::Effective { limit: None }
                )
                .unwrap()
                .result
                .returned_count,
            count
        );
    }
    let mut definition = fixture.definition();
    definition.rules.advanced_filter = Some(DatabaseViewFilter::Group {
        operator: DatabaseViewFilterGroupOperator::And,
        children: vec![DatabaseViewFilter::Clause {
            property_id: "p_rel00001".into(),
            operator: DatabaseViewFilterOperator::RelationContains,
            value: Some(Some(json!([targets[1]]))),
        }],
    });
    fixture.db_apply(
        "relation-filter",
        DatabaseIntent::PutView {
            database_id: DATABASE.into(),
            data_source_id: SOURCE.into(),
            view_id: VIEW.into(),
            expected_revision: fixture.coordinate().expected_view_revision,
            name: "Filtered".into(),
            layout: DatabaseViewLayout::Board,
            definition,
            is_default: true,
            before_view_id: None,
        },
    );
    assert_eq!(
        fixture
            .read(
                &authorization,
                fixture.coordinate(),
                DatabaseDisplayedViewSelection::Effective { limit: None }
            )
            .unwrap_err()
            .code,
        CoreErrorCode::Unauthorized
    );
    fixture.base.grant(
        "filter-target",
        LibraryResourceTarget::Page {
            page_id: targets[1].clone(),
        },
    );
    assert_eq!(
        fixture
            .read(
                &authorization,
                fixture.coordinate(),
                DatabaseDisplayedViewSelection::Effective { limit: None }
            )
            .unwrap()
            .result
            .returned_count,
        1
    );
}

#[test]
fn effective_list_queries_preserve_duplicate_hierarchy_occurrences_and_ignore_collapse() {
    let fixture = ViewFixture::new(true);
    fixture.property("p_group001", DatabasePropertySchema::MultiSelect);
    for (index, option_id) in ["o_group001", "o_group002"].into_iter().enumerate() {
        fixture.db_apply(
            option_id,
            DatabaseIntent::PutOption {
                data_source_id: SOURCE.into(),
                property_id: "p_group001".into(),
                option_id: option_id.into(),
                name: format!("Group {index}"),
                color: None,
                expected_property_revision: index as i64 + 1,
            },
        );
    }
    let pages = fixture.rows(
        "hierarchy",
        SOURCE,
        vec![
            LibraryAgentCreatePageDraft {
                values: vec![LibraryPageCopyValue {
                    property_id: "p_group001".into(),
                    value: json!(["o_group001"]),
                }],
                ..draft("Parent")
            },
            LibraryAgentCreatePageDraft {
                values: vec![LibraryPageCopyValue {
                    property_id: "p_group001".into(),
                    value: json!(["o_group001", "o_group002"]),
                }],
                ..draft("Needle child")
            },
        ],
    );
    let DatabaseReadValue::RowDetail { value: child } = fixture.db_read(DatabaseRead::RowDetail {
        page_id: pages[1].clone(),
    }) else {
        panic!("child")
    };
    fixture.db_apply(
        "parent",
        DatabaseIntent::SetTaskParent {
            data_source_id: SOURCE.into(),
            pages: vec![DatabaseTaskParentPage {
                page_id: pages[1].clone(),
                expected_value_revision: child.summary.task_parent_value_revision,
            }],
            parent_page_id: Some(pages[0].clone()),
            before_page_id: None,
        },
    );
    fixture.db_apply(
        "list",
        DatabaseIntent::ChangeViewLayout {
            database_id: DATABASE.into(),
            view_id: VIEW.into(),
            expected_revision: fixture.coordinate().expected_view_revision,
            layout: DatabaseViewLayout::List,
        },
    );
    let preferences = DatabaseViewPreferencesOverrideInput {
        presentation_override: DatabaseViewPresentationOverrideInput {
            group: Some(DatabaseViewGroupOverrideInput::Property {
                property_id: "p_group001".into(),
            }),
            hierarchy: Some(DatabaseViewHierarchyOverrideInput {
                show_sub_pages: Some(true),
                nested_sub_pages: Some(true),
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    fixture.preferences(0, &preferences);
    let mut coordinate = fixture.coordinate();
    coordinate.expected_preferences_revision = Some(1);
    coordinate.preferences_override = preferences.clone();
    let complete = fixture.complete(coordinate.clone());
    let DatabaseReadValue::ListWindow { value: window } =
        fixture.db_read(DatabaseRead::ListWindow {
            target: DatabaseViewReadTarget::PresentedView {
                view_id: VIEW.into(),
                preferences_override: Box::new(preferences),
            },
            window: CollectionWindowRequest {
                after: None,
                first: Some(200),
            },
        })
    else {
        panic!("List window")
    };
    let (occurrence_key, captured_child, group_path, ancestor_page_ids) = window
        .rows
        .items
        .iter()
        .find_map(|row| match row {
            DatabaseListProjectionRow::Page {
                occurrence_key,
                summary,
                group_path,
                ancestor_page_ids,
                ..
            } if summary.page_id == pages[1] => {
                Some((occurrence_key, summary, group_path, ancestor_page_ids))
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(
        captured_child
            .database_value_revisions
            .get("task_parent")
            .copied(),
        Some(child.summary.task_parent_value_revision + 1),
        "List observations retain the loaded Relation's actual write condition",
    );
    let captured = DatabaseObservedOccurrence {
        occurrence_key: Some(occurrence_key.clone()),
        page_id: captured_child.page_id.clone(),
        group_path: group_path.clone(),
        ancestor_page_ids: ancestor_page_ids.clone(),
        condition: DatabaseObservedRowCondition {
            metadata_revision: captured_child.metadata_revision,
            parent_revision: captured_child.parent_revision,
            document_id: captured_child.document_id.clone(),
            document_generation: captured_child.document_generation,
            document_head_seq: captured_child.document_head_seq,
            membership_id: captured_child.membership_id.clone(),
            membership_revision: captured_child.membership_revision,
            database_value_revisions: captured_child.database_value_revisions.clone(),
            position_revision: captured_child.position_revision,
            rank_key: captured_child.rank_key.clone(),
        },
    };
    assert_eq!(
        fixture
            .read(
                &fixture.base.authorization,
                coordinate.clone(),
                DatabaseDisplayedViewSelection::Observed {
                    occurrences: vec![captured]
                },
            )
            .unwrap()
            .result
            .returned_count,
        1
    );
    let canonical_keys = window
        .rows
        .items
        .iter()
        .filter_map(|row| match row {
            DatabaseListProjectionRow::Page { occurrence_key, .. } => Some(json!(occurrence_key)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(column(&complete, "occurrence_id"), canonical_keys);
    assert_eq!(complete.result.returned_count, 4);
    assert_eq!(
        column(&complete, "page_id")
            .iter()
            .filter(|id| **id == json!(pages[1]))
            .count(),
        2
    );
    let group_key = window
        .rows
        .items
        .iter()
        .find_map(|row| match row {
            DatabaseListProjectionRow::Group { occurrence_key, .. } => Some(occurrence_key.clone()),
            _ => None,
        })
        .unwrap();
    fixture.db_apply(
        "collapse",
        DatabaseIntent::SetViewOccurrenceDisclosure {
            view_id: VIEW.into(),
            target: nodex_core_contracts::database::DatabaseViewDisclosureTarget::Group {
                occurrence_key: group_key,
            },
            collapsed: true,
        },
    );
    assert_eq!(
        fixture.complete(coordinate.clone()).result.returned_count,
        4
    );
    coordinate.search_query = "needle".into();
    let searched = fixture.complete(coordinate.clone());
    assert_eq!(searched.result.returned_count, 4);
    let child_row = objects(&searched)
        .into_iter()
        .find(|row| row["page_id"] == json!(pages[1]))
        .unwrap();
    assert_eq!(child_row["depth"], 1);
    let selected = fixture
        .read(
            &fixture.base.authorization,
            coordinate,
            DatabaseDisplayedViewSelection::Observed {
                occurrences: vec![observed(&child_row, true)],
            },
        )
        .unwrap();
    assert_eq!(selected.result.returned_count, 1);
    assert_eq!(
        column(&selected, "parent_occurrence_id"),
        vec![child_row["parent_occurrence_id"].clone()]
    );
}

#[test]
fn effective_queries_fail_completely_on_input_budgets_and_honor_cancellation() {
    let fixture = ViewFixture::new(true);
    fixture.property("p_large001", DatabasePropertySchema::Text);
    fixture.rows(
        "large",
        SOURCE,
        (0..100)
            .map(|index| LibraryAgentCreatePageDraft {
                values: vec![LibraryPageCopyValue {
                    property_id: "p_large001".into(),
                    value: json!("x".repeat(60_000)),
                }],
                ..draft(&format!("Large {index}"))
            })
            .collect(),
    );
    let preferences = DatabaseViewPreferencesOverrideInput {
        presentation_override: DatabaseViewPresentationOverrideInput {
            display: Some(DatabaseViewLayoutDisplayOverrideInput {
                fields: Some(vec![
                    nodex_core_contracts::database::DatabaseViewFieldInput::Property {
                        property_id: "p_large001".into(),
                    },
                ]),
                property_order: None,
                show_empty_groups: None,
                show_description: None,
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    fixture.preferences(0, &preferences);
    let mut coordinate = fixture.coordinate();
    coordinate.expected_preferences_revision = Some(1);
    coordinate.preferences_override = preferences;
    assert_eq!(
        fixture
            .read(
                &fixture.base.authorization,
                coordinate,
                DatabaseDisplayedViewSelection::Effective { limit: Some(1) }
            )
            .unwrap_err()
            .code,
        CoreErrorCode::ResourceExhausted
    );
    let current = fixture.coordinate();
    let cancellation = crate::infrastructure::sqlite::QueryCancellation::new();
    cancellation.cancel();
    let failure = crate::infrastructure::request_execution::within_request_execution(
        crate::infrastructure::request_execution::RequestExecutionContext::new(
            crate::infrastructure::request_execution::RequestExecutionClass::Background,
            cancellation,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        ),
        || {
            fixture.read(
                &fixture.base.authorization,
                current,
                DatabaseDisplayedViewSelection::Effective { limit: None },
            )
        },
    );
    assert_eq!(failure.unwrap_err().code, CoreErrorCode::Cancelled);
}
