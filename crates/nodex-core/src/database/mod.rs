pub(crate) mod authorization;
mod genesis;
mod list_drag;
mod mutation;
pub(crate) mod page_key;
mod projection_delta;
pub(crate) mod property_semantics;
pub(crate) mod read;
mod read_authorization;
mod relation;
mod relation_projection;
pub(crate) mod view_contract;
mod window;

pub(crate) const MAX_PROPERTY_OPTIONS: usize = 100;
pub(crate) const MAX_DATA_SOURCE_PROPERTIES: usize = 200;
pub(crate) const MAX_DATABASE_VIEWS: usize = 200;

pub(crate) use genesis::create_database_authority_records;
pub(crate) use mutation::apply_as_collaborator as apply_intents_as_collaborator;
pub(crate) use mutation::{
    ExistingPageTransferTarget, PageCopyDataSourceDestination, PageCopyPositionAnchor,
    PageCopyValueDraft, PageCopyViewPlacement, PageTaskShorthandBatchPlan,
    PageTaskShorthandCandidate, PageTaskShorthandPreservedReason, StagedPagePlacementRevisions,
    active_property, apply_page_task_shorthand_schema,
    finalize_agent_moved_pages_in_data_source_prevalidated, normalize_value,
    place_copied_page_in_data_source, place_copied_page_in_data_source_prevalidated,
    place_staged_page_in_data_source, place_staged_page_in_data_source_prevalidated,
    plan_page_task_shorthand,
    refresh_transferred_page_projection as refresh_copied_page_projection,
    repair_scheduled_page_indexes, resolve_page_transfer_board_destination,
    resolve_page_transfer_data_source_destination,
    resolve_page_transfer_data_source_destination_prevalidated,
    resolve_page_transfer_list_destination, synchronize_membership_completion_timestamp,
    synchronize_relation_value_projections, transfer_existing_page_for_agent_move_prevalidated,
    transfer_existing_page_for_block_transfer, validate_page_copy_data_source_destination,
    validate_page_copy_data_source_destination_prevalidated, validate_page_copy_data_source_source,
    validate_page_transfer_data_source_source,
    validate_page_transfer_data_source_source_prevalidated,
};
pub(crate) use page_key::{
    create_page_key_namespace, current_page_key_for_database_page, current_page_key_for_page,
    current_page_keys_in_library, ensure_database_page_key, page_key_namespace_settings,
    preview_page_key_prefix, rename_page_key_prefix, resolve_page_key_matches_in_library,
};
pub(crate) use projection_delta::{
    record_local_projection_delta, record_page_detail_projection_delta,
    record_page_document_projection_delta,
};
pub(crate) use relation::{copy_relation_edges, remove_membership_task_parent_edges};
pub(crate) use view_contract::is_exact_primary_board_config;
pub(crate) use window::{default_page_move_view_id, mint_page_move_etag};

use nodex_core_contracts::database::{
    DatabaseCommitValue, DatabaseIntent, DatabaseRead, DatabaseReadValue, DatabaseReceipt,
};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, CommittedCoreModuleEvent, CoreError, CoreErrorCode,
    CoreErrorRecovery, DATABASE_CONTRACT_VERSION, ModuleApplyRequest, ModuleReadRequest,
    ModuleReadSnapshot,
};
use rusqlite::OptionalExtension;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::infrastructure::store::SqliteStoreKernel;
use crate::infrastructure::writer::{StoreReaders, StoreWriter};

#[derive(Clone, Debug)]
pub struct DatabaseApplyOutcome {
    pub committed: crate::ModuleWriterResult<DatabaseCommitValue, DatabaseReceipt>,
    pub event: Option<CommittedCoreModuleEvent>,
}

pub(crate) fn is_trusted_library_database_context(context: &BoundModuleContext) -> bool {
    context.project_id.is_none()
        && matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
        )
}

pub struct DatabaseModule {
    profile_id: String,
    library_id: String,
    readers: Option<StoreReaders>,
    writer: Option<StoreWriter>,
}

impl DatabaseModule {
    pub fn new(
        profile_id: impl Into<String>,
        library_id: impl Into<String>,
        kernel: &SqliteStoreKernel,
    ) -> Self {
        Self {
            profile_id: profile_id.into(),
            library_id: library_id.into(),
            readers: Some(kernel.readers()),
            writer: Some(kernel.writer()),
        }
    }

    pub fn read(
        &self,
        context: &BoundModuleContext,
        request: ModuleReadRequest<DatabaseRead>,
    ) -> Result<ModuleReadSnapshot<DatabaseReadValue>, CoreError> {
        self.validate_context(context)?;
        if request.contract_version != DATABASE_CONTRACT_VERSION {
            return Err(invalid("unsupported Database contract version"));
        }
        let Some(readers) = &self.readers else {
            return Err(unavailable("Database Module has no durable store"));
        };
        let profile_id = self.profile_id.clone();
        let library_id = self.library_id.clone();
        let context = context.clone();
        readers
            .read_default(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                let identity = transaction
                    .query_row(
                        "SELECT 1 FROM libraries WHERE id = ?1 AND profile_id = ?2",
                        rusqlite::params![library_id, profile_id],
                        |_| Ok(()),
                    )
                    .optional()?;
                if identity.is_none() {
                    return Err(StoreError::new(
                        StoreErrorCode::Unauthorized,
                        "bound Database identity is not present in this Profile store",
                        false,
                    ));
                }
                let store_epoch = transaction
                    .query_row(
                        "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .ok_or_else(|| corrupt("Profile store epoch is unavailable"))?;
                let commit_seq = crate::infrastructure::local_commit::head(&transaction)?;
                let read = request.read;
                let value = read::read_at_commit_head(
                    &transaction,
                    &library_id,
                    commit_seq,
                    &context,
                    read.clone(),
                )?;
                let authorization = read_authorization::issue(
                    &transaction,
                    &context,
                    &store_epoch,
                    commit_seq,
                    &read,
                    &value,
                )?;
                transaction.commit()?;
                Ok(ModuleReadSnapshot {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    store_epoch: nodex_core_contracts::StoreEpoch(store_epoch),
                    commit_head: commit_seq,
                    authorization,
                    value,
                })
            })
            .map_err(core_error)
    }

    pub fn apply(
        &self,
        context: &BoundModuleContext,
        request: ModuleApplyRequest<Vec<DatabaseIntent>>,
    ) -> Result<DatabaseApplyOutcome, CoreError> {
        self.validate_context(context)?;
        if request.contract_version != DATABASE_CONTRACT_VERSION {
            return Err(invalid("unsupported Database contract version"));
        }
        let Some(writer) = &self.writer else {
            return Err(unavailable("Database Module has no durable store"));
        };
        mutation::apply(writer, &self.profile_id, &self.library_id, context, request)
            .map_err(core_error)
    }

    fn validate_context(&self, context: &BoundModuleContext) -> Result<(), CoreError> {
        if context.profile_id.0 == self.profile_id && context.library_id.0 == self.library_id {
            return Ok(());
        }
        Err(CoreError {
            code: CoreErrorCode::Unauthorized,
            message: "bound Adapter identity does not match this Database Module".to_owned(),
            retryable: false,
            recovery: CoreErrorRecovery::None,
        })
    }
}

impl Default for DatabaseModule {
    fn default() -> Self {
        Self {
            profile_id: "probe-profile".to_owned(),
            library_id: "probe-library".to_owned(),
            readers: None,
            writer: None,
        }
    }
}

fn core_error(error: StoreError) -> CoreError {
    let code = match error.code {
        StoreErrorCode::InvalidInput => CoreErrorCode::InvalidInput,
        StoreErrorCode::NotFound => CoreErrorCode::NotFound,
        StoreErrorCode::PatchNotFound => CoreErrorCode::PatchNotFound,
        StoreErrorCode::PatchAmbiguous => CoreErrorCode::PatchAmbiguous,
        StoreErrorCode::PatchOverlap => CoreErrorCode::PatchOverlap,
        StoreErrorCode::StaleStoreEpoch => CoreErrorCode::StaleStoreEpoch,
        StoreErrorCode::Conflict => CoreErrorCode::Conflict,
        StoreErrorCode::HeadConflict => CoreErrorCode::HeadConflict,
        StoreErrorCode::RevisionConflict => CoreErrorCode::RevisionConflict,
        StoreErrorCode::IdempotencyKeyReused => CoreErrorCode::IdempotencyKeyReused,
        StoreErrorCode::IdempotencyWindowExpired => CoreErrorCode::IdempotencyWindowExpired,
        StoreErrorCode::LegacyIdempotencyUnavailable => CoreErrorCode::LegacyIdempotencyUnavailable,
        StoreErrorCode::ProtectedOwnerDeletion => CoreErrorCode::ProtectedOwnerDeletion,
        StoreErrorCode::UnsupportedSchema => CoreErrorCode::SchemaUnsupported,
        StoreErrorCode::StoreCorrupt => CoreErrorCode::StoreCorrupt,
        StoreErrorCode::MaintenanceInProgress => CoreErrorCode::MaintenanceInProgress,
        StoreErrorCode::ResourceExhausted => CoreErrorCode::ResourceExhausted,
        StoreErrorCode::Unauthorized => CoreErrorCode::Unauthorized,
        StoreErrorCode::GenerationConflict => CoreErrorCode::GenerationConflict,
        StoreErrorCode::MissingDependencies => CoreErrorCode::DocumentUpdateMissingDependencies,
        StoreErrorCode::MaterializationStale => CoreErrorCode::MaterializationStale,
        StoreErrorCode::WriterQueueFull | StoreErrorCode::ReaderPoolTimeout => {
            CoreErrorCode::Overloaded
        }
        StoreErrorCode::QueryCancelled => CoreErrorCode::Cancelled,
        StoreErrorCode::DeadlineExceeded => CoreErrorCode::DeadlineExceeded,
        StoreErrorCode::WriterClosed
        | StoreErrorCode::SqliteBusy
        | StoreErrorCode::SqliteFailure
        | StoreErrorCode::Internal => CoreErrorCode::CoreUnavailable,
        StoreErrorCode::AlreadyOwned
        | StoreErrorCode::InvalidProfile
        | StoreErrorCode::RuntimeIncompatible => CoreErrorCode::SchemaUnsupported,
    };
    CoreError {
        code,
        message: error.message,
        retryable: error.retryable,
        recovery: CoreErrorRecovery::None,
    }
}

