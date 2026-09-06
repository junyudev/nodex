use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use nodex_core_contracts::document::{
    DocumentSemanticCommand, OwnedDocumentContract, OwnedDocumentIntent,
};
use nodex_core_contracts::library::{LibraryPageDraftProjection, LibraryRead, LibraryReadValue};
use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch, VersionedModuleContract};
use nodex_core_protocol::client::CoreClient;
use nodex_core_protocol::{OwnedDocumentApplyRequest, ResponseEnvelope};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use similar::{Algorithm, DiffTag, TextDiff};

use crate::error::{CliError, CliErrorCode};
use crate::runtime::{
    CommandOutput, map_client_error, map_core_error, resolve_page_selector, selected_project,
    unwrap_library,
};

const DRAFT_SCHEMA_VERSION: u32 = 1;
const METADATA_PROJECTION_VERSION: u32 = 2;
const MAX_MANIFEST_BYTES: usize = 128 * 1024;
const MAX_APPLY_STATE_BYTES: usize =
    nodex_core_protocol::MAX_DOCUMENT_JSON_REQUEST_BYTES + 16 * 1024 * 1024;
const MAX_DRAFT_BODY_BYTES: usize = crate::page_mutation::MAX_BODY_INPUT_BYTES;
const MAX_DRAFT_LINES: usize = 200_000;
const MAX_SEMANTIC_COMMANDS: usize = 512;
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const READ_ONLY_DIRECTORY_MODE: u32 = 0o500;
const PRIVATE_FILE_MODE: u32 = 0o600;
const READ_ONLY_FILE_MODE: u32 = 0o400;
const MANIFEST_FILE: &str = "draft.json";
const BASE_DIRECTORY: &str = "base";
const WORK_DIRECTORY: &str = "work";
const META_FILE: &str = "meta.yaml";
const BODY_FILE: &str = "body.nested.md";
const APPLY_FILE: &str = "apply.json";
const APPLY_TEMP_FILE: &str = ".apply.tmp";

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct DraftWorkspaceResult {
    draft_id: String,
    #[schema(value_type = String)]
    directory: PathBuf,
    page_id: String,
    project_id: String,
    page_files: nodex_core_contracts::library::LibraryPageFileInventory,
    files: Vec<&'static str>,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct DraftDiffResult {
    draft_id: String,
    page_id: String,
    #[schema(value_type = String)]
    directory: PathBuf,
    changed: bool,
    title: DraftTitleDiff,
    body: DraftBodyDiff,
    apply_status: Option<&'static str>,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
struct DraftTitleDiff {
    changed: bool,
    base: String,
    work: String,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
struct DraftBodyDiff {
    changed: bool,
    base_sha256: String,
    work_sha256: String,
    added_lines: usize,
    removed_lines: usize,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct DraftDiscardResult {
    draft_id: String,
    page_id: String,
    #[schema(value_type = String)]
    directory: PathBuf,
    discarded: bool,
}
#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct DraftApplicationIdentity<'a> {
    draft_id: &'a str,
    #[schema(value_type = String)]
    directory: &'a Path,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct DraftNoChangeResult {
    draft_id: String,
    page_id: String,
    #[schema(value_type = String)]
    directory: PathBuf,
    outcome: &'static str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftPaths {
    base_meta: String,
    base_body: String,
    work_meta: String,
    work_body: String,
    apply_state: String,
}

impl Default for DraftPaths {
    fn default() -> Self {
        Self {
            base_meta: format!("{BASE_DIRECTORY}/{META_FILE}"),
            base_body: format!("{BASE_DIRECTORY}/{BODY_FILE}"),
            work_meta: format!("{WORK_DIRECTORY}/{META_FILE}"),
            work_body: format!("{WORK_DIRECTORY}/{BODY_FILE}"),
            apply_state: APPLY_FILE.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftManifest {
    schema_version: u32,
    metadata_projection_version: u32,
    draft_id: String,
    profile_id: String,
    project_id: String,
    page_id: String,
    store_epoch: String,
    created_at: String,
    base_meta_sha256: String,
    base_body_sha256: String,
    normalized_base_metadata_sha256: String,
    base_title_etag: String,
    base_body_etag: String,
    base_page_files: nodex_core_contracts::library::LibraryPageFileInventory,
    paths: DraftPaths,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DraftApplyStatus {
    Pending,
    Applied,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftApplyState {
    schema_version: u32,
    status: DraftApplyStatus,
    operation_id: String,
    accepted_title_sha256: String,
    accepted_body_sha256: String,
    document_id: String,
    generation: i64,
    expected_head_seq: i64,
    commands: Vec<DocumentSemanticCommand>,
    result: Option<Value>,
}

#[derive(Debug)]
struct DraftLayout {
    root: PathBuf,
    manifest: DraftManifest,
    base_meta: Vec<u8>,
    base_body: Vec<u8>,
    apply_state: Option<DraftApplyState>,
}

#[derive(Debug)]
struct LoadedDraft {
    layout: DraftLayout,
    base_metadata: crate::meta_yaml::PageMetaV2,
    work_metadata: crate::meta_yaml::PageMetaV2,
    base_body: String,
    work_body: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ChangedRange {
    old_start: usize,
    old_end: usize,
    new_start: usize,
    new_end: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CompiledPatch {
    old_fragment: String,
    new_fragment: String,
    current_start: usize,
    current_end: usize,
}

pub(crate) fn create(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    page_selector: &str,
    output: &Path,
) -> Result<CommandOutput, CliError> {
    let project = selected_project(client, explicit_project, cwd)?;
    let page_id = resolve_page_selector(client, &project.id, page_selector)?;
    let projection = read_projection(client, &project.id, &page_id)?;
    if projection.metadata_projection_version != METADATA_PROJECTION_VERSION {
        return Err(unsafe_path(
            output,
            "Core returned an unsupported draft metadata projection",
        ));
    }
    let base_metadata = crate::meta_yaml::parse(projection.meta_yaml.as_bytes())?;
    if base_metadata.id != page_id {
        return Err(CliError::new(
            CliErrorCode::PageIdMismatch,
            "Core draft metadata does not match the selected Page",
        )
        .at_path("id"));
    }
    crate::page_mutation::validate_title(base_metadata.title_markdown.clone())
        .map_err(draft_markdown_error)?;
    decode_body(
        projection.body_nested_markdown.as_bytes(),
        &output.join(BODY_FILE),
    )?;

    let destination = draft_destination(output)?;
    let draft_id = random_uuid_v4()?;
    let staging = destination
        .parent
        .join(format!(".{}.{}.tmp", destination.name, draft_id));
    create_private_directory(&staging)?;
    let result = (|| {
        let base_root = staging.join(BASE_DIRECTORY);
        let work_root = staging.join(WORK_DIRECTORY);
        create_private_directory(&base_root)?;
        create_private_directory(&work_root)?;

        let manifest = DraftManifest {
            schema_version: DRAFT_SCHEMA_VERSION,
            metadata_projection_version: METADATA_PROJECTION_VERSION,
            draft_id: draft_id.clone(),
            profile_id: client.handshake.generation.profile_id.clone(),
            project_id: project.id.clone(),
            page_id: page_id.clone(),
            store_epoch: projection.store_epoch.clone(),
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            base_meta_sha256: digest(projection.meta_yaml.as_bytes()),
            base_body_sha256: digest(projection.body_nested_markdown.as_bytes()),
            normalized_base_metadata_sha256: normalized_metadata_hash(&base_metadata)?,
            base_title_etag: projection.title_etag.clone(),
            base_body_etag: projection.body_etag.clone(),
            base_page_files: projection.page_files,
            paths: DraftPaths::default(),
        };
        let mut manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(internal)?;
        manifest_bytes.push(b'\n');
        write_new_file(
            &staging.join(MANIFEST_FILE),
            &manifest_bytes,
            READ_ONLY_FILE_MODE,
        )?;
        write_new_file(
            &base_root.join(META_FILE),
            projection.meta_yaml.as_bytes(),
            READ_ONLY_FILE_MODE,
        )?;
        write_new_file(
            &base_root.join(BODY_FILE),
            projection.body_nested_markdown.as_bytes(),
            READ_ONLY_FILE_MODE,
        )?;
        write_new_file(
            &work_root.join(META_FILE),
            projection.meta_yaml.as_bytes(),
            PRIVATE_FILE_MODE,
        )?;
        write_new_file(
            &work_root.join(BODY_FILE),
            projection.body_nested_markdown.as_bytes(),
            PRIVATE_FILE_MODE,
        )?;
        fs::set_permissions(
            &base_root,
            fs::Permissions::from_mode(READ_ONLY_DIRECTORY_MODE),
        )
        .map_err(|error| path_error(&base_root, error))?;
        sync_directory(&base_root)?;
        sync_directory(&work_root)?;
        sync_directory(&staging)?;

        if destination.remove_empty {
            fs::remove_dir(&destination.path)
                .map_err(|error| path_error(&destination.path, error))?;
        }
        fs::rename(&staging, &destination.path)
            .map_err(|error| path_error(&destination.path, error))?;
        sync_directory(&destination.parent)?;
        Ok(manifest)
    })();
    if result.is_err() {
        let _ = remove_generated_tree(&staging);
    }
    let manifest = result?;
    serde_json::to_value(DraftWorkspaceResult {
        draft_id: manifest.draft_id,
        directory: destination.path,
        page_id: manifest.page_id,
        project_id: manifest.project_id,
        page_files: manifest.base_page_files,
        files: vec![
            MANIFEST_FILE,
            "base/meta.yaml",
            "base/body.nested.md",
            "work/meta.yaml",
            "work/body.nested.md",
        ],
    })
    .map(CommandOutput::Json)
    .map_err(internal)
}

pub(crate) fn diff(directory: &Path) -> Result<CommandOutput, CliError> {
    let loaded = load_draft(directory)?;
    let metadata_change =
        crate::meta_yaml::compare_draft_metadata(&loaded.base_metadata, &loaded.work_metadata)?;
    let body = body_diff_summary(&loaded.base_body, &loaded.work_body);
    serde_json::to_value(DraftDiffResult {
        draft_id: loaded.layout.manifest.draft_id,
        page_id: loaded.layout.manifest.page_id,
        directory: loaded.layout.root,
        changed: metadata_change.title.is_some() || body.changed,
        title: DraftTitleDiff {
            changed: metadata_change.title.is_some(),
            base: loaded.base_metadata.title_markdown,
            work: loaded.work_metadata.title_markdown,
        },
        body,
        apply_status: loaded
            .layout
            .apply_state
            .as_ref()
            .map(|state| match state.status {
                DraftApplyStatus::Pending => "pending",
                DraftApplyStatus::Applied => "applied",
            }),
    })
    .map(CommandOutput::Json)
    .map_err(internal)
}

pub(crate) fn apply(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    directory: &Path,
) -> Result<CommandOutput, CliError> {
    let loaded = load_draft(directory)?;
    validate_manifest_client(client, explicit_project, cwd, &loaded.layout.manifest)?;
    let metadata_change =
        crate::meta_yaml::compare_draft_metadata(&loaded.base_metadata, &loaded.work_metadata)?;
    let accepted_title =
        crate::page_mutation::validate_title(loaded.work_metadata.title_markdown.clone())
            .map_err(draft_markdown_error)?;
    let operation_id = draft_operation_id(&loaded, &accepted_title)?;

    if let Some(state) = &loaded.layout.apply_state {
        validate_apply_state(&loaded, state, &operation_id, &accepted_title)?;
        let current = read_projection(
            client,
            &loaded.layout.manifest.project_id,
            &loaded.layout.manifest.page_id,
        )?;
        if current.document_id != state.document_id
            || current.document_generation != state.generation
        {
            return Err(draft_conflict(
                "draft apply marker no longer belongs to the selected Page document",
            ));
        }
        return submit_apply_state(client, &loaded, state.clone());
    }

    let title_changed = metadata_change.title.is_some();
    let body_changed = loaded.base_body != loaded.work_body;
    if !title_changed && !body_changed {
        return serde_json::to_value(DraftNoChangeResult {
            draft_id: loaded.layout.manifest.draft_id,
            page_id: loaded.layout.manifest.page_id,
            directory: loaded.layout.root,
            outcome: "no_change",
        })
        .map(CommandOutput::Json)
        .map_err(internal);
    }

    let current = read_projection(
        client,
        &loaded.layout.manifest.project_id,
        &loaded.layout.manifest.page_id,
    )?;
    let mut commands = Vec::new();
    if title_changed {
        if current.title_etag != loaded.layout.manifest.base_title_etag {
            return Err(draft_conflict(
                "Page title changed after the draft was created",
            ));
        }
        commands.push(DocumentSemanticCommand::SetTitle {
            inline_markdown: accepted_title.clone(),
            expected_etag: loaded.layout.manifest.base_title_etag.clone(),
        });
    }
    if body_changed {
        let remaining = MAX_SEMANTIC_COMMANDS.saturating_sub(commands.len());
        commands.extend(compile_body_commands(&loaded, &current, remaining)?);
    }
    let mut state = DraftApplyState {
        schema_version: DRAFT_SCHEMA_VERSION,
        status: DraftApplyStatus::Pending,
        operation_id,
        accepted_title_sha256: digest(accepted_title.as_bytes()),
        accepted_body_sha256: digest(loaded.work_body.as_bytes()),
        document_id: current.document_id.clone(),
        generation: current.document_generation,
        expected_head_seq: current.document_head_seq,
        commands,
        result: None,
    };
    if document_apply_request_size(&loaded.layout.manifest, &state)?
        > nodex_core_protocol::MAX_DOCUMENT_JSON_REQUEST_BYTES
    {
        state
            .commands
            .retain(|command| matches!(command, DocumentSemanticCommand::SetTitle { .. }));
        if body_changed {
            state
                .commands
                .extend(guarded_replacement(&loaded, &current)?);
        }
    }
    if document_apply_request_size(&loaded.layout.manifest, &state)?
        > nodex_core_protocol::MAX_DOCUMENT_JSON_REQUEST_BYTES
    {
        return Err(CliError::new(
            CliErrorCode::InvalidInput,
            "draft work cannot be encoded within the Document request bound",
        ));
    }
    write_apply_state(&loaded.layout.root, &state)?;
    submit_apply_state(client, &loaded, state)
}

pub(crate) fn discard(directory: &Path) -> Result<CommandOutput, CliError> {
    let layout = load_layout(directory)?;
    unseal_directory(&layout.root.join(BASE_DIRECTORY))?;
    unseal_directory(&layout.root.join(WORK_DIRECTORY))?;
    if layout.apply_state.is_some() {
        remove_known_file(&layout.root.join(APPLY_FILE))?;
    }
    remove_known_file(&layout.root.join(WORK_DIRECTORY).join(META_FILE))?;
    remove_known_file(&layout.root.join(WORK_DIRECTORY).join(BODY_FILE))?;
    remove_known_file(&layout.root.join(BASE_DIRECTORY).join(META_FILE))?;
    remove_known_file(&layout.root.join(BASE_DIRECTORY).join(BODY_FILE))?;
    remove_known_file(&layout.root.join(MANIFEST_FILE))?;
    remove_known_directory(&layout.root.join(WORK_DIRECTORY))?;
    remove_known_directory(&layout.root.join(BASE_DIRECTORY))?;
    let root = layout.root.clone();
    remove_known_directory(&root)?;
    serde_json::to_value(DraftDiscardResult {
        draft_id: layout.manifest.draft_id,
        page_id: layout.manifest.page_id,
        directory: root,
        discarded: true,
    })
    .map(CommandOutput::Json)
    .map_err(internal)
}

fn read_projection(
    client: &CoreClient,
    project_id: &str,
    page_id: &str,
) -> Result<LibraryPageDraftProjection, CliError> {
    let snapshot = unwrap_library(client.library_read(
        Some(project_id),
        LibraryRead::PageDraftProjection {
            page_id: page_id.to_owned(),
        },
    ))?;
    let LibraryReadValue::PageDraftProjection { value } = snapshot.value else {
        return Err(internal("Core returned the wrong Page draft projection"));
    };
    Ok(*value)
}

fn validate_manifest_client(
    client: &CoreClient,
    explicit_project: Option<&str>,
    cwd: &Path,
    manifest: &DraftManifest,
) -> Result<(), CliError> {
    if client.handshake.generation.profile_id != manifest.profile_id {
        return Err(draft_conflict(
            "draft Profile does not match the active Core Profile",
        ));
    }
    if client.handshake.store_epoch != manifest.store_epoch {
        return Err(draft_conflict(
            "draft belongs to an earlier Core store generation",
        ));
    }
    let selector = explicit_project.unwrap_or(&manifest.project_id);
    let project = selected_project(client, Some(selector), cwd)?;
    if project.id != manifest.project_id {
        return Err(draft_conflict(
            "draft Project does not match the selected Project",
        ));
    }
    Ok(())
}

fn submit_apply_state(
    client: &CoreClient,
    loaded: &LoadedDraft,
    mut state: DraftApplyState,
) -> Result<CommandOutput, CliError> {
    let response = client
        .document_apply(
            Some(&loaded.layout.manifest.project_id),
            false,
            document_apply_request(&loaded.layout.manifest, &state),
        )
        .map_err(map_client_error)?;
    let committed = match response.0 {
        ResponseEnvelope::Ok(committed) => committed,
        ResponseEnvelope::Error(error) => {
            if state.status == DraftApplyStatus::Pending {
                remove_apply_state(&loaded.layout.root)?;
            }
            return Err(map_draft_core_error(error));
        }
    };
    let mut result = crate::page_mutation::semantic_mutation_result(
        &loaded.layout.manifest.page_id,
        &committed,
        &[],
    )?;
    let Value::Object(result_object) = &mut result else {
        return Err(internal("draft mutation result is not an object"));
    };
    let identity = serde_json::to_value(DraftApplicationIdentity {
        draft_id: &loaded.layout.manifest.draft_id,
        directory: &loaded.layout.root,
    })
    .map_err(internal)?;
    let Value::Object(identity) = identity else {
        return Err(internal("draft identity is not an object"));
    };
    result_object.extend(identity);
    state.status = DraftApplyStatus::Applied;
    state.result = Some(result.clone());
    write_apply_state(&loaded.layout.root, &state)?;
    Ok(CommandOutput::Json(result))
}

fn map_draft_core_error(error: nodex_core_contracts::CoreError) -> CliError {
    use nodex_core_contracts::CoreErrorCode;

    match error.code {
        CoreErrorCode::InvalidInput | CoreErrorCode::InvalidDocumentSchema => {
            draft_markdown_error(CliError::new(CliErrorCode::InvalidInput, error.message))
        }
        CoreErrorCode::RevisionConflict
        | CoreErrorCode::GenerationConflict
        | CoreErrorCode::HeadConflict
        | CoreErrorCode::StaleStoreEpoch
        | CoreErrorCode::PatchNotFound
        | CoreErrorCode::PatchAmbiguous
        | CoreErrorCode::PatchOverlap => draft_conflict(error.message),
        _ => map_core_error(error),
    }
}

fn compile_body_commands(
    loaded: &LoadedDraft,
    current: &LibraryPageDraftProjection,
    maximum_commands: usize,
) -> Result<Vec<DocumentSemanticCommand>, CliError> {
    if maximum_commands == 0 {
        return guarded_replacement(loaded, current);
    }
    if let Some(patches) = compile_safe_patches(
        &loaded.base_body,
        &loaded.work_body,
        &current.body_nested_markdown,
        maximum_commands,
    ) {
        return Ok(patches
            .into_iter()
            .map(|patch| DocumentSemanticCommand::PatchBody {
                old_fragment: patch.old_fragment,
                new_fragment: patch.new_fragment,
                expected_matches: None,
            })
            .collect());
    }
    guarded_replacement(loaded, current)
}

fn guarded_replacement(
    loaded: &LoadedDraft,
    current: &LibraryPageDraftProjection,
) -> Result<Vec<DocumentSemanticCommand>, CliError> {
    if current.body_etag != loaded.layout.manifest.base_body_etag {
        return Err(draft_conflict(
            "Page body changed and the draft cannot form safe non-overlapping exact patches",
        ));
    }
    Ok(vec![DocumentSemanticCommand::ReplaceBody {
        nested_markdown: loaded.work_body.clone(),
        expected_etag: loaded.layout.manifest.base_body_etag.clone(),
    }])
}

fn compile_safe_patches(
    base: &str,
    work: &str,
    current: &str,
    maximum_commands: usize,
) -> Option<Vec<CompiledPatch>> {
    let base_lines = base.split_inclusive('\n').collect::<Vec<_>>();
    let work_lines = work.split_inclusive('\n').collect::<Vec<_>>();
    if base_lines.len() > MAX_DRAFT_LINES || work_lines.len() > MAX_DRAFT_LINES {
        return None;
    }
    let diff = TextDiff::configure()
        .algorithm(Algorithm::Histogram)
        .timeout(Duration::from_secs(2))
        .diff_lines(base, work);
    let ranges = changed_ranges(&diff);
    if ranges.is_empty() || ranges.len() > maximum_commands {
        return None;
    }
    let mut patches = Vec::with_capacity(ranges.len());
    for (index, range) in ranges.iter().enumerate() {
        let left_limit = if index == 0 {
            0
        } else {
            midpoint(ranges[index - 1].old_end, range.old_start)
        };
        let right_limit = if index + 1 == ranges.len() {
            base_lines.len()
        } else {
            midpoint(range.old_end, ranges[index + 1].old_start)
        };
        patches.push(compile_one_patch(
            &base_lines,
            &work_lines,
            current,
            range,
            left_limit,
            right_limit,
        )?);
    }
    let mut spans = patches
        .iter()
        .map(|patch| (patch.current_start, patch.current_end))
        .collect::<Vec<_>>();
    spans.sort_unstable();
    if spans.windows(2).any(|window| window[0].1 > window[1].0) {
        return None;
    }
    Some(patches)
}

fn changed_ranges(diff: &TextDiff<'_, '_, str>) -> Vec<ChangedRange> {
    let mut ranges = Vec::<ChangedRange>::new();
    for operation in diff.ops() {
        if operation.tag() == DiffTag::Equal {
            continue;
        }
        let old = operation.old_range();
        let new = operation.new_range();
        if let Some(previous) = ranges.last_mut()
            && previous.old_end == old.start
            && previous.new_end == new.start
        {
            previous.old_end = old.end;
            previous.new_end = new.end;
            continue;
        }
        ranges.push(ChangedRange {
            old_start: old.start,
            old_end: old.end,
            new_start: new.start,
            new_end: new.end,
        });
    }
    ranges
}

fn compile_one_patch(
    base_lines: &[&str],
    work_lines: &[&str],
    current: &str,
    range: &ChangedRange,
    left_limit: usize,
    right_limit: usize,
) -> Option<CompiledPatch> {
    let mut start = range.old_start;
    let mut end = range.old_end;
    let mut prefer_left = true;
    loop {
        if start < end {
            let old_fragment = base_lines[start..end].concat();
            let mut matches = current.match_indices(&old_fragment);
            if let Some((current_start, _)) = matches.next()
                && matches.next().is_none()
            {
                let mut new_fragment = base_lines[start..range.old_start].concat();
                new_fragment.push_str(&work_lines[range.new_start..range.new_end].concat());
                new_fragment.push_str(&base_lines[range.old_end..end].concat());
                return Some(CompiledPatch {
                    current_end: current_start.checked_add(old_fragment.len())?,
                    current_start,
                    old_fragment,
                    new_fragment,
                });
            }
        }
        let can_expand_left = start > left_limit;
        let can_expand_right = end < right_limit;
        if !can_expand_left && !can_expand_right {
            return None;
        }
        if (prefer_left && can_expand_left) || !can_expand_right {
            start -= 1;
        } else {
            end += 1;
        }
        prefer_left = !prefer_left;
    }
}

fn midpoint(left: usize, right: usize) -> usize {
    left + right.saturating_sub(left) / 2
}

fn body_diff_summary(base: &str, work: &str) -> DraftBodyDiff {
    let diff = TextDiff::configure()
        .algorithm(Algorithm::Histogram)
        .timeout(Duration::from_secs(2))
        .diff_lines(base, work);
    let mut added_lines = 0usize;
    let mut removed_lines = 0usize;
    for operation in diff.ops() {
        match operation.tag() {
            DiffTag::Insert => added_lines += operation.new_range().len(),
            DiffTag::Delete => removed_lines += operation.old_range().len(),
            DiffTag::Replace => {
                added_lines += operation.new_range().len();
                removed_lines += operation.old_range().len();
            }
            DiffTag::Equal => {}
        }
    }
    DraftBodyDiff {
        changed: base != work,
        base_sha256: digest(base.as_bytes()),
        work_sha256: digest(work.as_bytes()),
        added_lines,
        removed_lines,
    }
}

fn load_draft(directory: &Path) -> Result<LoadedDraft, CliError> {
    let layout = load_layout(directory)?;
    let work_meta_path = layout.root.join(WORK_DIRECTORY).join(META_FILE);
    let work_body_path = layout.root.join(WORK_DIRECTORY).join(BODY_FILE);
    let work_meta = read_private_file(
        &work_meta_path,
        crate::meta_yaml::MAX_META_YAML_BYTES,
        false,
    )?;
    let work_body = read_private_file(&work_body_path, MAX_DRAFT_BODY_BYTES, false)?;
    let base_metadata = crate::meta_yaml::parse(&layout.base_meta)?;
    if base_metadata.id != layout.manifest.page_id {
        return Err(CliError::new(
            CliErrorCode::PageIdMismatch,
            "base meta.yaml does not match draft.json",
        )
        .at_path("base/meta.yaml:id"));
    }
    let work_metadata = crate::meta_yaml::parse(&work_meta)?;
    crate::meta_yaml::compare_draft_metadata(&base_metadata, &work_metadata)?;
    crate::page_mutation::validate_title(work_metadata.title_markdown.clone())
        .map_err(draft_markdown_error)?;
    let base_body = decode_body(
        &layout.base_body,
        &layout.root.join(BASE_DIRECTORY).join(BODY_FILE),
    )?;
    let work_body = decode_body(&work_body, &work_body_path)?;
    Ok(LoadedDraft {
        layout,
        base_metadata,
        work_metadata,
        base_body,
        work_body,
    })
}

fn load_layout(directory: &Path) -> Result<DraftLayout, CliError> {
    let root = existing_absolute_path(directory)?;
    validate_directory(&root, Some(PRIVATE_DIRECTORY_MODE))?;
    cleanup_apply_temp(&root)?;
    validate_entries(
        &root,
        &[MANIFEST_FILE, BASE_DIRECTORY, WORK_DIRECTORY],
        &[APPLY_FILE],
    )?;
    let base_root = root.join(BASE_DIRECTORY);
    let work_root = root.join(WORK_DIRECTORY);
    validate_directory(&base_root, Some(READ_ONLY_DIRECTORY_MODE))?;
    validate_directory(&work_root, Some(PRIVATE_DIRECTORY_MODE))?;
    validate_entries(&base_root, &[META_FILE, BODY_FILE], &[])?;
    validate_entries(&work_root, &[META_FILE, BODY_FILE], &[])?;

    let manifest_bytes = read_private_file(&root.join(MANIFEST_FILE), MAX_MANIFEST_BYTES, true)?;
    let manifest = serde_json::from_slice::<DraftManifest>(&manifest_bytes).map_err(|error| {
        unsafe_path(
            &root.join(MANIFEST_FILE),
            format!("draft manifest is invalid: {error}"),
        )
    })?;
    validate_manifest(&manifest, &root)?;
    let base_meta = read_private_file(
        &base_root.join(META_FILE),
        crate::meta_yaml::MAX_META_YAML_BYTES,
        true,
    )?;
    let base_body = read_private_file(&base_root.join(BODY_FILE), MAX_DRAFT_BODY_BYTES, true)?;
    validate_private_file(&work_root.join(META_FILE), false)?;
    validate_private_file(&work_root.join(BODY_FILE), false)?;
    if digest(&base_meta) != manifest.base_meta_sha256
        || digest(&base_body) != manifest.base_body_sha256
    {
        return Err(unsafe_path(
            &root,
            "draft base files no longer match their manifest",
        ));
    }
    let parsed_base = crate::meta_yaml::parse(&base_meta)?;
    if normalized_metadata_hash(&parsed_base)? != manifest.normalized_base_metadata_sha256 {
        return Err(unsafe_path(
            &base_root.join(META_FILE),
            "draft base metadata no longer matches its normalized manifest hash",
        ));
    }
    let apply_state = if root.join(APPLY_FILE).exists() {
        let bytes = read_private_file(&root.join(APPLY_FILE), MAX_APPLY_STATE_BYTES, true)?;
        Some(
            serde_json::from_slice::<DraftApplyState>(&bytes).map_err(|error| {
                unsafe_path(
                    &root.join(APPLY_FILE),
                    format!("draft apply marker is invalid: {error}"),
                )
            })?,
        )
    } else {
        None
    };
    if let Some(state) = &apply_state {
        validate_apply_state_shape(state, &root)?;
    }
    Ok(DraftLayout {
        root,
        manifest,
        base_meta,
        base_body,
        apply_state,
    })
}

fn validate_manifest(manifest: &DraftManifest, root: &Path) -> Result<(), CliError> {
    if manifest.schema_version != DRAFT_SCHEMA_VERSION
        || manifest.metadata_projection_version != METADATA_PROJECTION_VERSION
        || manifest.paths != DraftPaths::default()
        || !valid_uuid_v4(&manifest.draft_id)
        || !valid_identity(&manifest.profile_id)
        || !valid_identity(&manifest.project_id)
        || !valid_identity(&manifest.page_id)
        || !valid_identity(&manifest.store_epoch)
        || !valid_hash(&manifest.base_meta_sha256)
        || !valid_hash(&manifest.base_body_sha256)
        || !valid_hash(&manifest.normalized_base_metadata_sha256)
        || manifest.base_title_etag.is_empty()
        || manifest.base_title_etag.len() > 512
        || manifest.base_body_etag.is_empty()
        || manifest.base_body_etag.len() > 512
        || manifest.base_page_files.page_id != manifest.page_id
        || manifest.base_page_files.revision < 0
        || manifest.base_page_files.files.len() > 100
        || manifest.base_page_files.total < manifest.base_page_files.files.len() as u64
        || DateTime::parse_from_rfc3339(&manifest.created_at).is_err()
    {
        return Err(unsafe_path(root, "draft manifest contract is invalid"));
    }
    Ok(())
}

fn validate_apply_state_shape(state: &DraftApplyState, root: &Path) -> Result<(), CliError> {
    let result_valid = match state.status {
        DraftApplyStatus::Pending => state.result.is_none(),
        DraftApplyStatus::Applied => state.result.is_some(),
    };
    if state.schema_version != DRAFT_SCHEMA_VERSION
        || !valid_identity(&state.operation_id)
        || !valid_hash(&state.accepted_title_sha256)
        || !valid_hash(&state.accepted_body_sha256)
        || !valid_identity(&state.document_id)
        || state.generation < 1
        || state.expected_head_seq < 0
        || state.commands.is_empty()
        || state.commands.len() > MAX_SEMANTIC_COMMANDS
        || !result_valid
    {
        return Err(unsafe_path(
            &root.join(APPLY_FILE),
            "draft apply marker contract is invalid",
        ));
    }
    Ok(())
}

fn validate_apply_state(
    loaded: &LoadedDraft,
    state: &DraftApplyState,
    operation_id: &str,
    accepted_title: &str,
) -> Result<(), CliError> {
    if state.operation_id != operation_id
        || state.accepted_title_sha256 != digest(accepted_title.as_bytes())
        || state.accepted_body_sha256 != digest(loaded.work_body.as_bytes())
    {
        return Err(CliError::new(
            CliErrorCode::DraftAlreadyApplied,
            "draft has an existing apply attempt for different accepted work; create a new draft",
        ));
    }
    validate_apply_commands(loaded, state, accepted_title)?;
    Ok(())
}

fn validate_apply_commands(
    loaded: &LoadedDraft,
    state: &DraftApplyState,
    accepted_title: &str,
) -> Result<(), CliError> {
    let title_changed = loaded.base_metadata.title_markdown != accepted_title;
    let body_changed = loaded.base_body != loaded.work_body;
    let mut title_commands = 0usize;
    let mut replacement = None::<String>;
    let mut patches = Vec::<(usize, usize, String)>::new();
    for command in &state.commands {
        match command {
            DocumentSemanticCommand::SetTitle {
                inline_markdown,
                expected_etag,
            } if title_changed
                && inline_markdown == accepted_title
                && expected_etag == &loaded.layout.manifest.base_title_etag =>
            {
                title_commands += 1;
            }
            DocumentSemanticCommand::ReplaceBody {
                nested_markdown,
                expected_etag,
            } if body_changed
                && nested_markdown == &loaded.work_body
                && expected_etag == &loaded.layout.manifest.base_body_etag
                && replacement.is_none()
                && patches.is_empty() =>
            {
                replacement = Some(nested_markdown.clone());
            }
            DocumentSemanticCommand::PatchBody {
                old_fragment,
                new_fragment,
                expected_matches: None,
            } if body_changed && replacement.is_none() && !old_fragment.is_empty() => {
                let mut matches = loaded.base_body.match_indices(old_fragment);
                let Some((start, _)) = matches.next() else {
                    return Err(invalid_apply_commands(&loaded.layout.root));
                };
                if matches.next().is_some() {
                    return Err(invalid_apply_commands(&loaded.layout.root));
                }
                patches.push((
                    start,
                    start
                        .checked_add(old_fragment.len())
                        .ok_or_else(|| invalid_apply_commands(&loaded.layout.root))?,
                    new_fragment.clone(),
                ));
            }
            _ => return Err(invalid_apply_commands(&loaded.layout.root)),
        }
    }
    if title_commands != usize::from(title_changed) {
        return Err(invalid_apply_commands(&loaded.layout.root));
    }
    if !body_changed && (replacement.is_some() || !patches.is_empty()) {
        return Err(invalid_apply_commands(&loaded.layout.root));
    }
    if body_changed {
        if replacement.as_deref() == Some(loaded.work_body.as_str()) {
            return Ok(());
        }
        if patches.is_empty() {
            return Err(invalid_apply_commands(&loaded.layout.root));
        }
        patches.sort_unstable_by_key(|(start, _, _)| *start);
        if patches.windows(2).any(|window| window[0].1 > window[1].0) {
            return Err(invalid_apply_commands(&loaded.layout.root));
        }
        let mut result = loaded.base_body.clone();
        for (start, end, new_fragment) in patches.into_iter().rev() {
            result.replace_range(start..end, &new_fragment);
        }
        if result != loaded.work_body {
            return Err(invalid_apply_commands(&loaded.layout.root));
        }
    }
    Ok(())
}

fn invalid_apply_commands(root: &Path) -> CliError {
    unsafe_path(
        &root.join(APPLY_FILE),
        "draft apply marker commands do not reproduce the accepted work",
    )
}

fn draft_operation_id(loaded: &LoadedDraft, accepted_title: &str) -> Result<String, CliError> {
    let fingerprint = serde_json::to_vec(&json!({
        "version": 1,
        "draft_id": loaded.layout.manifest.draft_id,
        "base_meta_sha256": loaded.layout.manifest.base_meta_sha256,
        "base_body_sha256": loaded.layout.manifest.base_body_sha256,
        "title": accepted_title,
        "body_sha256": digest(loaded.work_body.as_bytes()),
    }))
    .map_err(internal)?;
    Ok(format!("draft:{}", digest(&fingerprint)))
}

fn document_apply_request(
    manifest: &DraftManifest,
    state: &DraftApplyState,
) -> ModuleApplyRequest<OwnedDocumentIntent> {
    ModuleApplyRequest {
        contract_version: OwnedDocumentContract::VERSION,
        operation_id: state.operation_id.clone(),
        store_epoch: StoreEpoch(manifest.store_epoch.clone()),
        intent: OwnedDocumentIntent::ApplySemanticMutation {
            document_id: state.document_id.clone(),
            generation: state.generation,
            expected_head_seq: state.expected_head_seq,
            commands: state.commands.clone(),
        },
    }
}

fn document_apply_request_size(
    manifest: &DraftManifest,
    state: &DraftApplyState,
) -> Result<usize, CliError> {
    serde_json::to_vec(&OwnedDocumentApplyRequest(document_apply_request(
        manifest, state,
    )))
    .map(|bytes| bytes.len())
    .map_err(internal)
}

fn write_apply_state(root: &Path, state: &DraftApplyState) -> Result<(), CliError> {
    let path = root.join(APPLY_FILE);
    let temporary = root.join(APPLY_TEMP_FILE);
    if temporary.exists() {
        cleanup_apply_temp(root)?;
    }
    let mut bytes = serde_json::to_vec_pretty(state).map_err(internal)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_APPLY_STATE_BYTES {
        return Err(unsafe_path(
            &path,
            "draft apply marker exceeds its bounded size",
        ));
    }
    write_new_file(&temporary, &bytes, PRIVATE_FILE_MODE)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(READ_ONLY_FILE_MODE))
        .map_err(|error| path_error(&temporary, error))?;
    fs::rename(&temporary, &path).map_err(|error| path_error(&path, error))?;
    sync_directory(root)
}

fn remove_apply_state(root: &Path) -> Result<(), CliError> {
    let path = root.join(APPLY_FILE);
    if !path.exists() {
        return Ok(());
    }
    remove_known_file(&path)
}

fn cleanup_apply_temp(root: &Path) -> Result<(), CliError> {
    let temporary = root.join(APPLY_TEMP_FILE);
    match fs::symlink_metadata(&temporary) {
        Ok(_) => remove_known_file(&temporary),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(path_error(&temporary, error)),
    }
}

#[derive(Debug)]
struct DraftDestination {
    path: PathBuf,
    parent: PathBuf,
    name: String,
    remove_empty: bool,
}

fn draft_destination(output: &Path) -> Result<DraftDestination, CliError> {
    let lexical = absolute_normalized_path(output)?;
    let lexical_parent = lexical
        .parent()
        .ok_or_else(|| unsafe_path(&lexical, "draft destination has no parent"))?;
    let parent = lexical_parent
        .canonicalize()
        .map_err(|error| path_error(lexical_parent, error))?;
    validate_no_symlink_components(&parent)?;
    validate_directory(&parent, None)?;
    let name = lexical
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .ok_or_else(|| unsafe_path(&lexical, "draft destination name must be valid UTF-8"))?
        .to_owned();
    let path = parent.join(&name);
    let remove_empty = match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            validate_owned_metadata(&metadata, &path)?;
            if !metadata.is_dir() {
                return Err(unsafe_path(
                    &path,
                    "draft destination must be absent or an empty directory",
                ));
            }
            if fs::read_dir(&path)
                .map_err(|error| path_error(&path, error))?
                .next()
                .is_some()
            {
                return Err(unsafe_path(
                    &path,
                    "draft destination directory is not empty",
                ));
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(path_error(&path, error)),
    };
    Ok(DraftDestination {
        path,
        parent,
        name,
        remove_empty,
    })
}

fn existing_absolute_path(path: &Path) -> Result<PathBuf, CliError> {
    let lexical = absolute_normalized_path(path)?;
    let metadata = fs::symlink_metadata(&lexical).map_err(|error| path_error(&lexical, error))?;
    if metadata.file_type().is_symlink() {
        return Err(unsafe_path(&lexical, "draft root must not be a symlink"));
    }
    let canonical = lexical
        .canonicalize()
        .map_err(|error| path_error(&lexical, error))?;
    validate_no_symlink_components(&canonical)?;
    Ok(canonical)
}

fn absolute_normalized_path(path: &Path) -> Result<PathBuf, CliError> {
    if path.as_os_str().is_empty() {
        return Err(unsafe_path(path, "draft path is empty"));
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map_err(internal)?.join(path)
    };
    let mut normalized = PathBuf::from("/");
    for component in absolute.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(unsafe_path(path, "draft path escapes the filesystem root"));
                }
            }
            Component::Prefix(_) => {
                return Err(unsafe_path(path, "draft path has an unsupported prefix"));
            }
        }
    }
    if normalized == Path::new("/") {
        return Err(unsafe_path(
            path,
            "filesystem root cannot be a draft directory",
        ));
    }
    Ok(normalized)
}

fn validate_no_symlink_components(path: &Path) -> Result<(), CliError> {
    let mut current = PathBuf::from("/");
    for component in path.components() {
        let Component::Normal(value) = component else {
            continue;
        };
        current.push(value);
        let metadata =
            fs::symlink_metadata(&current).map_err(|error| path_error(&current, error))?;
        if metadata.file_type().is_symlink() {
            return Err(unsafe_path(
                &current,
                "draft path must not traverse a symlink",
            ));
        }
    }
    Ok(())
}

fn validate_entries(
    directory: &Path,
    required: &[&str],
    optional: &[&str],
) -> Result<(), CliError> {
    let entries = fs::read_dir(directory)
        .map_err(|error| path_error(directory, error))?
        .map(|entry| {
            entry
                .map_err(|error| path_error(directory, error))?
                .file_name()
                .into_string()
                .map_err(|_| unsafe_path(directory, "draft contains a non-UTF-8 entry"))
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let expected = required
        .iter()
        .chain(optional.iter())
        .map(|name| (*name).to_owned())
        .collect::<BTreeSet<_>>();
    let required = required
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<BTreeSet<_>>();
    if !required.is_subset(&entries) || !entries.is_subset(&expected) {
        return Err(unsafe_path(
            directory,
            format!(
                "draft layout contains missing or unknown entries: {}",
                entries.into_iter().collect::<Vec<_>>().join(", ")
            ),
        ));
    }
    Ok(())
}

fn validate_directory(path: &Path, exact_mode: Option<u32>) -> Result<(), CliError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| path_error(path, error))?;
    validate_owned_metadata(&metadata, path)?;
    if !metadata.is_dir() {
        return Err(unsafe_path(path, "draft path is not a directory"));
    }
    let mode = metadata.permissions().mode() & 0o777;
    if exact_mode.is_some_and(|expected| mode != expected)
        || (exact_mode.is_none() && mode & 0o022 != 0)
    {
        return Err(unsafe_path(path, "draft directory permissions are unsafe"));
    }
    Ok(())
}

fn validate_private_file(path: &Path, read_only: bool) -> Result<File, CliError> {
    let descriptor = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::CLOEXEC | rustix::fs::OFlags::NOFOLLOW,
        rustix::fs::Mode::empty(),
    )
    .map_err(|error| path_error(path, error))?;
    let file = File::from(descriptor);
    let metadata = file.metadata().map_err(|error| path_error(path, error))?;
    validate_owned_metadata(&metadata, path)?;
    if !metadata.is_file() {
        return Err(unsafe_path(path, "draft entry is not a regular file"));
    }
    let mode = metadata.permissions().mode() & 0o777;
    if (read_only && mode != READ_ONLY_FILE_MODE)
        || (!read_only && (mode & 0o077 != 0 || mode & 0o400 == 0))
    {
        return Err(unsafe_path(path, "draft file permissions are unsafe"));
    }
    Ok(file)
}

fn read_private_file(path: &Path, limit: usize, read_only: bool) -> Result<Vec<u8>, CliError> {
    let file = validate_private_file(path, read_only)?;
    let take_limit = u64::try_from(limit)
        .map_err(internal)?
        .checked_add(1)
        .ok_or_else(|| internal("draft input limit overflow"))?;
    let mut bytes = Vec::new();
    file.take(take_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| path_error(path, error))?;
    if bytes.len() > limit {
        return Err(CliError::new(
            CliErrorCode::DraftUnsafePath,
            format!("draft file exceeds its {limit}-byte bound"),
        )
        .at_path(path.display().to_string()));
    }
    Ok(bytes)
}

fn validate_owned_metadata(metadata: &fs::Metadata, path: &Path) -> Result<(), CliError> {
    if metadata.file_type().is_symlink() {
        return Err(unsafe_path(path, "draft paths must not be symlinks"));
    }
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(unsafe_path(
            path,
            "draft paths must be owned by the current user",
        ));
    }
    Ok(())
}

fn create_private_directory(path: &Path) -> Result<(), CliError> {
    fs::create_dir(path).map_err(|error| path_error(path, error))?;
    fs::set_permissions(path, fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE))
        .map_err(|error| path_error(path, error))?;
    validate_directory(path, Some(PRIVATE_DIRECTORY_MODE))
}

fn write_new_file(path: &Path, bytes: &[u8], mode: u32) -> Result<(), CliError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true).mode(PRIVATE_FILE_MODE);
    let mut file = options
        .open(path)
        .map_err(|error| path_error(path, error))?;
    file.write_all(bytes)
        .map_err(|error| path_error(path, error))?;
    file.sync_all().map_err(|error| path_error(path, error))?;
    drop(file);
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| path_error(path, error))
}

