use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, SecondsFormat, Utc};
use nodex_core_contracts::automation::{PageRecurrenceConfig, PageReminderConfig};
use nodex_core_contracts::database::DatabaseReceipt;
use nodex_core_contracts::library::{
    LibraryBlockPropertyFieldMutation, LibraryBlockPropertyFieldResult,
    LibraryBlockPropertyMutation, LibraryBlockPropertyMutationError,
    LibraryBlockPropertyMutationErrorCode, LibraryBlockPropertyMutationOutcome,
    LibraryBlockPropertyMutationReceipt, LibraryCommitValue, LibraryReceipt,
};
use nodex_core_contracts::{BoundModuleContext, ModuleMutationReceipt, ModuleName, StoreEpoch};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::automation::{
    refresh_scheduled_index, validate_recurrence_input, validate_reminders_input,
    validate_timezone_input,
};
use crate::document::sha256;
use crate::infrastructure::durable_mutation::{self, OperationIdentity, ReceiptMetadata};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::mutation::{
    MutationEffects, library_commit_result, refresh_page_intrinsic_projection,
    resolve_library_mutation_authority, seal_mutation,
};
use super::{LibraryApplyOutcome, require_page_write_access};

const MODULE_NAME: &str = "library";
const MUTATION_KIND: &str = "property_batch";
const MAX_ID_LENGTH: usize = 512;
const MAX_PROPERTY_KEY_LENGTH: usize = 128;
const MAX_FIELDS: usize = 256;
const MAX_ACTOR_BYTES: usize = 1_000_000;

const INTRINSIC_SCHEDULE_KEYS: [&str; 4] = [
    "schedule.isAllDay",
    "schedule.timezone",
    "recurrence.config",
    "reminders.config",
];

#[derive(Clone)]
struct PageAuthority {
    page_id: String,
    library_id: String,
}

#[derive(Clone)]
struct ResolvedIntrinsic {
    path: String,
    page: PageAuthority,
    property_key: String,
    value: Value,
    value_type: &'static str,
    current_revision: i64,
    current_value: Value,
}

#[derive(Clone)]
enum ResolvedField {
    Intrinsic(ResolvedIntrinsic),
}

impl ResolvedField {
    fn path(&self) -> &str {
        match self {
            Self::Intrinsic(field) => &field.path,
        }
    }

    fn page_id(&self) -> &str {
        match self {
            Self::Intrinsic(field) => &field.page.page_id,
        }
    }

    fn current_revision(&self) -> i64 {
        match self {
            Self::Intrinsic(field) => field.current_revision,
        }
    }

    fn current_value(&self) -> &Value {
        match self {
            Self::Intrinsic(field) => &field.current_value,
        }
    }
}

enum PropertyApplyError {
    Rejected(LibraryBlockPropertyMutationError),
    Store(StoreError),
}

impl From<rusqlite::Error> for PropertyApplyError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Store(StoreError::from(error))
    }
}

impl From<StoreError> for PropertyApplyError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

struct MutationEvidence {
    request_hash: String,
    request_json: String,
    actor_json: String,
    target_page_ids: Vec<String>,
    target_page_ids_json: String,
    database_ids: Vec<String>,
    database_ids_json: String,
    field_intents_json: String,
    expected_revisions_json: String,
}

pub(super) struct PagePropertyApplySupplement<'a> {
    pub(super) core_request_hash: &'a str,
    pub(super) database_receipt: Option<&'a DatabaseReceipt>,
    pub(super) committed_at: Option<&'a str>,
}

pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    mutation: &LibraryBlockPropertyMutation,
    supplement: PagePropertyApplySupplement<'_>,
) -> Result<LibraryApplyOutcome, StoreError> {
    let PagePropertyApplySupplement {
        core_request_hash,
        database_receipt,
        committed_at,
    } = supplement;
    let compound_mutation = database_receipt.is_some();
    let now = committed_at
        .map(str::to_owned)
        .map_or_else(|| sqlite_now(connection), Ok)?;
    let actor_project_id = actor_project_id(connection, context, library_id)?;
    let evidence = match validate_request(
        library_id,
        &actor_project_id,
        store_epoch,
        operation_id,
        mutation,
    ) {
        Ok(evidence) => evidence,
        Err(PropertyApplyError::Rejected(error)) => {
            if compound_mutation {
                return Err(rejection_store_error(error));
            }
            let evidence = minimal_evidence(
                library_id,
                &actor_project_id,
                store_epoch,
                operation_id,
                mutation,
            )?;
            persist_property_ledger(
                connection,
                &actor_project_id,
                store_epoch,
                operation_id,
                mutation.client_session_id.as_deref(),
                &evidence,
                "rejected",
                &ledger_error_json(operation_id, &error),
                &json!({}),
                None,
                &now,
            )?;
            return finish_rejection(
                connection,
                context,
                store_epoch,
                operation_id,
                core_request_hash,
                error,
                &now,
            );
        }
        Err(PropertyApplyError::Store(error)) => return Err(error),
    };

    if let Some(collision) = read_ledger_collision(
        connection,
        &actor_project_id,
        store_epoch,
        operation_id,
        mutation.client_session_id.as_deref(),
        &evidence,
    )? {
        if compound_mutation {
            return Err(rejection_store_error(collision));
        }
        return finish_rejection(
            connection,
            context,
            store_epoch,
            operation_id,
            core_request_hash,
            collision,
            &now,
        );
    }

    let resolved = match resolve_fields(connection, context, library_id, operation_id, mutation) {
        Ok(fields) => fields,
        Err(PropertyApplyError::Rejected(error)) => {
            if compound_mutation {
                return Err(rejection_store_error(error));
            }
            persist_property_ledger(
                connection,
                &actor_project_id,
                store_epoch,
                operation_id,
                mutation.client_session_id.as_deref(),
                &evidence,
                "rejected",
                &ledger_error_json(operation_id, &error),
                &json!({}),
                None,
                &now,
            )?;
            return finish_rejection(
                connection,
                context,
                store_epoch,
                operation_id,
                core_request_hash,
                error,
                &now,
            );
        }
        Err(PropertyApplyError::Store(error)) => return Err(error),
    };

    let mut property_result = None;
    let result = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: MODULE_NAME,
            operation_id,
            intent_hash: core_request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            let field_results = resolved
                .iter()
                .map(|field| persist_field(connection, operation_id, field, &now))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| match error {
                    PropertyApplyError::Rejected(error) => {
                        StoreError::new(StoreErrorCode::RevisionConflict, error.message, false)
                    }
                    PropertyApplyError::Store(error) => error,
                })?;

            let block_metadata_revisions = bump_page_metadata_revisions(
                connection,
                operation_id,
                &evidence.target_page_ids,
                &now,
            )?;
            let intrinsic_pages = resolved
                .iter()
                .map(|field| match field {
                    ResolvedField::Intrinsic(field) => field.page.page_id.clone(),
                })
                .collect::<BTreeSet<_>>();
            for page_id in intrinsic_pages {
                refresh_page_intrinsic_projection(connection, &page_id, &now)?;
                connection.execute(
                    "UPDATE page_read_model SET projection_version = projection_version + 1, \
                       updated_at = ?1 WHERE page_block_id = ?2",
                    params![now, page_id],
                )?;
            }
            for page_id in block_metadata_revisions.keys() {
                refresh_scheduled_index(connection, page_id, &now)?;
            }

            let outcome = LibraryBlockPropertyMutationOutcome::Committed {
                fields: field_results.clone(),
                block_metadata_revisions: block_metadata_revisions.clone(),
            };
            let mut committed_revisions = field_results
                .iter()
                .map(|result| {
                    (
                        field_result_path(result).to_owned(),
                        field_result_revision(result),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            committed_revisions.extend(
                block_metadata_revisions
                    .iter()
                    .map(|(page_id, revision)| (format!("page:{page_id}:metadata"), *revision)),
            );
            let mut affected_database_ids = evidence.database_ids.clone();
            let mut affected_view_ids = Vec::new();
            let mut affected_parent_keys = Vec::new();
            if let Some(database_receipt) = database_receipt {
                committed_revisions.extend(database_receipt.committed_revisions.clone());
                affected_database_ids.extend(database_receipt.affected_database_ids.clone());
                affected_view_ids.extend(database_receipt.affected_view_ids.clone());
                affected_parent_keys.extend(
                    database_receipt
                        .affected_data_source_ids
                        .iter()
                        .map(|id| format!("data_source:{id}")),
                );
                affected_database_ids.sort();
                affected_database_ids.dedup();
                affected_view_ids.sort();
                affected_view_ids.dedup();
                affected_parent_keys.sort();
                affected_parent_keys.dedup();
            }
            let outcome_receipt = LibraryBlockPropertyMutationReceipt { outcome };
            let change_payload = change_payload(
                &evidence,
                &resolved,
                &field_results,
                &block_metadata_revisions,
            );
            property_result = Some((field_results.clone(), block_metadata_revisions.clone()));
            seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    page_file_entries: Vec::new(),
                    file_revisions: BTreeMap::new(),
                    file_mutation: Default::default(),
                    project_id: actor_project_id.clone(),
                    operation_kind: MUTATION_KIND,
                    change_kind: "block_mutation",
                    did_mutate: true,
                    created_target: None,
                    affected_parent_keys,
                    affected_block_ids: evidence.target_page_ids.clone(),
                    affected_page_ids: evidence.target_page_ids.clone(),
                    affected_database_ids,
                    affected_view_ids,
                    affected_document_ids: Vec::new(),
                    committed_revisions,
                    page_create: None,
                    page_copy: None,
                    canvas_mutation: None,
                    block_transfer: None,
                    block_transfer_undo: None,
                    page_relocation_undo: None,
                    structural_edit: None,
                    page_lifecycle: None,
                    block_property_mutation: Some(outcome_receipt),
                    agent_page_copy: None,
                    agent_create_pages: None,
                    agent_move_pages: None,
                    change_payload: Some(change_payload),
                    committed_at: now.clone(),
                },
            )
        },
    )?;
    let result = library_commit_result(connection, result)?;
    let (field_results, block_metadata_revisions) = property_result.ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::Internal,
            "Property mutation omitted its ledger result",
            false,
        )
    })?;
    // The property ledger still links its history row to the physical
    // change_log effect. The public receipt cursor is the semantic
    // LocalCommit sequence and may differ after a multi-effect mutation.
    let event_sequence = result.committed.event_sequence;
    let ledger_result = ledger_success_json(
        operation_id,
        library_id,
        &actor_project_id,
        store_epoch,
        &field_results,
        &block_metadata_revisions,
        result.committed.receipt.commit_seq,
        &now,
    );
    persist_property_ledger(
        connection,
        &actor_project_id,
        store_epoch,
        operation_id,
        mutation.client_session_id.as_deref(),
        &evidence,
        "committed",
        &ledger_result,
        &Value::Object(
            field_results
                .iter()
                .map(|field| {
                    (
                        field_result_path(field).to_owned(),
                        Value::from(field_result_revision(field)),
                    )
                })
                .collect(),
        ),
        Some(event_sequence),
        &now,
    )?;
    Ok(result)
}

