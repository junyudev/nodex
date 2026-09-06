use chrono::{DateTime, NaiveDate};
use nodex_core_contracts::library::{
    LibraryPageDraftProjection, LibraryPagePrepareKind, LibraryPageProjectionFile,
    LibraryPageProjectionFileKind, LibraryPageProjectionFileValidators, PageMetaProjectionV2,
    ProjectedIdentityV1, ProjectedPropertyTypeV1, ProjectedPropertyV1, ProjectedPropertyValueV1,
    ProjectedRelationSummaryV1, ProjectedScheduleV1,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::document::{mint_document_projection_etags, mint_etag, parse_inline_markdown_title};
use crate::domain::nfm::{
    NfmDateMention, NfmInlineContent, NfmStyleSet, serialize_inline_content_for_adapter,
};
use crate::domain::rich_text::{RichTextItem, RichTextStyles, canonicalize_rich_text};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::content::page_content;
use super::mutation::{require_project_in_library, resolve_library_actor_project_id};

const PAGE_FILE_VERSION: u32 = 2;
const PAGE_DRAFT_VERSION: u32 = 1;
const MAX_IDENTITY_BYTES: usize = 512;
const MAX_NAME_BYTES: usize = 4_096;
const MAX_TEXT_BYTES: usize = 64 * 1024;

pub(super) struct PageProjectionFileRequest<'a> {
    pub commit_head: i64,
    pub requesting_project_id: Option<&'a str>,
    pub page_id: &'a str,
    pub kind: LibraryPageProjectionFileKind,
    pub prepare: Option<LibraryPagePrepareKind>,
}

pub(super) fn page_projection_file(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    request: PageProjectionFileRequest<'_>,
) -> Result<LibraryPageProjectionFile, StoreError> {
    let PageProjectionFileRequest {
        commit_head,
        requesting_project_id,
        page_id,
        kind,
        prepare,
    } = request;
    validate_prepare(kind, prepare.as_ref())?;
    let page = page_content(connection, library_id, store_epoch, commit_head, page_id)?;
    let etag_project_id = match requesting_project_id {
        Some(project_id) => {
            require_project_in_library(connection, project_id, library_id)?;
            project_id.to_owned()
        }
        None => resolve_library_actor_project_id(connection, library_id)?,
    };
    let page_key = crate::database::current_page_key_for_page(connection, library_id, page_id)?;
    let (title_etag, body_etag) = mint_document_projection_etags(
        connection,
        &etag_project_id,
        store_epoch,
        &page.document_id,
        page.rich_title.clone(),
        &page.body_nfm,
    )
    .map_err(etag_error)?;
    let mut validators = LibraryPageProjectionFileValidators {
        title_etag: Some(title_etag),
        body_etag: Some(body_etag),
        page_etag: None,
        move_etag: None,
    };

    match prepare {
        Some(LibraryPagePrepareKind::TitleSet | LibraryPagePrepareKind::DocumentReplace) => {}
        Some(LibraryPagePrepareKind::PageDelete) => {
            validators.page_etag = Some(mint_page_shell_etag(
                connection,
                library_id,
                &etag_project_id,
                store_epoch,
                page_id,
            )?);
        }
        Some(LibraryPagePrepareKind::PageMove { view_id }) => {
            let project_id = requesting_project_id
                .ok_or_else(|| unauthorized("Page move preparation requires a bound Project"))?;
            let view_id = match view_id {
                Some(view_id) => Some(view_id),
                None => {
                    crate::database::default_page_move_view_id(connection, library_id, page_id)?
                }
            };
            validators.move_etag = Some(crate::database::mint_page_move_etag(
                connection,
                library_id,
                project_id,
                store_epoch,
                page_id,
                view_id.as_deref(),
            )?);
        }
        None => {}
    }

    let (content, metadata) = match kind {
        LibraryPageProjectionFileKind::BodyNestedMarkdown => {
            (with_final_newline(&page.body_nfm), None)
        }
        LibraryPageProjectionFileKind::MetaYaml => {
            let projection = PageMetaProjectionV2 {
                id: page.page_id.clone(),
                page_key: page_key.clone(),
                title_markdown: render_title_markdown(&page.rich_title)?,
                properties: project_properties(
                    connection,
                    library_id,
                    page_id,
                    requesting_project_id,
                )?,
                schedule: project_schedule(
                    connection,
                    page_id,
                    library_id,
                    page.metadata_revision,
                )?,
            };
            let content = render_meta_yaml_v2(&projection)?;
            (content, Some(projection))
        }
    };

    Ok(LibraryPageProjectionFile {
        version: PAGE_FILE_VERSION,
        library_id: library_id.to_owned(),
        store_epoch: store_epoch.to_owned(),
        commit_head,
        page_id: page.page_id,
        metadata_revision: page.metadata_revision,
        document_id: page.document_id,
        document_generation: page.document_generation,
        document_head_seq: page.document_head_seq,
        kind,
        content,
        page_key,
        metadata,
        validators,
    })
}