fn sync_directory(path: &Path) -> Result<(), CliError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| path_error(path, error))
}

fn remove_known_file(path: &Path) -> Result<(), CliError> {
    let _file = validate_private_file(path, false)?;
    fs::set_permissions(path, fs::Permissions::from_mode(PRIVATE_FILE_MODE))
        .map_err(|error| path_error(path, error))?;
    fs::remove_file(path).map_err(|error| path_error(path, error))
}

fn remove_known_directory(path: &Path) -> Result<(), CliError> {
    validate_directory(path, None)?;
    fs::set_permissions(path, fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE))
        .map_err(|error| path_error(path, error))?;
    fs::remove_dir(path).map_err(|error| path_error(path, error))
}

fn unseal_directory(path: &Path) -> Result<(), CliError> {
    validate_directory(path, None)?;
    fs::set_permissions(path, fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE))
        .map_err(|error| path_error(path, error))
}

fn remove_generated_tree(root: &Path) -> Result<(), CliError> {
    if !root.exists() {
        return Ok(());
    }
    let work = root.join(WORK_DIRECTORY);
    let base = root.join(BASE_DIRECTORY);
    if work.exists() {
        unseal_directory(&work)?;
    }
    if base.exists() {
        unseal_directory(&base)?;
    }
    for path in [
        root.join(APPLY_TEMP_FILE),
        root.join(APPLY_FILE),
        work.join(META_FILE),
        work.join(BODY_FILE),
        base.join(META_FILE),
        base.join(BODY_FILE),
        root.join(MANIFEST_FILE),
    ] {
        if path.exists() {
            remove_known_file(&path)?;
        }
    }
    for path in [work, base, root.to_path_buf()] {
        if path.exists() {
            remove_known_directory(&path)?;
        }
    }
    Ok(())
}