fn validate_request(
    library_id: &str,
    actor_project_id: &str,
    store_epoch: &str,
    operation_id: &str,
    mutation: &LibraryBlockPropertyMutation,
) -> Result<MutationEvidence, PropertyApplyError> {
    validate_id(operation_id, "mutationId")?;
    if mutation.fields.is_empty() || mutation.fields.len() > MAX_FIELDS {
        return Err(rejected(
            LibraryBlockPropertyMutationErrorCode::InvalidPropertyMutationRequest,
            format!("Property mutation requires 1-{MAX_FIELDS} fields"),
            None,
            None,
            None,
        ));
    }
    if !mutation.actor.is_object() || canonical_json(&mutation.actor)?.len() > MAX_ACTOR_BYTES {
        return Err(rejected(
            LibraryBlockPropertyMutationErrorCode::InvalidPropertyMutationRequest,
            "Property mutation actor must be a bounded JSON object",
            None,
            None,
            None,
        ));
    }
    if let Some(client_session_id) = &mutation.client_session_id {
        validate_id(client_session_id, "clientSessionId")?;
    }
    let mut paths = BTreeSet::new();
    for field in &mutation.fields {
        let path = mutation_path(field)?;
        if !paths.insert(path.clone()) {
            return Err(rejected(
                LibraryBlockPropertyMutationErrorCode::InvalidPropertyMutationRequest,
                "Property mutation contains a duplicate field path",
                Some(path),
                None,
                None,
            ));
        }
        validate_field_shape(field, &path)?;
    }
    make_evidence(
        library_id,
        actor_project_id,
        store_epoch,
        operation_id,
        mutation,
        Vec::new(),
    )
    .map_err(PropertyApplyError::Store)
}

fn validate_field_shape(
    field: &LibraryBlockPropertyFieldMutation,
    path: &str,
) -> Result<(), PropertyApplyError> {
    match field {
        LibraryBlockPropertyFieldMutation::IntrinsicSet {
            block_id,
            property_key,
            expected_revision,
            ..
        } => {
            validate_id(block_id, "blockId")?;
            validate_property_id(property_key, "propertyKey")?;
            validate_revision(*expected_revision, path)?;
        }
    }
    Ok(())
}

fn resolve_fields(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    mutation: &LibraryBlockPropertyMutation,
) -> Result<Vec<ResolvedField>, PropertyApplyError> {
    let mut fields = mutation
        .fields
        .iter()
        .map(|field| resolve_intrinsic(connection, context, library_id, operation_id, field))
        .collect::<Result<Vec<_>, _>>()?;
    fields.sort_by(|left, right| left.path().cmp(right.path()));
    validate_schedule_after_mutation(connection, operation_id, &fields)?;
    Ok(fields)
}