pub(super) fn page_draft_projection(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    commit_head: i64,
    page_id: &str,
    requesting_project_id: Option<&str>,
) -> Result<LibraryPageDraftProjection, StoreError> {
    let meta = page_projection_file(
        connection,
        library_id,
        store_epoch,
        PageProjectionFileRequest {
            commit_head,
            requesting_project_id,
            page_id,
            kind: LibraryPageProjectionFileKind::MetaYaml,
            prepare: Some(LibraryPagePrepareKind::TitleSet),
        },
    )?;
    let body = page_projection_file(
        connection,
        library_id,
        store_epoch,
        PageProjectionFileRequest {
            commit_head,
            requesting_project_id,
            page_id,
            kind: LibraryPageProjectionFileKind::BodyNestedMarkdown,
            prepare: Some(LibraryPagePrepareKind::DocumentReplace),
        },
    )?;
    if meta.document_id != body.document_id
        || meta.document_generation != body.document_generation
        || meta.document_head_seq != body.document_head_seq
        || meta.metadata_revision != body.metadata_revision
    {
        return Err(corrupt(
            "Page draft projections do not share one authority revision",
        ));
    }
    let title_etag = meta
        .validators
        .title_etag
        .ok_or_else(|| corrupt("Page draft metadata omitted its title ETag"))?;
    let body_etag = body
        .validators
        .body_etag
        .ok_or_else(|| corrupt("Page draft body omitted its body ETag"))?;
    let page_files = super::page_file_inventory::list_authorized_page(
        connection,
        library_id,
        page_id,
        None,
        None,
        Some(100),
        super::page_file_inventory::write_capability(
            connection,
            library_id,
            requesting_project_id,
            page_id,
        )?,
    )?;
    Ok(LibraryPageDraftProjection {
        version: PAGE_DRAFT_VERSION,
        metadata_projection_version: PAGE_FILE_VERSION,
        library_id: library_id.to_owned(),
        store_epoch: store_epoch.to_owned(),
        commit_head,
        page_id: page_id.to_owned(),
        metadata_revision: meta.metadata_revision,
        document_id: meta.document_id,
        document_generation: meta.document_generation,
        document_head_seq: meta.document_head_seq,
        meta_yaml: meta.content,
        body_nested_markdown: body.content,
        page_files,
        title_etag,
        body_etag,
    })
}

fn validate_prepare(
    kind: LibraryPageProjectionFileKind,
    prepare: Option<&LibraryPagePrepareKind>,
) -> Result<(), StoreError> {
    let valid = matches!(
        (kind, prepare),
        (_, None)
            | (
                LibraryPageProjectionFileKind::MetaYaml,
                Some(LibraryPagePrepareKind::TitleSet)
            )
            | (
                LibraryPageProjectionFileKind::BodyNestedMarkdown,
                Some(LibraryPagePrepareKind::DocumentReplace)
            )
            | (_, Some(LibraryPagePrepareKind::PageDelete))
            | (_, Some(LibraryPagePrepareKind::PageMove { .. }))
    );
    if valid {
        return Ok(());
    }
    Err(invalid(
        "title.set can prepare only meta.yaml and document.replace can prepare only body.nested.md",
    ))
}

struct PageStorageAuthority {
    lifecycle: String,
    placement_revision: i64,
    parent_kind: String,
    parent_id: String,
    metadata_revision: i64,
}

pub(super) fn mint_page_shell_etag(
    connection: &Connection,
    library_id: &str,
    etag_project_id: &str,
    store_epoch: &str,
    page_id: &str,
) -> Result<String, StoreError> {
    let storage = page_storage_authority(connection, library_id, page_id)?;
    mint_etag(
        connection,
        "page_shell",
        etag_project_id,
        store_epoch,
        &[page_id],
        json!({
            "lifecycle": storage.lifecycle,
            "locationRevision": storage.placement_revision,
            "parentKind": storage.parent_kind,
            "parentId": storage.parent_id,
            "parentRevision": storage.placement_revision,
            "metadataRevision": storage.metadata_revision,
        }),
    )
    .map_err(etag_error)
}