fn decode_body(bytes: &[u8], path: &Path) -> Result<String, CliError> {
    let body = String::from_utf8(bytes.to_vec()).map_err(|_| {
        CliError::new(
            CliErrorCode::DraftInvalidMarkdown,
            "draft body must be valid UTF-8",
        )
        .at_path(path.display().to_string())
    })?;
    if body.contains('\r') || !body.ends_with('\n') {
        return Err(CliError::new(
            CliErrorCode::DraftInvalidMarkdown,
            "draft body must use canonical LF endings and retain its final LF",
        )
        .at_path(path.display().to_string()));
    }
    Ok(body)
}

fn normalized_metadata_hash(metadata: &crate::meta_yaml::PageMetaV2) -> Result<String, CliError> {
    serde_json::to_vec(metadata)
        .map(|bytes| digest(&bytes))
        .map_err(internal)
}

fn random_uuid_v4() -> Result<String, CliError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| internal("draft identity entropy is unavailable"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let encoded = hex::encode(bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &encoded[0..8],
        &encoded[8..12],
        &encoded[12..16],
        &encoded[16..20],
        &encoded[20..32]
    ))
}

fn valid_uuid_v4(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes().get(14) == Some(&b'4')
        && value
            .as_bytes()
            .get(19)
            .is_some_and(|byte| matches!(byte, b'8' | b'9' | b'a' | b'b'))
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase(),
        })
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && value.trim() == value
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn draft_markdown_error(error: CliError) -> CliError {
    CliError::new(CliErrorCode::DraftInvalidMarkdown, error.message)
}