fn resolve_intrinsic(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    mutation: &LibraryBlockPropertyFieldMutation,
) -> Result<ResolvedField, PropertyApplyError> {
    let LibraryBlockPropertyFieldMutation::IntrinsicSet {
        block_id,
        property_key,
        expected_revision,
        value,
    } = mutation;
    let path = mutation_path(mutation)?;
    let page = active_page(connection, library_id, operation_id, block_id, &path)?;
    authorize_page(connection, context, library_id, &page, &path)?;
    validate_intrinsic_value(property_key, value, &path)?;
    let current = connection
        .query_row(
            "SELECT value_type, value_json, revision FROM block_properties \
             WHERE block_id = ?1 AND library_id = ?2 AND property_key = ?3",
            params![block_id, page.library_id, property_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let (current_revision, current_value) = match current {
        Some((_value_type, value_json, revision)) => {
            let parsed = parse_canonical_json(&value_json, &path)?;
            (revision, parsed)
        }
        None => (0, Value::Null),
    };
    if current_revision != *expected_revision {
        return Err(rejected(
            LibraryBlockPropertyMutationErrorCode::PropertyConflict,
            format!("Property {path} is at revision {current_revision}, not {expected_revision}"),
            Some(path),
            Some(*expected_revision),
            Some(current_revision),
        ));
    }
    Ok(ResolvedField::Intrinsic(ResolvedIntrinsic {
        path,
        page,
        property_key: property_key.clone(),
        value: value.clone(),
        value_type: intrinsic_value_type(value),
        current_revision,
        current_value,
    }))
}

fn persist_field(
    connection: &Connection,
    operation_id: &str,
    field: &ResolvedField,
    now: &str,
) -> Result<LibraryBlockPropertyFieldResult, PropertyApplyError> {
    match field {
        ResolvedField::Intrinsic(field) => {
            let next_revision = field.current_revision + 1;
            let value_json = canonical_json(&field.value)?;
            let changes = if field.current_revision == 0 {
                connection.execute(
                    "INSERT INTO block_properties( \
                       block_id, library_id, property_key, value_type, value_json, revision, updated_at \
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                    params![
                        field.page.page_id,
                        field.page.library_id,
                        field.property_key,
                        field.value_type,
                        value_json,
                        now,
                    ],
                )?
            } else {
                connection.execute(
                    "UPDATE block_properties SET value_type = ?1, value_json = ?2, \
                       revision = revision + 1, updated_at = ?3 \
                     WHERE block_id = ?4 AND library_id = ?5 AND property_key = ?6 \
                       AND revision = ?7",
                    params![
                        field.value_type,
                        value_json,
                        now,
                        field.page.page_id,
                        field.page.library_id,
                        field.property_key,
                        field.current_revision,
                    ],
                )?
            };
            if changes != 1 {
                return Err(rejected(
                    LibraryBlockPropertyMutationErrorCode::PropertyConflict,
                    format!("Property {} changed while committing", field.path),
                    Some(field.path.clone()),
                    Some(field.current_revision),
                    Some(next_revision),
                ));
            }
            Ok(LibraryBlockPropertyFieldResult::Intrinsic {
                path: field.path.clone(),
                block_id: field.page.page_id.clone(),
                property_key: field.property_key.clone(),
                operation: "set".to_owned(),
                revision: next_revision,
                value: field.value.clone(),
            })
        }
    }
    .map_err(|error| match error {
        PropertyApplyError::Rejected(mut error) => {
            if error.message.is_empty() {
                error.message = format!("Property mutation {operation_id} was rejected");
            }
            PropertyApplyError::Rejected(error)
        }
        error => error,
    })
}

fn bump_page_metadata_revisions(
    connection: &Connection,
    operation_id: &str,
    page_ids: &[String],
    now: &str,
) -> Result<BTreeMap<String, i64>, StoreError> {
    let mut revisions = BTreeMap::new();
    for page_id in page_ids {
        let revision = connection
            .query_row(
                "UPDATE blocks SET metadata_revision = metadata_revision + 1, updated_at = ?1 \
                 WHERE id = ?2 AND type = 'page' AND lifecycle = 'active' \
                 RETURNING metadata_revision",
                params![now, page_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .ok_or_else(|| {
                StoreError::new(
                    StoreErrorCode::NotFound,
                    format!(
                        "Property mutation {operation_id} lost target Page {page_id} while committing"
                    ),
                    false,
                )
            })?;
        revisions.insert(page_id.clone(), revision);
    }
    Ok(revisions)
}

fn validate_schedule_after_mutation(
    connection: &Connection,
    operation_id: &str,
    fields: &[ResolvedField],
) -> Result<(), PropertyApplyError> {
    let pages = schedule_pages(fields);
    for page_id in pages {
        let first_path = fields
            .iter()
            .find(|field| field.page_id() == page_id && affects_schedule(field))
            .map(ResolvedField::path)
            .unwrap_or("schedule")
            .to_owned();
        let database_values = connection
            .prepare(
                "SELECT value.property_id, value.value_json \
                 FROM data_source_page_memberships membership \
                 JOIN data_source_property_values value \
                   ON value.data_source_id = membership.data_source_id \
                  AND value.membership_id = membership.id \
                 WHERE membership.page_block_id = ?1 AND membership.removed_at IS NULL \
                   AND value.property_id IN ('scheduled_start', 'scheduled_end')",
            )?
            .query_map([&page_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|(key, value)| parse_canonical_json(&value, &first_path).map(|value| (key, value)))
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        let mut intrinsic_values = connection
            .prepare(
                "SELECT property_key, value_json FROM block_properties \
                 WHERE block_id = ?1 AND property_key IN ( \
                   'schedule.isAllDay', 'schedule.timezone', \
                   'recurrence.config', 'reminders.config' \
                 )",
            )?
            .query_map([&page_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|(key, value)| parse_canonical_json(&value, &first_path).map(|value| (key, value)))
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        for field in fields.iter().filter(|field| field.page_id() == page_id) {
            let ResolvedField::Intrinsic(field) = field;
            if INTRINSIC_SCHEDULE_KEYS.contains(&field.property_key.as_str()) {
                intrinsic_values.insert(field.property_key.clone(), field.value.clone());
            }
        }
        validate_schedule_values(
            operation_id,
            &first_path,
            database_values.get("scheduled_start"),
            database_values.get("scheduled_end"),
            intrinsic_values.get("schedule.isAllDay"),
            intrinsic_values.get("schedule.timezone"),
            intrinsic_values.get("recurrence.config"),
            intrinsic_values.get("reminders.config"),
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_schedule_values(
    _operation_id: &str,
    path: &str,
    start: Option<&Value>,
    end: Option<&Value>,
    all_day: Option<&Value>,
    timezone: Option<&Value>,
    recurrence: Option<&Value>,
    reminders: Option<&Value>,
) -> Result<(), PropertyApplyError> {
    let start = optional_datetime(start, path)?;
    let end = optional_datetime(end, path)?;
    if start.is_some() != end.is_some() {
        return Err(property_value_invalid(
            path,
            "scheduled_start and scheduled_end must be set or cleared together",
        ));
    }
    if let (Some(start), Some(end)) = (start, end)
        && end <= start
    {
        return Err(property_value_invalid(
            path,
            "scheduled_end must be after scheduled_start",
        ));
    }
    let all_day = all_day.and_then(Value::as_bool).unwrap_or(false);
    if all_day && start.is_none() {
        return Err(property_value_invalid(
            path,
            "schedule.isAllDay requires a schedule range",
        ));
    }
    let timezone = match timezone {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => {
            return Err(property_value_invalid(
                path,
                "schedule.timezone must be a string or null",
            ));
        }
    };
    validate_timezone_input(timezone)
        .map_err(|error| property_value_invalid(path, &error.message))?;
    if let Some(value) = recurrence.filter(|value| !value.is_null()) {
        let recurrence = serde_json::from_value::<PageRecurrenceConfig>(value.clone())
            .map_err(|_| property_value_invalid(path, "recurrence.config is invalid"))?;
        validate_recurrence_input(&recurrence)
            .map_err(|error| property_value_invalid(path, &error.message))?;
    }
    let reminders = reminders
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let reminders = serde_json::from_value::<Vec<PageReminderConfig>>(reminders)
        .map_err(|_| property_value_invalid(path, "reminders.config is invalid"))?;
    validate_reminders_input(&reminders)
        .map_err(|error| property_value_invalid(path, &error.message))?;
    Ok(())
}

fn optional_datetime(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<DateTime<Utc>>, PropertyApplyError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let parsed = DateTime::parse_from_rfc3339(value)
                .map_err(|_| property_value_invalid(path, "scheduled datetime is invalid"))?
                .with_timezone(&Utc);
            if parsed.to_rfc3339_opts(SecondsFormat::Millis, true) != *value {
                return Err(property_value_invalid(
                    path,
                    "scheduled datetime must be canonical UTC RFC 3339",
                ));
            }
            Ok(Some(parsed))
        }
        Some(_) => Err(property_value_invalid(
            path,
            "scheduled datetime must be a string or null",
        )),
    }
}

fn schedule_pages(fields: &[ResolvedField]) -> BTreeSet<String> {
    fields
        .iter()
        .filter(|field| affects_schedule(field))
        .map(|field| field.page_id().to_owned())
        .collect()
}

fn affects_schedule(field: &ResolvedField) -> bool {
    let ResolvedField::Intrinsic(field) = field;
    INTRINSIC_SCHEDULE_KEYS.contains(&field.property_key.as_str())
}

fn validate_intrinsic_value(
    property_key: &str,
    value: &Value,
    path: &str,
) -> Result<(), PropertyApplyError> {
    if matches!(property_key, "agent.blocked" | "agent.status") {
        return Err(rejected(
            LibraryBlockPropertyMutationErrorCode::PropertyNotFound,
            format!("Intrinsic Property {path} is retired"),
            Some(path.to_owned()),
            None,
            None,
        ));
    }
    let valid = match property_key {
        "run.target" => value
            .as_str()
            .is_some_and(|value| matches!(value, "localProject" | "newWorktree" | "cloud")),
        "run.localPath" | "run.worktreePath" | "run.environmentPath" => {
            value.is_null() || value.is_string()
        }
        "run.baseBranch" => value.is_null() || value.as_str().is_some_and(valid_branch_name),
        "schedule.isAllDay" => value.is_boolean(),
        "schedule.timezone" => {
            if value.is_null() {
                true
            } else if let Some(value) = value.as_str() {
                validate_timezone_input(Some(value)).is_ok()
            } else {
                false
            }
        }
        "recurrence.config" => {
            value.is_null()
                || serde_json::from_value::<PageRecurrenceConfig>(value.clone())
                    .is_ok_and(|value| validate_recurrence_input(&value).is_ok())
        }
        "reminders.config" => serde_json::from_value::<Vec<PageReminderConfig>>(value.clone())
            .is_ok_and(|value| validate_reminders_input(&value).is_ok()),
        _ => true,
    };
    if valid {
        return Ok(());
    }
    Err(property_value_invalid(
        path,
        &format!("Intrinsic Property {path} is invalid"),
    ))
}

fn valid_branch_name(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty()
        || (!trimmed.starts_with('-')
            && !trimmed.chars().any(|character| {
                matches!(character, '~' | '^' | ':' | '?' | '*' | '[' | ']' | '\\')
                    || character.is_whitespace()
            }))
}

fn active_page(
    connection: &Connection,
    library_id: &str,
    _operation_id: &str,
    page_id: &str,
    path: &str,
) -> Result<PageAuthority, PropertyApplyError> {
    let row = connection
        .query_row(
            "SELECT block.type, block.lifecycle, block.library_id, page.block_id IS NOT NULL \
             FROM blocks block LEFT JOIN pages page ON page.block_id = block.id \
             WHERE block.id = ?1",
            [page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((block_type, block_lifecycle, page_library_id, is_page)) = row else {
        return Err(rejected(
            LibraryBlockPropertyMutationErrorCode::BlockNotFound,
            format!("Page Block does not exist: {page_id}"),
            Some(path.to_owned()),
            None,
            None,
        ));
    };
    if block_type != "page" || !is_page {
        return Err(rejected(
            LibraryBlockPropertyMutationErrorCode::BlockTypeMismatch,
            format!("Property mutations require a Page Block: {page_id}"),
            Some(path.to_owned()),
            None,
            None,
        ));
    }
    if block_lifecycle != "active" {
        return Err(rejected(
            LibraryBlockPropertyMutationErrorCode::BlockNotActive,
            format!("Page Block is not active: {page_id}"),
            Some(path.to_owned()),
            None,
            None,
        ));
    }
    if page_library_id != library_id {
        return Err(rejected(
            LibraryBlockPropertyMutationErrorCode::BlockNotFound,
            format!("Page Block is unavailable: {page_id}"),
            Some(path.to_owned()),
            None,
            None,
        ));
    }
    Ok(PageAuthority {
        page_id: page_id.to_owned(),
        library_id: page_library_id,
    })
}

fn authorize_page(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    page: &PageAuthority,
    path: &str,
) -> Result<(), PropertyApplyError> {
    let Some(requesting_project_id) = context.project_id.as_ref() else {
        return Ok(());
    };
    if require_page_write_access(
        connection,
        library_id,
        &requesting_project_id.0,
        &page.page_id,
    )
    .is_ok()
    {
        return Ok(());
    }
    Err(rejected(
        LibraryBlockPropertyMutationErrorCode::BlockNotFound,
        format!("Writable Page Block is unavailable: {}", page.page_id),
        Some(path.to_owned()),
        None,
        None,
    ))
}

fn actor_project_id(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
) -> Result<String, StoreError> {
    Ok(resolve_library_mutation_authority(connection, context, library_id)?.actor_project_id)
}

fn make_evidence(
    library_id: &str,
    actor_project_id: &str,
    store_epoch: &str,
    operation_id: &str,
    mutation: &LibraryBlockPropertyMutation,
    database_ids: Vec<String>,
) -> Result<MutationEvidence, StoreError> {
    let mut fields = mutation.fields.clone();
    fields.sort_by_key(|field| mutation_path(field).unwrap_or_default());
    let public_fields = fields
        .iter()
        .map(public_field_json)
        .collect::<Result<Vec<_>, _>>()?;
    let request = json!({
        "version": 3,
        "mutationId": operation_id,
        "accessContext": { "kind": "library" },
        "libraryId": library_id,
        "actorProjectId": actor_project_id,
        "storeEpoch": store_epoch,
        "clientSessionId": mutation.client_session_id,
        "actor": mutation.actor,
        "fields": public_fields,
    });
    let request = omit_null_member(request, "clientSessionId");
    let request_json = canonical_json(&request)?;
    let actor_json = canonical_json(&mutation.actor)?;
    let target_page_ids = fields
        .iter()
        .map(|field| match field {
            LibraryBlockPropertyFieldMutation::IntrinsicSet { block_id, .. } => block_id.clone(),
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let field_intents = fields
        .iter()
        .map(|field| {
            let path = mutation_path(field)?;
            Ok(match field {
                LibraryBlockPropertyFieldMutation::IntrinsicSet { .. } => json!({
                    "path": path,
                    "operation": "set",
                    "scope": "intrinsic",
                }),
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let expected_revisions = fields
        .iter()
        .map(|field| match field {
            LibraryBlockPropertyFieldMutation::IntrinsicSet {
                expected_revision, ..
            } => (mutation_path(field), *expected_revision),
        })
        .map(|(path, revision)| path.map(|path| (path, Value::from(revision))))
        .collect::<Result<Map<_, _>, _>>()?;
    Ok(MutationEvidence {
        request_hash: sha256(request_json.as_bytes()),
        request_json,
        actor_json,
        target_page_ids_json: serde_json::to_string(&target_page_ids)
            .map_err(|_| internal("Property target Page IDs cannot encode"))?,
        target_page_ids,
        database_ids_json: serde_json::to_string(&database_ids)
            .map_err(|_| internal("Property Database IDs cannot encode"))?,
        database_ids,
        field_intents_json: canonical_json(&Value::Array(field_intents))?,
        expected_revisions_json: canonical_json(&Value::Object(expected_revisions))?,
    })
}

fn minimal_evidence(
    library_id: &str,
    actor_project_id: &str,
    store_epoch: &str,
    operation_id: &str,
    mutation: &LibraryBlockPropertyMutation,
) -> Result<MutationEvidence, StoreError> {
    let mut evidence = make_evidence(
        library_id,
        actor_project_id,
        store_epoch,
        operation_id,
        mutation,
        Vec::new(),
    )?;
    if !mutation.actor.is_object() {
        evidence.actor_json = "{}".to_owned();
    }
    Ok(evidence)
}

fn public_field_json(field: &LibraryBlockPropertyFieldMutation) -> Result<Value, StoreError> {
    Ok(match field {
        LibraryBlockPropertyFieldMutation::IntrinsicSet {
            block_id,
            property_key,
            expected_revision,
            value,
        } => json!({
            "scope": "intrinsic",
            "blockId": block_id,
            "propertyKey": property_key,
            "operation": "set",
            "expectedRevision": expected_revision,
            "value": value,
        }),
    })
}

fn change_payload(
    evidence: &MutationEvidence,
    fields: &[ResolvedField],
    results: &[LibraryBlockPropertyFieldResult],
    block_metadata_revisions: &BTreeMap<String, i64>,
) -> Value {
    let resolved = fields
        .iter()
        .map(|field| (field.path(), field))
        .collect::<BTreeMap<_, _>>();
    json!({
        "version": 2,
        "requestHash": evidence.request_hash,
        "fieldPaths": results.iter().map(field_result_path).collect::<Vec<_>>(),
        "fieldChanges": results.iter().filter_map(|result| {
            let field = resolved.get(field_result_path(result))?;
            Some(json!({
                "path": field_result_path(result),
                "scope": field_result_scope(result),
                "operation": field_result_operation(result),
                "before": {
                    "exists": field.current_revision() > 0,
                    "revision": field.current_revision(),
                    "value": field.current_value(),
                },
                "after": {
                    "exists": true,
                    "revision": field_result_revision(result),
                    "value": field_result_value(result),
                },
            }))
        }).collect::<Vec<_>>(),
        "committedRevisions": results.iter().map(|result| {
            (field_result_path(result).to_owned(), Value::from(field_result_revision(result)))
        }).collect::<Map<_, _>>(),
        "blockMetadataRevisions": block_metadata_revisions,
    })
}

#[allow(clippy::too_many_arguments)]
fn persist_property_ledger(
    connection: &Connection,
    actor_project_id: &str,
    store_epoch: &str,
    operation_id: &str,
    client_session_id: Option<&str>,
    evidence: &MutationEvidence,
    outcome: &str,
    result: &Value,
    committed_revisions: &Value,
    change_log_seq: Option<i64>,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO block_mutations( \
           mutation_id, project_id, store_epoch, mutation_kind, actor_json, client_session_id, \
           request_hash, request_json, target_block_ids_json, affected_document_ids_json, \
           affected_database_block_ids_json, field_intents_json, expected_revisions_json, \
           outcome, result_json, committed_revisions_json, document_heads_json, \
           change_log_seq, recorded_at \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '[]', ?10, ?11, ?12, \
                   ?13, ?14, ?15, '{}', ?16, ?17)",
        params![
            operation_id,
            actor_project_id,
            store_epoch,
            MUTATION_KIND,
            evidence.actor_json,
            client_session_id,
            evidence.request_hash,
            evidence.request_json,
            evidence.target_page_ids_json,
            evidence.database_ids_json,
            evidence.field_intents_json,
            evidence.expected_revisions_json,
            outcome,
            canonical_json(result)?,
            canonical_json(committed_revisions)?,
            change_log_seq,
            now,
        ],
    )?;
    Ok(())
}

fn read_ledger_collision(
    connection: &Connection,
    actor_project_id: &str,
    store_epoch: &str,
    operation_id: &str,
    client_session_id: Option<&str>,
    evidence: &MutationEvidence,
) -> Result<Option<LibraryBlockPropertyMutationError>, StoreError> {
    let existing = connection
        .query_row(
            "SELECT project_id, store_epoch, mutation_kind, actor_json, client_session_id, \
               request_hash, request_json, target_block_ids_json, \
               affected_database_block_ids_json, field_intents_json, expected_revisions_json \
             FROM block_mutations WHERE mutation_id = ?1",
            [operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                ))
            },
        )
        .optional()?;
    let Some(existing) = existing else {
        return Ok(None);
    };
    let exact = existing.0 == actor_project_id
        && existing.1 == store_epoch
        && existing.2 == MUTATION_KIND
        && existing.3 == evidence.actor_json
        && existing.4.as_deref() == client_session_id
        && existing.5 == evidence.request_hash
        && existing.6 == evidence.request_json
        && existing.7 == evidence.target_page_ids_json
        && existing.8 == evidence.database_ids_json
        && existing.9 == evidence.field_intents_json
        && existing.10 == evidence.expected_revisions_json;
    Ok(Some(LibraryBlockPropertyMutationError {
        code: if exact {
            LibraryBlockPropertyMutationErrorCode::Unknown
        } else {
            LibraryBlockPropertyMutationErrorCode::MutationIdCollision
        },
        message: if exact {
            format!(
                "Mutation {operation_id} predates the native module receipt and cannot be replayed safely"
            )
        } else {
            format!("Mutation ID {operation_id} is already bound to another request")
        },
        retryable: false,
        field_path: None,
        expected_revision: None,
        actual_revision: None,
    }))
}

#[allow(clippy::too_many_arguments)]
fn ledger_success_json(
    operation_id: &str,
    library_id: &str,
    actor_project_id: &str,
    store_epoch: &str,
    fields: &[LibraryBlockPropertyFieldResult],
    block_metadata_revisions: &BTreeMap<String, i64>,
    commit_seq: i64,
    now: &str,
) -> Value {
    json!({
        "version": 3,
        "mutationId": operation_id,
        "accessContext": { "kind": "library" },
        "libraryId": library_id,
        "actorProjectId": actor_project_id,
        "storeEpoch": store_epoch,
        "duplicate": false,
        "fields": fields.iter().map(public_field_result_json).collect::<Vec<_>>(),
        "blockMetadataRevisions": block_metadata_revisions,
        "commitSeq": commit_seq,
        "committedAt": now,
    })
}

fn public_field_result_json(field: &LibraryBlockPropertyFieldResult) -> Value {
    match field {
        LibraryBlockPropertyFieldResult::Intrinsic {
            path,
            block_id,
            property_key,
            operation,
            revision,
            value,
        } => json!({
            "path": path,
            "scope": "intrinsic",
            "blockId": block_id,
            "propertyKey": property_key,
            "operation": operation,
            "revision": revision,
            "value": value,
        }),
    }
}

fn ledger_error_json(operation_id: &str, error: &LibraryBlockPropertyMutationError) -> Value {
    omit_null_members(json!({
        "code": property_error_code(error.code),
        "message": error.message,
        "retryable": error.retryable,
        "mutationId": operation_id,
        "fieldPath": error.field_path,
        "expectedRevision": error.expected_revision,
        "actualRevision": error.actual_revision,
    }))
}

fn finish_rejection(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    error: LibraryBlockPropertyMutationError,
    now: &str,
) -> Result<LibraryApplyOutcome, StoreError> {
    let commit_head =
        connection.query_row("SELECT COALESCE(MAX(seq), 0) FROM change_log", [], |row| {
            row.get::<_, i64>(0)
        })?;
    let commit_seq = crate::infrastructure::local_commit::head(connection)?;
    let committed = crate::ModuleWriterResult {
        value: LibraryCommitValue {
            page_file_entries: Vec::new(),
            file_mutation: Default::default(),
            affected_resource_ids: Vec::new(),
            page_create: None,
            page_copy: None,
            canvas_mutation: None,
            block_transfer: None,
            block_transfer_undo: None,
            page_relocation_undo: None,
            structural_edit: None,
            page_lifecycle: None,
            block_property_mutation: Some(LibraryBlockPropertyMutationReceipt {
                outcome: LibraryBlockPropertyMutationOutcome::Rejected { error },
            }),
            agent_page_copy: None,
            agent_create_pages: None,
            agent_move_pages: None,
        },
        receipt: LibraryReceipt {
            mutation: ModuleMutationReceipt {
                operation_id: operation_id.to_owned(),
                duplicate: false,
            },
            operation_kind: MUTATION_KIND.to_owned(),
            did_mutate: false,
            created_target: None,
            affected_parent_keys: Vec::new(),
            affected_page_ids: Vec::new(),
            affected_database_ids: Vec::new(),
            affected_view_ids: Vec::new(),
            committed_revisions: BTreeMap::new(),
            commit_seq,
            committed_at: now.to_owned(),
        },
        commit_seq,
        event_sequence: commit_head,
        store_epoch: StoreEpoch(store_epoch.to_owned()),
    };
    durable_mutation::record_no_op(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: MODULE_NAME,
            operation_id,
            context,
            store_epoch,
            intent_hash: request_hash,
            committed_at: now,
        },
        &committed,
        ReceiptMetadata {
            operation_kind: MUTATION_KIND,
            event_sequence: None,
            committed_at: now,
        },
    )?;
    Ok(LibraryApplyOutcome {
        committed,
        event: None,
    })
}

fn rejection_store_error(error: LibraryBlockPropertyMutationError) -> StoreError {
    let code = match error.code {
        LibraryBlockPropertyMutationErrorCode::MutationIdCollision => {
            StoreErrorCode::IdempotencyKeyReused
        }
        LibraryBlockPropertyMutationErrorCode::ProjectNotFound
        | LibraryBlockPropertyMutationErrorCode::BlockNotFound
        | LibraryBlockPropertyMutationErrorCode::PropertyNotFound => StoreErrorCode::NotFound,
        LibraryBlockPropertyMutationErrorCode::PropertyConflict => StoreErrorCode::RevisionConflict,
        LibraryBlockPropertyMutationErrorCode::PropertyValueCorrupt => StoreErrorCode::StoreCorrupt,
        LibraryBlockPropertyMutationErrorCode::Unknown => StoreErrorCode::Internal,
        _ => StoreErrorCode::InvalidInput,
    };
    StoreError::new(code, error.message, error.retryable)
}

fn mutation_path(field: &LibraryBlockPropertyFieldMutation) -> Result<String, StoreError> {
    Ok(match field {
        LibraryBlockPropertyFieldMutation::IntrinsicSet {
            block_id,
            property_key,
            ..
        } => format!(
            "intrinsic/{}/{}",
            encode_uri_component(block_id),
            encode_uri_component(property_key)
        ),
    })
}

fn encode_uri_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(*byte));
            continue;
        }
        encoded.push('%');
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn field_result_path(field: &LibraryBlockPropertyFieldResult) -> &str {
    match field {
        LibraryBlockPropertyFieldResult::Intrinsic { path, .. } => path,
    }
}

fn field_result_revision(field: &LibraryBlockPropertyFieldResult) -> i64 {
    match field {
        LibraryBlockPropertyFieldResult::Intrinsic { revision, .. } => *revision,
    }
}

fn field_result_scope(field: &LibraryBlockPropertyFieldResult) -> &'static str {
    match field {
        LibraryBlockPropertyFieldResult::Intrinsic { .. } => "intrinsic",
    }
}

fn field_result_operation(field: &LibraryBlockPropertyFieldResult) -> &str {
    match field {
        LibraryBlockPropertyFieldResult::Intrinsic { operation, .. } => operation,
    }
}

fn field_result_value(field: &LibraryBlockPropertyFieldResult) -> &Value {
    match field {
        LibraryBlockPropertyFieldResult::Intrinsic { value, .. } => value,
    }
}

fn intrinsic_value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) | Value::Object(_) => "json",
    }
}

fn parse_canonical_json(value: &str, path: &str) -> Result<Value, PropertyApplyError> {
    let parsed = serde_json::from_str::<Value>(value).map_err(|_| {
        rejected(
            LibraryBlockPropertyMutationErrorCode::PropertyValueCorrupt,
            format!("Stored Property {path} is not valid JSON"),
            Some(path.to_owned()),
            None,
            None,
        )
    })?;
    if canonical_json(&parsed)? == value {
        return Ok(parsed);
    }
    Err(rejected(
        LibraryBlockPropertyMutationErrorCode::PropertyValueCorrupt,
        format!("Stored Property {path} is not canonical JSON"),
        Some(path.to_owned()),
        None,
        None,
    ))
}

fn canonical_json(value: &Value) -> Result<String, StoreError> {
    serde_json::to_string(&canonical_value(value))
        .map_err(|_| internal("Property JSON cannot be encoded"))
}

fn canonical_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_value).collect()),
        Value::Object(input) => {
            let mut output = Map::new();
            let mut keys = input.keys().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let Some(value) = input.get(key) {
                    output.insert(key.clone(), canonical_value(value));
                }
            }
            Value::Object(output)
        }
        value => value.clone(),
    }
}