fn page_storage_authority(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<PageStorageAuthority, StoreError> {
    connection
        .query_row(
            "SELECT block.lifecycle, block.placement_revision, page.parent_kind, page.parent_id, \
               block.metadata_revision \
             FROM pages page JOIN blocks block ON block.id = page.block_id AND block.type = 'page' \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.library_id = ?2 AND block.lifecycle <> 'deleted'",
            params![page_id, library_id],
            |row| {
                Ok(PageStorageAuthority {
                    lifecycle: row.get(0)?,
                    placement_revision: row.get(1)?,
                    parent_kind: row.get(2)?,
                    parent_id: row.get(3)?,
                    metadata_revision: row.get(4)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Library Page file is unavailable"))
}

fn render_title_markdown(rich_title: &Value) -> Result<String, StoreError> {
    let items = serde_json::from_value::<Vec<RichTextItem>>(rich_title.clone())
        .map_err(|_| corrupt("Page rich title is not a typed portable rich-text value"))?;
    let canonical = canonicalize_rich_text(&items)
        .map_err(|_| corrupt("Page rich title is not canonical"))?
        .rich_text;
    if canonical != items {
        return Err(corrupt("Page rich title is not canonical"));
    }
    let inline = canonical
        .iter()
        .map(nfm_item)
        .collect::<Result<Vec<_>, _>>()?;
    let markdown = serialize_inline_content_for_adapter(&inline);
    let reparsed = parse_inline_markdown_title(&markdown)
        .map_err(|_| corrupt("Page rich title cannot be represented as inline Markdown"))?;
    if reparsed != canonical {
        return Err(corrupt(
            "Page rich title cannot be represented losslessly as inline Markdown",
        ));
    }
    Ok(markdown)
}

fn nfm_item(item: &RichTextItem) -> Result<NfmInlineContent, StoreError> {
    let styles = |styles: &RichTextStyles| NfmStyleSet {
        bold: styles.bold,
        italic: styles.italic,
        strikethrough: styles.strikethrough,
        underline: styles.underline,
        code: styles.code,
        color: styles.color.clone(),
    };
    match item {
        RichTextItem::Text {
            text,
            styles: item_styles,
        } => Ok(NfmInlineContent::Text {
            text: text.clone(),
            styles: styles(item_styles),
        }),
        RichTextItem::Link {
            text,
            href,
            styles: item_styles,
        } => Ok(NfmInlineContent::Link {
            text: text.clone(),
            href: href.clone(),
            styles: styles(item_styles),
        }),
        RichTextItem::ThreadMention { uuid } => {
            Ok(NfmInlineContent::ThreadMention { uuid: uuid.clone() })
        }
        RichTextItem::PageMention { target_page_id } => Ok(NfmInlineContent::PageMention {
            target_page_id: target_page_id.clone(),
        }),
        RichTextItem::DateMention {
            start,
            end,
            tz,
            format,
            time_format,
            reminder,
        } => Ok(NfmInlineContent::DateMention(NfmDateMention {
            start: start.clone(),
            end: end.clone(),
            tz: tz.clone(),
            format: format.clone(),
            time_format: time_format.clone(),
            reminder: reminder.clone(),
        })),
        RichTextItem::LineBreak => Err(corrupt("Page rich title contains a line break")),
    }
}

fn project_properties(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    requesting_project_id: Option<&str>,
) -> Result<Vec<ProjectedPropertyV1>, StoreError> {
    let parent = connection
        .query_row(
            "SELECT page.parent_kind, page.parent_id FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.lifecycle <> 'deleted'",
            params![page_id, library_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("Library Page metadata is unavailable"))?;
    if matches!(parent.0.as_str(), "library" | "page") {
        return Ok(Vec::new());
    }
    if parent.0 != "data_source" {
        return Err(corrupt("Library Page has an invalid parent kind"));
    }
    let projection = super::super::database::read::page_data_source_projection(
        connection,
        library_id,
        page_id,
        &parent.1,
        requesting_project_id,
    )?;
    projection
        .properties
        .iter()
        .map(|property| {
            let property_id = property.property_id.as_str();
            bounded_identity(property_id, "Property identity")?;
            let name = property.name.as_str();
            bounded_name(name, "Property name")?;
            let raw_type = crate::database::property_semantics::value_type(&property.schema);
            let value_type = property_type(raw_type)?;
            let config = projection
                .property_configs
                .get(property_id)
                .ok_or_else(|| corrupt("Property projection is missing config"))?;
            let null = Value::Null;
            let raw_value = match projection.values.get(property_id) {
                Some(record) => {
                    if required_string(record, "propertyId", "Property value identity")?
                        != property_id
                        || required_string(record, "valueType", "Property value type")? != raw_type
                    {
                        return Err(corrupt(
                            "Property value projection diverges from its definition",
                        ));
                    }
                    record
                        .get("value")
                        .ok_or_else(|| corrupt("Property value projection is incomplete"))?
                }
                None => &null,
            };
            Ok(ProjectedPropertyV1 {
                property_id: property_id.to_owned(),
                name: name.to_owned(),
                value_type,
                value: project_property_value(
                    property_id,
                    raw_type,
                    value_type,
                    config,
                    raw_value,
                )?,
            })
        })
        .collect()
}

fn property_type(value: &str) -> Result<ProjectedPropertyTypeV1, StoreError> {
    match value {
        "text" => Ok(ProjectedPropertyTypeV1::Text),
        "number" => Ok(ProjectedPropertyTypeV1::Number),
        "checkbox" => Ok(ProjectedPropertyTypeV1::Checkbox),
        "select" => Ok(ProjectedPropertyTypeV1::Select),
        "multi_select" => Ok(ProjectedPropertyTypeV1::MultiSelect),
        "date" => Ok(ProjectedPropertyTypeV1::Date),
        "datetime" => Ok(ProjectedPropertyTypeV1::Datetime),
        "relation" => Ok(ProjectedPropertyTypeV1::Relation),
        _ => Err(corrupt("Property projection has an unsupported type")),
    }
}

fn project_property_value(
    property_id: &str,
    storage_value_type: &str,
    value_type: ProjectedPropertyTypeV1,
    config: &Value,
    value: &Value,
) -> Result<ProjectedPropertyValueV1, StoreError> {
    if value.is_null() {
        return Ok(ProjectedPropertyValueV1::Null);
    }
    match value_type {
        ProjectedPropertyTypeV1::Text => value
            .as_str()
            .map(|value| bounded_text(value, "Text Property").map(str::to_owned))
            .transpose()?
            .map(ProjectedPropertyValueV1::Text)
            .ok_or_else(|| corrupt("Text Property value is not a string")),
        ProjectedPropertyTypeV1::Number => value
            .as_f64()
            .filter(|value| value.is_finite())
            .map(ProjectedPropertyValueV1::Number)
            .ok_or_else(|| corrupt("Number Property value is not finite")),
        ProjectedPropertyTypeV1::Checkbox => value
            .as_bool()
            .map(ProjectedPropertyValueV1::Checkbox)
            .ok_or_else(|| corrupt("Checkbox Property value is not boolean")),
        ProjectedPropertyTypeV1::Select => {
            let id = value
                .as_str()
                .ok_or_else(|| corrupt("Select Property value is not an option ID"))?;
            let config = validated_option_config(property_id, storage_value_type, config)?;
            option_identity(&config.options, id).map(ProjectedPropertyValueV1::Identity)
        }
        ProjectedPropertyTypeV1::MultiSelect => {
            let config = validated_option_config(property_id, storage_value_type, config)?;
            value
                .as_array()
                .ok_or_else(|| corrupt("Multi-select Property value is not a sequence"))?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| corrupt("Multi-select Property contains a non-string ID"))
                        .and_then(|id| option_identity(&config.options, id))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(ProjectedPropertyValueV1::Identities)
        }
        ProjectedPropertyTypeV1::Date => {
            let value = value
                .as_str()
                .ok_or_else(|| corrupt("Date Property value is not a string"))?;
            validate_date(value, "Date Property")?;
            Ok(ProjectedPropertyValueV1::Date(value.to_owned()))
        }
        ProjectedPropertyTypeV1::Datetime => {
            let value = value
                .as_str()
                .ok_or_else(|| corrupt("Datetime Property value is not a string"))?;
            validate_datetime(value, "Datetime Property")?;
            Ok(ProjectedPropertyValueV1::Datetime(value.to_owned()))
        }
        ProjectedPropertyTypeV1::Relation => {
            let preview = value
                .get("value")
                .filter(|_| value.get("kind").and_then(Value::as_str) == Some("relation"))
                .ok_or_else(|| corrupt("Relation Property preview is invalid"))?;
            let targets = preview
                .get("targets")
                .and_then(Value::as_array)
                .ok_or_else(|| corrupt("Relation Property preview targets are invalid"))?
                .iter()
                .map(|target| {
                    if target.get("kind").and_then(Value::as_str) != Some("visible") {
                        return Err(corrupt(
                            "Relation Property preview exposed an invalid target",
                        ));
                    }
                    let id = target
                        .get("page_id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| corrupt("Relation target identity is missing"))?;
                    let name = target
                        .get("title")
                        .and_then(Value::as_str)
                        .ok_or_else(|| corrupt("Relation target title is missing"))?;
                    bounded_identity(id, "Relation target identity")?;
                    bounded_name(name, "Relation target name")?;
                    Ok(ProjectedIdentityV1 {
                        id: id.to_owned(),
                        name: name.to_owned(),
                    })
                })
                .collect::<Result<Vec<_>, StoreError>>()?;
            let total_count = preview
                .get("total_count")
                .and_then(Value::as_i64)
                .ok_or_else(|| corrupt("Relation Property total count is invalid"))?;
            let restricted_count = preview
                .get("restricted_count")
                .and_then(Value::as_i64)
                .ok_or_else(|| corrupt("Relation Property restricted count is invalid"))?;
            let has_more = preview
                .get("has_more")
                .and_then(Value::as_bool)
                .ok_or_else(|| corrupt("Relation Property continuation marker is invalid"))?;
            let summary = ProjectedRelationSummaryV1 {
                targets,
                total_count,
                restricted_count,
                has_more,
            };
            validate_relation_summary(&summary)?;
            Ok(ProjectedPropertyValueV1::Relation(summary))
        }
    }
}

fn validated_option_config(
    property_id: &str,
    value_type: &str,
    config: &Value,
) -> Result<crate::database::property_semantics::PropertyOptionConfig, StoreError> {
    let config_json = serde_json::to_string(config)
        .map_err(|_| corrupt("Property option registry cannot encode"))?;
    crate::database::property_semantics::option_config_from_storage(
        property_id,
        value_type,
        &config_json,
    )
}

fn option_identity(
    options: &[crate::database::property_semantics::PropertyOption],
    id: &str,
) -> Result<ProjectedIdentityV1, StoreError> {
    bounded_identity(id, "Property option identity")?;
    let option = options
        .iter()
        .find(|option| option.id == id)
        .ok_or_else(|| corrupt("Select Property references an unknown option"))?;
    bounded_name(&option.name, "Property option name")?;
    Ok(ProjectedIdentityV1 {
        id: id.to_owned(),
        name: option.name.clone(),
    })
}

fn project_schedule(
    connection: &Connection,
    page_id: &str,
    library_id: &str,
    metadata_revision: i64,
) -> Result<Option<ProjectedScheduleV1>, StoreError> {
    let row = connection
        .query_row(
            "SELECT library_id, lifecycle, scheduled_start, scheduled_end, is_all_day, \
               schedule_timezone, source_metadata_revision \
             FROM scheduled_page_index WHERE page_block_id = ?1",
            [page_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((schedule_library_id, lifecycle, start, end, all_day, timezone, source_revision)) =
        row
    else {
        return Ok(None);
    };
    if schedule_library_id != library_id || source_revision != metadata_revision {
        return Err(corrupt("Page schedule projection is stale or mis-scoped"));
    }
    if lifecycle != "active" {
        return Ok(None);
    }
    let (start, end) = match (start, end) {
        (Some(start), Some(end)) => (start, end),
        (None, None) if all_day == 0 => return Ok(None),
        _ => return Err(corrupt("Page schedule projection has an incomplete range")),
    };
    let start_value = validate_datetime(&start, "Schedule start")?;
    let end_value = validate_datetime(&end, "Schedule end")?;
    if end_value <= start_value {
        return Err(corrupt("Page schedule end is not later than its start"));
    }
    if !matches!(all_day, 0 | 1) {
        return Err(corrupt("Page schedule all-day projection is invalid"));
    }
    if let Some(timezone) = &timezone {
        bounded_name(timezone, "Schedule timezone")?;
        timezone
            .parse::<chrono_tz::Tz>()
            .map_err(|_| corrupt("Page schedule timezone is not an IANA name"))?;
    }
    Ok(Some(ProjectedScheduleV1 {
        start,
        end,
        timezone,
        all_day: all_day == 1,
    }))
}

pub(super) fn render_meta_yaml_v2(value: &PageMetaProjectionV2) -> Result<String, StoreError> {
    bounded_identity(&value.id, "Page identity")?;
    if value.title_markdown.contains(['\n', '\r', '\t']) {
        return Err(corrupt(
            "Page title projection is not one inline-Markdown line",
        ));
    }
    bounded_text(&value.title_markdown, "Page title projection")?;
    let mut output = String::new();
    output.push_str("id: ");
    output.push_str(&quoted(&value.id)?);
    output.push_str("\npage_key: ");
    match &value.page_key {
        Some(page_key) => output.push_str(&quoted(page_key)?),
        None => output.push_str("null"),
    }
    output.push_str("\ntitle: ");
    output.push_str(&quoted(&value.title_markdown)?);
    if value.properties.is_empty() {
        output.push_str("\nproperties: {}\n");
    } else {
        output.push_str("\nproperties:\n");
        for property in &value.properties {
            render_property(&mut output, property)?;
        }
    }
    match &value.schedule {
        None => output.push_str("schedule: null\n"),
        Some(schedule) => {
            validate_schedule(schedule)?;
            output.push_str("schedule:\n  start: ");
            output.push_str(&quoted(&schedule.start)?);
            output.push_str("\n  end: ");
            output.push_str(&quoted(&schedule.end)?);
            output.push_str("\n  timezone: ");
            match &schedule.timezone {
                Some(timezone) => output.push_str(&quoted(timezone)?),
                None => output.push_str("null"),
            }
            output.push_str("\n  all_day: ");
            output.push_str(if schedule.all_day {
                "true\n"
            } else {
                "false\n"
            });
        }
    }
    Ok(output)
}

fn render_property(output: &mut String, property: &ProjectedPropertyV1) -> Result<(), StoreError> {
    bounded_identity(&property.property_id, "Property identity")?;
    bounded_name(&property.name, "Property name")?;
    validate_projected_value(property.value_type, &property.value)?;
    output.push_str("  ");
    output.push_str(&quoted(&property.property_id)?);
    output.push_str(":\n    name: ");
    output.push_str(&quoted(&property.name)?);
    output.push_str("\n    type: ");
    output.push_str(property_type_name(property.value_type));
    output.push_str("\n    value:");
    render_value(output, &property.value)?;
    Ok(())
}

fn render_value(output: &mut String, value: &ProjectedPropertyValueV1) -> Result<(), StoreError> {
    match value {
        ProjectedPropertyValueV1::Null => output.push_str(" null\n"),
        ProjectedPropertyValueV1::Text(value)
        | ProjectedPropertyValueV1::Date(value)
        | ProjectedPropertyValueV1::Datetime(value) => {
            output.push(' ');
            output.push_str(&quoted(value)?);
            output.push('\n');
        }
        ProjectedPropertyValueV1::Number(value) => {
            if !value.is_finite() {
                return Err(corrupt("Projected number is not finite"));
            }
            output.push(' ');
            output.push_str(
                &serde_json::Number::from_f64(*value)
                    .ok_or_else(|| corrupt("Projected number is not finite"))?
                    .to_string(),
            );
            output.push('\n');
        }
        ProjectedPropertyValueV1::Checkbox(value) => {
            output.push_str(if *value { " true\n" } else { " false\n" });
        }
        ProjectedPropertyValueV1::Identity(value) => {
            output.push('\n');
            render_identity(output, value, "      ", false)?;
        }
        ProjectedPropertyValueV1::Identities(values) if values.is_empty() => {
            output.push_str(" []\n");
        }
        ProjectedPropertyValueV1::Identities(values) => {
            output.push('\n');
            for value in values {
                render_identity(output, value, "      ", true)?;
            }
        }
        ProjectedPropertyValueV1::Relation(summary) => {
            validate_relation_summary(summary)?;
            output.push_str("\n      targets:");
            if summary.targets.is_empty() {
                output.push_str(" []\n");
            } else {
                output.push('\n');
                for target in &summary.targets {
                    render_identity(output, target, "        ", true)?;
                }
            }
            output.push_str("      total_count: ");
            output.push_str(&summary.total_count.to_string());
            output.push_str("\n      restricted_count: ");
            output.push_str(&summary.restricted_count.to_string());
            output.push_str("\n      has_more: ");
            output.push_str(if summary.has_more {
                "true\n"
            } else {
                "false\n"
            });
        }
    }
    Ok(())
}

fn render_identity(
    output: &mut String,
    identity: &ProjectedIdentityV1,
    indent: &str,
    sequence: bool,
) -> Result<(), StoreError> {
    bounded_identity(&identity.id, "Projected identity")?;
    bounded_name(&identity.name, "Projected identity name")?;
    output.push_str(indent);
    if sequence {
        output.push_str("- id: ");
    } else {
        output.push_str("id: ");
    }
    output.push_str(&quoted(&identity.id)?);
    output.push('\n');
    output.push_str(indent);
    if sequence {
        output.push_str("  ");
    }
    output.push_str("name: ");
    output.push_str(&quoted(&identity.name)?);
    output.push('\n');
    Ok(())
}

fn validate_projected_value(
    value_type: ProjectedPropertyTypeV1,
    value: &ProjectedPropertyValueV1,
) -> Result<(), StoreError> {
    let valid = matches!(value, ProjectedPropertyValueV1::Null)
        || matches!(
            (value_type, value),
            (
                ProjectedPropertyTypeV1::Text,
                ProjectedPropertyValueV1::Text(_)
            ) | (
                ProjectedPropertyTypeV1::Number,
                ProjectedPropertyValueV1::Number(_)
            ) | (
                ProjectedPropertyTypeV1::Checkbox,
                ProjectedPropertyValueV1::Checkbox(_)
            ) | (
                ProjectedPropertyTypeV1::Select,
                ProjectedPropertyValueV1::Identity(_)
            ) | (
                ProjectedPropertyTypeV1::MultiSelect,
                ProjectedPropertyValueV1::Identities(_)
            ) | (
                ProjectedPropertyTypeV1::Relation,
                ProjectedPropertyValueV1::Relation(_)
            ) | (
                ProjectedPropertyTypeV1::Date,
                ProjectedPropertyValueV1::Date(_)
            ) | (
                ProjectedPropertyTypeV1::Datetime,
                ProjectedPropertyValueV1::Datetime(_)
            )
        );
    if !valid {
        return Err(corrupt(
            "Projected Property value does not match its declared type",
        ));
    }
    match value {
        ProjectedPropertyValueV1::Text(value) => {
            bounded_text(value, "Projected text Property")?;
        }
        ProjectedPropertyValueV1::Number(value) if !value.is_finite() => {
            return Err(corrupt("Projected number is not finite"));
        }
        ProjectedPropertyValueV1::Date(value) => validate_date(value, "Projected date")?,
        ProjectedPropertyValueV1::Datetime(value) => {
            validate_datetime(value, "Projected datetime")?;
        }
        ProjectedPropertyValueV1::Relation(summary) => validate_relation_summary(summary)?,
        _ => {}
    }
    Ok(())
}

fn validate_relation_summary(value: &ProjectedRelationSummaryV1) -> Result<(), StoreError> {
    if value.total_count < 0
        || value.restricted_count < 0
        || value.targets.len() > 3
        || value.total_count < value.restricted_count + value.targets.len() as i64
        || value.has_more != (value.total_count > value.targets.len() as i64)
    {
        return Err(corrupt("Projected Relation summary is inconsistent"));
    }
    for target in &value.targets {
        bounded_identity(&target.id, "Relation target identity")?;
        bounded_name(&target.name, "Relation target name")?;
    }
    Ok(())
}

fn validate_schedule(value: &ProjectedScheduleV1) -> Result<(), StoreError> {
    let start = validate_datetime(&value.start, "Schedule start")?;
    let end = validate_datetime(&value.end, "Schedule end")?;
    if end <= start {
        return Err(corrupt("Page schedule end is not later than its start"));
    }
    if let Some(timezone) = &value.timezone {
        bounded_name(timezone, "Schedule timezone")?;
        timezone
            .parse::<chrono_tz::Tz>()
            .map_err(|_| corrupt("Page schedule timezone is not an IANA name"))?;
    }
    Ok(())
}

fn property_type_name(value: ProjectedPropertyTypeV1) -> &'static str {
    match value {
        ProjectedPropertyTypeV1::Text => "text",
        ProjectedPropertyTypeV1::Number => "number",
        ProjectedPropertyTypeV1::Checkbox => "checkbox",
        ProjectedPropertyTypeV1::Select => "select",
        ProjectedPropertyTypeV1::MultiSelect => "multi_select",
        ProjectedPropertyTypeV1::Date => "date",
        ProjectedPropertyTypeV1::Datetime => "datetime",
        ProjectedPropertyTypeV1::Relation => "relation",
    }
}

fn validate_date(value: &str, label: &str) -> Result<(), StoreError> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| corrupt(format!("{label} is not a YYYY-MM-DD date")))?;
    if parsed.format("%Y-%m-%d").to_string() == value {
        return Ok(());
    }
    Err(corrupt(format!("{label} is not canonical")))
}

fn validate_datetime(
    value: &str,
    label: &str,
) -> Result<DateTime<chrono::FixedOffset>, StoreError> {
    if !has_explicit_offset(value) {
        return Err(corrupt(format!(
            "{label} does not have an explicit RFC 3339 offset"
        )));
    }
    DateTime::parse_from_rfc3339(value)
        .map_err(|_| corrupt(format!("{label} is not valid RFC 3339")))
}

fn has_explicit_offset(value: &str) -> bool {
    value.ends_with('Z')
        || value.get(10..).is_some_and(|tail| {
            tail.contains('+') || tail.rfind('-').is_some_and(|index| index > 0)
        })
}

fn required_string<'a>(value: &'a Value, key: &str, label: &str) -> Result<&'a str, StoreError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| corrupt(format!("{label} is missing or invalid")))
}

fn bounded_identity<'a>(value: &'a str, label: &str) -> Result<&'a str, StoreError> {
    if !value.is_empty() && value.len() <= MAX_IDENTITY_BYTES && value.trim() == value {
        return Ok(value);
    }
    Err(corrupt(format!("{label} is not a bounded canonical ID")))
}

fn bounded_name<'a>(value: &'a str, label: &str) -> Result<&'a str, StoreError> {
    if !value.is_empty() && value.len() <= MAX_NAME_BYTES {
        return Ok(value);
    }
    Err(corrupt(format!("{label} is empty or oversized")))
}