fn draft_conflict(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::DraftConflict, message)
}

fn unsafe_path(path: &Path, message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::DraftUnsafePath, message).at_path(path.display().to_string())
}

fn path_error(path: &Path, error: impl std::fmt::Display) -> CliError {
    unsafe_path(path, error.to_string())
}

fn internal(error: impl std::fmt::Display) -> CliError {
    CliError::new(CliErrorCode::Internal, error.to_string())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn patch_compiler_expands_repeated_lines_and_survives_unrelated_remote_edits() {
        let base = "# A\nrepeat\nold\nrepeat\n# B\nrepeat\nold\nrepeat\n";
        let work = "# A\nrepeat\nNEW\nrepeat\n# B\nrepeat\nold\nrepeat\n";
        let current = "remote preface\n# A\nrepeat\nold\nrepeat\n# B\nrepeat\nold\nrepeat\n";
        let patches = compile_safe_patches(base, work, current, 512).expect("safe exact patch");
        assert_eq!(patches.len(), 1);
        assert!(patches[0].old_fragment.contains("# A\n"));
        assert_eq!(current.matches(&patches[0].old_fragment).count(), 1);
        let patched = current.replacen(&patches[0].old_fragment, &patches[0].new_fragment, 1);
        assert_eq!(
            patched,
            "remote preface\n# A\nrepeat\nNEW\nrepeat\n# B\nrepeat\nold\nrepeat\n"
        );
    }

    #[test]
    fn patch_compiler_handles_pure_insertions_and_rejects_overlapping_remote_changes() {
        let inserted = compile_safe_patches("one\ntwo\n", "one\nNEW\ntwo\n", "one\ntwo\n", 512)
            .expect("anchored insertion patch");
        assert_eq!(inserted.len(), 1);
        assert!(!inserted[0].old_fragment.is_empty());
        assert_eq!(
            "one\ntwo\n".replacen(&inserted[0].old_fragment, &inserted[0].new_fragment, 1),
            "one\nNEW\ntwo\n"
        );
        assert!(compile_safe_patches("one\ntwo\n", "one\nTWO\n", "one\nremote\n", 512).is_none());
    }

    #[test]
    fn draft_destination_accepts_only_absent_or_current_user_owned_empty_directories() {
        let directory = tempdir().expect("draft parent");
        let absent = directory.path().join("absent");
        assert!(!draft_destination(&absent).unwrap().remove_empty);

        let empty = directory.path().join("empty");
        fs::create_dir(&empty).expect("empty destination");
        assert!(draft_destination(&empty).unwrap().remove_empty);

        fs::write(empty.join("user-file"), b"keep").expect("non-empty destination");
        let error = draft_destination(&empty).expect_err("non-empty destination must fail");
        assert_eq!(error.code, CliErrorCode::DraftUnsafePath);

        let linked = directory.path().join("linked");
        symlink(&empty, &linked).expect("linked destination");
        let error = draft_destination(&linked).expect_err("linked destination must fail");
        assert_eq!(error.code, CliErrorCode::DraftUnsafePath);
    }

    #[test]
    fn layout_validation_refuses_unknown_entries_and_symlinked_work_files() {
        let directory = tempdir().expect("draft parent");
        let root = directory.path().join("draft");
        write_fixture(&root);
        fs::write(root.join("unknown"), b"no").expect("unknown entry");
        let error = load_layout(&root).expect_err("unknown draft entry");
        assert_eq!(error.code, CliErrorCode::DraftUnsafePath);
        fs::remove_file(root.join("unknown")).expect("remove unknown entry");
        fs::remove_file(root.join(WORK_DIRECTORY).join(BODY_FILE)).expect("remove work body");
        symlink(
            root.join(BASE_DIRECTORY).join(BODY_FILE),
            root.join(WORK_DIRECTORY).join(BODY_FILE),
        )
        .expect("symlink work body");
        let error = load_layout(&root).expect_err("symlinked work file");
        assert_eq!(error.code, CliErrorCode::DraftUnsafePath);
    }

    #[test]
    fn draft_validation_detects_base_tampering_and_invalid_work_content() {
        let directory = tempdir().expect("draft parent");
        let root = directory.path().join("draft");
        write_fixture(&root);
        let base_body = root.join(BASE_DIRECTORY).join(BODY_FILE);
        fs::set_permissions(&base_body, fs::Permissions::from_mode(PRIVATE_FILE_MODE)).unwrap();
        fs::write(&base_body, b"Tampered\n").expect("tampered base body");
        fs::set_permissions(&base_body, fs::Permissions::from_mode(READ_ONLY_FILE_MODE)).unwrap();
        let error = load_layout(&root).expect_err("base hash mismatch must fail");
        assert_eq!(error.code, CliErrorCode::DraftUnsafePath);

        fs::set_permissions(
            root.join(BASE_DIRECTORY),
            fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE),
        )
        .unwrap();
        fs::set_permissions(&base_body, fs::Permissions::from_mode(PRIVATE_FILE_MODE)).unwrap();
        fs::write(&base_body, b"Body\n").expect("restore base body");
        fs::set_permissions(&base_body, fs::Permissions::from_mode(READ_ONLY_FILE_MODE)).unwrap();
        fs::set_permissions(
            root.join(BASE_DIRECTORY),
            fs::Permissions::from_mode(READ_ONLY_DIRECTORY_MODE),
        )
        .unwrap();
        fs::write(
            root.join(WORK_DIRECTORY).join(BODY_FILE),
            b"missing final LF",
        )
        .expect("invalid work body");
        let error = load_draft(&root).expect_err("non-canonical body must fail");
        assert_eq!(error.code, CliErrorCode::DraftInvalidMarkdown);

        fs::write(root.join(WORK_DIRECTORY).join(BODY_FILE), b"Body\n").unwrap();
        fs::write(
            root.join(WORK_DIRECTORY).join(META_FILE),
            b"id: \"another-page\"\ntitle: \"Title\"\nproperties: {}\nschedule: null\n",
        )
        .unwrap();
        let error = load_draft(&root).expect_err("Page identity change must fail");
        assert_eq!(error.code, CliErrorCode::PageIdMismatch);
    }

    #[test]
    fn formatting_only_metadata_is_a_noop_and_keeps_the_deterministic_operation_id() {
        let directory = tempdir().expect("draft parent");
        let root = directory.path().join("draft");
        write_fixture(&root);
        let original = load_draft(&root).expect("original draft");
        let original_id = draft_operation_id(&original, &original.work_metadata.title_markdown)
            .expect("original operation ID");
        fs::write(
            root.join(WORK_DIRECTORY).join(META_FILE),
            b"# harmless formatting\nschedule: null\nproperties: {}\ntitle: 'Title'\nid: 'page-1'\n",
        )
        .expect("formatted metadata");
        let formatted = load_draft(&root).expect("formatted draft");
        assert_eq!(
            draft_operation_id(&formatted, &formatted.work_metadata.title_markdown).unwrap(),
            original_id
        );
        let CommandOutput::Json(summary) = diff(&root).expect("local diff") else {
            panic!("draft diff must be JSON")
        };
        assert_eq!(summary["changed"], false);
    }

    #[test]
    fn guarded_replacement_requires_the_original_body_etag() {
        let directory = tempdir().expect("draft parent");
        let root = directory.path().join("draft");
        write_fixture(&root);
        fs::write(root.join(WORK_DIRECTORY).join(BODY_FILE), b"Replacement\n").unwrap();
        let loaded = load_draft(&root).expect("changed body");
        let current = draft_projection("body-etag", "Remote body\n");
        assert!(matches!(
            guarded_replacement(&loaded, &current).unwrap().as_slice(),
            [DocumentSemanticCommand::ReplaceBody { nested_markdown, .. }]
                if nested_markdown == "Replacement\n"
        ));

        let stale = draft_projection("remote-etag", "Remote body\n");
        let error = guarded_replacement(&loaded, &stale)
            .expect_err("stale body cannot be replaced wholesale");
        assert_eq!(error.code, CliErrorCode::DraftConflict);
    }

    #[test]
    fn discard_removes_only_a_valid_known_layout_even_with_invalid_work_content() {
        let directory = tempdir().expect("draft parent");
        let root = directory.path().join("draft");
        write_fixture(&root);
        fs::write(root.join(WORK_DIRECTORY).join(META_FILE), b"not: [valid")
            .expect("invalid work metadata");
        discard(&root).expect("discard does not parse disposable work content");
        assert!(!root.exists());
    }

    #[test]
    fn apply_marker_commands_must_reproduce_only_the_accepted_title_and_body() {
        let directory = tempdir().expect("draft parent");
        let root = directory.path().join("draft");
        write_fixture(&root);
        fs::write(
            root.join(WORK_DIRECTORY).join(META_FILE),
            b"id: \"page-1\"\ntitle: \"New title\"\nproperties: {}\nschedule: null\n",
        )
        .expect("work title");
        fs::write(root.join(WORK_DIRECTORY).join(BODY_FILE), b"New body\n").expect("work body");
        let loaded = load_draft(&root).expect("changed draft");
        let title = loaded.work_metadata.title_markdown.clone();
        let operation_id = draft_operation_id(&loaded, &title).unwrap();
        let valid = DraftApplyState {
            schema_version: 1,
            status: DraftApplyStatus::Pending,
            operation_id: operation_id.clone(),
            accepted_title_sha256: digest(title.as_bytes()),
            accepted_body_sha256: digest(loaded.work_body.as_bytes()),
            document_id: "document-1".to_owned(),
            generation: 1,
            expected_head_seq: 1,
            commands: vec![
                DocumentSemanticCommand::SetTitle {
                    inline_markdown: title.clone(),
                    expected_etag: "title-etag".to_owned(),
                },
                DocumentSemanticCommand::ReplaceBody {
                    nested_markdown: "New body\n".to_owned(),
                    expected_etag: "body-etag".to_owned(),
                },
            ],
            result: None,
        };
        validate_apply_state(&loaded, &valid, &operation_id, &title).expect("exact apply marker");

        let mut tampered = valid;
        tampered.commands[1] = DocumentSemanticCommand::ReplaceBody {
            nested_markdown: "Different Page content\n".to_owned(),
            expected_etag: "body-etag".to_owned(),
        };
        let error = validate_apply_state(&loaded, &tampered, &operation_id, &title)
            .expect_err("marker cannot change accepted work");
        assert_eq!(error.code, CliErrorCode::DraftUnsafePath);

        fs::write(
            root.join(WORK_DIRECTORY).join(BODY_FILE),
            b"Changed after apply\n",
        )
        .unwrap();
        let changed = load_draft(&root).expect("changed accepted work");
        let changed_title = changed.work_metadata.title_markdown.clone();
        let changed_operation_id = draft_operation_id(&changed, &changed_title).unwrap();
        let error =
            validate_apply_state(&changed, &tampered, &changed_operation_id, &changed_title)
                .expect_err("accepted work cannot change after apply starts");
        assert_eq!(error.code, CliErrorCode::DraftAlreadyApplied);
    }

    fn draft_projection(body_etag: &str, body: &str) -> LibraryPageDraftProjection {
        LibraryPageDraftProjection {
            version: 1,
            metadata_projection_version: 2,
            library_id: "library-1".to_owned(),
            store_epoch: "epoch-1".to_owned(),
            commit_head: 1,
            page_id: "page-1".to_owned(),
            metadata_revision: 1,
            document_id: "document-1".to_owned(),
            document_generation: 1,
            document_head_seq: 1,
            meta_yaml: String::new(),
            body_nested_markdown: body.to_owned(),
            page_files: nodex_core_contracts::library::LibraryPageFileInventory {
                can_write: true,
                page_id: "page-1".to_owned(),
                revision: 0,
                body_usage_revision: 0,
                files: Vec::new(),
                next_cursor: None,
                has_more: false,
                total: 0,
                unplaced_total: 0,
                placed_total: 0,
            },
            title_etag: "title-etag".to_owned(),
            body_etag: body_etag.to_owned(),
        }
    }

    fn write_fixture(root: &Path) {
        create_private_directory(root).expect("draft root");
        let base = root.join(BASE_DIRECTORY);
        let work = root.join(WORK_DIRECTORY);
        create_private_directory(&base).expect("base root");
        create_private_directory(&work).expect("work root");
        let metadata = b"id: \"page-1\"\ntitle: \"Title\"\nproperties: {}\nschedule: null\n";
        let body = b"Body\n";
        let parsed = crate::meta_yaml::parse(metadata).expect("fixture metadata");
        let manifest = DraftManifest {
            schema_version: 1,
            metadata_projection_version: 2,
            draft_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            profile_id: "profile-1".to_owned(),
            project_id: "project-1".to_owned(),
            page_id: "page-1".to_owned(),
            store_epoch: "epoch-1".to_owned(),
            created_at: "2026-07-21T00:00:00.000Z".to_owned(),
            base_meta_sha256: digest(metadata),
            base_body_sha256: digest(body),
            normalized_base_metadata_sha256: normalized_metadata_hash(&parsed).unwrap(),
            base_title_etag: "title-etag".to_owned(),
            base_body_etag: "body-etag".to_owned(),
            base_page_files: nodex_core_contracts::library::LibraryPageFileInventory {
                can_write: true,
                page_id: "page-1".to_owned(),
                revision: 0,
                body_usage_revision: 0,
                files: Vec::new(),
                next_cursor: None,
                has_more: false,
                total: 0,
                unplaced_total: 0,
                placed_total: 0,
            },
            paths: DraftPaths::default(),
        };
        let mut manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        manifest_bytes.push(b'\n');
        write_new_file(
            &root.join(MANIFEST_FILE),
            &manifest_bytes,
            READ_ONLY_FILE_MODE,
        )
        .unwrap();
        write_new_file(&base.join(META_FILE), metadata, READ_ONLY_FILE_MODE).unwrap();
        write_new_file(&base.join(BODY_FILE), body, READ_ONLY_FILE_MODE).unwrap();
        write_new_file(&work.join(META_FILE), metadata, PRIVATE_FILE_MODE).unwrap();
        write_new_file(&work.join(BODY_FILE), body, PRIVATE_FILE_MODE).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(READ_ONLY_DIRECTORY_MODE)).unwrap();
    }
}