fn omit_null_member(mut value: Value, key: &str) -> Value {
    if let Some(object) = value.as_object_mut()
        && object.get(key).is_some_and(Value::is_null)
    {
        object.remove(key);
    }
    value
}

fn omit_null_members(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
    value
}

fn validate_id(value: &str, label: &str) -> Result<(), PropertyApplyError> {
    if !value.is_empty() && value.len() <= MAX_ID_LENGTH && value.trim() == value {
        return Ok(());
    }
    Err(rejected(
        LibraryBlockPropertyMutationErrorCode::InvalidPropertyMutationRequest,
        format!("{label} must be a canonical non-empty string"),
        None,
        None,
        None,
    ))
}

fn validate_property_id(value: &str, label: &str) -> Result<(), PropertyApplyError> {
    if !value.is_empty() && value.len() <= MAX_PROPERTY_KEY_LENGTH && value.trim() == value {
        return Ok(());
    }
    Err(rejected(
        LibraryBlockPropertyMutationErrorCode::InvalidPropertyMutationRequest,
        format!("{label} must be a canonical Property identity"),
        None,
        None,
        None,
    ))
}

fn validate_revision(revision: i64, path: &str) -> Result<(), PropertyApplyError> {
    if revision >= 0 {
        return Ok(());
    }
    Err(rejected(
        LibraryBlockPropertyMutationErrorCode::InvalidPropertyMutationRequest,
        "expectedRevision must be non-negative",
        Some(path.to_owned()),
        None,
        None,
    ))
}