fn bounded_text<'a>(value: &'a str, label: &str) -> Result<&'a str, StoreError> {
    if value.len() <= MAX_TEXT_BYTES {
        return Ok(value);
    }
    Err(corrupt(format!("{label} is oversized")))
}

fn quoted(value: &str) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|_| corrupt("Metadata string cannot be quoted"))
}

fn with_final_newline(value: &str) -> String {
    if value.ends_with('\n') {
        return value.to_owned();
    }
    format!("{value}\n")
}

fn etag_error(error: impl std::fmt::Display) -> StoreError {
    StoreError::new(
        StoreErrorCode::StoreCorrupt,
        format!("Page validator authority is unavailable: {error}"),
        false,
    )
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn unauthorized(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_yaml_preserves_schema_order_and_typed_values() {
        let value = PageMetaProjectionV2 {
            id: "page:one".to_owned(),
            page_key: Some("LAB-13".to_owned()),
            title_markdown: "Launch **plan**".to_owned(),
            properties: vec![
                ProjectedPropertyV1 {
                    property_id: "status".to_owned(),
                    name: "Status".to_owned(),
                    value_type: ProjectedPropertyTypeV1::Select,
                    value: ProjectedPropertyValueV1::Identity(ProjectedIdentityV1 {
                        id: "triage".to_owned(),
                        name: "Triage".to_owned(),
                    }),
                },
                ProjectedPropertyV1 {
                    property_id: "tags".to_owned(),
                    name: "Tags".to_owned(),
                    value_type: ProjectedPropertyTypeV1::MultiSelect,
                    value: ProjectedPropertyValueV1::Identities(vec![ProjectedIdentityV1 {
                        id: "native".to_owned(),
                        name: "Native".to_owned(),
                    }]),
                },
                ProjectedPropertyV1 {
                    property_id: "p_blocked0".to_owned(),
                    name: "Blocked by".to_owned(),
                    value_type: ProjectedPropertyTypeV1::Relation,
                    value: ProjectedPropertyValueV1::Relation(ProjectedRelationSummaryV1 {
                        targets: vec![ProjectedIdentityV1 {
                            id: "page:dependency".to_owned(),
                            name: "Dependency".to_owned(),
                        }],
                        total_count: 4,
                        restricted_count: 1,
                        has_more: true,
                    }),
                },
            ],
            schedule: Some(ProjectedScheduleV1 {
                start: "2026-07-20T09:00:00+08:00".to_owned(),
                end: "2026-07-20T10:00:00+08:00".to_owned(),
                timezone: Some("Asia/Shanghai".to_owned()),
                all_day: false,
            }),
        };

        assert_eq!(
            render_meta_yaml_v2(&value).expect("canonical metadata"),
            concat!(
                "id: \"page:one\"\n",
                "page_key: \"LAB-13\"\n",
                "title: \"Launch **plan**\"\n",
                "properties:\n",
                "  \"status\":\n",
                "    name: \"Status\"\n",
                "    type: select\n",
                "    value:\n",
                "      id: \"triage\"\n",
                "      name: \"Triage\"\n",
                "  \"tags\":\n",
                "    name: \"Tags\"\n",
                "    type: multi_select\n",
                "    value:\n",
                "      - id: \"native\"\n",
                "        name: \"Native\"\n",
                "  \"p_blocked0\":\n",
                "    name: \"Blocked by\"\n",
                "    type: relation\n",
                "    value:\n",
                "      targets:\n",
                "        - id: \"page:dependency\"\n",
                "          name: \"Dependency\"\n",
                "      total_count: 4\n",
                "      restricted_count: 1\n",
                "      has_more: true\n",
                "schedule:\n",
                "  start: \"2026-07-20T09:00:00+08:00\"\n",
                "  end: \"2026-07-20T10:00:00+08:00\"\n",
                "  timezone: \"Asia/Shanghai\"\n",
                "  all_day: false\n",
            )
        );
    }

    #[test]
    fn canonical_yaml_rejects_mismatched_property_variants() {
        let value = PageMetaProjectionV2 {
            id: "page:one".to_owned(),
            page_key: None,
            title_markdown: "Title".to_owned(),
            properties: vec![ProjectedPropertyV1 {
                property_id: "priority".to_owned(),
                name: "Priority".to_owned(),
                value_type: ProjectedPropertyTypeV1::Select,
                value: ProjectedPropertyValueV1::Text("o_high0000".to_owned()),
            }],
            schedule: None,
        };

        let error = render_meta_yaml_v2(&value).expect_err("mismatched value must fail");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
    }

    #[test]
    fn prepare_is_narrowly_bound_to_the_projected_file() {
        assert!(
            validate_prepare(
                LibraryPageProjectionFileKind::MetaYaml,
                Some(&LibraryPagePrepareKind::TitleSet)
            )
            .is_ok()
        );
        assert!(
            validate_prepare(
                LibraryPageProjectionFileKind::BodyNestedMarkdown,
                Some(&LibraryPagePrepareKind::DocumentReplace)
            )
            .is_ok()
        );
        assert!(
            validate_prepare(
                LibraryPageProjectionFileKind::BodyNestedMarkdown,
                Some(&LibraryPagePrepareKind::TitleSet)
            )
            .is_err()
        );
    }
}