fn invalid(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::InvalidInput,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn unavailable(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::CoreUnavailable,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use base64::prelude::{BASE64_URL_SAFE_NO_PAD, Engine as _};
    use std::collections::{BTreeMap, BTreeSet};

    use nodex_core_contracts::agent::{AgentExecutionAuthorization, AgentTurnProvenance};
    use nodex_core_contracts::collection::CollectionWindowRequest;
    use nodex_core_contracts::database::{
        DatabaseAgentDataSourceQuery, DatabaseAgentViewQuery, DatabaseGroupScope, DatabaseIntent,
        DatabaseListMoveEdge, DatabaseListMoveSelection, DatabaseListMoveTarget,
        DatabaseListProjectionExpectation, DatabaseListProjectionRow, DatabaseListTransientKind,
        DatabaseNumberFormat, DatabaseOperationOutcome, DatabaseOptionPlacement,
        DatabasePageKeyPrefixAvailability, DatabasePageLayoutPlacement,
        DatabasePagePropertyAddress, DatabasePagePropertyVisibility, DatabasePropertyPlacement,
        DatabasePropertySchema, DatabasePropertySetDelta, DatabasePropertyValueEdit,
        DatabasePropertyValueInput, DatabasePropertyValueMutation, DatabaseRowsTarget,
        DatabaseTaskParentPage, DatabaseTransferTarget, DatabaseViewCompletedRangeInput,
        DatabaseViewCompletionOverrideInput, DatabaseViewDefinition, DatabaseViewDisclosureTarget,
        DatabaseViewFilter, DatabaseViewFilterGroupOperator, DatabaseViewFilterOperator,
        DatabaseViewGroupOverrideInput, DatabaseViewLayout, DatabaseViewLayoutDisplayOverrideInput,
        DatabaseViewNullOrder, DatabaseViewPersonalPreferences, DatabaseViewPlacement,
        DatabaseViewPreferencesOverrideInput, DatabaseViewPresentationOverrideInput,
        DatabaseViewReadTarget, DatabaseViewRulesOverrideInput, DatabaseViewSort,
        DatabaseViewSortDirection, DatabaseViewSortDirectionInput, DatabaseViewSortField,
    };
    use nodex_core_contracts::library::{
        LIBRARY_CONTRACT_VERSION, LibraryIntent, LibraryPageLifecycleMutation, LibraryWriteParent,
    };
    use nodex_core_contracts::workspace::{
        PROJECT_WORKSPACE_CONTRACT_VERSION, ProjectWorkspaceIntent, ProjectWorkspaceThreadPatch,
        ProjectWorkspaceTurnAuthority, ProjectWorkspaceTurnAuthorityScope,
        ProjectWorkspaceTurnAuthoritySource,
    };
    use nodex_core_contracts::{
        AdapterKind, CoreModuleEventPayload, LibraryId, LocalProjectionPatch, LocalProjectionScope,
        ModuleApplyRequest, ProfileId, ProjectId, ProjectionImpact, StoreEpoch,
    };
    use rusqlite::params;
    use serde_json::{Value, json};
    use tempfile::tempdir;

    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::library::LibraryModule;
    use crate::workspace::ProjectWorkspaceModule;

    use super::*;

    const DATABASE_ID: &str = "018f1000-0000-7000-8000-000000000001";
    const SOURCE_ID: &str = "018f1000-0000-7000-8000-000000000002";
    const VIEW_ID: &str = "018f1000-0000-7000-8000-000000000003";
    const NOW: &str = "2026-07-19T00:15:00.000Z";

    fn view_config(filter: Value, group_property_id: Option<&str>, fields: &[&str]) -> Value {
        let advanced_filter =
            if filter == json!({ "kind": "group", "operator": "and", "children": [] }) {
                Value::Null
            } else if filter.get("kind").and_then(Value::as_str) == Some("clause") {
                json!({ "kind": "group", "operator": "and", "children": [filter] })
            } else {
                filter
            };
        let fields = fields
            .iter()
            .map(|property_id| json!({ "kind": "property", "propertyId": property_id }))
            .collect::<Vec<_>>();
        json!({
            "schemaKey": "nodex.database-view",
            "schemaVersion": 6,
            "rules": {
                "propertyFilters": [],
                "advancedFilter": advanced_filter,
                "sorts": [{
                    "field": { "kind": "manual" },
                    "direction": "asc",
                    "nulls": "last"
                }]
            },
            "presentation": {
                "group": group_property_id.map(|property_id| json!({
                    "propertyId": property_id
                })),
                "subgroup": null,
                "groupDirection": "asc",
                "completion": { "range": "all", "orderByRecency": false },
                "hierarchy": { "showSubPages": true, "nestedSubPages": false },
                "display": { "fields": fields, "showEmptyGroups": false }
            }
        })
    }

    fn view_definition(config: Value) -> DatabaseViewDefinition {
        super::view_contract::decode_definition_value(config)
            .expect("test View config must satisfy the durable definition contract")
    }

    fn preferences_override(
        presentation_override: DatabaseViewPresentationOverrideInput,
    ) -> DatabaseViewPreferencesOverrideInput {
        DatabaseViewPreferencesOverrideInput {
            presentation_override,
            ..Default::default()
        }
    }

    fn context() -> BoundModuleContext {
        BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project-1".to_owned())),
            connection_id: "connection:database-read".to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    fn library_context(adapter: AdapterKind) -> BoundModuleContext {
        BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: None,
            connection_id: "connection:database-library".to_owned(),
            adapter,
        }
    }

    #[test]
    fn creates_option_and_selects_it_atomically() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-1', 'library-1', 'Atomic options', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, 'epoch-1', ?1, ?1)",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed identity");
        let library = LibraryModule::new("profile-1", "library-1", &kernel);
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:atomic-option-database".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateDatabase {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        name: "Product work".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create Database");
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:atomic-option-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page:atomic-option".to_owned(),
                        document_id: "document:atomic-option".to_owned(),
                        title: "Atomic option".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create Page");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE projects SET database_block_id = ?1 WHERE id = 'project-1'",
                    [DATABASE_ID],
                )?;
                Ok(())
            })
            .expect("bind Project Database");

        let module = DatabaseModule::new("profile-1", "library-1", &kernel);
        let noncanonical_custom_property = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-noncanonical-property".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "risk".to_owned(),
                        expected_data_source_revision: 1,
                        expected_property_revision: 0,
                        name: "Risk".to_owned(),
                        schema: DatabasePropertySchema::Select,
                        before_property_id: None,
                    }],
                },
            )
            .expect_err("reject a noncanonical custom Property identity");
        assert_eq!(
            noncanonical_custom_property.code,
            CoreErrorCode::InvalidInput
        );

        let invalid_priority_schema = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-priority-schema".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "priority".to_owned(),
                        expected_data_source_revision: 1,
                        expected_property_revision: 1,
                        name: "Priority".to_owned(),
                        schema: DatabasePropertySchema::Text,
                        before_property_id: None,
                    }],
                },
            )
            .expect_err("reject non-select Priority schema");
        assert_eq!(invalid_priority_schema.code, CoreErrorCode::InvalidInput);

        let retired_priority_option = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-retired-priority-option".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutOption {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "priority".to_owned(),
                        option_id: "p4-later".to_owned(),
                        name: "P4 - Later".to_owned(),
                        color: None,
                        expected_property_revision: 1,
                    }],
                },
            )
            .expect_err("reject retired Priority option");
        assert_eq!(retired_priority_option.code, CoreErrorCode::InvalidInput);

        let view_revision = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT revision FROM database_views WHERE id = ?1",
                        [VIEW_ID],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("read primary View revision");
        let retired_priority_filter = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-retired-priority-filter".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: view_revision,
                        name: "Product work".to_owned(),
                        layout: DatabaseViewLayout::Board,
                        definition: view_definition(view_config(
                            json!({
                                "kind": "clause",
                                "propertyId": "priority",
                                "operator": "select_is",
                                "value": "p4-later"
                            }),
                            Some("status"),
                            &["status", "priority", "estimate", "tags"],
                        )),
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect_err("reject retired Priority filter");
        assert_eq!(retired_priority_filter.code, CoreErrorCode::InvalidInput);

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:atomic-option-membership".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::TransferPage {
                        page_id: "page:atomic-option".to_owned(),
                        expected_parent_revision: 1,
                        expected_active_membership_revision: 0,
                        target: DatabaseTransferTarget::DataSource {
                            data_source_id: SOURCE_ID.to_owned(),
                        },
                    }],
                },
            )
            .expect("add Page to Data Source");

        let applied = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:create-and-select-option".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![
                        DatabaseIntent::PutOption {
                            data_source_id: SOURCE_ID.to_owned(),
                            property_id: "tags".to_owned(),
                            option_id: "o_atomic01".to_owned(),
                            name: "Atomic".to_owned(),
                            color: Some("blue".to_owned()),
                            expected_property_revision: 1,
                        },
                        DatabaseIntent::EditPropertyValues {
                            edits: vec![DatabasePropertyValueMutation {
                                address: DatabasePagePropertyAddress {
                                    page_id: "page:atomic-option".to_owned(),
                                    data_source_id: SOURCE_ID.to_owned(),
                                    property_id: "tags".to_owned(),
                                },
                                edit: DatabasePropertyValueEdit::PatchSet {
                                    delta: DatabasePropertySetDelta::MultiSelect {
                                        add_option_ids: vec!["o_atomic01".to_owned()],
                                        remove_option_ids: Vec::new(),
                                    },
                                },
                            }],
                        },
                    ],
                },
            )
            .expect("create and select option in one transaction");
        assert_eq!(applied.committed.value.operation_count, 2);

        let replayed = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:create-and-select-option".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![
                        DatabaseIntent::PutOption {
                            data_source_id: SOURCE_ID.to_owned(),
                            property_id: "tags".to_owned(),
                            option_id: "o_atomic01".to_owned(),
                            name: "Atomic".to_owned(),
                            color: Some("blue".to_owned()),
                            expected_property_revision: 1,
                        },
                        DatabaseIntent::EditPropertyValues {
                            edits: vec![DatabasePropertyValueMutation {
                                address: DatabasePagePropertyAddress {
                                    page_id: "page:atomic-option".to_owned(),
                                    data_source_id: SOURCE_ID.to_owned(),
                                    property_id: "tags".to_owned(),
                                },
                                edit: DatabasePropertyValueEdit::PatchSet {
                                    delta: DatabasePropertySetDelta::MultiSelect {
                                        add_option_ids: vec!["o_atomic01".to_owned()],
                                        remove_option_ids: Vec::new(),
                                    },
                                },
                            }],
                        },
                    ],
                },
            )
            .expect("replay the atomic operation receipt");
        assert_eq!(replayed.committed.value.operation_count, 2);

        let noncanonical_tag_identity = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-noncanonical-tag-identity".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutOption {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "tags".to_owned(),
                        option_id: "tag:legacy".to_owned(),
                        name: "Legacy".to_owned(),
                        color: None,
                        expected_property_revision: 2,
                    }],
                },
            )
            .expect_err("reject a noncanonical tags option identity");
        assert_eq!(noncanonical_tag_identity.code, CoreErrorCode::InvalidInput);

        let noncanonical_tag_name = module.apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "operation:reject-noncanonical-tag-name".to_owned(),
                store_epoch: StoreEpoch("epoch-1".to_owned()),
                intent: vec![DatabaseIntent::PutOption {
                    data_source_id: SOURCE_ID.to_owned(),
                    property_id: "tags".to_owned(),
                    option_id: "o_name0001".to_owned(),
                    name: "Cafe\u{301}".to_owned(),
                    color: None,
                    expected_property_revision: 2,
                }],
            },
        );
        assert!(
            noncanonical_tag_name.is_err(),
            "Tags option names must already be Unicode NFC"
        );

        let failed = module.apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "operation:create-and-select-option-fails".to_owned(),
                store_epoch: StoreEpoch("epoch-1".to_owned()),
                intent: vec![
                    DatabaseIntent::PutOption {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "tags".to_owned(),
                        option_id: "o_atomic02".to_owned(),
                        name: "Must roll back".to_owned(),
                        color: None,
                        expected_property_revision: 2,
                    },
                    DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:missing".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "tags".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::PatchSet {
                                delta: DatabasePropertySetDelta::MultiSelect {
                                    add_option_ids: vec!["o_atomic02".to_owned()],
                                    remove_option_ids: Vec::new(),
                                },
                            },
                        }],
                    },
                ],
            },
        );
        assert!(
            failed.is_err(),
            "an invalid selection must fail the whole apply"
        );

        kernel
            .readers()
            .read_default(|connection| {
                let config = connection.query_row(
                    "SELECT config_json FROM data_source_properties \
                     WHERE data_source_id = ?1 AND id = 'tags'",
                    [SOURCE_ID],
                    |row| row.get::<_, String>(0),
                )?;
                let value = connection.query_row(
                    "SELECT value.value_json FROM data_source_property_values value \
                     JOIN data_source_page_memberships membership ON membership.id = value.membership_id \
                     WHERE value.data_source_id = ?1 AND value.property_id = 'tags' \
                       AND membership.page_block_id = 'page:atomic-option'",
                    [SOURCE_ID],
                    |row| row.get::<_, String>(0),
                )?;
                assert!(config.contains("o_atomic01"));
                assert!(!config.contains("o_atomic02"));
                assert_eq!(value, "[\"o_atomic01\"]");
                Ok(())
            })
            .expect("option registry and value commit together");
    }

    #[test]
    fn reads_catalog_descriptors_views_and_filtered_rows_from_one_authority() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-1', 'library-1', 'Database reads', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, 'epoch-1', ?1, ?1)",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed identity");
        let library = LibraryModule::new("profile-1", "library-1", &kernel);
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:database-read-fixture".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateDatabase {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        name: "Product work".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create Database");
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:database-row-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page:database-row".to_owned(),
                        document_id: "document:database-row".to_owned(),
                        title: "Fix sign-in".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create Page");
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:database-row-page-2".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page:database-row-2".to_owned(),
                        document_id: "document:database-row-2".to_owned(),
                        title: "Review release".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create second Page");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE projects SET database_block_id = ?1 WHERE id = 'project-1'",
                        [DATABASE_ID],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_properties(\
                           data_source_id, id, name, value_type, config_json, rank_key, lifecycle, \
                           schema_revision, created_at, updated_at\
                         ) VALUES (?1, 'p_agent000', 'Agent note', 'text', '{}', \
                           'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'active', 1, ?2, ?2)",
                        params![SOURCE_ID, NOW],
                    )?;
                    transaction.execute(
                        "DELETE FROM library_block_placements WHERE block_id = 'page:database-row'",
                        [],
                    )?;
                    transaction.execute(
                        "UPDATE pages SET parent_kind = 'data_source', parent_id = ?1 \
                         WHERE block_id = 'page:database-row'",
                        [SOURCE_ID],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_page_memberships(\
                           id, data_source_id, page_block_id, revision, created_at, removed_at\
                         ) VALUES ('membership:row', ?1, 'page:database-row', 1, ?2, NULL)",
                        params![SOURCE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_property_values(\
                           data_source_id, membership_id, property_id, value_type, value_json, \
                           revision, updated_at\
                         ) VALUES (?1, 'membership:row', 'status', 'select', '\"triage\"', 1, ?2)",
                        params![SOURCE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_property_values(\
                           data_source_id, membership_id, property_id, value_type, value_json, \
                           revision, updated_at\
                         ) VALUES (?1, 'membership:row', 'p_agent000', 'text', '\"alpha\"', 1, ?2)",
                        params![SOURCE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_property_values(\
                           data_source_id, membership_id, property_id, value_type, value_json, \
                           revision, updated_at\
                         ) VALUES (?1, 'membership:row', 'task_parent', 'relation', 'null', 1, ?2)",
                        params![SOURCE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO database_view_page_positions(\
                           view_id, page_block_id, rank_key, revision, created_at, updated_at\
                         ) VALUES (?1, 'page:database-row', 'a', 1, ?2, ?2)",
                        params![VIEW_ID, NOW],
                    )?;
                    transaction.execute(
                        "UPDATE page_read_model SET parent_kind = 'data_source', parent_id = ?1, \
                           library_rank_key = NULL, membership_id = 'membership:row', \
                           database_block_id = ?2, view_id = ?3, view_group_key = 'triage', \
                           view_rank_key = 'a', database_values_json = '{\"status\":\"triage\"}' \
                         WHERE page_block_id = 'page:database-row'",
                        params![SOURCE_ID, DATABASE_ID, VIEW_ID],
                    )?;
                    transaction.execute(
                        "DELETE FROM library_block_placements \
                         WHERE block_id = 'page:database-row-2'",
                        [],
                    )?;
                    transaction.execute(
                        "UPDATE pages SET parent_kind = 'data_source', parent_id = ?1 \
                         WHERE block_id = 'page:database-row-2'",
                        [SOURCE_ID],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_page_memberships(\
                           id, data_source_id, page_block_id, revision, created_at, removed_at\
                         ) VALUES ('membership:row-2', ?1, 'page:database-row-2', 1, ?2, NULL)",
                        params![SOURCE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_property_values(\
                           data_source_id, membership_id, property_id, value_type, value_json, \
                           revision, updated_at\
                         ) VALUES (?1, 'membership:row-2', 'task_parent', 'relation', 'null', 1, ?2)",
                        params![SOURCE_ID, NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO data_source_property_values(\
                           data_source_id, membership_id, property_id, value_type, value_json, \
                           revision, updated_at\
                         ) VALUES (?1, 'membership:row-2', 'p_agent000', 'text', '\"beta\"', 1, ?2)",
                        params![SOURCE_ID, NOW],
                    )?;
                    transaction.execute(
                        "UPDATE page_read_model SET parent_kind = 'data_source', parent_id = ?1, \
                           library_rank_key = NULL, membership_id = 'membership:row-2', \
                           database_block_id = ?2, view_id = NULL, view_group_key = NULL, \
                           view_rank_key = NULL, database_values_json = '{}' \
                         WHERE page_block_id = 'page:database-row-2'",
                        params![SOURCE_ID, DATABASE_ID],
                    )?;
                    Ok(())
                })
            })
            .expect("place Database row");
        let workspace = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel)
            .expect("Workspace module");
        workspace
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: "operation:database-agent-thread".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: ProjectWorkspaceIntent::UpsertThread {
                        thread_id: "thread:database-agent".to_owned(),
                        patch: Box::new(ProjectWorkspaceThreadPatch {
                            project_id: Some(Some("project-1".to_owned())),
                            thread_name: Some(Some("Database Agent".to_owned())),
                            created_at: Some(1),
                            updated_at: Some(1),
                            linked_at: Some(NOW.to_owned()),
                            ..ProjectWorkspaceThreadPatch::default()
                        }),
                    },
                },
            )
            .expect("persist Database Agent Thread");
        workspace
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    operation_id: "operation:database-agent-turn".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: ProjectWorkspaceIntent::FreezeTurnAuthority {
                        thread_id: "thread:database-agent".to_owned(),
                        turn_id: "turn:database-agent".to_owned(),
                        root_thread_id: "thread:database-agent".to_owned(),
                        actor_project_id: "project-1".to_owned(),
                        source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                        inherited_from: None,
                    },
                },
            )
            .expect("freeze Database Agent Turn");
        let agent_authorization = AgentExecutionAuthorization {
            provenance: AgentTurnProvenance {
                profile_id: "profile-1".to_owned(),
                authority: ProjectWorkspaceTurnAuthority {
                    thread_id: "thread:database-agent".to_owned(),
                    turn_id: "turn:database-agent".to_owned(),
                    root_thread_id: "thread:database-agent".to_owned(),
                    actor_project_id: "project-1".to_owned(),
                    library_id: "library-1".to_owned(),
                    store_epoch: "epoch-1".to_owned(),
                    scope: ProjectWorkspaceTurnAuthorityScope::Project,
                    source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                },
            },
            call_id: "call:database-agent".to_owned(),
            resource_access: None,
        };
        let module = DatabaseModule::new("profile-1", "library-1", &kernel);

        const BODY_SENTINEL: &str = "BODY-MUST-NOT-APPEAR-IN-DATABASE-WINDOW";
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE document_materializations SET nfm = ?1 \
                     WHERE document_id = 'document:database-row'",
                    [BODY_SENTINEL],
                )?;
                Ok(())
            })
            .expect("seed a Page body sentinel");
        let first_window = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::ProjectDefault,
                        window: CollectionWindowRequest {
                            after: None,
                            first: Some(1),
                        },
                        group_scope: None,
                    },
                },
            )
            .expect("read the first bounded Database View window");
        let authorization = first_window
            .authorization
            .as_ref()
            .expect("Database View window has canonical read authorization");
        assert_eq!(authorization.covered_commit_seq, first_window.commit_head);
        assert!(matches!(
            &authorization.subject,
            nodex_core_contracts::events::ResourceKey::Project { project_id }
                if project_id == "project-1"
        ));
        assert!(
            authorization
                .authorization_dependencies
                .iter()
                .any(|resource| {
                    matches!(
                        resource,
                        nodex_core_contracts::events::ResourceKey::Page { page_id }
                            if page_id == "page:database-row"
                    )
                })
        );
        assert_eq!(authorization.stamp_hash.len(), 64);
        let DatabaseReadValue::ViewWindow {
            value: first_window,
        } = first_window.value
        else {
            panic!("Database View window snapshot");
        };
        assert_eq!(first_window.rows.items.len(), 1);
        assert_eq!(first_window.rows.items[0].page_id, "page:database-row");
        let next_cursor = first_window
            .rows
            .next_cursor
            .clone()
            .expect("first window has a continuation");
        let encoded_window =
            serde_json::to_vec(&first_window).expect("encode Database View window");
        assert!(encoded_window.len() < 1024 * 1024);
        assert!(
            !String::from_utf8(encoded_window)
                .expect("window JSON is UTF-8")
                .contains(BODY_SENTINEL)
        );

        let next_window = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::ProjectDefault,
                        window: CollectionWindowRequest {
                            after: Some(next_cursor),
                            first: Some(1),
                        },
                        group_scope: None,
                    },
                },
            )
            .expect("continue the Database View window");
        let DatabaseReadValue::ViewWindow { value: next_window } = next_window.value else {
            panic!("next Database View window snapshot");
        };
        assert_eq!(
            next_window
                .rows
                .items
                .iter()
                .map(|row| row.page_id.as_str())
                .collect::<Vec<_>>(),
            ["page:database-row-2"]
        );
        assert!(next_window.rows.next_cursor.is_none());

        let rows_by_id = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::RowsById {
                        target: DatabaseRowsTarget::ProjectDefault,
                        page_ids: vec!["page:database-row-2".to_owned()],
                    },
                },
            )
            .expect("read one Database row by identity");
        let DatabaseReadValue::RowsById { value: rows_by_id } = rows_by_id.value else {
            panic!("Database rows-by-ID snapshot");
        };
        assert_eq!(rows_by_id.rows.len(), 1);
        assert_eq!(rows_by_id.rows[0].page_id, "page:database-row-2");

        let row_detail = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::RowDetail {
                        page_id: "page:database-row".to_owned(),
                    },
                },
            )
            .expect("read one Database row detail");
        let DatabaseReadValue::RowDetail { value: row_detail } = row_detail.value else {
            panic!("Database row detail snapshot");
        };
        assert_eq!(row_detail.summary.page_id, "page:database-row");
        assert_eq!(row_detail.body_nfm, BODY_SENTINEL);

        let agent_query = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::AgentDataSourceQuery {
                        data_source_id: SOURCE_ID.to_owned(),
                        query: DatabaseAgentDataSourceQuery {
                            authorization: agent_authorization.clone(),
                            cursor: None,
                            limit: Some(1),
                            projection_property_ids: None,
                            filter: DatabaseViewFilter::Group {
                                operator: DatabaseViewFilterGroupOperator::And,
                                children: Vec::new(),
                            },
                            sort: Vec::new(),
                        },
                    },
                },
            )
            .expect("query primary Data Source with exact Agent Turn authority");
        let DatabaseReadValue::AgentDataSourceQuery { value } = agent_query.value else {
            panic!("Agent Database query snapshot");
        };
        assert_eq!(value.rows.items[0].page_id, "page:database-row");
        assert!(value.rows.next_cursor.is_some());
        let next_cursor = value
            .rows
            .next_cursor
            .expect("Agent query has a next cursor");
        let cursor_before_change = next_cursor.clone();
        let mut continuation_authorization = agent_authorization.clone();
        continuation_authorization.call_id = "call:database-agent-next".to_owned();
        let next_agent_query = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::AgentDataSourceQuery {
                        data_source_id: SOURCE_ID.to_owned(),
                        query: DatabaseAgentDataSourceQuery {
                            authorization: continuation_authorization,
                            cursor: Some(next_cursor),
                            limit: Some(1),
                            projection_property_ids: None,
                            filter: DatabaseViewFilter::Group {
                                operator: DatabaseViewFilterGroupOperator::And,
                                children: Vec::new(),
                            },
                            sort: Vec::new(),
                        },
                    },
                },
            )
            .expect("continue exact Agent Database query");
        let DatabaseReadValue::AgentDataSourceQuery { value } = next_agent_query.value else {
            panic!("next Agent Database query snapshot");
        };
        assert_eq!(value.rows.items[0].page_id, "page:database-row-2");
        assert!(value.rows.next_cursor.is_none());

        let mut sorted_authorization = agent_authorization.clone();
        sorted_authorization.call_id = "call:database-agent-sorted".to_owned();
        let sorted_agent_query = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::AgentDataSourceQuery {
                        data_source_id: SOURCE_ID.to_owned(),
                        query: DatabaseAgentDataSourceQuery {
                            authorization: sorted_authorization,
                            cursor: None,
                            limit: Some(2),
                            projection_property_ids: Some(vec!["p_agent000".to_owned()]),
                            filter: DatabaseViewFilter::Group {
                                operator: DatabaseViewFilterGroupOperator::And,
                                children: Vec::new(),
                            },
                            sort: vec![DatabaseViewSort {
                                field: DatabaseViewSortField::Title,
                                direction: DatabaseViewSortDirection::Desc,
                                nulls: DatabaseViewNullOrder::Last,
                            }],
                        },
                    },
                },
            )
            .expect("run a sorted transient Data Source query");
        let DatabaseReadValue::AgentDataSourceQuery { value } = sorted_agent_query.value else {
            panic!("sorted Agent Data Source query snapshot");
        };
        assert_eq!(
            value
                .rows
                .items
                .iter()
                .map(|row| row.page_id.as_str())
                .collect::<Vec<_>>(),
            ["page:database-row-2", "page:database-row"]
        );
        assert_eq!(
            value.rows.items[0].database_values.get("p_agent000"),
            Some(&json!("beta"))
        );
        assert_eq!(value.rows.items[0].effective_group_key, None);
        assert_eq!(value.rows.items[0].rank_key, None);

        let mut manual_sort_authorization = agent_authorization.clone();
        manual_sort_authorization.call_id = "call:database-agent-manual-sort".to_owned();
        let manual_sort_error = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::AgentDataSourceQuery {
                        data_source_id: SOURCE_ID.to_owned(),
                        query: DatabaseAgentDataSourceQuery {
                            authorization: manual_sort_authorization,
                            cursor: None,
                            limit: Some(2),
                            projection_property_ids: None,
                            filter: DatabaseViewFilter::Group {
                                operator: DatabaseViewFilterGroupOperator::And,
                                children: Vec::new(),
                            },
                            sort: vec![DatabaseViewSort {
                                field: DatabaseViewSortField::Manual,
                                direction: DatabaseViewSortDirection::Asc,
                                nulls: DatabaseViewNullOrder::Last,
                            }],
                        },
                    },
                },
            )
            .expect_err("transient Data Source query rejects View manual order");
        assert_eq!(manual_sort_error.code, CoreErrorCode::InvalidInput);

        let mut view_authorization = agent_authorization.clone();
        view_authorization.call_id = "call:database-agent-view-projection".to_owned();
        let agent_view_query = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::AgentViewQuery {
                        view_id: VIEW_ID.to_owned(),
                        query: DatabaseAgentViewQuery {
                            authorization: view_authorization,
                            cursor: None,
                            limit: Some(1),
                            projection_property_ids: Some(vec!["p_agent000".to_owned()]),
                        },
                    },
                },
            )
            .expect("project a hidden Property through a saved View query");
        let DatabaseReadValue::AgentViewQuery { value } = agent_view_query.value else {
            panic!("Agent View query snapshot");
        };
        assert_eq!(
            value.rows.items[0].database_values.get("p_agent000"),
            Some(&json!("alpha"))
        );

        let mut filtered_authorization = agent_authorization.clone();
        filtered_authorization.call_id = "call:database-agent-filtered".to_owned();
        let filtered_agent_query = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::AgentDataSourceQuery {
                        data_source_id: SOURCE_ID.to_owned(),
                        query: DatabaseAgentDataSourceQuery {
                            authorization: filtered_authorization,
                            cursor: None,
                            limit: Some(10),
                            projection_property_ids: Some(Vec::new()),
                            filter: DatabaseViewFilter::Clause {
                                property_id: "status".to_owned(),
                                operator: DatabaseViewFilterOperator::IsEmpty,
                                value: None,
                            },
                            sort: Vec::new(),
                        },
                    },
                },
            )
            .expect("run a filtered transient Data Source query");
        let DatabaseReadValue::AgentDataSourceQuery { value } = filtered_agent_query.value else {
            panic!("filtered Agent Data Source query snapshot");
        };
        assert_eq!(
            value
                .rows
                .items
                .iter()
                .map(|row| row.page_id.as_str())
                .collect::<Vec<_>>(),
            ["page:database-row-2"]
        );
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated) \
                     VALUES ('project-2', 'library-1', 'Granted reader', ?1, ?1)",
                    [NOW],
                )?;
                connection.execute(
                    "INSERT INTO project_resource_grants(\
                       id, project_id, library_id, root_kind, root_id, access, recursive, \
                       revision, lifecycle, created_at, updated_at\
                     ) VALUES ('grant:project-2-database', 'project-2', 'library-1', \
                       'database', ?1, 'read', 1, 1, 'active', ?2, ?2)",
                    params![DATABASE_ID, NOW],
                )?;
                Ok(())
            })
            .expect("grant a second Project the source Database");
        let transfer = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:database-agent-page-2-cleanup".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::TransferPage {
                        page_id: "page:database-row-2".to_owned(),
                        expected_parent_revision: 1,
                        expected_active_membership_revision: 1,
                        target: DatabaseTransferTarget::Library {
                            library_id: "library-1".to_owned(),
                        },
                    }],
                },
            )
            .expect("remove second Agent query row from the shared fixture");
        assert!(matches!(
            transfer
                .event
                .as_ref()
                .expect("transfer event")
                .projection_impact,
            ProjectionImpact::Resources { .. }
        ));
        let transfer_manifest = kernel
            .readers()
            .read_default(|connection| {
                crate::infrastructure::local_commit::read_manifest(
                    connection,
                    transfer.committed.commit_seq,
                )
            })
            .expect("transfer projection manifest");
        for project_id in ["project-1", "project-2"] {
            assert!(transfer_manifest.projection_effects.iter().any(|effect| {
                matches!(
                    &effect.scope.scope,
                    LocalProjectionScope::DatabaseView {
                        project_id: affected_project_id,
                        view_id,
                        ..
                    } if affected_project_id == project_id && view_id == VIEW_ID
                ) && effect.patch.is_none()
                    && effect.requires_read_at_least
            }));
        }
        assert!(transfer_manifest.revocations.iter().any(|revocation| {
            matches!(
                &revocation.authorization_scope,
                nodex_core_contracts::events::DeliveryAuthorizationScope::Project {
                    project_id,
                    ..
                } if project_id == "project-2"
            ) && revocation.resource_id == "page:database-row-2"
        }));
        let continued_after_change = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::AgentDataSourceQuery {
                        data_source_id: SOURCE_ID.to_owned(),
                        query: DatabaseAgentDataSourceQuery {
                            authorization: agent_authorization,
                            cursor: Some(cursor_before_change),
                            limit: Some(1),
                            projection_property_ids: None,
                            filter: DatabaseViewFilter::Group {
                                operator: DatabaseViewFilterGroupOperator::And,
                                children: Vec::new(),
                            },
                            sort: Vec::new(),
                        },
                    },
                },
            )
            .expect("Agent Database cursor survives a concurrent commit");
        let DatabaseReadValue::AgentDataSourceQuery { value } = continued_after_change.value else {
            panic!("continued Agent Database query snapshot");
        };
        assert!(value.rows.items.is_empty());
        assert!(value.rows.next_cursor.is_none());

        let catalog = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::CatalogWindow {
                        window: Default::default(),
                    },
                },
            )
            .expect("read catalog");
        let DatabaseReadValue::CatalogWindow { databases } = catalog.value else {
            panic!("catalog snapshot");
        };
        assert_eq!(databases.items.len(), 1);
        assert_eq!(databases.items[0].database.database_id, DATABASE_ID);
        let data_sources = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::DataSourceWindow {
                        database_id: DATABASE_ID.to_owned(),
                        window: Default::default(),
                    },
                },
            )
            .expect("read Data Source descriptor window");
        let DatabaseReadValue::DataSourceWindow { data_sources } = data_sources.value else {
            panic!("Data Source descriptor window");
        };
        assert_eq!(data_sources.items[0].data_source_id, SOURCE_ID);
        let views = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewDescriptorWindow {
                        database_id: DATABASE_ID.to_owned(),
                        window: Default::default(),
                    },
                },
            )
            .expect("read View descriptor window");
        let DatabaseReadValue::ViewDescriptorWindow { views } = views.value else {
            panic!("View descriptor window");
        };
        assert!(views.items[0].is_default);

        let page_row = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::RowDetail {
                        page_id: "page:database-row".to_owned(),
                    },
                },
            )
            .expect("read exact Database Page row");
        let DatabaseReadValue::RowDetail { value: page_row } = page_row.value else {
            panic!("Database Page row snapshot");
        };
        assert_eq!(page_row.summary.page_id, "page:database-row");
        assert_eq!(page_row.summary.position_order, Some(0));
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE blocks SET lifecycle = 'archived' \
                         WHERE id = 'page:database-row'",
                        [],
                    )?;
                    transaction.execute(
                        "UPDATE page_read_model SET lifecycle = 'archived' \
                         WHERE page_block_id = 'page:database-row'",
                        [],
                    )?;
                    Ok(())
                })
            })
            .expect("archive Database Page fixture");
        let archived_row = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::RowDetail {
                        page_id: "page:database-row".to_owned(),
                    },
                },
            )
            .expect("read archived Database Page row");
        let DatabaseReadValue::RowDetail {
            value: archived_row,
        } = archived_row.value
        else {
            panic!("archived Database Page row snapshot");
        };
        assert_eq!(archived_row.summary.lifecycle, "archived");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE blocks SET lifecycle = 'active' \
                         WHERE id = 'page:database-row'",
                        [],
                    )?;
                    transaction.execute(
                        "UPDATE page_read_model SET lifecycle = 'active' \
                         WHERE page_block_id = 'page:database-row'",
                        [],
                    )?;
                    Ok(())
                })
            })
            .expect("restore Database Page fixture");

        let request = ModuleApplyRequest {
            contract_version: DATABASE_CONTRACT_VERSION,
            operation_id: "operation:database-schema-values".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: vec![
                DatabaseIntent::PutProperty {
                    data_source_id: SOURCE_ID.to_owned(),
                    property_id: "p_risk0000".to_owned(),
                    expected_data_source_revision: 1,
                    expected_property_revision: 0,
                    name: "Risk".to_owned(),
                    schema: DatabasePropertySchema::Select,
                    before_property_id: Some("tags".to_owned()),
                },
                DatabaseIntent::PutOption {
                    data_source_id: SOURCE_ID.to_owned(),
                    property_id: "p_risk0000".to_owned(),
                    option_id: "o_high0000".to_owned(),
                    name: "High".to_owned(),
                    color: Some("red".to_owned()),
                    expected_property_revision: 1,
                },
                DatabaseIntent::EditPropertyValues {
                    edits: vec![DatabasePropertyValueMutation {
                        address: DatabasePagePropertyAddress {
                            page_id: "page:database-row".to_owned(),
                            data_source_id: SOURCE_ID.to_owned(),
                            property_id: "p_risk0000".to_owned(),
                        },
                        edit: DatabasePropertyValueEdit::Replace {
                            expected_value_revision: 0,
                            value: DatabasePropertyValueInput::Select {
                                option_id: "o_high0000".to_owned(),
                            },
                        },
                    }],
                },
            ],
        };
        let applied = module
            .apply(&context(), request.clone())
            .expect("commit schema and value batch");
        assert_eq!(applied.committed.value.operation_count, 3);
        assert!(!applied.committed.receipt.mutation.duplicate);
        assert_eq!(
            applied.committed.receipt.affected_database_ids,
            [DATABASE_ID]
        );
        assert_eq!(
            applied.committed.receipt.affected_page_ids,
            ["page:database-row"]
        );
        assert_eq!(
            applied.committed.receipt.operation_kinds,
            ["put_property", "put_option", "edit_property_values"]
        );
        assert_eq!(
            applied.committed.receipt.committed_revisions,
            BTreeMap::from([
                (format!("source:{SOURCE_ID}"), 3),
                (format!("property:{SOURCE_ID}:p_risk0000"), 2),
                (format!("page_layout:{SOURCE_ID}"), 2),
                (format!("value:{SOURCE_ID}:membership:row:p_risk0000"), 1),
                ("page:page:database-row:metadata".to_owned(), 2),
            ])
        );
        assert_eq!(
            applied.committed.receipt.commit_seq,
            applied.committed.commit_seq
        );
        let event = applied.event.as_ref().expect("committed Database event");
        assert_eq!(applied.committed.receipt.committed_at, event.committed_at);
        let schema_manifest = kernel
            .readers()
            .read_default(|connection| {
                crate::infrastructure::local_commit::read_manifest(
                    connection,
                    applied.committed.commit_seq,
                )
            })
            .expect("schema CommitManifest");
        assert!(schema_manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                LocalProjectionScope::PageDetailDataSource { data_source_id, .. }
                    if data_source_id == SOURCE_ID
            )
        }));
        kernel
            .writer()
            .call(|connection| {
                let revisions = connection.query_row(
                    "SELECT block.metadata_revision, projection.metadata_revision \
                     FROM blocks block \
                     JOIN page_read_model projection ON projection.page_block_id = block.id \
                     WHERE block.id = 'page:database-row'",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?;
                assert_eq!(revisions, (2, 2));
                Ok(())
            })
            .expect("Page metadata projections stay synchronized after value writes");

        let noncanonical_custom_option = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-noncanonical-custom-option".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutOption {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_risk0000".to_owned(),
                        option_id: "high".to_owned(),
                        name: "High".to_owned(),
                        color: None,
                        expected_property_revision: 2,
                    }],
                },
            )
            .expect_err("reject a noncanonical custom option identity");
        assert_eq!(noncanonical_custom_option.code, CoreErrorCode::InvalidInput);

        let noncanonical_option_name = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-noncanonical-option-name".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutOption {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_risk0000".to_owned(),
                        option_id: "o_other000".to_owned(),
                        name: " Other ".to_owned(),
                        color: None,
                        expected_property_revision: 2,
                    }],
                },
            )
            .expect_err("reject a noncanonical option name");
        assert_eq!(noncanonical_option_name.code, CoreErrorCode::InvalidInput);

        let replayed = module
            .apply(&context(), request.clone())
            .expect("replay exact Database batch");
        assert!(replayed.committed.receipt.mutation.duplicate);
        assert_eq!(
            replayed.committed.event_sequence,
            applied.committed.event_sequence
        );
        assert_eq!(
            replayed.committed.receipt.committed_revisions,
            applied.committed.receipt.committed_revisions
        );
        assert_eq!(
            replayed.committed.receipt.committed_at,
            applied.committed.receipt.committed_at
        );
        assert!(replayed.event.is_none());

        let mut divergent = request;
        divergent.intent.push(DatabaseIntent::EditPropertyValues {
            edits: vec![DatabasePropertyValueMutation {
                address: DatabasePagePropertyAddress {
                    page_id: "page:database-row".to_owned(),
                    data_source_id: SOURCE_ID.to_owned(),
                    property_id: "p_risk0000".to_owned(),
                },
                edit: DatabasePropertyValueEdit::Replace {
                    expected_value_revision: 1,
                    value: DatabasePropertyValueInput::Empty,
                },
            }],
        });
        let collision = module
            .apply(&context(), divergent)
            .expect_err("reject divergent Database retry");
        assert_eq!(collision.code, CoreErrorCode::IdempotencyKeyReused);

        let rollback = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:database-rollback".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![
                        DatabaseIntent::PutProperty {
                            data_source_id: SOURCE_ID.to_owned(),
                            property_id: "p_score000".to_owned(),
                            expected_data_source_revision: 3,
                            expected_property_revision: 0,
                            name: "Score".to_owned(),
                            schema: DatabasePropertySchema::Number {
                                format: Default::default(),
                            },
                            before_property_id: None,
                        },
                        DatabaseIntent::EditPropertyValues {
                            edits: vec![DatabasePropertyValueMutation {
                                address: DatabasePagePropertyAddress {
                                    page_id: "page:database-row".to_owned(),
                                    data_source_id: SOURCE_ID.to_owned(),
                                    property_id: "status".to_owned(),
                                },
                                edit: DatabasePropertyValueEdit::Replace {
                                    expected_value_revision: 99,
                                    value: DatabasePropertyValueInput::Select {
                                        option_id: "build".to_owned(),
                                    },
                                },
                            }],
                        },
                    ],
                },
            )
            .expect_err("roll back an invalid Database batch");
        assert_eq!(rollback.code, CoreErrorCode::RevisionConflict);

        let source = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::DataSource {
                        data_source_id: SOURCE_ID.to_owned(),
                    },
                },
            )
            .expect("read committed Data Source schema");
        let DatabaseReadValue::DataSource { value: source } = source.value else {
            panic!("Data Source descriptor snapshot");
        };
        assert_eq!(source.data_source.schema_revision, 3);
        let properties = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::PropertyWindow {
                        data_source_id: SOURCE_ID.to_owned(),
                        window: Default::default(),
                    },
                },
            )
            .expect("read committed Property window");
        let DatabaseReadValue::PropertyWindow { properties } = properties.value else {
            panic!("Property window");
        };
        assert_eq!(properties.items.len(), 11);
        assert!(
            properties
                .items
                .iter()
                .all(|value| value.property_id != "p_score000")
        );
        let status = properties
            .items
            .iter()
            .find(|value| value.property_id == "status")
            .expect("status Property");
        assert_eq!(status.schema, DatabasePropertySchema::Select);
        assert!(status.option_count > 0);
        assert!(status.capabilities.sortable);
        let options = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::OptionWindow {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "status".to_owned(),
                        window: CollectionWindowRequest {
                            after: None,
                            first: Some(1),
                        },
                    },
                },
            )
            .expect("read first Property option window");
        let DatabaseReadValue::OptionWindow { options } = options.value else {
            panic!("Property option window");
        };
        assert_eq!(options.items.len(), 1);
        assert_eq!(options.items[0].id, "triage");
        let second_option = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::OptionWindow {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "status".to_owned(),
                        window: CollectionWindowRequest {
                            after: options.next_cursor,
                            first: Some(1),
                        },
                    },
                },
            )
            .expect("read next Property option in config order");
        let DatabaseReadValue::OptionWindow {
            options: second_option,
        } = second_option.value
        else {
            panic!("second Property option window");
        };
        assert_eq!(second_option.items[0].id, "plan");
        let row_window = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::View {
                            view_id: VIEW_ID.to_owned(),
                        },
                        window: Default::default(),
                        group_scope: None,
                    },
                },
            )
            .expect("read committed Database row window");
        let DatabaseReadValue::ViewWindow { value: row_window } = row_window.value else {
            panic!("Database row window snapshot");
        };
        assert_eq!(row_window.rows.items[0].page_id, "page:database-row");

        const SECOND_VIEW_ID: &str = "018f1000-0000-7000-8000-000000000004";
        let ungrouped_config = view_config(
            json!({ "kind": "group", "operator": "and", "children": [] }),
            None,
            &["status", "p_risk0000"],
        );
        let view_and_position = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:database-view-position".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![
                        DatabaseIntent::PutView {
                            database_id: DATABASE_ID.to_owned(),
                            data_source_id: SOURCE_ID.to_owned(),
                            view_id: SECOND_VIEW_ID.to_owned(),
                            expected_revision: 0,
                            name: "Risk list".to_owned(),
                            layout: DatabaseViewLayout::List,
                            definition: view_definition(ungrouped_config.clone()),
                            is_default: true,
                            before_view_id: Some(VIEW_ID.to_owned()),
                        },
                        DatabaseIntent::PositionPage {
                            view_id: SECOND_VIEW_ID.to_owned(),
                            page_id: "page:database-row".to_owned(),
                            expected_position_revision: 0,
                            before_page_id: None,
                        },
                    ],
                },
            )
            .expect("create default View and position its row atomically");
        assert_eq!(view_and_position.committed.value.operation_count, 2);
        assert_eq!(
            view_and_position.committed.receipt.affected_view_ids,
            [SECOND_VIEW_ID]
        );
        let grouped_config = view_config(
            json!({ "kind": "group", "operator": "and", "children": [] }),
            Some("p_risk0000"),
            &["status", "p_risk0000"],
        );
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:database-view-regroup".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![
                        DatabaseIntent::PutView {
                            database_id: DATABASE_ID.to_owned(),
                            data_source_id: SOURCE_ID.to_owned(),
                            view_id: SECOND_VIEW_ID.to_owned(),
                            expected_revision: 1,
                            name: "Risk board".to_owned(),
                            layout: DatabaseViewLayout::Board,
                            definition: view_definition(grouped_config),
                            is_default: true,
                            before_view_id: None,
                        },
                        DatabaseIntent::PositionPage {
                            view_id: SECOND_VIEW_ID.to_owned(),
                            page_id: "page:database-row".to_owned(),
                            expected_position_revision: 0,
                            before_page_id: None,
                        },
                    ],
                },
            )
            .expect("clear stale positions and position against the new group");
        let grouped = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::View {
                            view_id: SECOND_VIEW_ID.to_owned(),
                        },
                        window: Default::default(),
                        group_scope: None,
                    },
                },
            )
            .expect("query regrouped View");
        let DatabaseReadValue::ViewWindow { value: grouped } = grouped.value else {
            panic!("View query snapshot");
        };
        assert_eq!(
            grouped.rows.items[0].effective_group_key.as_deref(),
            Some("o_high0000")
        );
        assert_eq!(grouped.rows.items[0].position_revision, Some(1));
        let personally_ungrouped = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::PresentedView {
                            view_id: SECOND_VIEW_ID.to_owned(),
                            preferences_override: preferences_override(
                                DatabaseViewPresentationOverrideInput {
                                    group: Some(DatabaseViewGroupOverrideInput::None),
                                    subgroup: None,
                                    group_direction: None,
                                    completion: None,
                                    hierarchy: None,
                                    display: None,
                                },
                            ),
                        },
                        window: Default::default(),
                        group_scope: None,
                    },
                },
            )
            .expect("query View through a personal presentation override");
        let DatabaseReadValue::ViewWindow {
            value: personally_ungrouped,
        } = personally_ungrouped.value
        else {
            panic!("personally presented View query snapshot");
        };
        assert_eq!(personally_ungrouped.rows.items[0].effective_group_key, None);
        kernel
            .writer()
            .call(|connection| {
                let revisions = connection.query_row(
                    "SELECT block.metadata_revision, projection.metadata_revision \
                     FROM blocks block \
                     JOIN page_read_model projection ON projection.page_block_id = block.id \
                     WHERE block.id = 'page:database-row'",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?;
                assert_eq!(revisions.0, revisions.1);
                Ok(())
            })
            .expect("Page metadata projections stay synchronized after positioning");

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:database-delete-old-view".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::DeleteView {
                        database_id: DATABASE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                    }],
                },
            )
            .expect("delete a non-default View");
        let old_view = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                },
            )
            .expect("read deleted View descriptor");
        let DatabaseReadValue::View { value: old_view } = old_view.value else {
            panic!("View descriptor snapshot");
        };
        assert_eq!(old_view.lifecycle, "deleted");
        assert_eq!(old_view.revision, 2);

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:database-row-to-library".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::TransferPage {
                        page_id: "page:database-row".to_owned(),
                        expected_parent_revision: 1,
                        expected_active_membership_revision: 1,
                        target: DatabaseTransferTarget::Library {
                            library_id: "library-1".to_owned(),
                        },
                    }],
                },
            )
            .expect("transfer a Database row back to the Library");
        let empty_source = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::View {
                            view_id: SECOND_VIEW_ID.to_owned(),
                        },
                        window: Default::default(),
                        group_scope: None,
                    },
                },
            )
            .expect("read source after row transfer");
        let DatabaseReadValue::ViewWindow {
            value: empty_source,
        } = empty_source.value
        else {
            panic!("Data Source query snapshot");
        };
        assert!(empty_source.rows.items.is_empty());

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:database-row-return".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::TransferPage {
                        page_id: "page:database-row".to_owned(),
                        expected_parent_revision: 2,
                        expected_active_membership_revision: 0,
                        target: DatabaseTransferTarget::DataSource {
                            data_source_id: SOURCE_ID.to_owned(),
                        },
                    }],
                },
            )
            .expect("restore the historical Data Source membership");
        let returned = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::View {
                            view_id: SECOND_VIEW_ID.to_owned(),
                        },
                        window: Default::default(),
                        group_scope: None,
                    },
                },
            )
            .expect("read restored Database row");
        let DatabaseReadValue::ViewWindow { value: returned } = returned.value else {
            panic!("Data Source query snapshot");
        };
        assert_eq!(returned.rows.items[0].membership_revision, 3);
        let page_parent_rejection = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:database-page-parent-rejected".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::TransferPage {
                        page_id: "page:database-row".to_owned(),
                        expected_parent_revision: 3,
                        expected_active_membership_revision: 3,
                        target: DatabaseTransferTarget::Page {
                            page_id: "page:database-row".to_owned(),
                        },
                    }],
                },
            )
            .expect_err("Page-parent transfers require Document authority");
        assert_eq!(page_parent_rejection.code, CoreErrorCode::InvalidInput);

        let library_source = module
            .read(
                &library_context(AdapterKind::Test),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::DataSource {
                        data_source_id: SOURCE_ID.to_owned(),
                    },
                },
            )
            .expect("trusted Library scope reads a concrete Data Source");
        let DatabaseReadValue::DataSource {
            value: library_source,
        } = library_source.value
        else {
            panic!("Library Data Source descriptor");
        };
        assert_eq!(library_source.data_source.data_source_id, SOURCE_ID);
        let untrusted_library_read = module
            .read(
                &library_context(AdapterKind::Agent),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::DataSource {
                        data_source_id: SOURCE_ID.to_owned(),
                    },
                },
            )
            .expect_err("untrusted Adapter cannot claim Library Database scope");
        assert_eq!(untrusted_library_read.code, CoreErrorCode::Unauthorized);

        let library_write = module
            .apply(
                &library_context(AdapterKind::Test),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:library-database-property".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_libnote0".to_owned(),
                        expected_data_source_revision: 3,
                        expected_property_revision: 0,
                        name: "Library note".to_owned(),
                        schema: DatabasePropertySchema::Text,
                        before_property_id: None,
                    }],
                },
            )
            .expect("trusted Library scope mutates a concrete Data Source");
        assert_eq!(
            library_write.committed.receipt.committed_revisions,
            BTreeMap::from([
                (format!("source:{SOURCE_ID}"), 4),
                (format!("property:{SOURCE_ID}:p_libnote0"), 1),
                (format!("page_layout:{SOURCE_ID}"), 3),
            ])
        );
        let library_event = library_write.event.expect("Library Database event");
        let CoreModuleEventPayload::Database(library_event) = library_event.payload else {
            panic!("Database event payload");
        };
        assert_eq!(library_event.project_id, None);

        let database_events = kernel
            .writer()
            .call(|connection| {
                connection
                    .query_row(
                        "SELECT count(*) FROM change_log WHERE kind = 'database.changed'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("count Database events");
        assert_eq!(database_events, 8);
    }

    struct GroupRowSpec {
        page_id: &'static str,
        title: &'static str,
        value_json: Option<&'static str>,
        rank_key: Option<&'static str>,
    }

    fn seed_grouped_fixture(kernel: &SqliteStoreKernel, rows: Vec<GroupRowSpec>) -> DatabaseModule {
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-1', 'library-1', 'Grouped windows', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                         VALUES (1, 'epoch-1', ?1, ?1)",
                        [NOW],
                    )?;
                    Ok(())
                })
            })
            .expect("seed identity");
        let library = LibraryModule::new("profile-1", "library-1", kernel);
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:grouped-fixture-database".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateDatabase {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        name: "Grouped work".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create Database");
        for row in &rows {
            library
                .apply(
                    &context(),
                    ModuleApplyRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        operation_id: format!("operation:grouped-fixture-{}", row.page_id),
                        store_epoch: StoreEpoch("epoch-1".to_owned()),
                        intent: LibraryIntent::CreatePage {
                            page_id: row.page_id.to_owned(),
                            document_id: format!("document:{}", row.page_id),
                            title: row.title.to_owned(),
                            parent: LibraryWriteParent::Library { before: None },
                        },
                    },
                )
                .expect("create Page");
        }
        kernel
            .writer()
            .call(move |connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE projects SET database_block_id = ?1 WHERE id = 'project-1'",
                        [DATABASE_ID],
                    )?;
                    for row in &rows {
                        let membership_id = format!("membership:{}", row.page_id);
                        transaction.execute(
                            "DELETE FROM library_block_placements WHERE block_id = ?1",
                            [row.page_id],
                        )?;
                        transaction.execute(
                            "UPDATE pages SET parent_kind = 'data_source', parent_id = ?1 \
                             WHERE block_id = ?2",
                            params![SOURCE_ID, row.page_id],
                        )?;
                        transaction.execute(
                            "INSERT INTO data_source_page_memberships(\
                               id, data_source_id, page_block_id, revision, created_at, removed_at\
                             ) VALUES (?1, ?2, ?3, 1, ?4, NULL)",
                            params![membership_id, SOURCE_ID, row.page_id, NOW],
                        )?;
                        transaction.execute(
                            "INSERT INTO data_source_property_values(\
                               data_source_id, membership_id, property_id, value_type, \
                               value_json, revision, updated_at\
                             ) VALUES (?1, ?2, 'task_parent', 'relation', 'null', 1, ?3)",
                            params![SOURCE_ID, membership_id, NOW],
                        )?;
                        if let Some(value_json) = row.value_json {
                            transaction.execute(
                                "INSERT INTO data_source_property_values(\
                                   data_source_id, membership_id, property_id, value_type, \
                                   value_json, revision, updated_at\
                                 ) VALUES (?1, ?2, 'status', 'select', ?3, 1, ?4)",
                                params![SOURCE_ID, membership_id, value_json, NOW],
                            )?;
                        }
                        if let Some(rank_key) = row.rank_key {
                            transaction.execute(
                                "INSERT INTO database_view_page_positions(\
                                   view_id, page_block_id, rank_key, revision, \
                                   created_at, updated_at\
                                 ) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
                                params![VIEW_ID, row.page_id, rank_key, NOW],
                            )?;
                        }
                        let values_json = row
                            .value_json
                            .map(|value| format!("{{\"status\":{value}}}"))
                            .unwrap_or_else(|| "{}".to_owned());
                        transaction.execute(
                            "UPDATE page_read_model SET parent_kind = 'data_source', \
                               parent_id = ?1, library_rank_key = NULL, membership_id = ?2, \
                               database_block_id = ?3, database_values_json = ?4 \
                             WHERE page_block_id = ?5",
                            params![
                                SOURCE_ID,
                                membership_id,
                                DATABASE_ID,
                                values_json,
                                row.page_id,
                            ],
                        )?;
                    }
                    Ok(())
                })
            })
            .expect("place Database rows");
        DatabaseModule::new("profile-1", "library-1", kernel)
    }

    #[test]
    fn page_layout_is_source_owned_ordered_and_revision_guarded() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(&kernel, vec![]);
        let initial = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::PageLayout {
                        data_source_id: SOURCE_ID.to_owned(),
                    },
                },
            )
            .expect("read initial Page layout");
        let DatabaseReadValue::PageLayout { value: initial } = initial.value else {
            panic!("Page layout snapshot");
        };
        assert_eq!(initial.revision, 1);
        assert_eq!(
            initial
                .entries
                .first()
                .map(|entry| entry.property_id.as_str()),
            Some("status")
        );

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:page-layout-status".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutPageLayoutEntry {
                        data_source_id: SOURCE_ID.to_owned(),
                        expected_revision: 1,
                        property_id: "status".to_owned(),
                        visibility: DatabasePagePropertyVisibility::HideWhenEmpty,
                        placement: Some(DatabasePageLayoutPlacement::End),
                    }],
                },
            )
            .expect("update Page layout");
        let updated = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::PageLayout {
                        data_source_id: SOURCE_ID.to_owned(),
                    },
                },
            )
            .expect("read updated Page layout");
        let DatabaseReadValue::PageLayout { value: updated } = updated.value else {
            panic!("updated Page layout snapshot");
        };
        assert_eq!(updated.revision, 2);
        assert_eq!(
            updated
                .entries
                .last()
                .map(|entry| entry.property_id.as_str()),
            Some("status")
        );
        assert_eq!(
            updated.entries.last().map(|entry| entry.visibility),
            Some(DatabasePagePropertyVisibility::HideWhenEmpty)
        );

        let conflict = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:page-layout-stale".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutPageLayoutEntry {
                        data_source_id: SOURCE_ID.to_owned(),
                        expected_revision: 1,
                        property_id: "priority".to_owned(),
                        visibility: DatabasePagePropertyVisibility::AlwaysHide,
                        placement: None,
                    }],
                },
            )
            .expect_err("reject stale Page layout mutation");
        assert_eq!(conflict.code, CoreErrorCode::RevisionConflict);
    }

    #[test]
    fn number_format_is_durable_and_preserves_non_empty_values() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![GroupRowSpec {
                page_id: "page:format-row",
                title: "Formatted",
                value_json: Some("\"build\""),
                rank_key: Some("a0"),
            }],
        );
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:create-number-format".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_metric00".to_owned(),
                        expected_data_source_revision: 1,
                        expected_property_revision: 0,
                        name: "Metric".to_owned(),
                        schema: DatabasePropertySchema::Number {
                            format: DatabaseNumberFormat::Plain,
                        },
                        before_property_id: None,
                    }],
                },
            )
            .expect("create Number Property");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:set-number-value".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:format-row".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "p_metric00".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::Replace {
                                expected_value_revision: 0,
                                value: DatabasePropertyValueInput::Number { value: 0.25 },
                            },
                        }],
                    }],
                },
            )
            .expect("set Number value");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:format-number-percent".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::ChangePropertyType {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_metric00".to_owned(),
                        expected_data_source_revision: 2,
                        expected_property_revision: 1,
                        schema: DatabasePropertySchema::Number {
                            format: DatabaseNumberFormat::Percent,
                        },
                    }],
                },
            )
            .expect("change Number presentation without clearing values");

        let properties = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::PropertyWindow {
                        data_source_id: SOURCE_ID.to_owned(),
                        window: Default::default(),
                    },
                },
            )
            .expect("read formatted Property");
        let DatabaseReadValue::PropertyWindow { properties } = properties.value else {
            panic!("Property window");
        };
        let metric = properties
            .items
            .iter()
            .find(|property| property.property_id == "p_metric00")
            .expect("Metric Property");
        assert_eq!(
            metric.schema,
            DatabasePropertySchema::Number {
                format: DatabaseNumberFormat::Percent,
            }
        );
        assert_eq!(metric.non_empty_value_count, 1);

        let stored_value = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT value_json FROM data_source_property_values \
                         WHERE data_source_id = ?1 AND property_id = 'p_metric00'",
                        [SOURCE_ID],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("read preserved Number value");
        assert_eq!(stored_value, "0.25");

        let blocked = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:block-number-type-change".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::ChangePropertyType {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_metric00".to_owned(),
                        expected_data_source_revision: 3,
                        expected_property_revision: 2,
                        schema: DatabasePropertySchema::Text,
                    }],
                },
            )
            .expect_err("block structural type changes while values exist");
        assert_eq!(blocked.code, CoreErrorCode::Conflict);
    }

    #[test]
    fn property_lifecycle_uses_explicit_move_and_permanently_retires_identity() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(&kernel, vec![]);
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:lifecycle-create".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_life0000".to_owned(),
                        expected_data_source_revision: 1,
                        expected_property_revision: 0,
                        name: "Lifecycle".to_owned(),
                        schema: DatabasePropertySchema::Text,
                        before_property_id: None,
                    }],
                },
            )
            .expect("create Property");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:lifecycle-duplicate".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::DuplicateProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_life0000".to_owned(),
                        expected_data_source_revision: 2,
                        expected_property_revision: 1,
                        new_property_id: "p_dupe0000".to_owned(),
                        name: "Lifecycle copy".to_owned(),
                        option_ids: vec![],
                    }],
                },
            )
            .expect("duplicate Property");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:lifecycle-move-end".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::MoveProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_life0000".to_owned(),
                        expected_data_source_revision: 3,
                        expected_property_revision: 1,
                        placement: DatabasePropertyPlacement::End,
                    }],
                },
            )
            .expect("move Property to end");
        let properties = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::PropertyWindow {
                        data_source_id: SOURCE_ID.to_owned(),
                        window: Default::default(),
                    },
                },
            )
            .expect("read reordered Properties");
        let DatabaseReadValue::PropertyWindow { properties } = properties.value else {
            panic!("Property window");
        };
        assert_eq!(properties.items.last().unwrap().property_id, "p_life0000");

        for (operation_id, intent) in [
            (
                "operation:lifecycle-delete",
                DatabaseIntent::DeleteProperty {
                    data_source_id: SOURCE_ID.to_owned(),
                    property_id: "p_life0000".to_owned(),
                    expected_data_source_revision: 4,
                    expected_property_revision: 2,
                },
            ),
            (
                "operation:lifecycle-restore",
                DatabaseIntent::RestoreProperty {
                    data_source_id: SOURCE_ID.to_owned(),
                    property_id: "p_life0000".to_owned(),
                    expected_data_source_revision: 5,
                    expected_property_revision: 3,
                },
            ),
            (
                "operation:lifecycle-delete-again",
                DatabaseIntent::DeleteProperty {
                    data_source_id: SOURCE_ID.to_owned(),
                    property_id: "p_life0000".to_owned(),
                    expected_data_source_revision: 6,
                    expected_property_revision: 4,
                },
            ),
            (
                "operation:lifecycle-permanent",
                DatabaseIntent::PermanentlyDeleteProperty {
                    data_source_id: SOURCE_ID.to_owned(),
                    property_id: "p_life0000".to_owned(),
                    expected_data_source_revision: 7,
                    expected_property_revision: 5,
                },
            ),
        ] {
            module
                .apply(
                    &context(),
                    ModuleApplyRequest {
                        contract_version: DATABASE_CONTRACT_VERSION,
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch("epoch-1".to_owned()),
                        intent: vec![intent],
                    },
                )
                .expect(operation_id);
        }
        let retired = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:lifecycle-reuse-retired".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_life0000".to_owned(),
                        expected_data_source_revision: 8,
                        expected_property_revision: 0,
                        name: "Reused".to_owned(),
                        schema: DatabasePropertySchema::Text,
                        before_property_id: None,
                    }],
                },
            )
            .expect_err("retired Property identities cannot be reused");
        assert!(retired.message.contains("retired"));
    }

    #[test]
    fn option_management_preserves_workflow_structure_and_clears_custom_values_atomically() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![GroupRowSpec {
                page_id: "page:option-row",
                title: "Option row",
                value_json: None,
                rank_key: Some("a0"),
            }],
        );
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:create-phase-property".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_phase000".to_owned(),
                        expected_data_source_revision: 1,
                        expected_property_revision: 0,
                        name: "Phase".to_owned(),
                        schema: DatabasePropertySchema::Select,
                        before_property_id: None,
                    }],
                },
            )
            .expect("create custom Select Property");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:create-phase-option".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutOption {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_phase000".to_owned(),
                        option_id: "o_phase000".to_owned(),
                        name: "Research".to_owned(),
                        color: Some("blue".to_owned()),
                        expected_property_revision: 1,
                    }],
                },
            )
            .expect("create custom option");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:select-phase-option".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:option-row".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "p_phase000".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::Replace {
                                expected_value_revision: 0,
                                value: DatabasePropertyValueInput::Select {
                                    option_id: "o_phase000".to_owned(),
                                },
                            },
                        }],
                    }],
                },
            )
            .expect("select custom option");

        let referenced = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-referenced-option-delete".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::DeleteOption {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_phase000".to_owned(),
                        option_id: "o_phase000".to_owned(),
                        expected_property_revision: 2,
                    }],
                },
            )
            .expect_err("plain option deletion cannot leave dangling values");
        assert_eq!(referenced.code, CoreErrorCode::Conflict);

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:clear-and-delete-option".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::DeleteOptionAndClearValues {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_phase000".to_owned(),
                        option_id: "o_phase000".to_owned(),
                        expected_property_revision: 2,
                    }],
                },
            )
            .expect("clear values and delete custom option in one transaction");
        let remaining = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::OptionWindow {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_phase000".to_owned(),
                        window: Default::default(),
                    },
                },
            )
            .expect("read custom options after deletion");
        let DatabaseReadValue::OptionWindow { options } = remaining.value else {
            panic!("custom option window");
        };
        assert!(options.items.is_empty());
        let value_count = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT count(*) FROM data_source_property_values \
                         WHERE data_source_id = ?1 AND property_id = 'p_phase000' \
                           AND value_json != 'null'",
                        [SOURCE_ID],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("count cleared option values");
        assert_eq!(value_count, 0);

        let properties = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::PropertyWindow {
                        data_source_id: SOURCE_ID.to_owned(),
                        window: Default::default(),
                    },
                },
            )
            .expect("read status management revision");
        let DatabaseReadValue::PropertyWindow { properties } = properties.value else {
            panic!("Property window");
        };
        let status = properties
            .items
            .iter()
            .find(|property| property.property_id == "status")
            .expect("status Property");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:rename-status-option".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutOption {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "status".to_owned(),
                        option_id: "triage".to_owned(),
                        name: "Inbox".to_owned(),
                        color: Some("gray".to_owned()),
                        expected_property_revision: status.revision,
                    }],
                },
            )
            .expect("status option presentation remains editable");
        for (operation_id, intent) in [
            (
                "operation:reject-status-option-move",
                DatabaseIntent::MoveOption {
                    data_source_id: SOURCE_ID.to_owned(),
                    property_id: "status".to_owned(),
                    option_id: "triage".to_owned(),
                    expected_property_revision: status.revision + 1,
                    placement: DatabaseOptionPlacement::End,
                },
            ),
            (
                "operation:reject-status-option-delete",
                DatabaseIntent::DeleteOption {
                    data_source_id: SOURCE_ID.to_owned(),
                    property_id: "status".to_owned(),
                    option_id: "triage".to_owned(),
                    expected_property_revision: status.revision + 1,
                },
            ),
            (
                "operation:reject-new-status-option",
                DatabaseIntent::PutOption {
                    data_source_id: SOURCE_ID.to_owned(),
                    property_id: "status".to_owned(),
                    option_id: "o_status00".to_owned(),
                    name: "Extra".to_owned(),
                    color: None,
                    expected_property_revision: status.revision + 1,
                },
            ),
        ] {
            let blocked = module
                .apply(
                    &context(),
                    ModuleApplyRequest {
                        contract_version: DATABASE_CONTRACT_VERSION,
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch("epoch-1".to_owned()),
                        intent: vec![intent],
                    },
                )
                .expect_err(operation_id);
            assert_eq!(
                blocked.code,
                if operation_id == "operation:reject-new-status-option" {
                    CoreErrorCode::InvalidInput
                } else {
                    CoreErrorCode::Conflict
                },
                "{operation_id}: {}",
                blocked.message
            );
        }
    }

    #[test]
    fn conditional_color_rules_validate_identity_and_participate_in_property_repair() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(&kernel, vec![]);
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:create-color-property".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_tone0000".to_owned(),
                        expected_data_source_revision: 1,
                        expected_property_revision: 0,
                        name: "Tone".to_owned(),
                        schema: DatabasePropertySchema::Text,
                        before_property_id: None,
                    }],
                },
            )
            .expect("create conditional color Property");

        let color_rule = json!({
            "ruleId": "rule:tone",
            "propertyId": "p_tone0000",
            "operator": "text_is",
            "value": "urgent",
            "colorSource": "fixed",
            "color": "red"
        });
        let mut invalid_source_config = view_config(
            json!({ "kind": "group", "operator": "and", "children": [] }),
            None,
            &["status"],
        );
        invalid_source_config["presentation"]["conditionalColors"] = json!([{
            "ruleId": "rule:tone",
            "propertyId": "p_tone0000",
            "operator": "text_is",
            "value": "urgent",
            "colorSource": "property_option",
            "color": "red"
        }]);
        let invalid_source = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-option-color-on-text".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        name: "Board".to_owned(),
                        layout: DatabaseViewLayout::Board,
                        definition: view_definition(invalid_source_config),
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect_err("only option Properties can supply conditional colors");
        assert_eq!(invalid_source.code, CoreErrorCode::InvalidInput);
        let mut duplicate_config = view_config(
            json!({ "kind": "group", "operator": "and", "children": [] }),
            None,
            &["status"],
        );
        duplicate_config["presentation"]["conditionalColors"] =
            json!([color_rule.clone(), color_rule.clone()]);
        let duplicate = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-duplicate-color-rules".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        name: "Board".to_owned(),
                        layout: DatabaseViewLayout::Board,
                        definition: view_definition(duplicate_config),
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect_err("conditional rule identities are unique within a View");
        assert_eq!(duplicate.code, CoreErrorCode::InvalidInput);

        let mut valid_config = view_config(
            json!({ "kind": "group", "operator": "and", "children": [] }),
            None,
            &["status"],
        );
        valid_config["presentation"]["conditionalColors"] = json!([color_rule]);
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:save-color-rule".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        name: "Board".to_owned(),
                        layout: DatabaseViewLayout::Board,
                        definition: view_definition(valid_config),
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect("save conditional color rule");
        let properties = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::PropertyWindow {
                        data_source_id: SOURCE_ID.to_owned(),
                        window: Default::default(),
                    },
                },
            )
            .expect("read conditional color dependency");
        let DatabaseReadValue::PropertyWindow { properties } = properties.value else {
            panic!("Property window");
        };
        let tone = properties
            .items
            .iter()
            .find(|property| property.property_id == "p_tone0000")
            .expect("Tone Property");
        assert_eq!(tone.referenced_view_ids, [VIEW_ID]);

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:repair-color-rule-delete".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![
                        DatabaseIntent::PutView {
                            database_id: DATABASE_ID.to_owned(),
                            data_source_id: SOURCE_ID.to_owned(),
                            view_id: VIEW_ID.to_owned(),
                            expected_revision: 2,
                            name: "Board".to_owned(),
                            layout: DatabaseViewLayout::Board,
                            definition: view_definition(view_config(
                                json!({
                                    "kind": "group",
                                    "operator": "and",
                                    "children": []
                                }),
                                None,
                                &["status"],
                            )),
                            is_default: true,
                            before_view_id: None,
                        },
                        DatabaseIntent::DeleteProperty {
                            data_source_id: SOURCE_ID.to_owned(),
                            property_id: "p_tone0000".to_owned(),
                            expected_data_source_revision: 2,
                            expected_property_revision: 1,
                        },
                    ],
                },
            )
            .expect("repair conditional rules while soft-deleting their Property");
        let view = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                },
            )
            .expect("read repaired View");
        let DatabaseReadValue::View { value } = view.value else {
            panic!("View record");
        };
        assert!(value.definition.presentation.conditional_colors.is_empty());
    }

    #[test]
    fn personal_view_filter_changes_projection_without_mutating_the_durable_view() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:personal-filter-match",
                    title: "Match",
                    value_json: Some("\"triage\""),
                    rank_key: Some("a0"),
                },
                GroupRowSpec {
                    page_id: "page:personal-filter-other",
                    title: "Other",
                    value_json: Some("\"build\""),
                    rank_key: Some("b0"),
                },
            ],
        );
        let filtered = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::PresentedView {
                            view_id: VIEW_ID.to_owned(),
                            preferences_override: DatabaseViewPreferencesOverrideInput {
                                rules_override: DatabaseViewRulesOverrideInput {
                                    advanced_filter: Some(
                                        nodex_core_contracts::database::DatabaseViewAdvancedFilterOverrideInput::Filter {
                                            filter: DatabaseViewFilter::Group {
                                                operator: DatabaseViewFilterGroupOperator::And,
                                                children: vec![DatabaseViewFilter::Clause {
                                                    property_id: "status".to_owned(),
                                                    operator: DatabaseViewFilterOperator::SelectIs,
                                                    value: Some(Some(json!("triage"))),
                                                }],
                                            },
                                        },
                                    ),
                                    ..Default::default()
                                },
                                ..Default::default()
                            },
                        },
                        window: Default::default(),
                        group_scope: None,
                    },
                },
            )
            .expect("read a personally filtered View");
        let DatabaseReadValue::ViewWindow { value } = filtered.value else {
            panic!("personally filtered View window");
        };
        assert_eq!(value.rows.items.len(), 1);
        assert_eq!(value.rows.items[0].page_id, "page:personal-filter-match");

        let durable = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                },
            )
            .expect("read durable View after personal filtering");
        let DatabaseReadValue::View { value } = durable.value else {
            panic!("durable View record");
        };
        assert!(matches!(value.definition.rules.advanced_filter, None));
    }

    #[test]
    fn incomplete_personal_filter_draft_round_trips_without_affecting_projection() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:draft-one",
                    title: "One",
                    value_json: Some("\"triage\""),
                    rank_key: Some("a0"),
                },
                GroupRowSpec {
                    page_id: "page:draft-two",
                    title: "Two",
                    value_json: Some("\"build\""),
                    rank_key: Some("b0"),
                },
            ],
        );
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:save-incomplete-filter-draft".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutViewPersonalPreferences {
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 0,
                        rules_override: DatabaseViewRulesOverrideInput {
                            advanced_filter: Some(
                                nodex_core_contracts::database::DatabaseViewAdvancedFilterOverrideInput::Filter {
                                    filter: DatabaseViewFilter::Group {
                                        operator: DatabaseViewFilterGroupOperator::And,
                                        children: vec![DatabaseViewFilter::Clause {
                                            property_id: "status".to_owned(),
                                            operator: DatabaseViewFilterOperator::SelectIs,
                                            value: Some(None),
                                        }],
                                    },
                                },
                            ),
                            ..Default::default()
                        },
                        presentation_override: DatabaseViewPresentationOverrideInput::default(),
                    }],
                },
            )
            .expect("persist an incomplete personal filter draft");

        let stored = read_personal_presentation(&module);
        let encoded = serde_json::to_value(&stored.rules_override).expect("encode saved draft");
        assert!(
            encoded["advanced_filter"]["filter"]["children"][0]["value"].is_null(),
            "the present null operand must survive storage and readback"
        );

        let window = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::PresentedView {
                            view_id: VIEW_ID.to_owned(),
                            preferences_override: DatabaseViewPreferencesOverrideInput {
                                rules_override: stored.rules_override,
                                presentation_override: stored.presentation_override,
                            },
                        },
                        window: Default::default(),
                        group_scope: None,
                    },
                },
            )
            .expect("query with an incomplete draft");
        let DatabaseReadValue::ViewWindow { value } = window.value else {
            panic!("View window");
        };
        assert_eq!(value.rows.items.len(), 2);

        let rejected = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-missing-filter-operand".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutViewPersonalPreferences {
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        rules_override: DatabaseViewRulesOverrideInput {
                            advanced_filter: Some(
                                nodex_core_contracts::database::DatabaseViewAdvancedFilterOverrideInput::Filter {
                                    filter: DatabaseViewFilter::Group {
                                        operator: DatabaseViewFilterGroupOperator::And,
                                        children: vec![DatabaseViewFilter::Clause {
                                            property_id: "status".to_owned(),
                                            operator: DatabaseViewFilterOperator::SelectIs,
                                            value: None,
                                        }],
                                    },
                                },
                            ),
                            ..Default::default()
                        },
                        presentation_override: DatabaseViewPresentationOverrideInput::default(),
                    }],
                },
            )
            .expect_err("reject a parser-incompatible missing operand");
        assert_eq!(rejected.code, CoreErrorCode::InvalidInput);
        assert_eq!(read_personal_presentation(&module).revision, 1);
    }

    #[test]
    fn deleting_the_default_view_selects_a_fallback_and_rejects_the_last_view() {
        const SECOND_VIEW_ID: &str = "018f1000-0000-7000-8000-000000000099";
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(&kernel, vec![]);
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:create-second-view".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: SECOND_VIEW_ID.to_owned(),
                        expected_revision: 0,
                        name: "Second".to_owned(),
                        layout: DatabaseViewLayout::List,
                        definition: view_definition(view_config(
                            json!({ "kind": "group", "operator": "and", "children": [] }),
                            None,
                            &["status"],
                        )),
                        is_default: false,
                        before_view_id: None,
                    }],
                },
            )
            .expect("create second View");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:move-default-view-end".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::MoveView {
                        database_id: DATABASE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        placement: DatabaseViewPlacement::End,
                    }],
                },
            )
            .expect("move default View to end");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:delete-default-view".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::DeleteView {
                        database_id: DATABASE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 2,
                    }],
                },
            )
            .expect("delete default View");
        let descriptor = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::Database {
                        target: nodex_core_contracts::database::DatabaseIdentityTarget::Database {
                            database_id: DATABASE_ID.to_owned(),
                        },
                    },
                },
            )
            .expect("read Database fallback");
        let DatabaseReadValue::Database { value } = descriptor.value else {
            panic!("Database descriptor");
        };
        assert_eq!(
            value.database.default_view_id.as_deref(),
            Some(SECOND_VIEW_ID)
        );

        let last = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-delete-last-view".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::DeleteView {
                        database_id: DATABASE_ID.to_owned(),
                        view_id: SECOND_VIEW_ID.to_owned(),
                        expected_revision: 1,
                    }],
                },
            )
            .expect_err("reject deleting the last active View");
        assert_eq!(last.code, CoreErrorCode::Conflict);
    }

    #[test]
    fn duplicate_and_layout_conversion_are_explicit_view_intents() {
        const DUPLICATE_VIEW_ID: &str = "018f1000-0000-7000-8000-00000000009a";
        const SECOND_DUPLICATE_VIEW_ID: &str = "018f1000-0000-7000-8000-00000000009b";
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(&kernel, vec![]);
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:duplicate-view".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::DuplicateView {
                        database_id: DATABASE_ID.to_owned(),
                        source_view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        new_view_id: DUPLICATE_VIEW_ID.to_owned(),
                    }],
                },
            )
            .expect("duplicate durable View");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:duplicate-view-again".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::DuplicateView {
                        database_id: DATABASE_ID.to_owned(),
                        source_view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        new_view_id: SECOND_DUPLICATE_VIEW_ID.to_owned(),
                    }],
                },
            )
            .expect("duplicate durable View with a deduplicated name");
        let views = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewDescriptorWindow {
                        database_id: DATABASE_ID.to_owned(),
                        window: Default::default(),
                    },
                },
            )
            .expect("read duplicated Views");
        let DatabaseReadValue::ViewDescriptorWindow { views } = views.value else {
            panic!("View descriptor window");
        };
        let duplicate = views
            .items
            .iter()
            .find(|view| view.view_id == DUPLICATE_VIEW_ID)
            .expect("first duplicate");
        let second_duplicate = views
            .items
            .iter()
            .find(|view| view.view_id == SECOND_DUPLICATE_VIEW_ID)
            .expect("second duplicate");
        assert_eq!(duplicate.name, "Board copy");
        assert_eq!(second_duplicate.name, "Board copy 2");
        assert_eq!(duplicate.layout, DatabaseViewLayout::Board);
        assert_eq!(duplicate.definition, views.items[0].definition);
        assert_eq!(views.items[0].view_id, VIEW_ID);
        assert_eq!(
            views.items[1..3]
                .iter()
                .map(|view| view.view_id.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([DUPLICATE_VIEW_ID, SECOND_DUPLICATE_VIEW_ID])
        );

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:change-view-layout".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::ChangeViewLayout {
                        database_id: DATABASE_ID.to_owned(),
                        view_id: DUPLICATE_VIEW_ID.to_owned(),
                        expected_revision: 1,
                        layout: DatabaseViewLayout::List,
                    }],
                },
            )
            .expect("convert durable View layout");
        let converted = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::View {
                        view_id: DUPLICATE_VIEW_ID.to_owned(),
                    },
                },
            )
            .expect("read converted View");
        let DatabaseReadValue::View { value: converted } = converted.value else {
            panic!("converted View");
        };
        assert_eq!(converted.layout, DatabaseViewLayout::List);
        assert_eq!(converted.revision, 2);
        assert!(!converted.definition.presentation.display.show_description);
        assert_eq!(converted.definition.rules, duplicate.definition.rules);
    }

    fn read_personal_presentation(module: &DatabaseModule) -> DatabaseViewPersonalPreferences {
        let snapshot = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewPersonalPreferences {
                        view_id: VIEW_ID.to_owned(),
                    },
                },
            )
            .expect("read personal View preferences");
        let DatabaseReadValue::ViewPersonalPreferences { value } = snapshot.value else {
            panic!("View personal presentation value");
        };
        value
    }

    fn read_collapsed_occurrences(module: &DatabaseModule) -> Vec<DatabaseViewDisclosureTarget> {
        let snapshot = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewCollapsedOccurrences {
                        view_id: VIEW_ID.to_owned(),
                    },
                },
            )
            .expect("read collapsed View occurrences");
        let DatabaseReadValue::ViewCollapsedOccurrences { value } = snapshot.value else {
            panic!("View collapsed occurrences value");
        };
        value.targets
    }

    fn apply_task_parent(
        module: &DatabaseModule,
        operation_id: &str,
        pages: &[(&str, i64)],
        parent_page_id: Option<&str>,
        before_page_id: Option<&str>,
    ) -> Result<DatabaseApplyOutcome, CoreError> {
        module.apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: operation_id.to_owned(),
                store_epoch: StoreEpoch("epoch-1".to_owned()),
                intent: vec![DatabaseIntent::SetTaskParent {
                    data_source_id: SOURCE_ID.to_owned(),
                    pages: pages
                        .iter()
                        .map(
                            |(page_id, expected_value_revision)| DatabaseTaskParentPage {
                                page_id: (*page_id).to_owned(),
                                expected_value_revision: *expected_value_revision,
                            },
                        )
                        .collect(),
                    parent_page_id: parent_page_id.map(str::to_owned),
                    before_page_id: before_page_id.map(str::to_owned),
                }],
            },
        )
    }

    #[test]
    fn personal_presentation_and_occurrence_disclosure_have_independent_conflict_scopes() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(&kernel, Vec::new());

        assert_eq!(read_personal_presentation(&module).revision, 0);
        assert!(read_collapsed_occurrences(&module).is_empty());
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:put-personal-view-presentation".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutViewPersonalPreferences {
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 0,
                        rules_override: DatabaseViewRulesOverrideInput::default(),
                        presentation_override: DatabaseViewPresentationOverrideInput {
                            display: Some(DatabaseViewLayoutDisplayOverrideInput {
                                fields: None,
                                property_order: Some(vec!["status".to_owned()]),
                                show_empty_groups: None,
                                show_description: Some(false),
                            }),
                            ..Default::default()
                        },
                    }],
                },
            )
            .expect("persist personal View presentation");
        let stored = read_personal_presentation(&module);
        assert_eq!(stored.revision, 1);
        assert_eq!(
            stored
                .presentation_override
                .display
                .as_ref()
                .and_then(|display| display.show_description),
            Some(false)
        );
        assert_eq!(
            stored
                .presentation_override
                .display
                .and_then(|display| display.property_order),
            Some(vec!["status".to_owned()])
        );

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:collapse-view-group".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::SetViewOccurrenceDisclosure {
                        view_id: VIEW_ID.to_owned(),
                        target: DatabaseViewDisclosureTarget::Group {
                            occurrence_key: "GROUP_\"triage\"".to_owned(),
                        },
                        collapsed: true,
                    }],
                },
            )
            .expect("collapse independently of presentation revision");
        assert_eq!(
            read_collapsed_occurrences(&module),
            [DatabaseViewDisclosureTarget::Group {
                occurrence_key: "GROUP_\"triage\"".to_owned(),
            }],
        );

        let stale = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:stale-personal-view-presentation".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutViewPersonalPreferences {
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 0,
                        rules_override: DatabaseViewRulesOverrideInput::default(),
                        presentation_override: DatabaseViewPresentationOverrideInput::default(),
                    }],
                },
            )
            .expect_err("stale personal View presentation revision");
        assert_eq!(stale.code, CoreErrorCode::RevisionConflict);

        let reset = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reset-personal-view-presentation".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutViewPersonalPreferences {
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        rules_override: DatabaseViewRulesOverrideInput::default(),
                        presentation_override: DatabaseViewPresentationOverrideInput::default(),
                    }],
                },
            )
            .expect("reset personal View presentation");
        assert_eq!(
            reset
                .committed
                .receipt
                .committed_revisions
                .get(&format!("view_preferences:profile-1:{VIEW_ID}")),
            Some(&2),
        );
        let reset_value = read_personal_presentation(&module);
        assert_eq!(reset_value.revision, 2);
        assert_eq!(reset_value.presentation_override, Default::default());
        assert_eq!(read_collapsed_occurrences(&module).len(), 1);

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:put-personal-group-direction".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutViewPersonalPreferences {
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 2,
                        rules_override: DatabaseViewRulesOverrideInput::default(),
                        presentation_override: DatabaseViewPresentationOverrideInput {
                            group_direction: Some(DatabaseViewSortDirectionInput::Desc),
                            ..Default::default()
                        },
                    }],
                },
            )
            .expect("persist a group-direction-only presentation override");
        let direction_only = read_personal_presentation(&module);
        assert_eq!(direction_only.revision, 3);
        assert_eq!(
            direction_only.presentation_override.group_direction,
            Some(DatabaseViewSortDirectionInput::Desc),
        );
        assert_eq!(read_collapsed_occurrences(&module).len(), 1);

        let idempotent = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:collapse-view-group-again".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::SetViewOccurrenceDisclosure {
                        view_id: VIEW_ID.to_owned(),
                        target: DatabaseViewDisclosureTarget::Group {
                            occurrence_key: "GROUP_\"triage\"".to_owned(),
                        },
                        collapsed: true,
                    }],
                },
            )
            .expect("repeat disclosure patch is idempotent");
        assert!(idempotent.committed.receipt.affected_view_ids.is_empty());

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:expand-view-group".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::SetViewOccurrenceDisclosure {
                        view_id: VIEW_ID.to_owned(),
                        target: DatabaseViewDisclosureTarget::Group {
                            occurrence_key: "GROUP_\"triage\"".to_owned(),
                        },
                        collapsed: false,
                    }],
                },
            )
            .expect("expand occurrence");
        assert!(read_collapsed_occurrences(&module).is_empty());
    }

    #[test]
    fn task_hierarchy_round_trips_order_rejects_cycles_and_unparents() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:parent",
                    title: "Parent",
                    value_json: None,
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:child",
                    title: "Child",
                    value_json: None,
                    rank_key: Some("b"),
                },
                GroupRowSpec {
                    page_id: "page:grandchild",
                    title: "Grandchild",
                    value_json: None,
                    rank_key: Some("c"),
                },
                GroupRowSpec {
                    page_id: "page:peer",
                    title: "Peer",
                    value_json: None,
                    rank_key: Some("d"),
                },
            ],
        );

        apply_task_parent(
            &module,
            "operation:hierarchy-child",
            &[("page:child", 1)],
            Some("page:parent"),
            None,
        )
        .expect("nest child");
        apply_task_parent(
            &module,
            "operation:hierarchy-grandchild",
            &[("page:grandchild", 1)],
            Some("page:child"),
            None,
        )
        .expect("nest grandchild");

        let window = read_view_window(&module, 20, None, None).expect("read hierarchy window");
        let child = window
            .rows
            .items
            .iter()
            .find(|row| row.page_id == "page:child")
            .expect("child row");
        assert_eq!(child.task_parent_page_id.as_deref(), Some("page:parent"));
        assert_eq!(child.task_parent_value_revision, 2);
        assert!(child.task_sibling_rank.is_some());
        let child_value_revision_before_peer_insert = child.task_parent_value_revision;
        let child_metadata_revision_before_peer_insert = child.metadata_revision;

        let cycle = apply_task_parent(
            &module,
            "operation:hierarchy-cycle",
            &[("page:parent", 1)],
            Some("page:grandchild"),
            None,
        )
        .expect_err("reject hierarchy cycle");
        assert_eq!(cycle.code, CoreErrorCode::InvalidInput);

        let stale = apply_task_parent(
            &module,
            "operation:hierarchy-stale",
            &[("page:child", 1)],
            Some("page:parent"),
            None,
        )
        .expect_err("reject stale hierarchy revision");
        assert_eq!(stale.code, CoreErrorCode::RevisionConflict);

        apply_task_parent(
            &module,
            "operation:hierarchy-peer-before-child",
            &[("page:peer", 1)],
            Some("page:parent"),
            Some("page:child"),
        )
        .expect("insert peer before child");
        let ordered = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .prepare(
                        "SELECT membership.page_block_id \
                         FROM data_source_relation_edges edge \
                         JOIN data_source_page_memberships membership \
                           ON membership.data_source_id = edge.source_data_source_id \
                          AND membership.id = edge.source_membership_id \
                         WHERE edge.source_data_source_id = ?1 \
                           AND edge.property_id = 'task_parent' \
                           AND edge.target_page_block_id = 'page:parent' \
                         ORDER BY edge.sibling_rank, membership.page_block_id",
                    )?
                    .query_map([SOURCE_ID], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(StoreError::from)
            })
            .expect("read sibling ordering");
        assert_eq!(ordered, ["page:peer", "page:child"]);

        let after_peer_insert =
            read_view_window(&module, 20, None, None).expect("read localized sibling insert");
        let unchanged_child = after_peer_insert
            .rows
            .items
            .iter()
            .find(|row| row.page_id == "page:child")
            .expect("unchanged child row");
        assert_eq!(
            unchanged_child.task_parent_value_revision, child_value_revision_before_peer_insert,
            "inserting another sibling must not advance an untouched child's Parent value revision",
        );
        assert_eq!(
            unchanged_child.metadata_revision, child_metadata_revision_before_peer_insert,
            "inserting another sibling must not invalidate an untouched child's Page metadata",
        );

        let child_revision = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT value.revision FROM data_source_property_values value \
                         JOIN data_source_page_memberships membership \
                           ON membership.data_source_id = value.data_source_id \
                          AND membership.id = value.membership_id \
                         WHERE membership.page_block_id = 'page:child' \
                           AND value.property_id = 'task_parent'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("read rebalanced child revision");
        let unparented = apply_task_parent(
            &module,
            "operation:hierarchy-unparent-child",
            &[("page:child", child_revision)],
            None,
            None,
        )
        .expect("unparent child");
        assert_eq!(
            unparented
                .committed
                .receipt
                .committed_revisions
                .get(&format!(
                    "value:{SOURCE_ID}:membership:page:child:task_parent"
                )),
            Some(&(child_revision + 1)),
        );
        let window = read_view_window(&module, 20, None, None).expect("read unparented window");
        let child = window
            .rows
            .items
            .iter()
            .find(|row| row.page_id == "page:child")
            .expect("unparented child row");
        assert_eq!(child.task_parent_page_id, None);
        assert_eq!(child.task_parent_value_revision, child_revision + 1);
    }

    #[test]
    fn task_parent_rank_rebalance_preserves_untouched_sibling_revisions() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:parent",
                    title: "Parent",
                    value_json: None,
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:left",
                    title: "Left",
                    value_json: None,
                    rank_key: Some("b"),
                },
                GroupRowSpec {
                    page_id: "page:right",
                    title: "Right",
                    value_json: None,
                    rank_key: Some("c"),
                },
                GroupRowSpec {
                    page_id: "page:moved",
                    title: "Moved",
                    value_json: None,
                    rank_key: Some("d"),
                },
            ],
        );
        apply_task_parent(
            &module,
            "operation:rebalance-left",
            &[("page:left", 1)],
            Some("page:parent"),
            None,
        )
        .expect("nest left sibling");
        apply_task_parent(
            &module,
            "operation:rebalance-right",
            &[("page:right", 1)],
            Some("page:parent"),
            None,
        )
        .expect("nest right sibling");

        kernel
            .writer()
            .call(|connection| {
                let edges = connection
                    .prepare(
                        "SELECT edge_id, source_membership_id, target_page_block_id, created_at \
                         FROM data_source_relation_edges \
                         WHERE source_data_source_id = ?1 AND property_id = 'task_parent' \
                           AND source_membership_id IN (\
                             'membership:page:left', 'membership:page:right'\
                           )",
                    )?
                    .query_map([SOURCE_ID], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                connection.execute(
                    "DELETE FROM data_source_relation_edges \
                     WHERE source_data_source_id = ?1 AND property_id = 'task_parent' \
                       AND source_membership_id IN (\
                         'membership:page:left', 'membership:page:right'\
                       )",
                    [SOURCE_ID],
                )?;
                for (edge_id, membership_id, target_page_id, created_at) in edges {
                    let sibling_rank = match membership_id.as_str() {
                        "membership:page:left" => "00000000000000000000000000000001",
                        "membership:page:right" => "00000000000000000000000000000002",
                        _ => unreachable!("query bounds the rewritten memberships"),
                    };
                    connection.execute(
                        "INSERT INTO data_source_relation_edges(\
                           edge_id, source_data_source_id, source_membership_id, property_id, \
                           target_page_block_id, created_at, sibling_rank\
                         ) VALUES (?1, ?2, ?3, 'task_parent', ?4, ?5, ?6)",
                        params![
                            edge_id,
                            SOURCE_ID,
                            membership_id,
                            target_page_id,
                            created_at,
                            sibling_rank,
                        ],
                    )?;
                }
                Ok(())
            })
            .expect("exhaust sibling rank gap");

        let before = read_view_window(&module, 20, None, None).expect("read rank exhaustion");
        let untouched_before = before
            .rows
            .items
            .iter()
            .filter(|row| row.page_id == "page:left" || row.page_id == "page:right")
            .map(|row| {
                (
                    row.page_id.clone(),
                    (row.task_parent_value_revision, row.metadata_revision),
                )
            })
            .collect::<BTreeMap<_, _>>();

        apply_task_parent(
            &module,
            "operation:rebalance-insert",
            &[("page:moved", 1)],
            Some("page:parent"),
            Some("page:right"),
        )
        .expect("insert through exhausted rank gap");

        let after = read_view_window(&module, 20, None, None).expect("read rebalanced siblings");
        let untouched_after = after
            .rows
            .items
            .iter()
            .filter(|row| row.page_id == "page:left" || row.page_id == "page:right")
            .map(|row| {
                (
                    row.page_id.clone(),
                    (row.task_parent_value_revision, row.metadata_revision),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(untouched_after, untouched_before);

        let ordered = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .prepare(
                        "SELECT membership.page_block_id \
                         FROM data_source_relation_edges edge \
                         JOIN data_source_page_memberships membership \
                           ON membership.data_source_id = edge.source_data_source_id \
                          AND membership.id = edge.source_membership_id \
                         WHERE edge.source_data_source_id = ?1 \
                           AND edge.property_id = 'task_parent' \
                           AND edge.target_page_block_id = 'page:parent' \
                         ORDER BY edge.sibling_rank, membership.page_block_id",
                    )?
                    .query_map([SOURCE_ID], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(StoreError::from)
            })
            .expect("read order after rank maintenance");
        assert_eq!(ordered, ["page:left", "page:moved", "page:right"]);

        apply_task_parent(
            &module,
            "operation:rebalance-repeat-noop",
            &[("page:moved", 2)],
            Some("page:parent"),
            Some("page:right"),
        )
        .expect("repeat the same Parent position");
        let repeated = read_view_window(&module, 20, None, None).expect("read repeated position");
        let moved = repeated
            .rows
            .items
            .iter()
            .find(|row| row.page_id == "page:moved")
            .expect("moved Page after no-op");
        assert_eq!(moved.task_parent_value_revision, 2);
    }

    #[test]
    fn task_parent_relation_edits_and_hierarchy_intents_share_one_revision_authority() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:parent",
                    title: "Parent",
                    value_json: None,
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:child",
                    title: "Child",
                    value_json: None,
                    rank_key: Some("b"),
                },
            ],
        );

        let patch_one = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-patch-one-relation".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:child".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "task_parent".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::PatchSet {
                                delta: nodex_core_contracts::database::DatabasePropertySetDelta::Relation {
                                    add_page_ids: vec!["page:parent".to_owned()],
                                    remove_edge_ids: Vec::new(),
                                },
                            },
                        }],
                    }],
                },
            )
            .expect_err("cardinality-one Relation rejects set patches");
        assert_eq!(patch_one.code, CoreErrorCode::InvalidInput);

        let related = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:relation-parent-child".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:child".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "task_parent".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::ReplaceOneRelation {
                                expected_value_revision: 1,
                                target_page_id: Some("page:parent".to_owned()),
                            },
                        }],
                    }],
                },
            )
            .expect("set Parent through the generic Relation editor");
        assert_eq!(
            related.committed.receipt.committed_revisions.get(&format!(
                "value:{SOURCE_ID}:membership:page:child:task_parent"
            )),
            Some(&2),
        );

        apply_task_parent(
            &module,
            "operation:hierarchy-unparent-related-child",
            &[("page:child", 2)],
            None,
            None,
        )
        .expect("clear Parent through the hierarchy command");
        let window = read_view_window(&module, 20, None, None).expect("read shared authority");
        let child = window
            .rows
            .items
            .iter()
            .find(|row| row.page_id == "page:child")
            .expect("child row");
        assert_eq!(child.task_parent_page_id, None);
        assert_eq!(child.task_parent_value_revision, 3);

        let stale_relation = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:stale-relation-parent".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:child".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "task_parent".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::ReplaceOneRelation {
                                expected_value_revision: 2,
                                target_page_id: Some("page:parent".to_owned()),
                            },
                        }],
                    }],
                },
            )
            .expect_err("reject stale Relation edit after hierarchy command");
        assert_eq!(stale_relation.code, CoreErrorCode::RevisionConflict);
    }

    #[test]
    fn archived_parent_is_retained_as_a_relation_but_not_as_active_list_hierarchy() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:parent",
                    title: "Parent",
                    value_json: None,
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:child",
                    title: "Child",
                    value_json: None,
                    rank_key: Some("b"),
                },
            ],
        );
        apply_task_parent(
            &module,
            "operation:archive-parent-child",
            &[("page:child", 1)],
            Some("page:parent"),
            None,
        )
        .expect("nest child");

        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "UPDATE blocks SET lifecycle = 'archived' WHERE id = 'page:parent'",
                        [],
                    )?;
                    transaction.execute(
                        "UPDATE page_read_model SET lifecycle = 'archived' \
                         WHERE page_block_id = 'page:parent'",
                        [],
                    )?;
                    Ok(())
                })
            })
            .expect("archive parent projection");

        let archived = read_view_window(&module, 20, None, None).expect("read archived parent");
        let child = archived
            .rows
            .items
            .iter()
            .find(|row| row.page_id == "page:child")
            .expect("visible child");
        assert_eq!(child.task_parent_page_id, None);
        assert_eq!(child.task_sibling_rank, None);
        assert_eq!(child.task_parent_value_revision, 2);
        let retained_edges = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT count(*) FROM data_source_relation_edges \
                         WHERE source_data_source_id = ?1 \
                           AND source_membership_id = 'membership:page:child' \
                           AND property_id = 'task_parent' \
                           AND target_page_block_id = 'page:parent'",
                        [SOURCE_ID],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("read retained Parent edge");
        assert_eq!(retained_edges, 1);

        kernel
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "UPDATE blocks SET lifecycle = 'active' WHERE id = 'page:parent'; \
                     UPDATE page_read_model SET lifecycle = 'active' \
                       WHERE page_block_id = 'page:parent';",
                )?;
                Ok(())
            })
            .expect("restore parent projection");
        let restored = read_view_window(&module, 20, None, None).expect("read restored parent");
        let child = restored
            .rows
            .items
            .iter()
            .find(|row| row.page_id == "page:child")
            .expect("restored child");
        assert_eq!(child.task_parent_page_id.as_deref(), Some("page:parent"));
        assert_eq!(child.task_parent_value_revision, 2);
    }

    #[test]
    fn task_hierarchy_enforces_the_depth_ten_boundary() {
        const DEPTH_PAGE_IDS: [&str; 12] = [
            "page:depth-0",
            "page:depth-1",
            "page:depth-2",
            "page:depth-3",
            "page:depth-4",
            "page:depth-5",
            "page:depth-6",
            "page:depth-7",
            "page:depth-8",
            "page:depth-9",
            "page:depth-10",
            "page:depth-11",
        ];
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let rows = DEPTH_PAGE_IDS
            .iter()
            .map(|page_id| GroupRowSpec {
                page_id,
                title: page_id,
                value_json: None,
                rank_key: None,
            })
            .collect();
        let module = seed_grouped_fixture(&kernel, rows);

        for index in 1..=10 {
            apply_task_parent(
                &module,
                &format!("operation:hierarchy-depth-{index}"),
                &[(DEPTH_PAGE_IDS[index], 1)],
                Some(DEPTH_PAGE_IDS[index - 1]),
                None,
            )
            .expect("build hierarchy to the supported depth");
        }
        let too_deep = apply_task_parent(
            &module,
            "operation:hierarchy-depth-overflow",
            &[("page:depth-11", 1)],
            Some("page:depth-10"),
            None,
        )
        .expect_err("reject hierarchy depth eleven");
        assert_eq!(too_deep.code, CoreErrorCode::InvalidInput);
    }

    #[test]
    fn removing_a_parent_membership_promotes_its_child_tree_to_roots() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:removed-parent",
                    title: "Removed parent",
                    value_json: None,
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:promoted-child",
                    title: "Promoted child",
                    value_json: None,
                    rank_key: Some("b"),
                },
                GroupRowSpec {
                    page_id: "page:retained-grandchild",
                    title: "Retained grandchild",
                    value_json: None,
                    rank_key: Some("c"),
                },
            ],
        );
        apply_task_parent(
            &module,
            "operation:removed-parent-child",
            &[("page:promoted-child", 1)],
            Some("page:removed-parent"),
            None,
        )
        .expect("nest child");
        apply_task_parent(
            &module,
            "operation:removed-parent-grandchild",
            &[("page:retained-grandchild", 1)],
            Some("page:promoted-child"),
            None,
        )
        .expect("nest grandchild");

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:remove-hierarchy-parent-membership".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::TransferPage {
                        page_id: "page:removed-parent".to_owned(),
                        expected_parent_revision: 1,
                        expected_active_membership_revision: 1,
                        target: DatabaseTransferTarget::Library {
                            library_id: "library-1".to_owned(),
                        },
                    }],
                },
            )
            .expect("remove parent from the Data Source");

        let window = read_view_window(&module, 20, None, None).expect("read promoted tree");
        let child = window
            .rows
            .items
            .iter()
            .find(|row| row.page_id == "page:promoted-child")
            .expect("promoted child");
        let grandchild = window
            .rows
            .items
            .iter()
            .find(|row| row.page_id == "page:retained-grandchild")
            .expect("retained grandchild");
        assert_eq!(child.task_parent_page_id, None);
        assert_eq!(child.task_parent_value_revision, 3);
        assert_eq!(
            grandchild.task_parent_page_id.as_deref(),
            Some("page:promoted-child"),
        );
        assert_eq!(grandchild.task_parent_value_revision, 2);
    }

    #[test]
    fn deleting_a_parent_page_projects_promoted_children_through_library_events() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let database = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:deleted-parent",
                    title: "Deleted parent",
                    value_json: Some("\"triage\""),
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:library-promoted-child",
                    title: "Promoted child",
                    value_json: Some("\"triage\""),
                    rank_key: Some("b"),
                },
            ],
        );
        apply_task_parent(
            &database,
            "operation:delete-parent-child",
            &[("page:library-promoted-child", 1)],
            Some("page:deleted-parent"),
            None,
        )
        .expect("nest child");
        let (metadata_revision, parent_revision) = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT metadata_revision, placement_revision FROM blocks \
                         WHERE id = 'page:deleted-parent'",
                        [],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(StoreError::from)
            })
            .expect("read parent revisions");
        let library = LibraryModule::new("profile-1", "library-1", &kernel);
        let deleted = library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:delete-parent-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyPageLifecycle {
                        mutation: Box::new(LibraryPageLifecycleMutation::DeletePage {
                            page_id: "page:deleted-parent".to_owned(),
                            expected_metadata_revision: metadata_revision,
                            expected_parent_revision: parent_revision,
                            parent_document_head: None,
                        }),
                    },
                },
            )
            .expect("delete parent Page through Library lifecycle");
        assert_eq!(
            deleted.committed.receipt.committed_revisions.get(&format!(
                "value:{SOURCE_ID}:membership:page:library-promoted-child:task_parent"
            )),
            Some(&3),
        );
        assert!(
            deleted
                .committed
                .receipt
                .affected_page_ids
                .iter()
                .any(|page_id| page_id == "page:library-promoted-child")
        );

        let window = read_view_window(&database, 20, None, None).expect("read promoted child");
        let child = window
            .rows
            .items
            .iter()
            .find(|row| row.page_id == "page:library-promoted-child")
            .expect("promoted child");
        assert_eq!(child.task_parent_page_id, None);
        assert_eq!(child.task_parent_value_revision, 3);
    }

    #[test]
    fn list_window_inserts_transient_ancestors_and_stitches_cursors() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:list-parent",
                    title: "Filtered parent",
                    value_json: Some("\"triage\""),
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:list-child",
                    title: "Matching child",
                    value_json: Some("\"done\""),
                    rank_key: Some("b"),
                },
            ],
        );
        apply_task_parent(
            &module,
            "operation:list-window-child",
            &[("page:list-child", 1)],
            Some("page:list-parent"),
            None,
        )
        .expect("nest matching child");
        let mut config = view_config(
            json!({
                "kind": "clause",
                "propertyId": "status",
                "operator": "select_is",
                "value": "done"
            }),
            None,
            &["status", "priority", "estimate", "tags"],
        );
        config["presentation"]["hierarchy"] =
            json!({ "showSubPages": true, "nestedSubPages": true });
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:list-window-view".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        name: "Nested List".to_owned(),
                        layout: DatabaseViewLayout::List,
                        definition: view_definition(config),
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect("enable nested filtered List");

        let first = read_list_window(&module, 1, None).expect("first List window");
        assert_eq!(first.total_model_count, 1);
        assert_eq!(first.total_occurrence_count, 2);
        assert_eq!((first.window_start, first.window_end), (0, 1));
        assert!(!first.is_complete);
        let DatabaseListProjectionRow::Page {
            summary,
            transient_kind,
            depth,
            subtree_occurrence_count,
            concrete_subtree_page_count,
            subtree_height,
            first_child_occurrence_key,
            ..
        } = &first.rows.items[0]
        else {
            panic!("transient parent occurrence");
        };
        assert_eq!(summary.page_id, "page:list-parent");
        assert_eq!(*transient_kind, DatabaseListTransientKind::Ancestor);
        assert_eq!(*depth, 0);
        assert_eq!(*subtree_occurrence_count, 2);
        assert_eq!(*concrete_subtree_page_count, 1);
        assert_eq!(*subtree_height, 1);
        assert!(first_child_occurrence_key.is_some());

        let second = read_list_window(&module, 1, first.rows.next_cursor.clone())
            .expect("second List window");
        assert_eq!((second.window_start, second.window_end), (1, 2));
        assert!(second.is_complete);
        let DatabaseListProjectionRow::Page {
            summary,
            transient_kind,
            ancestor_page_ids,
            depth,
            ..
        } = &second.rows.items[0]
        else {
            panic!("matching child occurrence");
        };
        assert_eq!(summary.page_id, "page:list-child");
        assert_eq!(*transient_kind, DatabaseListTransientKind::None);
        assert_eq!(ancestor_page_ids, &["page:list-parent"]);
        assert_eq!(*depth, 1);
    }

    #[test]
    fn semantic_list_move_keeps_a_concrete_subtree_atomic_and_undoable() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:move-parent",
                    title: "Move parent",
                    value_json: Some("\"triage\""),
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:move-child",
                    title: "Move child",
                    value_json: Some("\"triage\""),
                    rank_key: Some("b"),
                },
                GroupRowSpec {
                    page_id: "page:move-grandchild",
                    title: "Move grandchild",
                    value_json: Some("\"triage\""),
                    rank_key: Some("c"),
                },
                GroupRowSpec {
                    page_id: "page:ship-target",
                    title: "Ship target",
                    value_json: Some("\"ship\""),
                    rank_key: Some("d"),
                },
            ],
        );
        apply_task_parent(
            &module,
            "operation:list-move-child",
            &[("page:move-child", 1)],
            Some("page:move-parent"),
            None,
        )
        .expect("nest child");
        apply_task_parent(
            &module,
            "operation:list-move-grandchild",
            &[("page:move-grandchild", 1)],
            Some("page:move-child"),
            None,
        )
        .expect("nest grandchild");
        configure_nested_status_list(&module, "operation:list-move-view");

        let before = read_list_window(&module, 50, None).expect("read source List");
        let initiator_occurrence_key = before
            .rows
            .items
            .iter()
            .find_map(|row| match row {
                DatabaseListProjectionRow::Page {
                    occurrence_key,
                    summary,
                    transient_kind: DatabaseListTransientKind::None,
                    ..
                } if summary.page_id == "page:move-parent" => Some(occurrence_key.clone()),
                _ => None,
            })
            .expect("concrete parent occurrence");
        let target_occurrence_key = before
            .rows
            .items
            .iter()
            .find_map(|row| match row {
                DatabaseListProjectionRow::Group {
                    occurrence_key,
                    group_key: Some(group_key),
                    ..
                } if group_key == "ship" => Some(occurrence_key.clone()),
                _ => None,
            })
            .expect("Ship group target");
        let moved = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:list-subtree-move".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::MoveListOccurrences {
                        view_id: VIEW_ID.to_owned(),
                        preferences_override: DatabaseViewPreferencesOverrideInput::default(),
                        expected_projection: list_projection_expectation(&before),
                        initiator_occurrence_key: initiator_occurrence_key.clone(),
                        selection: DatabaseListMoveSelection::Explicit {
                            occurrence_keys: vec![initiator_occurrence_key],
                        },
                        target: DatabaseListMoveTarget::Group {
                            occurrence_key: target_occurrence_key,
                        },
                    }],
                },
            )
            .expect("move concrete subtree");
        let DatabaseOperationOutcome::ListOccurrenceMove {
            moved_page_ids,
            move_root_page_ids,
            normalized_target,
            undo_recipe,
            ..
        } = moved.committed.receipt.operation_outcomes[0].clone()
        else {
            panic!("semantic List move outcome");
        };
        assert_eq!(
            moved_page_ids,
            [
                "page:move-parent",
                "page:move-child",
                "page:move-grandchild",
            ],
        );
        assert_eq!(move_root_page_ids, ["page:move-parent"]);
        assert_eq!(normalized_target.group_key.as_deref(), Some("ship"));
        assert_eq!(normalized_target.parent_page_id, None);

        let after = read_list_window(&module, 50, None).expect("read moved List");
        let summaries = after
            .rows
            .items
            .iter()
            .filter_map(|row| match row {
                DatabaseListProjectionRow::Page { summary, .. } => {
                    Some((summary.page_id.as_str(), summary.as_ref()))
                }
                _ => None,
            })
            .collect::<BTreeMap<_, _>>();
        for page_id in [
            "page:move-parent",
            "page:move-child",
            "page:move-grandchild",
        ] {
            assert_eq!(
                summaries[page_id].database_values.get("status"),
                Some(&json!("ship")),
            );
        }
        assert_eq!(summaries["page:move-parent"].task_parent_page_id, None);
        assert_eq!(
            summaries["page:move-child"].task_parent_page_id.as_deref(),
            Some("page:move-parent"),
        );
        assert_eq!(
            summaries["page:move-grandchild"]
                .task_parent_page_id
                .as_deref(),
            Some("page:move-child"),
        );

        let guarded_undo_recipe = (*undo_recipe).clone();
        let parent_status_revision =
            summaries["page:move-parent"].database_value_revisions["status"];
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:list-subtree-external-edit".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:move-parent".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "status".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::Replace {
                                expected_value_revision: parent_status_revision,
                                value: DatabasePropertyValueInput::Select {
                                    option_id: "build".to_owned(),
                                },
                            },
                        }],
                    }],
                },
            )
            .expect("edit a moved logical field after the drag");
        let externally_edited =
            read_list_window(&module, 50, None).expect("read externally edited List");
        let rejected_undo = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:list-subtree-stale-undo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::UndoListOccurrenceMove {
                        recipe: guarded_undo_recipe,
                    }],
                },
            )
            .expect_err("reject Undo after another writer changes a moved field");
        assert_eq!(rejected_undo.code, CoreErrorCode::RevisionConflict);
        let after_rejected_undo =
            read_list_window(&module, 50, None).expect("read List after rejected Undo");
        assert_eq!(after_rejected_undo.projection, externally_edited.projection);
        let guarded_summaries = after_rejected_undo
            .rows
            .items
            .iter()
            .filter_map(|row| match row {
                DatabaseListProjectionRow::Page { summary, .. } => {
                    Some((summary.page_id.as_str(), summary.as_ref()))
                }
                _ => None,
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            guarded_summaries["page:move-parent"]
                .database_values
                .get("status"),
            Some(&json!("build")),
        );
        for page_id in ["page:move-child", "page:move-grandchild"] {
            assert_eq!(
                guarded_summaries[page_id].database_values.get("status"),
                Some(&json!("ship")),
            );
        }

        let parent_build_revision =
            guarded_summaries["page:move-parent"].database_value_revisions["status"];
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:list-subtree-restore-post-state".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:move-parent".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "status".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::Replace {
                                expected_value_revision: parent_build_revision,
                                value: DatabasePropertyValueInput::Select {
                                    option_id: "ship".to_owned(),
                                },
                            },
                        }],
                    }],
                },
            )
            .expect("restore the guarded post-move value before safe Undo");

        let undone = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:list-subtree-undo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::UndoListOccurrenceMove {
                        recipe: *undo_recipe,
                    }],
                },
            )
            .expect("undo concrete subtree move");
        assert!(matches!(
            undone.committed.receipt.operation_outcomes.as_slice(),
            [DatabaseOperationOutcome::ListOccurrenceMoveUndo { .. }],
        ));
        let restored = read_list_window(&module, 50, None).expect("read restored List");
        for summary in restored.rows.items.iter().filter_map(|row| match row {
            DatabaseListProjectionRow::Page { summary, .. }
                if summary.page_id.starts_with("page:move-") =>
            {
                Some(summary)
            }
            _ => None,
        }) {
            assert_eq!(
                summary.database_values.get("status"),
                Some(&json!("triage"))
            );
        }
    }

    #[test]
    fn semantic_list_move_uses_default_view_positions_when_sort_is_empty() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:default-parent",
                    title: "Default parent",
                    value_json: Some("\"triage\""),
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:default-child",
                    title: "Default child",
                    value_json: Some("\"triage\""),
                    rank_key: Some("b"),
                },
                GroupRowSpec {
                    page_id: "page:default-target",
                    title: "Default target",
                    value_json: Some("\"triage\""),
                    rank_key: Some("c"),
                },
            ],
        );
        apply_task_parent(
            &module,
            "operation:default-list-child",
            &[("page:default-child", 1)],
            Some("page:default-parent"),
            None,
        )
        .expect("nest default List child");
        let mut config = view_config(
            json!({ "kind": "group", "operator": "and", "children": [] }),
            None,
            &["status", "priority", "estimate", "tags"],
        );
        config["rules"]["sorts"] = json!([]);
        config["presentation"]["hierarchy"] =
            json!({ "showSubPages": true, "nestedSubPages": true });
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:default-list-view".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        name: "Default position List".to_owned(),
                        layout: DatabaseViewLayout::List,
                        definition: view_definition(config),
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect("configure default-position List");

        let before = read_list_window(&module, 50, None).expect("read default List");
        let occurrence_key = |page_id: &str| {
            before
                .rows
                .items
                .iter()
                .find_map(|row| match row {
                    DatabaseListProjectionRow::Page {
                        occurrence_key,
                        summary,
                        transient_kind: DatabaseListTransientKind::None,
                        ..
                    } if summary.page_id == page_id => Some(occurrence_key.clone()),
                    _ => None,
                })
                .expect("concrete default List occurrence")
        };
        let source_key = occurrence_key("page:default-parent");
        let target_key = occurrence_key("page:default-target");
        let moved = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:default-list-move".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::MoveListOccurrences {
                        view_id: VIEW_ID.to_owned(),
                        preferences_override: DatabaseViewPreferencesOverrideInput::default(),
                        expected_projection: list_projection_expectation(&before),
                        initiator_occurrence_key: source_key.clone(),
                        selection: DatabaseListMoveSelection::Explicit {
                            occurrence_keys: vec![source_key],
                        },
                        target: DatabaseListMoveTarget::Page {
                            occurrence_key: target_key,
                            edge: DatabaseListMoveEdge::After,
                        },
                    }],
                },
            )
            .expect("move a subtree in default position order");
        let DatabaseOperationOutcome::ListOccurrenceMove { undo_recipe, .. } =
            moved.committed.receipt.operation_outcomes[0].clone()
        else {
            panic!("default List move outcome");
        };
        let page_order = |window: &nodex_core_contracts::database::DatabaseListWindow| {
            window
                .rows
                .items
                .iter()
                .filter_map(|row| match row {
                    DatabaseListProjectionRow::Page { summary, .. } => {
                        Some(summary.page_id.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        let after = read_list_window(&module, 50, None).expect("read moved default List");
        assert_eq!(
            page_order(&after),
            [
                "page:default-target".to_owned(),
                "page:default-parent".to_owned(),
                "page:default-child".to_owned(),
            ]
        );

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:default-list-undo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::UndoListOccurrenceMove {
                        recipe: *undo_recipe,
                    }],
                },
            )
            .expect("undo the default position move");
        let restored = read_list_window(&module, 50, None).expect("read restored default List");
        assert_eq!(
            page_order(&restored),
            [
                "page:default-parent".to_owned(),
                "page:default-child".to_owned(),
                "page:default-target".to_owned(),
            ]
        );
    }

    #[test]
    fn semantic_list_move_adopts_the_sorted_property_at_the_target_slot() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:sorted-source",
                    title: "Sorted source",
                    value_json: Some("\"ship\""),
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:sorted-low-a",
                    title: "Sorted low A",
                    value_json: Some("\"ship\""),
                    rank_key: Some("b"),
                },
                GroupRowSpec {
                    page_id: "page:sorted-low-b",
                    title: "Sorted low B",
                    value_json: Some("\"ship\""),
                    rank_key: Some("c"),
                },
            ],
        );
        kernel
            .writer()
            .call(|connection| {
                for (page_id, priority) in [
                    ("page:sorted-source", "p1-high"),
                    ("page:sorted-low-a", "p3-low"),
                    ("page:sorted-low-b", "p3-low"),
                ] {
                    connection.execute(
                        "INSERT INTO data_source_property_values(\
                           data_source_id, membership_id, property_id, value_type, \
                           value_json, revision, updated_at\
                         ) VALUES (?1, ?2, 'priority', 'select', ?3, 1, ?4)",
                        params![
                            SOURCE_ID,
                            format!("membership:{page_id}"),
                            serde_json::to_string(priority).expect("priority JSON"),
                            NOW,
                        ],
                    )?;
                }
                Ok(())
            })
            .expect("seed sorted Property values");
        let mut config = view_config(
            json!({ "kind": "group", "operator": "and", "children": [] }),
            Some("status"),
            &["status", "priority"],
        );
        config["rules"]["sorts"] = json!([{
            "field": { "kind": "property", "propertyId": "priority" },
            "direction": "asc",
            "nulls": "last"
        }]);
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:sorted-list-view".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        name: "Sorted List".to_owned(),
                        layout: DatabaseViewLayout::List,
                        definition: view_definition(config),
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect("configure sorted List");
        let before = read_list_window(&module, 50, None).expect("read sorted List");
        let occurrence_key = |page_id: &str| {
            before
                .rows
                .items
                .iter()
                .find_map(|row| match row {
                    DatabaseListProjectionRow::Page {
                        occurrence_key,
                        summary,
                        transient_kind: DatabaseListTransientKind::None,
                        ..
                    } if summary.page_id == page_id => Some(occurrence_key.clone()),
                    _ => None,
                })
                .expect("sorted List occurrence")
        };
        let source_key = occurrence_key("page:sorted-source");
        let target_key = occurrence_key("page:sorted-low-b");
        let block_expectation = list_projection_expectation(&before);
        let block_target_key = target_key.clone();
        let block_destination = kernel
            .writer()
            .call(move |connection| {
                resolve_page_transfer_list_destination(
                    connection,
                    "library-1",
                    "project-1",
                    SOURCE_ID,
                    VIEW_ID,
                    &DatabaseViewPreferencesOverrideInput::default(),
                    &block_expectation,
                    &DatabaseListMoveTarget::Page {
                        occurrence_key: block_target_key,
                        edge: DatabaseListMoveEdge::Before,
                    },
                )
            })
            .expect("compile a sorted List Block destination");
        assert!(
            block_destination
                .values
                .iter()
                .any(|value| { value.property_id == "priority" && value.value == json!("p3-low") })
        );
        assert_eq!(
            block_destination
                .view
                .as_ref()
                .and_then(|view| view.before.as_ref())
                .map(|before| before.page_id.as_str()),
            Some("page:sorted-low-b"),
        );
        let moved = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:sorted-list-move".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::MoveListOccurrences {
                        view_id: VIEW_ID.to_owned(),
                        preferences_override: DatabaseViewPreferencesOverrideInput::default(),
                        expected_projection: list_projection_expectation(&before),
                        initiator_occurrence_key: source_key.clone(),
                        selection: DatabaseListMoveSelection::Explicit {
                            occurrence_keys: vec![source_key],
                        },
                        target: DatabaseListMoveTarget::Page {
                            occurrence_key: target_key,
                            edge: DatabaseListMoveEdge::Before,
                        },
                    }],
                },
            )
            .expect("move into a sorted List slot");
        let DatabaseOperationOutcome::ListOccurrenceMove { undo_recipe, .. } =
            &moved.committed.receipt.operation_outcomes[0]
        else {
            panic!("sorted List move outcome");
        };
        assert!(undo_recipe.property_states.iter().any(|state| {
            state.page_id == "page:sorted-source"
                && state.property_id == "priority"
                && state.after_value
                    == DatabasePropertyValueInput::Select {
                        option_id: "p3-low".to_owned(),
                    }
        }));
        let after = read_list_window(&module, 50, None).expect("read inferred sorted List");
        let source = after
            .rows
            .items
            .iter()
            .find_map(|row| match row {
                DatabaseListProjectionRow::Page { summary, .. }
                    if summary.page_id == "page:sorted-source" =>
                {
                    Some(summary)
                }
                _ => None,
            })
            .expect("moved sorted Page");
        assert_eq!(
            source.database_values.get("priority"),
            Some(&json!("p3-low")),
        );
        let page_order = after
            .rows
            .items
            .iter()
            .filter_map(|row| match row {
                DatabaseListProjectionRow::Page { summary, .. } => Some(summary.page_id.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            page_order,
            [
                "page:sorted-low-a".to_owned(),
                "page:sorted-source".to_owned(),
                "page:sorted-low-b".to_owned(),
            ],
        );
    }

    #[test]
    fn semantic_list_move_rolls_back_group_adoption_when_depth_validation_fails() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let mut rows = vec![
            GroupRowSpec {
                page_id: "page:deep-source",
                title: "Deep source",
                value_json: Some("\"triage\""),
                rank_key: Some("a"),
            },
            GroupRowSpec {
                page_id: "page:deep-child",
                title: "Deep child",
                value_json: Some("\"triage\""),
                rank_key: Some("b"),
            },
        ];
        const TARGETS: [&str; 10] = [
            "page:target-0",
            "page:target-1",
            "page:target-2",
            "page:target-3",
            "page:target-4",
            "page:target-5",
            "page:target-6",
            "page:target-7",
            "page:target-8",
            "page:target-9",
        ];
        for (index, page_id) in TARGETS.iter().enumerate() {
            rows.push(GroupRowSpec {
                page_id,
                title: page_id,
                value_json: Some("\"ship\""),
                rank_key: Some(if index % 2 == 0 { "c" } else { "d" }),
            });
        }
        let module = seed_grouped_fixture(&kernel, rows);
        apply_task_parent(
            &module,
            "operation:deep-source-child",
            &[("page:deep-child", 1)],
            Some("page:deep-source"),
            None,
        )
        .expect("nest source child");
        for index in 1..TARGETS.len() {
            apply_task_parent(
                &module,
                &format!("operation:deep-target-{index}"),
                &[(TARGETS[index], 1)],
                Some(TARGETS[index - 1]),
                None,
            )
            .expect("build target hierarchy");
        }
        configure_nested_status_list(&module, "operation:deep-list-view");
        let before = read_list_window(&module, 100, None).expect("read deep List");
        let source_key = before
            .rows
            .items
            .iter()
            .find_map(|row| match row {
                DatabaseListProjectionRow::Page {
                    occurrence_key,
                    summary,
                    transient_kind: DatabaseListTransientKind::None,
                    ..
                } if summary.page_id == "page:deep-source" => Some(occurrence_key.clone()),
                _ => None,
            })
            .expect("source occurrence");
        let target_key = before
            .rows
            .items
            .iter()
            .find_map(|row| match row {
                DatabaseListProjectionRow::Page {
                    occurrence_key,
                    summary,
                    transient_kind: DatabaseListTransientKind::None,
                    ..
                } if summary.page_id == TARGETS[9] => Some(occurrence_key.clone()),
                _ => None,
            })
            .expect("deep target occurrence");
        let error = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:deep-list-move".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::MoveListOccurrences {
                        view_id: VIEW_ID.to_owned(),
                        preferences_override: DatabaseViewPreferencesOverrideInput::default(),
                        expected_projection: list_projection_expectation(&before),
                        initiator_occurrence_key: source_key.clone(),
                        selection: DatabaseListMoveSelection::Explicit {
                            occurrence_keys: vec![source_key],
                        },
                        target: DatabaseListMoveTarget::Page {
                            occurrence_key: target_key,
                            edge: DatabaseListMoveEdge::Inside,
                        },
                    }],
                },
            )
            .expect_err("reject a subtree deeper than ten Parent edges");
        assert_eq!(error.code, CoreErrorCode::InvalidInput);

        let after = read_list_window(&module, 100, None).expect("read rolled-back List");
        assert_eq!(
            after.projection.covered_commit_seq,
            before.projection.covered_commit_seq
        );
        for summary in after.rows.items.iter().filter_map(|row| match row {
            DatabaseListProjectionRow::Page { summary, .. }
                if summary.page_id == "page:deep-source"
                    || summary.page_id == "page:deep-child" =>
            {
                Some(summary)
            }
            _ => None,
        }) {
            assert_eq!(
                summary.database_values.get("status"),
                Some(&json!("triage"))
            );
        }
    }

    #[test]
    fn list_window_expands_multi_value_group_occurrences() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:multi-group",
                    title: "Two tags",
                    value_json: Some("\"triage\""),
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:single-group",
                    title: "One tag",
                    value_json: Some("\"triage\""),
                    rank_key: Some("b"),
                },
            ],
        );
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:list-multi-value".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![
                        DatabaseIntent::PutOption {
                            data_source_id: SOURCE_ID.to_owned(),
                            property_id: "tags".to_owned(),
                            option_id: "o_AAAAAAAA".to_owned(),
                            name: "Zulu".to_owned(),
                            color: None,
                            expected_property_revision: 1,
                        },
                        DatabaseIntent::PutOption {
                            data_source_id: SOURCE_ID.to_owned(),
                            property_id: "tags".to_owned(),
                            option_id: "o_BBBBBBBB".to_owned(),
                            name: "Alpha".to_owned(),
                            color: None,
                            expected_property_revision: 2,
                        },
                        DatabaseIntent::EditPropertyValues {
                            edits: vec![
                                DatabasePropertyValueMutation {
                                    address: DatabasePagePropertyAddress {
                                        page_id: "page:multi-group".to_owned(),
                                        data_source_id: SOURCE_ID.to_owned(),
                                        property_id: "tags".to_owned(),
                                    },
                                    edit: DatabasePropertyValueEdit::Replace {
                                        expected_value_revision: 0,
                                        value: DatabasePropertyValueInput::MultiSelect {
                                            option_ids: vec![
                                                "o_AAAAAAAA".to_owned(),
                                                "o_BBBBBBBB".to_owned(),
                                            ],
                                        },
                                    },
                                },
                                DatabasePropertyValueMutation {
                                    address: DatabasePagePropertyAddress {
                                        page_id: "page:single-group".to_owned(),
                                        data_source_id: SOURCE_ID.to_owned(),
                                        property_id: "tags".to_owned(),
                                    },
                                    edit: DatabasePropertyValueEdit::Replace {
                                        expected_value_revision: 0,
                                        value: DatabasePropertyValueInput::MultiSelect {
                                            option_ids: vec!["o_BBBBBBBB".to_owned()],
                                        },
                                    },
                                },
                            ],
                        },
                        DatabaseIntent::PutView {
                            database_id: DATABASE_ID.to_owned(),
                            data_source_id: SOURCE_ID.to_owned(),
                            view_id: VIEW_ID.to_owned(),
                            expected_revision: 1,
                            name: "Tag List".to_owned(),
                            layout: DatabaseViewLayout::List,
                            definition: view_definition(view_config(
                                json!({ "kind": "group", "operator": "and", "children": [] }),
                                Some("tags"),
                                &["status", "priority", "estimate", "tags"],
                            )),
                            is_default: true,
                            before_view_id: None,
                        },
                    ],
                },
            )
            .expect("configure multi-value grouping");

        let window = read_list_window(&module, 20, None).expect("multi-value List window");
        assert_eq!(window.total_model_count, 2);
        assert_eq!(window.total_occurrence_count, 3);
        assert_eq!(window.groups.len(), 2);
        let summary = window
            .rows
            .items
            .iter()
            .find_map(|row| match row {
                DatabaseListProjectionRow::Page { summary, .. } => Some(summary.as_ref()),
                _ => None,
            })
            .expect("multi-value row summary");
        assert_eq!(
            summary.database_values.get("tags"),
            Some(&json!(["o_AAAAAAAA", "o_BBBBBBBB"])),
        );
        let view_window =
            read_view_window(&module, 20, None, None).expect("canonical multi-value View window");
        assert_eq!(
            view_window.rows.items[0].effective_group_key.as_deref(),
            Some("[\"o_AAAAAAAA\",\"o_BBBBBBBB\"]"),
        );
        let occurrences = window
            .rows
            .items
            .iter()
            .filter_map(|row| match row {
                DatabaseListProjectionRow::Page {
                    occurrence_key,
                    summary,
                    group_path,
                    ..
                } => Some((occurrence_key, summary.page_id.as_str(), group_path)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(occurrences.len(), 3);
        assert_ne!(occurrences[0].0, occurrences[1].0);
        assert_eq!(
            occurrences
                .iter()
                .map(|(_, _, path)| path[0].as_deref())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([Some("o_AAAAAAAA"), Some("o_BBBBBBBB")]),
        );

        let descending = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ListWindow {
                        target: DatabaseViewReadTarget::PresentedView {
                            view_id: VIEW_ID.to_owned(),
                            preferences_override: preferences_override(
                                DatabaseViewPresentationOverrideInput {
                                    group_direction: Some(DatabaseViewSortDirectionInput::Desc),
                                    ..Default::default()
                                },
                            ),
                        },
                        window: CollectionWindowRequest {
                            after: None,
                            first: Some(20),
                        },
                    },
                },
            )
            .expect("read descending group order");
        let DatabaseReadValue::ListWindow { value: descending } = descending.value else {
            panic!("descending List window");
        };
        let group_keys = descending
            .rows
            .items
            .iter()
            .filter_map(|row| match row {
                DatabaseListProjectionRow::Group { group_key, .. } => group_key.as_deref(),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(group_keys, ["o_BBBBBBBB", "o_AAAAAAAA"]);

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:list-filter-canonical-tag".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 2,
                        name: "Tag List".to_owned(),
                        layout: DatabaseViewLayout::List,
                        definition: view_definition(view_config(
                            json!({
                                "kind": "clause",
                                "propertyId": "tags",
                                "operator": "multi_select_contains",
                                "value": ["o_AAAAAAAA"]
                            }),
                            Some("tags"),
                            &["status", "priority", "estimate", "tags"],
                        )),
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect("filter by canonical tag identity");
        let filtered = read_list_window(&module, 20, None).expect("filtered tag List window");
        assert_eq!(filtered.total_model_count, 1);
        assert_eq!(filtered.total_occurrence_count, 2);

        let mut sorted_config = view_config(
            json!({ "kind": "group", "operator": "and", "children": [] }),
            None,
            &["status", "priority", "estimate", "tags"],
        );
        sorted_config["rules"]["sorts"] = json!([{
            "field": { "kind": "property", "propertyId": "tags" },
            "direction": "asc",
            "nulls": "last"
        }]);
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:list-sort-canonical-tag".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 3,
                        name: "Tag List".to_owned(),
                        layout: DatabaseViewLayout::List,
                        definition: view_definition(sorted_config),
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect("sort by canonical tag identity");
        let sorted =
            read_view_window(&module, 20, None, None).expect("sorted canonical tag View window");
        assert_eq!(
            sorted
                .rows
                .items
                .iter()
                .map(|row| row.page_id.as_str())
                .collect::<Vec<_>>(),
            ["page:multi-group", "page:single-group"],
        );
    }

    #[test]
    fn view_descriptor_changes_advance_shared_page_detail_database_authority() {
        const SECOND_VIEW_ID: &str = "018f1000-0000-7000-8000-000000000006";
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(&kernel, Vec::new());

        let changed = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:page-detail-view-descriptor".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: SECOND_VIEW_ID.to_owned(),
                        expected_revision: 0,
                        name: "Secondary list".to_owned(),
                        layout: DatabaseViewLayout::List,
                        definition: view_definition(view_config(
                            json!({
                                "kind": "group",
                                "operator": "and",
                                "children": []
                            }),
                            None,
                            &["status"],
                        )),
                        is_default: false,
                        before_view_id: None,
                    }],
                },
            )
            .expect("change a shared Database View descriptor");
        let manifest = kernel
            .readers()
            .read_default(|connection| {
                crate::infrastructure::local_commit::read_manifest(
                    connection,
                    changed.committed.commit_seq,
                )
            })
            .expect("View descriptor CommitManifest");
        assert!(manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                LocalProjectionScope::PageDetailDatabase { database_id, .. }
                    if database_id == DATABASE_ID
            )
        }));
        assert!(!manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                LocalProjectionScope::PageDetailDataSource { .. }
            )
        }));

        let deleted = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:page-detail-delete-view-descriptor".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::DeleteView {
                        database_id: DATABASE_ID.to_owned(),
                        view_id: SECOND_VIEW_ID.to_owned(),
                        expected_revision: 1,
                    }],
                },
            )
            .expect("delete a shared Database View descriptor");
        let manifest = kernel
            .readers()
            .read_default(|connection| {
                crate::infrastructure::local_commit::read_manifest(
                    connection,
                    deleted.committed.commit_seq,
                )
            })
            .expect("deleted View descriptor CommitManifest");
        assert!(manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                LocalProjectionScope::PageDetailDatabase { database_id, .. }
                    if database_id == DATABASE_ID
            )
        }));
        assert!(
            !manifest.projection_effects.iter().any(|effect| {
                matches!(&effect.scope.scope, LocalProjectionScope::Project { .. })
            })
        );
    }

    #[test]
    fn database_page_key_namespace_reads_and_rename_share_one_causal_commit() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![GroupRowSpec {
                page_id: "page:page-key-row",
                title: "Page-key row",
                value_json: None,
                rank_key: Some("a"),
            }],
        );
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    create_page_key_namespace(
                        transaction,
                        "library-1",
                        DATABASE_ID,
                        Some("LAB"),
                        "Lab",
                        NOW,
                    )?;
                    ensure_database_page_key(
                        transaction,
                        "library-1",
                        DATABASE_ID,
                        "page:page-key-row",
                        NOW,
                    )?;
                    Ok(())
                })
            })
            .expect("enable Database Page-key namespace");

        let preview = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::PageKeyPrefixPreview {
                        database_id: Some(DATABASE_ID.to_owned()),
                        name_hint: "Lab".to_owned(),
                        requested_prefix: Some("lab".to_owned()),
                    },
                },
            )
            .expect("preview current Database prefix");
        let DatabaseReadValue::PageKeyPrefixPreview { value: preview } = preview.value else {
            panic!("Page-key prefix preview");
        };
        assert_eq!(preview.prefix, "LAB");
        assert_eq!(
            preview.availability,
            DatabasePageKeyPrefixAvailability::Current
        );
        assert_eq!(preview.next_number, 2);
        assert_eq!(preview.example_keys, ["LAB-2", "LAB-3", "LAB-4"]);

        let namespace = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::PageKeyNamespace {
                        database_id: DATABASE_ID.to_owned(),
                    },
                },
            )
            .expect("read Database Page-key namespace");
        let DatabaseReadValue::PageKeyNamespace { value: namespace } = namespace.value else {
            panic!("Page-key namespace");
        };
        assert_eq!(namespace.current_prefix, "LAB");
        assert_eq!(namespace.assigned_page_count, 1);
        assert_eq!(namespace.revision, 1);

        let renamed = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:rename-page-key-prefix".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::RenamePageKeyPrefix {
                        database_id: DATABASE_ID.to_owned(),
                        expected_revision: 1,
                        prefix: "RND".to_owned(),
                    }],
                },
            )
            .expect("rename Database Page-key prefix");
        assert_eq!(
            renamed
                .committed
                .receipt
                .committed_revisions
                .get(&format!("page_key_namespace:{DATABASE_ID}")),
            Some(&2),
        );

        let manifest = kernel
            .readers()
            .read_default(|connection| {
                crate::infrastructure::local_commit::read_manifest(
                    connection,
                    renamed.committed.commit_seq,
                )
            })
            .expect("Page-key rename CommitManifest");
        assert!(manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                LocalProjectionScope::DatabaseView { database_id, .. }
                    if database_id == DATABASE_ID
            ) && effect.patch.is_none()
        }));
        assert!(manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                LocalProjectionScope::PageDetailDatabase { database_id, .. }
                    if database_id == DATABASE_ID
            )
        }));
        assert!(!manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.patch,
                Some(LocalProjectionPatch::PageChanged { .. })
                    | Some(LocalProjectionPatch::DatabaseRowUpsert { .. })
                    | Some(LocalProjectionPatch::DatabaseRowRemove { .. })
            )
        }));
    }

    #[test]
    fn schedule_index_follows_direct_property_edits_and_schema_deletion() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![GroupRowSpec {
                page_id: "page:schedule-row",
                title: "Scheduled row",
                value_json: Some("\"triage\""),
                rank_key: Some("a"),
            }],
        );
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO scheduled_page_index( \
                       page_block_id, library_id, lifecycle, scheduled_start, scheduled_end, \
                       is_all_day, recurrence_json, reminders_json, schedule_timezone, \
                       source_metadata_revision, updated_at \
                     ) VALUES ('page:schedule-row', 'library-1', 'active', NULL, NULL, 0, \
                       'null', '[]', NULL, 1, ?1)",
                    [NOW],
                )?;
                Ok(())
            })
            .expect("seed schedule index");

        let edited = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:set-schedule-pair".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![
                            DatabasePropertyValueMutation {
                                address: DatabasePagePropertyAddress {
                                    page_id: "page:schedule-row".to_owned(),
                                    data_source_id: SOURCE_ID.to_owned(),
                                    property_id: "scheduled_start".to_owned(),
                                },
                                edit: DatabasePropertyValueEdit::Replace {
                                    expected_value_revision: 0,
                                    value: DatabasePropertyValueInput::Datetime {
                                        value: "2026-08-04T09:00:00.000Z".to_owned(),
                                    },
                                },
                            },
                            DatabasePropertyValueMutation {
                                address: DatabasePagePropertyAddress {
                                    page_id: "page:schedule-row".to_owned(),
                                    data_source_id: SOURCE_ID.to_owned(),
                                    property_id: "scheduled_end".to_owned(),
                                },
                                edit: DatabasePropertyValueEdit::Replace {
                                    expected_value_revision: 0,
                                    value: DatabasePropertyValueInput::Datetime {
                                        value: "2026-08-04T10:00:00.000Z".to_owned(),
                                    },
                                },
                            },
                        ],
                    }],
                },
            )
            .expect("write schedule pair through Database Property authority");
        let edit_manifest = kernel
            .readers()
            .read_default(|connection| {
                crate::infrastructure::local_commit::read_manifest(
                    connection,
                    edited.committed.commit_seq,
                )
            })
            .expect("Property edit CommitManifest");
        assert!(edit_manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.patch,
                Some(LocalProjectionPatch::PageChanged { page_id, .. })
                    if page_id == "page:schedule-row"
            )
        }));
        assert!(edit_manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                LocalProjectionScope::DatabaseView { .. }
            ) && effect.patch.is_none()
        }));
        assert!(!edit_manifest.projection_effects.iter().any(|effect| {
            matches!(
                &effect.scope.scope,
                LocalProjectionScope::PageDetailDataSource { .. }
            )
        }));

        let indexed = kernel
            .writer()
            .call(|connection| {
                connection
                    .query_row(
                        "SELECT scheduled_start, scheduled_end FROM scheduled_page_index \
                         WHERE page_block_id = 'page:schedule-row'",
                        [],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .map_err(StoreError::from)
            })
            .expect("read updated schedule index");
        assert_eq!(
            indexed,
            (
                "2026-08-04T09:00:00.000Z".to_owned(),
                "2026-08-04T10:00:00.000Z".to_owned(),
            )
        );

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:delete-schedule-start".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::DeleteProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "scheduled_start".to_owned(),
                        expected_data_source_revision: 1,
                        expected_property_revision: 1,
                    }],
                },
            )
            .expect("delete one schedule Property");

        let indexed_start = kernel
            .writer()
            .call(|connection| {
                connection
                    .query_row(
                        "SELECT scheduled_start FROM scheduled_page_index \
                         WHERE page_block_id = 'page:schedule-row'",
                        [],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("read degraded schedule index");
        assert_eq!(indexed_start, None);

        let (schedule_revision, metadata_revision, status_value) = kernel
            .writer()
            .call(|connection| {
                let (expected_parent_revision, expected_membership_revision) = connection
                    .query_row(
                        "SELECT block.placement_revision, membership.revision \
                         FROM blocks block \
                         JOIN data_source_page_memberships membership \
                           ON membership.page_block_id = block.id AND membership.removed_at IS NULL \
                         WHERE block.id = 'page:schedule-row'",
                        [],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )?;
                let destination = PageCopyDataSourceDestination {
                    data_source_id: SOURCE_ID.to_owned(),
                    expected_data_source_revision: 1,
                    values: vec![PageCopyValueDraft {
                        property_id: "status".to_owned(),
                        value: json!("plan"),
                    }],
                    view: None,
                };
                transfer_existing_page_for_block_transfer(
                    connection,
                    "library-1",
                    "project-1",
                    "page:schedule-row",
                    expected_parent_revision,
                    expected_membership_revision,
                    ExistingPageTransferTarget::DataSource(&destination),
                    NOW,
                )?;
                connection
                    .query_row(
                        "SELECT schedule.source_metadata_revision, block.metadata_revision, value.value_json \
                         FROM scheduled_page_index schedule \
                         JOIN blocks block ON block.id = schedule.page_block_id \
                         JOIN data_source_page_memberships membership \
                           ON membership.page_block_id = block.id AND membership.removed_at IS NULL \
                         JOIN data_source_property_values value \
                           ON value.membership_id = membership.id \
                          AND value.data_source_id = membership.data_source_id \
                          AND value.property_id = 'status' \
                         WHERE schedule.page_block_id = 'page:schedule-row'",
                        [],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, String>(2)?,
                            ))
                        },
                    )
                    .map_err(StoreError::from)
            })
            .expect("structural Page transfer keeps schedule coordinates current");
        assert_eq!(schedule_revision, metadata_revision);
        assert_eq!(status_value, "\"plan\"");
    }

    #[test]
    fn relation_property_persists_edges_and_reads_preview_and_full_window() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:relation-row",
                    title: "Define Relation",
                    value_json: Some("\"backlog\""),
                    rank_key: None,
                },
                GroupRowSpec {
                    page_id: "page:target-a",
                    title: "Target A",
                    value_json: None,
                    rank_key: None,
                },
                GroupRowSpec {
                    page_id: "page:target-b",
                    title: "Target B",
                    value_json: None,
                    rank_key: None,
                },
                GroupRowSpec {
                    page_id: "page:target-c",
                    title: "Target C",
                    value_json: None,
                    rank_key: None,
                },
                GroupRowSpec {
                    page_id: "page:target-d",
                    title: "Target D",
                    value_json: None,
                    rank_key: None,
                },
            ],
        );
        let source_revision = kernel
            .writer()
            .call(|connection| {
                connection
                    .query_row(
                        "SELECT schema_revision FROM data_sources WHERE id = ?1",
                        [SOURCE_ID],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("source revision");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:put-relation".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutProperty {
                        data_source_id: SOURCE_ID.to_owned(),
                        property_id: "p_blocked0".to_owned(),
                        expected_data_source_revision: source_revision,
                        expected_property_revision: 0,
                        name: "Blocked by".to_owned(),
                        schema: DatabasePropertySchema::Relation {
                            target_data_source_id: SOURCE_ID.to_owned(),
                            cardinality:
                                nodex_core_contracts::database::DatabaseRelationCardinality::Many,
                        },
                        before_property_id: None,
                    }],
                },
            )
            .expect("create Relation Property");
        let replace_many = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:reject-replace-many-relation".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:relation-row".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "p_blocked0".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::ReplaceOneRelation {
                                expected_value_revision: 0,
                                target_page_id: Some("page:target-a".to_owned()),
                            },
                        }],
                    }],
                },
            )
            .expect_err("cardinality-many Relation rejects single-target replacement");
        assert_eq!(replace_many.code, CoreErrorCode::InvalidInput);
        let write = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:set-relation".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:relation-row".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "p_blocked0".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::PatchSet {
                                delta: nodex_core_contracts::database::DatabasePropertySetDelta::Relation {
                                    add_page_ids: [
                                        "page:relation-row",
                                        "page:target-a",
                                        "page:target-b",
                                        "page:target-c",
                                        "page:target-d",
                                    ]
                                    .into_iter()
                                    .map(str::to_owned)
                                    .collect(),
                                    remove_edge_ids: Vec::new(),
                                },
                            },
                        }],
                    }],
                },
            )
            .expect("write Relation edge");
        assert_eq!(
            write
                .committed
                .receipt
                .committed_revisions
                .values()
                .filter(|revision| **revision == 1)
                .count(),
            1
        );
        kernel
            .writer()
            .call(|connection| {
                let authority = connection.query_row(
                    "SELECT value.value_json, value.revision, count(edge.target_page_block_id) \
                     FROM data_source_property_values value \
                     LEFT JOIN data_source_relation_edges edge \
                       ON edge.source_data_source_id = value.data_source_id \
                       AND edge.source_membership_id = value.membership_id \
                       AND edge.property_id = value.property_id \
                     WHERE value.data_source_id = ?1 AND value.property_id = 'p_blocked0'",
                    [SOURCE_ID],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )?;
                assert_eq!(authority, ("null".to_owned(), 1, 5));
                Ok(())
            })
            .expect("inspect normalized Relation authority");
        let no_op = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:patch-relation-no-op".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:relation-row".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "p_blocked0".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::PatchSet {
                                delta: nodex_core_contracts::database::DatabasePropertySetDelta::Relation {
                                    add_page_ids: vec!["page:relation-row".to_owned()],
                                    remove_edge_ids: Vec::new(),
                                },
                            },
                        }],
                    }],
                },
            )
            .expect("Relation patch no-op");
        assert!(no_op.committed.receipt.committed_revisions.is_empty());
        let revision_after_no_op = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT revision FROM data_source_property_values \
                         WHERE data_source_id = ?1 AND property_id = 'p_blocked0'",
                        [SOURCE_ID],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("Relation revision after no-op");
        assert_eq!(revision_after_no_op, 1);
        let guessed_remove = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:patch-relation-guessed-remove".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:relation-row".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "p_blocked0".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::PatchSet {
                                delta: nodex_core_contracts::database::DatabasePropertySetDelta::Relation {
                                    add_page_ids: Vec::new(),
                                    remove_edge_ids: vec!["0".repeat(64)],
                                },
                            },
                        }],
                    }],
                },
            )
            .expect_err("Relation removal cannot probe an unknown Page identity");
        assert_eq!(
            guessed_remove.code,
            CoreErrorCode::NotFound,
            "{guessed_remove:?}"
        );
        let stale_clear = module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:clear-many-relation-stale".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:relation-row".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "p_blocked0".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::ClearManyRelation {
                                expected_value_revision: 0,
                            },
                        }],
                    }],
                },
            )
            .expect_err("stale cardinality-many Relation clear");
        assert_eq!(stale_clear.code, CoreErrorCode::RevisionConflict);
        let (view_revision, mut view_config) = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT revision, config_json FROM database_views WHERE id = ?1",
                        [VIEW_ID],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                serde_json::from_str::<serde_json::Value>(
                                    &row.get::<_, String>(1)?,
                                )
                                .map_err(|error| {
                                    rusqlite::Error::FromSqlConversionFailure(
                                        1,
                                        rusqlite::types::Type::Text,
                                        Box::new(error),
                                    )
                                })?,
                            ))
                        },
                    )
                    .map_err(StoreError::from)
            })
            .expect("read Relation filter View");
        view_config["rules"]["advancedFilter"] = json!({
            "kind": "group",
            "operator": "and",
            "children": [{
                "kind": "clause",
                "propertyId": "p_blocked0",
                "operator": "relation_contains",
                "value": ["page:relation-row"]
            }]
        });
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:filter-relation".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: view_revision,
                        name: "Workflow".to_owned(),
                        layout: DatabaseViewLayout::Board,
                        definition: view_definition(view_config),
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect("save authorized Relation membership filter");
        let filtered = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::View {
                            view_id: VIEW_ID.to_owned(),
                        },
                        window: Default::default(),
                        group_scope: None,
                    },
                },
            )
            .expect("query Relation membership filter");
        let DatabaseReadValue::ViewWindow { value: filtered } = filtered.value else {
            panic!("Relation filtered View");
        };
        assert_eq!(filtered.rows.items.len(), 1);
        let preview = &filtered.rows.items[0].database_values["p_blocked0"]["value"];
        assert_eq!(preview["total_count"], 5);
        assert_eq!(preview["targets"].as_array().map(Vec::len), Some(3));
        assert_eq!(preview["restricted_count"], 0);
        assert_eq!(preview["has_more"], true);
        let snapshot = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::RelationTargetWindow {
                        address: DatabasePagePropertyAddress {
                            page_id: "page:relation-row".to_owned(),
                            data_source_id: SOURCE_ID.to_owned(),
                            property_id: "p_blocked0".to_owned(),
                        },
                        window: CollectionWindowRequest {
                            after: None,
                            first: Some(1),
                        },
                    },
                },
            )
            .expect("read Relation window");
        let DatabaseReadValue::RelationTargetWindow { value } = snapshot.value else {
            panic!("Relation window");
        };
        assert_eq!(value.value_revision, 1);
        assert_eq!(value.total_count, 5);
        let first_edge_id = match value.targets.items.as_slice() {
            [
                nodex_core_contracts::database::DatabaseRelationTargetItem::Visible {
                    edge_id,
                    page_id,
                    ..
                },
            ] if page_id == "page:relation-row" => edge_id.clone(),
            targets => panic!("unexpected Relation targets: {targets:?}"),
        };
        let cursor = value.targets.next_cursor.expect("Relation continuation");
        let encoded_payload = cursor.split('.').nth(1).expect("cursor payload");
        let payload = String::from_utf8(
            BASE64_URL_SAFE_NO_PAD
                .decode(encoded_payload)
                .expect("base64 cursor payload"),
        )
        .expect("JSON cursor payload");
        assert!(payload.contains("relation_target"));
        for page_id in [
            "page:relation-row",
            "page:target-a",
            "page:target-b",
            "page:target-c",
            "page:target-d",
        ] {
            assert!(!payload.contains(page_id));
        }
        let candidates = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::RelationCandidateWindow {
                        data_source_id: SOURCE_ID.to_owned(),
                        query: Some("define".to_owned()),
                        window: CollectionWindowRequest {
                            after: None,
                            first: Some(10),
                        },
                    },
                },
            )
            .expect("search Relation candidates");
        let DatabaseReadValue::RelationCandidateWindow { candidates } = candidates.value else {
            panic!("Relation candidate window");
        };
        assert_eq!(candidates.items.len(), 1);
        assert_eq!(candidates.items[0].page_id, "page:relation-row");

        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:remove-relation-edge".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:relation-row".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "p_blocked0".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::PatchSet {
                                delta: nodex_core_contracts::database::DatabasePropertySetDelta::Relation {
                                    add_page_ids: Vec::new(),
                                    remove_edge_ids: vec![first_edge_id],
                                },
                            },
                        }],
                    }],
                },
            )
            .expect("remove Relation by source-owned edge handle");
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: "operation:clear-relation".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: "page:relation-row".to_owned(),
                                data_source_id: SOURCE_ID.to_owned(),
                                property_id: "p_blocked0".to_owned(),
                            },
                            edit: DatabasePropertyValueEdit::ClearManyRelation {
                                expected_value_revision: 2,
                            },
                        }],
                    }],
                },
            )
            .expect("clear Relation by revision fence");
        let remaining_edges = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT count(*) FROM data_source_relation_edges \
                         WHERE source_data_source_id = ?1 AND property_id = 'p_blocked0'",
                        [SOURCE_ID],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
            })
            .expect("read remaining Relation edges");
        assert_eq!(remaining_edges, 0);
    }

    fn read_view_window(
        module: &DatabaseModule,
        first: u32,
        after: Option<String>,
        group_scope: Option<DatabaseGroupScope>,
    ) -> Result<nodex_core_contracts::database::DatabaseViewWindow, CoreError> {
        let snapshot = module.read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ViewWindow {
                    target: DatabaseViewReadTarget::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                    window: CollectionWindowRequest {
                        after,
                        first: Some(first),
                    },
                    group_scope,
                },
            },
        )?;
        let DatabaseReadValue::ViewWindow { value } = snapshot.value else {
            panic!("view window read");
        };
        Ok(value)
    }

    fn read_list_window(
        module: &DatabaseModule,
        first: u32,
        after: Option<String>,
    ) -> Result<nodex_core_contracts::database::DatabaseListWindow, CoreError> {
        let snapshot = module.read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ListWindow {
                    target: DatabaseViewReadTarget::View {
                        view_id: VIEW_ID.to_owned(),
                    },
                    window: CollectionWindowRequest {
                        after,
                        first: Some(first),
                    },
                },
            },
        )?;
        let DatabaseReadValue::ListWindow { value } = snapshot.value else {
            panic!("List window read");
        };
        Ok(value)
    }

    fn list_projection_expectation(
        window: &nodex_core_contracts::database::DatabaseListWindow,
    ) -> DatabaseListProjectionExpectation {
        DatabaseListProjectionExpectation {
            scope_key: window.projection.scope.canonical_key.clone(),
            schema_version: window.projection.scope.schema_version,
            revision: window.projection.revision,
            covered_commit_seq: window.projection.covered_commit_seq,
            effect_hash: window.projection.effect_hash.clone(),
        }
    }

    fn configure_nested_status_list(module: &DatabaseModule, operation_id: &str) {
        let mut config = view_config(
            json!({ "kind": "group", "operator": "and", "children": [] }),
            Some("status"),
            &["status", "priority", "estimate", "tags"],
        );
        config["presentation"]["hierarchy"] =
            json!({ "showSubPages": true, "nestedSubPages": true });
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: vec![DatabaseIntent::PutView {
                        database_id: DATABASE_ID.to_owned(),
                        data_source_id: SOURCE_ID.to_owned(),
                        view_id: VIEW_ID.to_owned(),
                        expected_revision: 1,
                        name: "Nested status List".to_owned(),
                        layout: DatabaseViewLayout::List,
                        definition: view_definition(config),
                        is_default: true,
                        before_view_id: None,
                    }],
                },
            )
            .expect("configure nested status List");
    }

    fn read_view_context(
        module: &DatabaseModule,
        view_id: &str,
        first: u32,
        after: Option<String>,
        group_scope: Option<DatabaseGroupScope>,
    ) -> Result<nodex_core_contracts::database::DatabaseViewContext, CoreError> {
        let snapshot = module.read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ViewContext {
                    view_id: view_id.to_owned(),
                    window: CollectionWindowRequest {
                        after,
                        first: Some(first),
                    },
                    group_scope,
                },
            },
        )?;
        let DatabaseReadValue::ViewContext { value } = snapshot.value else {
            panic!("view context read");
        };
        assert_eq!(
            value.rows.authority.projection_revision,
            snapshot.commit_head
        );
        assert_eq!(value.projection.covered_commit_seq, snapshot.commit_head);
        assert_eq!(value.projection.scope.schema_version, 1);
        assert_eq!(
            value.projection.scope.scope,
            nodex_core_contracts::LocalProjectionScope::DatabaseView {
                project_id: "project-1".to_owned(),
                database_id: DATABASE_ID.to_owned(),
                data_source_id: SOURCE_ID.to_owned(),
                view_id: view_id.to_owned(),
            }
        );
        Ok(*value)
    }

    #[test]
    fn view_authority_uses_the_local_commit_head_after_a_physical_sequence_gap() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![GroupRowSpec {
                page_id: "page:sequence-gap-row",
                title: "Sequence gap row",
                value_json: Some("\"triage\""),
                rank_key: Some("a"),
            }],
        );

        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE sqlite_sequence SET seq = seq + 100 WHERE name = 'change_log'",
                    [],
                )?;
                Ok(())
            })
            .expect("advance the private physical sequence");
        LibraryModule::new("profile-1", "library-1", &kernel)
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "operation:sequence-gap-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: "page:sequence-gap".to_owned(),
                        document_id: "document:sequence-gap".to_owned(),
                        title: "Physical sequence gap".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("append a valid commit after the physical sequence gap");

        let (physical_head, semantic_head) = kernel
            .writer()
            .call(|connection| {
                Ok((
                    connection.query_row(
                        "SELECT COALESCE(MAX(seq), 0) FROM change_log",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    crate::infrastructure::local_commit::head(connection)?,
                ))
            })
            .expect("read diverged heads");
        assert!(physical_head > semantic_head);

        for read in [
            DatabaseRead::ViewWindow {
                target: DatabaseViewReadTarget::View {
                    view_id: VIEW_ID.to_owned(),
                },
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(10),
                },
                group_scope: None,
            },
            DatabaseRead::ViewGroups {
                target: DatabaseViewReadTarget::View {
                    view_id: VIEW_ID.to_owned(),
                },
            },
            DatabaseRead::ViewContext {
                view_id: VIEW_ID.to_owned(),
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(10),
                },
                group_scope: None,
            },
        ] {
            let snapshot = module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: DATABASE_CONTRACT_VERSION,
                        read,
                    },
                )
                .expect("read View authority");
            assert_eq!(snapshot.commit_head, semantic_head);
            match snapshot.value {
                DatabaseReadValue::ViewWindow { value } => {
                    assert_eq!(value.projection.covered_commit_seq, semantic_head);
                    assert_eq!(value.rows.authority.projection_revision, semantic_head);
                }
                DatabaseReadValue::ViewGroups { value } => {
                    assert_eq!(value.projection.covered_commit_seq, semantic_head);
                }
                DatabaseReadValue::ViewContext { value } => {
                    assert_eq!(value.projection.covered_commit_seq, semantic_head);
                    assert_eq!(value.groups.projection.covered_commit_seq, semantic_head);
                    assert_eq!(value.rows.authority.projection_revision, semantic_head);
                }
                _ => panic!("unexpected View read value"),
            }
        }
    }

    #[test]
    fn view_context_composes_descriptors_groups_rows_and_signed_move_authority() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:row-a",
                    title: "First",
                    value_json: Some("\"triage\""),
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:row-b",
                    title: "Second",
                    value_json: Some("\"done\""),
                    rank_key: Some("b"),
                },
            ],
        );

        let first = read_view_context(&module, VIEW_ID, 1, None, None).expect("first context");
        assert_eq!(first.database.database_id, DATABASE_ID);
        assert_eq!(first.data_source.data_source_id, SOURCE_ID);
        assert_eq!(first.view.view_id, VIEW_ID);
        assert_eq!(
            first
                .view
                .definition
                .presentation
                .group
                .as_ref()
                .map(|group| group.property_id.as_str()),
            Some("status")
        );
        assert!(
            first
                .properties
                .iter()
                .any(|property| property.property_id == "status")
        );
        assert_eq!(first.groups.total_rows, 2);
        assert_eq!(first.rows.items.len(), 1);
        assert!(first.rows.items[0].move_etag.starts_with("nxe1."));
        let first_etag = first.rows.items[0].move_etag.clone();
        let cursor = first
            .rows
            .next_cursor
            .clone()
            .expect("context continuation");

        let second = read_view_context(&module, VIEW_ID, 1, Some(cursor.clone()), None)
            .expect("next context");
        assert_eq!(second.rows.items.len(), 1);
        assert_ne!(
            first.rows.items[0].summary.page_id,
            second.rows.items[0].summary.page_id
        );
        assert!(second.rows.next_cursor.is_none());

        const OTHER_VIEW_ID: &str = "018f1000-0000-7000-8000-00000000000c";
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO database_views(\
                       id, database_block_id, data_source_id, name, layout, config_json, revision, \
                       rank_key, lifecycle, created_at, updated_at\
                     ) SELECT ?1, database_block_id, data_source_id, 'Other board', layout, \
                       config_json, revision, 'z', lifecycle, created_at, updated_at \
                     FROM database_views WHERE id = ?2",
                    params![OTHER_VIEW_ID, VIEW_ID],
                )?;
                Ok(())
            })
            .expect("seed another View");
        let cross_view = read_view_context(&module, OTHER_VIEW_ID, 1, Some(cursor.clone()), None)
            .expect_err("cursor cannot cross Views");
        assert_eq!(cross_view.code, CoreErrorCode::InvalidInput);

        let mut tampered = cursor.into_bytes();
        let last = tampered.last_mut().expect("non-empty cursor");
        *last = if *last == b'a' { b'b' } else { b'a' };
        let tampered = String::from_utf8(tampered).expect("ASCII cursor");
        let rejection = read_view_context(&module, VIEW_ID, 1, Some(tampered), None)
            .expect_err("tampered cursor");
        assert_eq!(rejection.code, CoreErrorCode::InvalidInput);

        let triage = read_view_context(
            &module,
            VIEW_ID,
            200,
            None,
            Some(DatabaseGroupScope::Path {
                group_key: Some("triage".to_owned()),
                subgroup_key: None,
            }),
        )
        .expect("group-scoped context");
        assert_eq!(triage.groups.total_rows, 2);
        assert_eq!(triage.rows.items.len(), 1);
        assert_eq!(
            triage.rows.items[0].summary.effective_group_key.as_deref(),
            Some("triage")
        );

        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE database_view_page_positions \
                     SET rank_key = 'z', revision = revision + 1, updated_at = ?1 \
                     WHERE view_id = ?2 AND page_block_id = 'page:row-a'",
                    params![NOW, VIEW_ID],
                )?;
                Ok(())
            })
            .expect("change the row position authority");
        let moved = read_view_context(
            &module,
            VIEW_ID,
            200,
            None,
            Some(DatabaseGroupScope::Path {
                group_key: Some("triage".to_owned()),
                subgroup_key: None,
            }),
        )
        .expect("context after position change");
        assert_ne!(moved.rows.items[0].move_etag, first_etag);

        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated) \
                     VALUES ('project-2', 'library-1', 'Unauthorized', ?1, ?1)",
                    [NOW],
                )?;
                Ok(())
            })
            .expect("seed an unrelated Project");
        let mut unauthorized_context = context();
        unauthorized_context.project_id = Some(ProjectId("project-2".to_owned()));
        let unauthorized = module
            .read(
                &unauthorized_context,
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewContext {
                        view_id: VIEW_ID.to_owned(),
                        window: Default::default(),
                        group_scope: None,
                    },
                },
            )
            .expect_err("another Project cannot read View context");
        assert_eq!(unauthorized.code, CoreErrorCode::Unauthorized);
    }

    #[test]
    fn group_scoped_windows_partition_the_view_and_agree_with_group_totals() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:row-a",
                    title: "Positioned triage",
                    value_json: Some("\"triage\""),
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:row-b",
                    title: "Valued but unpositioned",
                    value_json: Some("\"done\""),
                    rank_key: None,
                },
                GroupRowSpec {
                    page_id: "page:row-c",
                    title: "Empty string value",
                    value_json: Some("\"\""),
                    rank_key: None,
                },
                GroupRowSpec {
                    page_id: "page:row-d",
                    title: "Ranked without a grouping value",
                    value_json: None,
                    rank_key: Some("b"),
                },
                GroupRowSpec {
                    page_id: "page:row-e",
                    title: "Null value",
                    value_json: Some("null"),
                    rank_key: None,
                },
                GroupRowSpec {
                    page_id: "page:row-f",
                    title: "No value row",
                    value_json: None,
                    rank_key: None,
                },
                GroupRowSpec {
                    page_id: "page:row-g",
                    title: "List value",
                    value_json: Some("[\"x\"]"),
                    rank_key: None,
                },
                GroupRowSpec {
                    page_id: "page:row-h",
                    title: "Empty list value",
                    value_json: Some("[]"),
                    rank_key: None,
                },
            ],
        );

        let flat = read_view_window(&module, 200, None, None).expect("flat window");
        assert_eq!(flat.rows.items.len(), 8);
        let flat_ids = flat
            .rows
            .items
            .iter()
            .map(|row| row.page_id.clone())
            .collect::<std::collections::BTreeSet<_>>();

        let groups_snapshot = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewGroups {
                        target: DatabaseViewReadTarget::View {
                            view_id: VIEW_ID.to_owned(),
                        },
                    },
                },
            )
            .expect("view groups read");
        let DatabaseReadValue::ViewGroups { value: groups } = groups_snapshot.value else {
            panic!("view groups value");
        };
        assert!(groups.grouped);
        assert!(!groups.truncated);
        assert_eq!(groups.total_rows, 8);
        assert_eq!(
            groups
                .groups
                .iter()
                .map(|group| (group.group_key.clone(), group.total_rows))
                .collect::<Vec<_>>(),
            vec![
                (Some("[\"x\"]".to_owned()), 1),
                (Some("done".to_owned()), 1),
                (Some("triage".to_owned()), 1),
                (None, 5),
            ],
        );

        // Every row lands in exactly one scope, and scoped traversal covers the
        // flat window without duplicates.
        let mut scoped_ids = std::collections::BTreeSet::new();
        let mut scopes = groups
            .groups
            .iter()
            .filter_map(|group| group.group_key.clone())
            .map(|key| DatabaseGroupScope::Path {
                group_key: Some(key),
                subgroup_key: None,
            })
            .collect::<Vec<_>>();
        scopes.push(DatabaseGroupScope::Path {
            group_key: None,
            subgroup_key: None,
        });
        for scope in &scopes {
            let mut cursor = None;
            loop {
                let window = read_view_window(&module, 1, cursor.take(), Some(scope.clone()))
                    .expect("scoped window");
                for row in &window.rows.items {
                    assert!(
                        scoped_ids.insert(row.page_id.clone()),
                        "row {} appeared in two scopes",
                        row.page_id
                    );
                }
                match window.rows.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
        }
        assert_eq!(scoped_ids, flat_ids);

        // Scoped ordering: positioned rows first by rank, then unpositioned.
        let triage = read_view_window(
            &module,
            200,
            None,
            Some(DatabaseGroupScope::Path {
                group_key: Some("triage".to_owned()),
                subgroup_key: None,
            }),
        )
        .expect("triage window");
        assert_eq!(
            triage
                .rows
                .items
                .iter()
                .map(|row| row.page_id.as_str())
                .collect::<Vec<_>>(),
            vec!["page:row-a"],
        );
        assert!(
            triage
                .rows
                .items
                .iter()
                .all(|row| row.effective_group_key.as_deref() == Some("triage"))
        );

        // A cursor minted for one scope is a different query for another scope.
        let unassigned_first = read_view_window(
            &module,
            1,
            None,
            Some(DatabaseGroupScope::Path {
                group_key: None,
                subgroup_key: None,
            }),
        )
        .expect("unassigned first window");
        let unassigned_cursor = unassigned_first
            .rows
            .next_cursor
            .expect("unassigned continuation");
        let cross_scope = read_view_window(
            &module,
            1,
            Some(unassigned_cursor),
            Some(DatabaseGroupScope::Path {
                group_key: Some("triage".to_owned()),
                subgroup_key: None,
            }),
        )
        .expect_err("cross-scope cursor must be rejected");
        assert_eq!(cross_scope.code, CoreErrorCode::InvalidInput);

        // The discriminated read contract rejects coordinates that do not
        // belong to a read before they can reach Database authorization.
        let wrong_mode = serde_json::from_value::<DatabaseRead>(json!({
            "kind": "view_groups",
            "target": { "kind": "view", "view_id": VIEW_ID },
            "group_scope": {
                "kind": "path",
                "group_key": null,
                "subgroup_key": null
            }
        }));
        assert!(wrong_mode.is_err());
    }

    #[test]
    fn workflow_status_transitions_maintain_membership_completion_time() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![GroupRowSpec {
                page_id: "page:completion-transition",
                title: "Completion transition",
                value_json: Some("\"triage\""),
                rank_key: Some("a"),
            }],
        );
        let write_status = |operation_id: &str, revision: i64, option_id: &str| {
            module
                .apply(
                    &context(),
                    ModuleApplyRequest {
                        contract_version: DATABASE_CONTRACT_VERSION,
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch("epoch-1".to_owned()),
                        intent: vec![DatabaseIntent::EditPropertyValues {
                            edits: vec![DatabasePropertyValueMutation {
                                address: DatabasePagePropertyAddress {
                                    page_id: "page:completion-transition".to_owned(),
                                    data_source_id: SOURCE_ID.to_owned(),
                                    property_id: "status".to_owned(),
                                },
                                edit: DatabasePropertyValueEdit::Replace {
                                    expected_value_revision: revision,
                                    value: DatabasePropertyValueInput::Select {
                                        option_id: option_id.to_owned(),
                                    },
                                },
                            }],
                        }],
                    },
                )
                .expect("write workflow status");
        };
        let read_completed_at = || {
            kernel
                .readers()
                .read_default(|connection| {
                    connection
                        .query_row(
                            "SELECT completed_at FROM data_source_page_memberships \
                             WHERE page_block_id = 'page:completion-transition' \
                               AND removed_at IS NULL",
                            [],
                            |row| row.get::<_, Option<String>>(0),
                        )
                        .map_err(StoreError::from)
                })
                .expect("read completion timestamp")
        };

        write_status("operation:complete", 1, "ship");
        let completed_at = read_completed_at().expect("completion timestamp");
        assert!(completed_at.ends_with('Z'));
        write_status("operation:repeat-complete", 2, "ship");
        assert_eq!(read_completed_at().as_deref(), Some(completed_at.as_str()));
        write_status("operation:reopen", 3, "build");
        assert_eq!(read_completed_at(), None);
    }

    #[test]
    fn completed_ranges_and_recency_share_the_effective_view_projection() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:active",
                    title: "Active",
                    value_json: Some("\"triage\""),
                    rank_key: Some("c"),
                },
                GroupRowSpec {
                    page_id: "page:recently-completed",
                    title: "Recent",
                    value_json: Some("\"ship\""),
                    rank_key: Some("b"),
                },
                GroupRowSpec {
                    page_id: "page:older-completed",
                    title: "Older",
                    value_json: Some("\"ship\""),
                    rank_key: Some("a"),
                },
            ],
        );
        let today = chrono::Utc::now()
            .format("%Y-%m-%dT12:00:00.000Z")
            .to_string();
        let older = (chrono::Utc::now() - chrono::Duration::days(2))
            .format("%Y-%m-%dT12:00:00.000Z")
            .to_string();
        kernel
            .writer()
            .call(move |connection| {
                connection.execute(
                    "UPDATE data_source_page_memberships SET completed_at = ?1 \
                     WHERE page_block_id = 'page:recently-completed'",
                    [today],
                )?;
                connection.execute(
                    "UPDATE data_source_page_memberships SET completed_at = ?1 \
                     WHERE page_block_id = 'page:older-completed'",
                    [older],
                )?;
                Ok(())
            })
            .expect("seed completion times");

        let read_presented = |range, order_by_recency| {
            let snapshot = module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: DATABASE_CONTRACT_VERSION,
                        read: DatabaseRead::ViewWindow {
                            target: DatabaseViewReadTarget::PresentedView {
                                view_id: VIEW_ID.to_owned(),
                                preferences_override: preferences_override(
                                    DatabaseViewPresentationOverrideInput {
                                        group: Some(DatabaseViewGroupOverrideInput::None),
                                        subgroup: None,
                                        group_direction: None,
                                        completion: Some(DatabaseViewCompletionOverrideInput {
                                            range: Some(range),
                                            order_by_recency: Some(order_by_recency),
                                        }),
                                        hierarchy: None,
                                        display: None,
                                    },
                                ),
                            },
                            window: Default::default(),
                            group_scope: None,
                        },
                    },
                )
                .expect("read effective completion projection");
            let DatabaseReadValue::ViewWindow { value } = snapshot.value else {
                panic!("View window value");
            };
            value
                .rows
                .items
                .into_iter()
                .map(|row| row.page_id)
                .collect::<Vec<_>>()
        };

        assert_eq!(
            read_presented(DatabaseViewCompletedRangeInput::None, false),
            vec!["page:active"]
        );
        assert_eq!(
            read_presented(DatabaseViewCompletedRangeInput::PastDay, false),
            vec!["page:recently-completed", "page:active"]
        );
        assert_eq!(
            read_presented(DatabaseViewCompletedRangeInput::All, true),
            vec![
                "page:active",
                "page:recently-completed",
                "page:older-completed"
            ]
        );
    }

    #[test]
    fn subgroup_paths_and_finite_empty_groups_share_one_bounded_projection() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![
                GroupRowSpec {
                    page_id: "page:triage-high",
                    title: "Triage high",
                    value_json: Some("\"triage\""),
                    rank_key: Some("a"),
                },
                GroupRowSpec {
                    page_id: "page:triage-medium",
                    title: "Triage medium",
                    value_json: Some("\"triage\""),
                    rank_key: Some("b"),
                },
                GroupRowSpec {
                    page_id: "page:ship-high",
                    title: "Ship high",
                    value_json: Some("\"ship\""),
                    rank_key: Some("c"),
                },
            ],
        );
        kernel
            .writer()
            .call(|connection| {
                for (page_id, priority) in [
                    ("page:triage-high", "p1-high"),
                    ("page:triage-medium", "p2-medium"),
                    ("page:ship-high", "p1-high"),
                ] {
                    let membership_id = format!("membership:{page_id}");
                    connection.execute(
                        "INSERT INTO data_source_property_values(\
                           data_source_id, membership_id, property_id, value_type, value_json, \
                           revision, updated_at\
                         ) VALUES (?1, ?2, 'priority', 'select', ?3, 1, ?4)",
                        params![
                            SOURCE_ID,
                            membership_id,
                            serde_json::to_string(priority).expect("priority JSON"),
                            NOW
                        ],
                    )?;
                    connection.execute(
                        "UPDATE page_read_model SET database_values_json = \
                           json_set(database_values_json, '$.priority', ?1) \
                         WHERE page_block_id = ?2",
                        params![priority, page_id],
                    )?;
                }
                Ok(())
            })
            .expect("seed subgroup values");
        let presentation_override = preferences_override(DatabaseViewPresentationOverrideInput {
            subgroup: Some(DatabaseViewGroupOverrideInput::Property {
                property_id: "priority".to_owned(),
            }),
            display: Some(DatabaseViewLayoutDisplayOverrideInput {
                fields: None,
                property_order: None,
                show_empty_groups: Some(true),
                show_description: None,
            }),
            ..Default::default()
        });
        let groups_snapshot = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewGroups {
                        target: DatabaseViewReadTarget::PresentedView {
                            view_id: VIEW_ID.to_owned(),
                            preferences_override: presentation_override.clone(),
                        },
                    },
                },
            )
            .expect("read subgroup hierarchy");
        let DatabaseReadValue::ViewGroups { value: groups } = groups_snapshot.value else {
            panic!("View groups value");
        };
        assert!(groups.grouped);
        assert!(groups.subgrouped);
        assert!(!groups.truncated);
        assert_eq!(groups.group_limit, 200);
        assert_eq!(groups.total_groups, 20);
        assert_eq!(groups.groups.len(), 20);
        assert_eq!(
            groups
                .groups
                .iter()
                .find(|group| {
                    group.group_key.as_deref() == Some("triage")
                        && group.subgroup_key.as_deref() == Some("p1-high")
                })
                .map(|group| group.total_rows),
            Some(1)
        );
        assert_eq!(
            groups
                .groups
                .iter()
                .find(|group| {
                    group.group_key.as_deref() == Some("build")
                        && group.subgroup_key.as_deref() == Some("p3-low")
                })
                .map(|group| group.total_rows),
            Some(0)
        );

        let scoped = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::PresentedView {
                            view_id: VIEW_ID.to_owned(),
                            preferences_override: presentation_override.clone(),
                        },
                        window: Default::default(),
                        group_scope: Some(DatabaseGroupScope::Path {
                            group_key: Some("triage".to_owned()),
                            subgroup_key: Some("p2-medium".to_owned()),
                        }),
                    },
                },
            )
            .expect("read one subgroup path");
        let DatabaseReadValue::ViewWindow { value: scoped } = scoped.value else {
            panic!("View window value");
        };
        assert_eq!(scoped.rows.items.len(), 1);
        assert_eq!(scoped.rows.items[0].page_id, "page:triage-medium");
        assert_eq!(
            scoped.rows.items[0].effective_subgroup_key.as_deref(),
            Some("p2-medium")
        );

        kernel
            .writer()
            .call(|connection| {
                let options = |discriminator: char| {
                    (0..15)
                        .map(|index| {
                            let id = format!("o_{discriminator}{index:07}");
                            json!({ "id": id, "name": format!("Option {index}") })
                        })
                        .collect::<Vec<_>>()
                };
                connection.execute(
                    "INSERT INTO data_source_properties(\
                       data_source_id, id, name, value_type, config_json, rank_key, lifecycle, \
                       schema_revision, created_at, updated_at\
                     ) VALUES (?1, 'p_group000', 'Group', 'select', ?2, 'y1', 'active', 1, ?3, ?3)",
                    params![
                        SOURCE_ID,
                        json!({ "options": options('g') }).to_string(),
                        NOW
                    ],
                )?;
                connection.execute(
                    "INSERT INTO data_source_properties(\
                       data_source_id, id, name, value_type, config_json, rank_key, lifecycle, \
                       schema_revision, created_at, updated_at\
                     ) VALUES (?1, 'p_subgr000', 'Subgroup', 'select', ?2, 'y2', 'active', 1, ?3, ?3)",
                    params![
                        SOURCE_ID,
                        json!({ "options": options('s') }).to_string(),
                        NOW
                    ],
                )?;
                Ok(())
            })
            .expect("seed large custom option domains");
        let bounded_override = preferences_override(DatabaseViewPresentationOverrideInput {
            group: Some(DatabaseViewGroupOverrideInput::Property {
                property_id: "p_group000".to_owned(),
            }),
            subgroup: Some(DatabaseViewGroupOverrideInput::Property {
                property_id: "p_subgr000".to_owned(),
            }),
            display: Some(DatabaseViewLayoutDisplayOverrideInput {
                fields: None,
                property_order: None,
                show_empty_groups: Some(true),
                show_description: None,
            }),
            ..Default::default()
        });
        let bounded = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewGroups {
                        target: DatabaseViewReadTarget::PresentedView {
                            view_id: VIEW_ID.to_owned(),
                            preferences_override: bounded_override,
                        },
                    },
                },
            )
            .expect("read bounded empty group combinations");
        let DatabaseReadValue::ViewGroups { value: bounded } = bounded.value else {
            panic!("View groups value");
        };
        assert!(bounded.truncated);
        assert_eq!(bounded.group_limit, 200);
        // The 15×15 configured combinations plus the encountered empty path.
        assert_eq!(bounded.total_groups, 226);
        assert_eq!(bounded.groups.len(), 200);

        let invalid_override = preferences_override(DatabaseViewPresentationOverrideInput {
            subgroup: Some(DatabaseViewGroupOverrideInput::Property {
                property_id: "p_deleted0".to_owned(),
            }),
            ..Default::default()
        });
        let invalid = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewGroups {
                        target: DatabaseViewReadTarget::PresentedView {
                            view_id: VIEW_ID.to_owned(),
                            preferences_override: invalid_override,
                        },
                    },
                },
            )
            .expect("normalize stale subgroup property");
        let DatabaseReadValue::ViewGroups { value: invalid } = invalid.value else {
            panic!("View groups value");
        };
        assert!(!invalid.subgrouped);
    }

    #[test]
    fn ungrouped_views_reject_group_scopes_and_report_flat_totals() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
        let module = seed_grouped_fixture(
            &kernel,
            vec![GroupRowSpec {
                page_id: "page:row-a",
                title: "Only row",
                value_json: Some("\"triage\""),
                rank_key: Some("a"),
            }],
        );
        const FLAT_VIEW_ID: &str = "018f1000-0000-7000-8000-00000000000f";
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO database_views(\
                       id, database_block_id, data_source_id, name, layout, config_json, revision, \
                       rank_key, lifecycle, created_at, updated_at\
                     ) SELECT ?1, database_block_id, data_source_id, 'Flat', 'list', \
                       json_set(config_json, '$.presentation.group', json('null')), 1, 'z', 'active', \
                       created_at, updated_at \
                     FROM database_views WHERE id = ?2",
                    params![FLAT_VIEW_ID, VIEW_ID],
                )?;
                Ok(())
            })
            .expect("create ungrouped View");

        let scoped = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewWindow {
                        target: DatabaseViewReadTarget::View {
                            view_id: FLAT_VIEW_ID.to_owned(),
                        },
                        window: Default::default(),
                        group_scope: Some(DatabaseGroupScope::Path {
                            group_key: None,
                            subgroup_key: None,
                        }),
                    },
                },
            )
            .expect_err("ungrouped View must reject group scopes");
        assert_eq!(scoped.code, CoreErrorCode::InvalidInput);

        let groups_snapshot = module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewGroups {
                        target: DatabaseViewReadTarget::View {
                            view_id: FLAT_VIEW_ID.to_owned(),
                        },
                    },
                },
            )
            .expect("ungrouped view groups read");
        let DatabaseReadValue::ViewGroups { value: groups } = groups_snapshot.value else {
            panic!("ungrouped view groups value");
        };
        assert!(!groups.grouped);
        assert_eq!(groups.total_rows, 1);
        assert!(groups.groups.is_empty());
    }
}