fn property_value_invalid(path: &str, message: &str) -> PropertyApplyError {
    rejected(
        LibraryBlockPropertyMutationErrorCode::PropertyValueInvalid,
        message,
        Some(path.to_owned()),
        None,
        None,
    )
}

fn rejected(
    code: LibraryBlockPropertyMutationErrorCode,
    message: impl Into<String>,
    field_path: Option<String>,
    expected_revision: Option<i64>,
    actual_revision: Option<i64>,
) -> PropertyApplyError {
    PropertyApplyError::Rejected(LibraryBlockPropertyMutationError {
        code,
        message: message.into(),
        retryable: false,
        field_path,
        expected_revision,
        actual_revision,
    })
}

fn property_error_code(code: LibraryBlockPropertyMutationErrorCode) -> &'static str {
    match code {
        LibraryBlockPropertyMutationErrorCode::InvalidPropertyMutationRequest => {
            "invalid_property_mutation_request"
        }
        LibraryBlockPropertyMutationErrorCode::MutationIdCollision => "mutation_id_collision",
        LibraryBlockPropertyMutationErrorCode::ProjectNotFound => "project_not_found",
        LibraryBlockPropertyMutationErrorCode::BlockNotFound => "block_not_found",
        LibraryBlockPropertyMutationErrorCode::BlockNotActive => "block_not_active",
        LibraryBlockPropertyMutationErrorCode::BlockTypeMismatch => "block_type_mismatch",
        LibraryBlockPropertyMutationErrorCode::PropertyNotFound => "property_not_found",
        LibraryBlockPropertyMutationErrorCode::PropertyTypeMismatch => "property_type_mismatch",
        LibraryBlockPropertyMutationErrorCode::PropertyValueInvalid => "property_value_invalid",
        LibraryBlockPropertyMutationErrorCode::PropertyValueCorrupt => "property_value_corrupt",
        LibraryBlockPropertyMutationErrorCode::PropertyConflict => "property_conflict",
        LibraryBlockPropertyMutationErrorCode::Unknown => "unknown",
    }
}

fn sqlite_now(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(StoreError::from)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}
