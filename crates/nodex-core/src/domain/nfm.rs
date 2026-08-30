use std::cmp::Ordering;

use serde_json::{Map, Value};
use thiserror::Error;

use super::block_materialization::MaterializedBlockNode;

pub(crate) const NFM_COLORS: &[&str] = &[
    "gray",
    "brown",
    "orange",
    "yellow",
    "green",
    "blue",
    "purple",
    "pink",
    "red",
    "gray_bg",
    "brown_bg",
    "orange_bg",
    "yellow_bg",
    "green_bg",
    "blue_bg",
    "purple_bg",
    "pink_bg",
    "red_bg",
];
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NfmStyleSet {
    pub bold: bool,
    pub italic: bool,
    pub strikethrough: bool,
    pub underline: bool,
    pub code: bool,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NfmInlineContent {
    Math {
        source: String,
    },
    Text {
        text: String,
        styles: NfmStyleSet,
    },
    Link {
        text: String,
        href: String,
        styles: NfmStyleSet,
    },
    LineBreak,
    Attachment {
        kind: String,
        mode: String,
        source: String,
        name: String,
        mime_type: Option<String>,
        bytes: Option<u64>,
        origin: Option<String>,
    },
    AgentConfig {
        mode: Option<String>,
        provider: Option<String>,
        model: Option<String>,
        reasoning: Option<String>,
        speed: Option<String>,
        permission: Option<String>,
        raw_attributes: Option<String>,
    },
    ThreadMention {
        uuid: String,
    },
    PageMention {
        target_page_id: String,
    },
    DateMention(NfmDateMention),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NfmDateMention {
    pub start: String,
    pub end: Option<String>,
    pub tz: Option<String>,
    pub format: Option<String>,
    pub time_format: Option<String>,
    pub reminder: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NfmTableColumn {
    pub width: Option<u64>,
    pub color: Option<String>,
    pub align: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NfmTableCell {
    pub content: Vec<NfmInlineContent>,
    pub color: Option<String>,
    pub colspan: Option<u64>,
    pub rowspan: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NfmTableRow {
    pub cells: Vec<NfmTableCell>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NfmBlock {
    Paragraph {
        content: Vec<NfmInlineContent>,
        color: Option<String>,
        children: Vec<NfmBlock>,
    },
    EmptyBlock {
        children: Vec<NfmBlock>,
    },
    Heading {
        level: u8,
        is_toggleable: bool,
        is_open: bool,
        content: Vec<NfmInlineContent>,
        color: Option<String>,
        children: Vec<NfmBlock>,
    },
    BulletListItem {
        content: Vec<NfmInlineContent>,
        color: Option<String>,
        children: Vec<NfmBlock>,
    },
    NumberedListItem {
        start: Option<u64>,
        content: Vec<NfmInlineContent>,
        color: Option<String>,
        children: Vec<NfmBlock>,
    },
    CheckListItem {
        checked: bool,
        content: Vec<NfmInlineContent>,
        color: Option<String>,
        children: Vec<NfmBlock>,
    },
    Toggle {
        is_open: bool,
        content: Vec<NfmInlineContent>,
        color: Option<String>,
        children: Vec<NfmBlock>,
    },
    Blockquote {
        content: Vec<NfmInlineContent>,
        color: Option<String>,
        children: Vec<NfmBlock>,
    },
    CodeBlock {
        language: String,
        code: String,
        children: Vec<NfmBlock>,
    },
    MathBlock {
        source: String,
    },
    Table {
        color: Option<String>,
        rows: Vec<NfmTableRow>,
        columns: Vec<NfmTableColumn>,
        header_row: bool,
        header_column: bool,
        fit_page_width: bool,
    },
    Callout {
        icon: Option<String>,
        content: Vec<NfmInlineContent>,
        color: Option<String>,
        children: Vec<NfmBlock>,
    },
    Image {
        source: String,
        caption: Vec<NfmInlineContent>,
        preview_width: Option<f64>,
        color: Option<String>,
        children: Vec<NfmBlock>,
    },
    DatabaseViewRef {
        database_view_id: String,
        display_hint: Option<String>,
    },
    Database {
        uuid: String,
    },
    Canvas {
        uuid: String,
    },
    SyncedBlockRef {
        source_block_id: String,
    },
    TemplateRef {
        source_block_id: String,
        display_hint: Option<String>,
    },
    Page {
        uuid: String,
    },
    PageRef {
        target_block_id: String,
    },
    ThreadSection {
        label: Option<String>,
        thread_id: Option<String>,
        children: Vec<NfmBlock>,
    },
    Divider {
        children: Vec<NfmBlock>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct NfmMaterialization {
    pub blocks: Vec<NfmBlock>,
    pub nfm: String,
    pub plain_text: String,
    pub preview: String,
}

#[derive(Debug, Error, PartialEq)]
pub enum NfmMaterializationError {
    #[error("Block {block_id} has unsupported materialized type {block_type}")]
    UnsupportedBlockType {
        block_id: String,
        block_type: String,
    },
    #[error("Block {block_id} has invalid {field}: {message}")]
    InvalidBlock {
        block_id: String,
        field: String,
        message: String,
    },
}

pub fn materialize_nfm(
    block_tree: &[MaterializedBlockNode],
) -> Result<NfmMaterialization, NfmMaterializationError> {
    let blocks = block_tree
        .iter()
        .map(materialize_block)
        .collect::<Result<Vec<_>, _>>()?;
    let nfm = if semantic_empty_document_root(block_tree).is_some() {
        String::new()
    } else {
        serialize_nfm(&blocks)
    };
    let plain_text = extract_plain_text(&blocks);
    let preview = build_preview(&plain_text);
    Ok(NfmMaterialization {
        blocks,
        nfm,
        plain_text,
        preview,
    })
}

pub fn serialize_nfm(blocks: &[NfmBlock]) -> String {
    serialize_blocks(blocks, 0).join("\n")
}

pub fn extract_plain_text(blocks: &[NfmBlock]) -> String {
    let mut parts = Vec::new();
    collect_block_text(blocks, &mut parts);
    parts
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn build_preview(plain_text: &str) -> String {
    if plain_text.encode_utf16().count() <= 240 {
        return plain_text.to_owned();
    }
    let mut units = 0usize;
    let mut boundary = 0usize;
    for (index, character) in plain_text.char_indices() {
        let next = units + character.len_utf16();
        if next > 240 {
            break;
        }
        units = next;
        boundary = index + character.len_utf8();
    }
    format!("{}...", plain_text[..boundary].trim_end())
}

pub fn semantic_empty_document_root(
    blocks: &[MaterializedBlockNode],
) -> Option<&MaterializedBlockNode> {
    let [root] = blocks else {
        return None;
    };
    (root.block_type == "paragraph"
        && root.children.is_empty()
        && matches!(&root.content, Some(Value::Array(content)) if content.is_empty()))
    .then_some(root)
}

fn materialize_block(block: &MaterializedBlockNode) -> Result<NfmBlock, NfmMaterializationError> {
    let children = block
        .children
        .iter()
        .map(materialize_block)
        .collect::<Result<Vec<_>, _>>()?;
    let color = props_to_color(&block.props);
    let inline = || materialize_inline(block.content.as_ref());

    let result = match block.block_type.as_str() {
        "paragraph" => {
            let content = inline();
            if content.is_empty() && color.is_none() {
                NfmBlock::EmptyBlock { children }
            } else {
                NfmBlock::Paragraph {
                    content,
                    color,
                    children,
                }
            }
        }
        "heading" => NfmBlock::Heading {
            level: number_prop(&block.props, "level")
                .unwrap_or(1.0)
                .clamp(1.0, 4.0) as u8,
            is_toggleable: bool_prop(&block.props, "isToggleable") == Some(true),
            is_open: false,
            content: inline(),
            color,
            children,
        },
        "bulletListItem" => NfmBlock::BulletListItem {
            content: inline(),
            color,
            children,
        },
        "numberedListItem" => NfmBlock::NumberedListItem {
            start: positive_integer_prop(&block.props, "start"),
            content: inline(),
            color,
            children,
        },
        "checkListItem" => NfmBlock::CheckListItem {
            checked: bool_prop(&block.props, "checked") == Some(true),
            content: inline(),
            color,
            children,
        },
        "toggleListItem" => NfmBlock::Toggle {
            is_open: false,
            content: inline(),
            color,
            children,
        },
        "quote" => NfmBlock::Blockquote {
            content: inline(),
            color,
            children,
        },
        "codeBlock" => NfmBlock::CodeBlock {
            language: normalize_code_language(string_prop(&block.props, "language")),
            code: extract_code_text(block.content.as_ref()),
            children,
        },
        "mathBlock" => NfmBlock::MathBlock {
            source: extract_code_text(block.content.as_ref()),
        },
        "table" => materialize_table(block, color)?,
        "callout" => NfmBlock::Callout {
            icon: non_empty_string_prop(&block.props, "icon"),
            content: inline(),
            color,
            children,
        },
        "image" => {
            let Some(source) = string_prop(&block.props, "url") else {
                return Err(invalid_block(block, "url", "image URL must be a string"));
            };
            NfmBlock::Image {
                source: source.trim().to_owned(),
                caption: string_prop(&block.props, "caption")
                    .filter(|value| !value.is_empty())
                    .map(parse_inline_content)
                    .unwrap_or_default(),
                preview_width: number_prop(&block.props, "previewWidth")
                    .filter(|value| value.is_finite() && *value > 0.0),
                color,
                children,
            }
        }
        "databaseViewRef" => NfmBlock::DatabaseViewRef {
            database_view_id: non_empty_string_prop(&block.props, "databaseViewId")
                .unwrap_or_default(),
            display_hint: non_empty_string_prop(&block.props, "displayHint"),
        },
        "database" => NfmBlock::Database {
            uuid: block.id.clone(),
        },
        "canvas" => NfmBlock::Canvas {
            uuid: block.id.clone(),
        },
        "syncedBlockRef" => NfmBlock::SyncedBlockRef {
            source_block_id: non_empty_string_prop(&block.props, "sourceBlockId")
                .unwrap_or_default(),
        },
        "templateRef" => NfmBlock::TemplateRef {
            source_block_id: non_empty_string_prop(&block.props, "sourceBlockId")
                .unwrap_or_default(),
            display_hint: non_empty_string_prop(&block.props, "displayHint"),
        },
        "page" => NfmBlock::Page {
            uuid: block.id.clone(),
        },
        "pageRef" => NfmBlock::PageRef {
            target_block_id: non_empty_string_prop(&block.props, "targetBlockId")
                .unwrap_or_default(),
        },
        "threadSection" => NfmBlock::ThreadSection {
            label: non_empty_string_prop(&block.props, "label"),
            thread_id: non_empty_string_prop(&block.props, "threadId"),
            children,
        },
        "divider" => NfmBlock::Divider { children },
        block_type => {
            return Err(NfmMaterializationError::UnsupportedBlockType {
                block_id: block.id.clone(),
                block_type: block_type.to_owned(),
            });
        }
    };
    Ok(result)
}

fn materialize_inline(content: Option<&Value>) -> Vec<NfmInlineContent> {
    let Some(Value::Array(items)) = content else {
        return Vec::new();
    };
    let mut output = Vec::new();
    for item in items {
        let Some(item) = item.as_object() else {
            continue;
        };
        match item.get("type").and_then(Value::as_str) {
            Some("attachment") => append_attachment(item, &mut output),
            Some("agentConfig") => append_agent_config(item, &mut output),
            Some("threadMention") => append_thread_mention(item, &mut output),
            Some("pageMention") => append_page_mention(item, &mut output),
            Some("dateMention") => append_date_mention(item, &mut output),
            Some("math") => append_math(item, &mut output),
            Some("link") => append_link(item, &mut output),
            Some("text") => append_text(item, &mut output),
            _ => {}
        }
    }
    output
}

fn append_math(item: &Map<String, Value>, output: &mut Vec<NfmInlineContent>) {
    let Some(source) = item.get("content").and_then(Value::as_str) else {
        return;
    };
    output.push(NfmInlineContent::Math {
        source: source.to_owned(),
    });
}

fn append_attachment(item: &Map<String, Value>, output: &mut Vec<NfmInlineContent>) {
    let Some(props) = item.get("props").and_then(Value::as_object) else {
        return;
    };
    let kind = map_string(props, "kind");
    let mode = map_string(props, "mode");
    let source = map_string(props, "source").filter(|value| !value.trim().is_empty());
    let name = map_string(props, "name").filter(|value| !value.trim().is_empty());
    if !matches!(kind, Some("text" | "file" | "folder"))
        || !matches!(mode, Some("materialized" | "link"))
        || source.is_none()
        || name.is_none()
    {
        return;
    }
    let kind = kind.expect("validated kind").to_owned();
    output.push(NfmInlineContent::Attachment {
        bytes: if kind == "folder" {
            None
        } else {
            map_number(props, "bytes")
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value.floor() as u64)
        },
        kind,
        mode: mode.expect("validated mode").to_owned(),
        source: source.expect("validated source").to_owned(),
        name: name.expect("validated name").to_owned(),
        mime_type: map_non_empty_string(props, "mimeType"),
        origin: map_non_empty_string(props, "origin"),
    });
}

fn append_agent_config(item: &Map<String, Value>, output: &mut Vec<NfmInlineContent>) {
    let props = item.get("props").and_then(Value::as_object);
    output.push(NfmInlineContent::AgentConfig {
        mode: props.and_then(|props| map_non_empty_string(props, "mode")),
        provider: props.and_then(|props| map_non_empty_string(props, "provider")),
        model: props.and_then(|props| map_non_empty_string(props, "model")),
        reasoning: props.and_then(|props| map_non_empty_string(props, "reasoning")),
        speed: props.and_then(|props| map_non_empty_string(props, "speed")),
        permission: props.and_then(|props| map_non_empty_string(props, "permission")),
        raw_attributes: props.and_then(|props| map_non_empty_string(props, "rawAttributes")),
    });
}

fn append_thread_mention(item: &Map<String, Value>, output: &mut Vec<NfmInlineContent>) {
    let uuid = item
        .get("props")
        .and_then(Value::as_object)
        .and_then(|props| map_string(props, "uuid"))
        .map(str::trim)
        .filter(|uuid| !uuid.is_empty());
    if let Some(uuid) = uuid {
        output.push(NfmInlineContent::ThreadMention {
            uuid: uuid.to_owned(),
        });
    }
}

fn append_page_mention(item: &Map<String, Value>, output: &mut Vec<NfmInlineContent>) {
    let target_page_id = item
        .get("props")
        .and_then(Value::as_object)
        .and_then(|props| map_string(props, "targetPageId"))
        .map(str::trim)
        .filter(|page_id| !page_id.is_empty());
    if let Some(target_page_id) = target_page_id {
        output.push(NfmInlineContent::PageMention {
            target_page_id: target_page_id.to_owned(),
        });
    }
}

fn append_date_mention(item: &Map<String, Value>, output: &mut Vec<NfmInlineContent>) {
    let Some(props) = item.get("props").and_then(Value::as_object) else {
        return;
    };
    if let Some(date) = normalize_date_mention(props) {
        output.push(NfmInlineContent::DateMention(date));
    }
}

fn append_link(item: &Map<String, Value>, output: &mut Vec<NfmInlineContent>) {
    let content = item
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = content
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<String>();
    let styles = content
        .first()
        .and_then(Value::as_object)
        .and_then(|item| item.get("styles"))
        .and_then(Value::as_object)
        .map(styles_from_json)
        .unwrap_or_default();
    let href = item
        .get("href")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    append_inline_with_linebreaks(output, text, styles, Some(href));
}

fn append_text(item: &Map<String, Value>, output: &mut Vec<NfmInlineContent>) {
    let text = item
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let styles = item
        .get("styles")
        .and_then(Value::as_object)
        .map(styles_from_json)
        .unwrap_or_default();
    append_inline_with_linebreaks(output, text, styles, None);
}

fn append_inline_with_linebreaks(
    output: &mut Vec<NfmInlineContent>,
    text: String,
    styles: NfmStyleSet,
    href: Option<String>,
) {
    let parts = text.split('\n').collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        if !part.is_empty() {
            output.push(match &href {
                Some(href) => NfmInlineContent::Link {
                    text: (*part).to_owned(),
                    href: href.clone(),
                    styles: styles.clone(),
                },
                None => NfmInlineContent::Text {
                    text: (*part).to_owned(),
                    styles: styles.clone(),
                },
            });
        }
        if index + 1 < parts.len() {
            output.push(NfmInlineContent::LineBreak);
        }
    }
}

fn styles_from_json(styles: &Map<String, Value>) -> NfmStyleSet {
    let text_color = map_string(styles, "textColor").and_then(normalize_text_color);
    let background = map_string(styles, "backgroundColor").and_then(normalize_background_color);
    NfmStyleSet {
        bold: map_bool(styles, "bold") == Some(true),
        italic: map_bool(styles, "italic") == Some(true),
        strikethrough: map_bool(styles, "strike") == Some(true),
        underline: map_bool(styles, "underline") == Some(true),
        code: map_bool(styles, "code") == Some(true),
        color: background.or(text_color),
    }
}

fn props_to_color(props: &std::collections::BTreeMap<String, Value>) -> Option<String> {
    string_prop(props, "backgroundColor")
        .and_then(normalize_background_color)
        .or_else(|| string_prop(props, "textColor").and_then(normalize_text_color))
}

fn normalize_text_color(value: &str) -> Option<String> {
    if value == "default" || value.ends_with("_bg") || !NFM_COLORS.contains(&value) {
        return None;
    }
    Some(value.to_owned())
}

fn normalize_background_color(value: &str) -> Option<String> {
    let candidate = format!("{}_bg", value.to_lowercase());
    NFM_COLORS
        .contains(&candidate.as_str())
        .then_some(candidate)
}

fn materialize_table(
    block: &MaterializedBlockNode,
    color: Option<String>,
) -> Result<NfmBlock, NfmMaterializationError> {
    let Some(content) = block.content.as_ref().and_then(Value::as_object) else {
        return Err(invalid_block(
            block,
            "content",
            "table content must be an object",
        ));
    };
    let source_rows = content
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let source_widths = content
        .get("columnWidths")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let source_cells = source_rows
        .iter()
        .map(|row| {
            row.as_object()
                .and_then(|row| row.get("cells"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let column_count = source_cells
        .iter()
        .map(Vec::len)
        .chain([source_widths.len(), 1])
        .max()
        .unwrap_or(1);
    let columns = (0..column_count)
        .map(|index| NfmTableColumn {
            width: source_widths
                .get(index)
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| value.floor() as u64),
            color: None,
            align: resolve_table_alignment(&source_cells, index),
        })
        .collect();
    let rows = if source_cells.is_empty() {
        vec![NfmTableRow {
            cells: vec![NfmTableCell::default(); column_count],
            color: None,
        }]
    } else {
        source_cells
            .iter()
            .map(|cells| NfmTableRow {
                cells: (0..column_count)
                    .map(|index| cells.get(index).map(read_table_cell).unwrap_or_default())
                    .collect(),
                color: None,
            })
            .collect()
    };
    Ok(NfmBlock::Table {
        color,
        rows,
        columns,
        header_row: content
            .get("headerRows")
            .and_then(Value::as_f64)
            .is_some_and(|value| value.is_finite() && value > 0.0),
        header_column: content
            .get("headerCols")
            .and_then(Value::as_f64)
            .is_some_and(|value| value.is_finite() && value > 0.0),
        fit_page_width: false,
    })
}

fn read_table_cell(value: &Value) -> NfmTableCell {
    if let Some(content) = value.as_array() {
        return NfmTableCell {
            content: materialize_inline(Some(&Value::Array(content.clone()))),
            ..NfmTableCell::default()
        };
    }
    let Some(cell) = value.as_object() else {
        return NfmTableCell::default();
    };
    let props = cell.get("props").and_then(Value::as_object);
    NfmTableCell {
        content: materialize_inline(cell.get("content")),
        color: props.and_then(props_map_to_color),
        colspan: props
            .and_then(|props| map_number(props, "colspan"))
            .filter(|value| value.is_finite() && *value > 1.0)
            .map(|value| value.floor() as u64),
        rowspan: props
            .and_then(|props| map_number(props, "rowspan"))
            .filter(|value| value.is_finite() && *value > 1.0)
            .map(|value| value.floor() as u64),
    }
}

fn props_map_to_color(props: &Map<String, Value>) -> Option<String> {
    map_string(props, "backgroundColor")
        .and_then(normalize_background_color)
        .or_else(|| map_string(props, "textColor").and_then(normalize_text_color))
}

fn resolve_table_alignment(rows: &[Vec<Value>], column_index: usize) -> Option<String> {
    let alignments = rows
        .iter()
        .filter_map(|row| row.get(column_index))
        .filter_map(Value::as_object)
        .filter_map(|cell| cell.get("props"))
        .filter_map(Value::as_object)
        .filter_map(|props| map_string(props, "textAlignment"))
        .filter(|value| matches!(*value, "left" | "center" | "right"))
        .collect::<Vec<_>>();
    let first = *alignments.first()?;
    if first == "left" || alignments.iter().any(|alignment| *alignment != first) {
        return None;
    }
    Some(first.to_owned())
}

fn serialize_blocks(blocks: &[NfmBlock], indent: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let prefix = "\t".repeat(indent);
    let ordered_starts = resolve_ordered_list_starts(blocks);
    for (index, block) in blocks.iter().enumerate() {
        match block {
            NfmBlock::Paragraph {
                content,
                color,
                children,
            } => {
                let text = serialize_inline_content(content);
                if text.is_empty() && color.is_none() {
                    lines.push(format!("{prefix}<empty-block/>"));
                } else {
                    lines.push(format!("{prefix}{text}{}", color_suffix(color)));
                }
                lines.extend(serialize_blocks(children, indent + 1));
            }
            NfmBlock::EmptyBlock { children } => {
                lines.push(format!("{prefix}<empty-block/>"));
                lines.extend(serialize_blocks(children, indent + 1));
            }
            NfmBlock::Heading {
                level,
                is_toggleable,
                is_open,
                content,
                color,
                children,
            } => {
                let toggle = if *is_toggleable {
                    if *is_open { "▼" } else { "▶" }
                } else {
                    ""
                };
                lines.push(format!(
                    "{prefix}{toggle}{} {}{}",
                    "#".repeat(*level as usize),
                    serialize_inline_content(content),
                    color_suffix(color)
                ));
                lines.extend(serialize_blocks(children, indent + 1));
            }
            NfmBlock::BulletListItem {
                content,
                color,
                children,
            } => {
                lines.push(format!(
                    "{prefix}- {}{}",
                    serialize_inline_content(content),
                    color_suffix(color)
                ));
                lines.extend(serialize_blocks(children, indent + 1));
            }
            NfmBlock::NumberedListItem {
                content,
                color,
                children,
                ..
            } => {
                lines.push(format!(
                    "{prefix}{}. {}{}",
                    ordered_starts[index].unwrap_or(1),
                    serialize_inline_content(content),
                    color_suffix(color)
                ));
                lines.extend(serialize_blocks(children, indent + 1));
            }
            NfmBlock::CheckListItem {
                checked,
                content,
                color,
                children,
            } => {
                lines.push(format!(
                    "{prefix}- [{}] {}{}",
                    if *checked { "x" } else { " " },
                    serialize_inline_content(content),
                    color_suffix(color)
                ));
                lines.extend(serialize_blocks(children, indent + 1));
            }
            NfmBlock::Toggle {
                is_open,
                content,
                color,
                children,
            } => {
                lines.push(format!(
                    "{prefix}{} {}{}",
                    if *is_open { "▼" } else { "▶" },
                    serialize_inline_content(content),
                    color_suffix(color)
                ));
                lines.extend(serialize_blocks(children, indent + 1));
            }
            NfmBlock::Blockquote {
                content,
                color,
                children,
            } => {
                lines.push(format!(
                    "{prefix}> {}{}",
                    serialize_inline_content(content),
                    color_suffix(color)
                ));
                lines.extend(serialize_blocks(children, indent + 1));
            }
            NfmBlock::CodeBlock {
                language,
                code,
                children,
            } => {
                let fence = select_code_fence(code);
                lines.push(format!("{prefix}{fence}{language}"));
                lines.extend(code.split('\n').map(|line| format!("{prefix}{line}")));
                lines.push(format!("{prefix}{fence}"));
                lines.extend(serialize_blocks(children, indent + 1));
            }
            NfmBlock::MathBlock { source } => {
                let fence = select_math_fence(source);
                lines.push(format!("{prefix}{fence}"));
                lines.extend(source.split('\n').map(|line| format!("{prefix}{line}")));
                lines.push(format!("{prefix}{fence}"));
            }
            NfmBlock::Table {
                color,
                rows,
                columns,
                header_row,
                header_column,
                fit_page_width,
            } => {
                lines.extend(serialize_table(
                    color,
                    rows,
                    columns,
                    *header_row,
                    *header_column,
                    *fit_page_width,
                    indent,
                ));
            }
            NfmBlock::Callout {
                icon,
                content,
                color,
                children,
            } => {
                let mut attrs = Vec::new();
                if let Some(icon) = icon {
                    attrs.push(format!("icon=\"{icon}\""));
                }
                if let Some(color) = color {
                    attrs.push(format!("color=\"{color}\""));
                }
                let suffix = if attrs.is_empty() {
                    String::new()
                } else {
                    format!(" {}", attrs.join(" "))
                };
                lines.push(format!("{prefix}<callout{suffix}>"));
                let text = serialize_inline_content(content);
                if !text.is_empty() {
                    lines.push(format!("{prefix}\t{text}"));
                }
                lines.extend(serialize_blocks(children, indent + 1));
                lines.push(format!("{prefix}</callout>"));
            }
            NfmBlock::Image {
                source,
                caption,
                preview_width,
                color,
                children,
            } => {
                let mut attrs = vec![format!("source=\"{}\"", escape_xml_attr(source))];
                if let Some(color) = color {
                    attrs.push(format!("color=\"{color}\""));
                }
                if let Some(width) = preview_width {
                    attrs.push(format!("preview-width=\"{}\"", format_number(*width)));
                }
                lines.push(format!(
                    "{prefix}<image {}>{}</image>",
                    attrs.join(" "),
                    serialize_inline_content(caption)
                ));
                lines.extend(serialize_blocks(children, indent + 1));
            }
            NfmBlock::DatabaseViewRef {
                database_view_id,
                display_hint,
            } => {
                let mut attrs = vec![format!(
                    "database-view=\"{}\"",
                    escape_xml_attr(database_view_id)
                )];
                if let Some(hint) = display_hint {
                    attrs.push(format!("display-hint=\"{}\"", escape_xml_attr(hint)));
                }
                lines.push(format!("{prefix}<database-view-ref {} />", attrs.join(" ")));
            }
            NfmBlock::Database { uuid } => lines.push(format!(
                "{prefix}<database uuid=\"{}\" />",
                escape_xml_attr(uuid)
            )),
            NfmBlock::Canvas { uuid } => lines.push(format!(
                "{prefix}<canvas uuid=\"{}\" />",
                escape_xml_attr(uuid)
            )),
            NfmBlock::SyncedBlockRef { source_block_id } => lines.push(format!(
                "{prefix}<synced-block-ref source-block=\"{}\" />",
                escape_xml_attr(source_block_id)
            )),
            NfmBlock::TemplateRef {
                source_block_id,
                display_hint,
            } => {
                let mut attrs = vec![format!(
                    "source-block=\"{}\"",
                    escape_xml_attr(source_block_id)
                )];
                if let Some(hint) = display_hint {
                    attrs.push(format!("display-hint=\"{}\"", escape_xml_attr(hint)));
                }
                lines.push(format!("{prefix}<template-ref {} />", attrs.join(" ")));
            }
            NfmBlock::Page { uuid } => lines.push(format!(
                "{prefix}<page uuid=\"{}\" />",
                escape_xml_attr(uuid)
            )),
            NfmBlock::PageRef { target_block_id } => lines.push(format!(
                "{prefix}<page-ref url=\"{}\" />",
                escape_xml_attr(&build_page_deep_link(target_block_id))
            )),
            NfmBlock::ThreadSection {
                label,
                thread_id,
                children,
            } => {
                let mut attrs = Vec::new();
                if let Some(label) = label.as_ref().filter(|value| !value.is_empty()) {
                    attrs.push(format!("label=\"{}\"", escape_xml_attr(label)));
                }
                if let Some(thread_id) = thread_id.as_ref().filter(|value| !value.is_empty()) {
                    attrs.push(format!("thread=\"{}\"", escape_xml_attr(thread_id)));
                }
                let suffix = if attrs.is_empty() {
                    String::new()
                } else {
                    format!(" {}", attrs.join(" "))
                };
                lines.push(format!("{prefix}<thread-section{suffix} />"));
                lines.extend(serialize_blocks(children, indent + 1));
            }
            NfmBlock::Divider { children } => {
                lines.push(format!("{prefix}---"));
                lines.extend(serialize_blocks(children, indent + 1));
            }
        }
    }
    lines
}

fn serialize_inline_content(items: &[NfmInlineContent]) -> String {
    items.iter().map(serialize_inline_item).collect()
}

pub(crate) fn serialize_inline_content_for_adapter(items: &[NfmInlineContent]) -> String {
    serialize_inline_content(items)
}

fn serialize_inline_item(item: &NfmInlineContent) -> String {
    match item {
        NfmInlineContent::Math { source } => serialize_inline_math(source),
        NfmInlineContent::LineBreak => "<br>".to_owned(),
        NfmInlineContent::Attachment {
            kind,
            mode,
            source,
            name,
            mime_type,
            bytes,
            origin,
        } => {
            let mut attrs = vec![
                format!("kind=\"{}\"", escape_xml_attr(kind)),
                format!("mode=\"{}\"", escape_xml_attr(mode)),
                format!("source=\"{}\"", escape_xml_attr(source)),
                format!("name=\"{}\"", escape_xml_attr(name)),
            ];
            if let Some(mime_type) = mime_type.as_ref().filter(|value| !value.is_empty()) {
                attrs.push(format!("mime=\"{}\"", escape_xml_attr(mime_type)));
            }
            if kind != "folder"
                && let Some(bytes) = bytes
            {
                attrs.push(format!("bytes=\"{bytes}\""));
            }
            if let Some(origin) = origin.as_ref().filter(|value| !value.is_empty()) {
                attrs.push(format!("origin=\"{}\"", escape_xml_attr(origin)));
            }
            format!("<attachment {} />", attrs.join(" "))
        }
        NfmInlineContent::AgentConfig {
            mode,
            provider,
            model,
            reasoning,
            speed,
            permission,
            raw_attributes,
        } => {
            let attrs = [
                ("mode", mode),
                ("provider", provider),
                ("model", model),
                ("reasoning", reasoning),
                ("speed", speed),
                ("permission", permission),
            ]
            .into_iter()
            .filter_map(|(name, value)| {
                value
                    .as_ref()
                    .filter(|value| !value.is_empty())
                    .map(|value| format!("{name}=\"{}\"", escape_xml_attr(value)))
            })
            .collect::<Vec<_>>();
            if !attrs.is_empty() {
                return format!("<agent-config {} />", attrs.join(" "));
            }
            if let Some(raw) = raw_attributes
                .as_deref()
                .map(str::trim)
                .filter(|raw| !raw.is_empty())
            {
                return format!("<agent-config {raw} />");
            }
            "<agent-config />".to_owned()
        }
        NfmInlineContent::ThreadMention { uuid } => {
            format!("<mention-thread uuid=\"{}\" />", escape_xml_attr(uuid))
        }
        NfmInlineContent::PageMention { target_page_id } => format!(
            "<mention-page url=\"{}\" />",
            escape_xml_attr(&build_page_deep_link(target_page_id))
        ),
        NfmInlineContent::DateMention(date) => {
            let attrs = serialize_date_mention_attrs(date);
            if attrs.is_empty() {
                String::new()
            } else {
                format!("<mention-date {attrs} />")
            }
        }
        NfmInlineContent::Link { text, href, styles } => {
            format!("[{}]({href})", apply_styles(escape_nfm(text), styles))
        }
        NfmInlineContent::Text { text, styles } if styles.code => {
            let longest_backtick_run = text
                .as_bytes()
                .split(|byte| *byte != b'`')
                .map(<[u8]>::len)
                .max()
                .unwrap_or_default();
            let fence = "`".repeat(longest_backtick_run + 1);
            if text.starts_with('`') || text.ends_with('`') {
                format!("{fence} {text} {fence}")
            } else {
                format!("{fence}{text}{fence}")
            }
        }
        NfmInlineContent::Text { text, styles } => apply_styles(escape_nfm(text), styles),
    }
}

fn serialize_inline_math(source: &str) -> String {
    if !source.is_empty()
        && !source.contains('\n')
        && !source.contains('$')
        && !source.contains('`')
        && source.trim() == source
    {
        return format!("${source}$");
    }

    let longest_backtick_run = source
        .as_bytes()
        .split(|byte| *byte != b'`')
        .map(<[u8]>::len)
        .max()
        .unwrap_or_default();
    let fence = "`".repeat(longest_backtick_run + 1);
    format!("${fence} {source} {fence}$")
}

fn apply_styles(mut text: String, styles: &NfmStyleSet) -> String {
    if text.is_empty() {
        return text;
    }
    if let Some(color) = &styles.color {
        text = format!("<span color=\"{color}\">{text}</span>");
    }
    if styles.underline {
        text = format!("<span underline=\"true\">{text}</span>");
    }
    if styles.strikethrough {
        text = format!("~~{text}~~");
    }
    if styles.italic {
        text = format!("*{text}*");
    }
    if styles.bold {
        text = format!("**{text}**");
    }
    text
}

fn serialize_table(
    color: &Option<String>,
    rows: &[NfmTableRow],
    columns: &[NfmTableColumn],
    header_row: bool,
    header_column: bool,
    fit_page_width: bool,
    indent: usize,
) -> Vec<String> {
    if can_serialize_table_as_gfm(
        color,
        rows,
        columns,
        header_row,
        header_column,
        fit_page_width,
    ) {
        return serialize_gfm_table(rows, columns, indent);
    }
    serialize_xml_table(
        color,
        rows,
        columns,
        header_row,
        header_column,
        fit_page_width,
        indent,
    )
}

fn can_serialize_table_as_gfm(
    color: &Option<String>,
    rows: &[NfmTableRow],
    columns: &[NfmTableColumn],
    header_row: bool,
    header_column: bool,
    fit_page_width: bool,
) -> bool {
    header_row
        && !header_column
        && !fit_page_width
        && color.is_none()
        && !rows.is_empty()
        && columns
            .iter()
            .all(|column| column.width.is_none() && column.color.is_none())
        && rows.iter().all(|row| {
            row.color.is_none()
                && row.cells.iter().all(|cell| {
                    cell.color.is_none() && cell.colspan.is_none() && cell.rowspan.is_none()
                })
        })
}

fn serialize_gfm_table(
    rows: &[NfmTableRow],
    columns: &[NfmTableColumn],
    indent: usize,
) -> Vec<String> {
    let prefix = "\t".repeat(indent);
    let row = |row: &NfmTableRow| {
        format!(
            "{prefix}| {} |",
            row.cells
                .iter()
                .map(|cell| serialize_inline_content(&cell.content))
                .collect::<Vec<_>>()
                .join(" | ")
        )
    };
    let mut lines = vec![row(&rows[0])];
    lines.push(format!(
        "{prefix}| {} |",
        columns
            .iter()
            .map(|column| match column.align.as_deref() {
                Some("left") => ":---",
                Some("center") => ":---:",
                Some("right") => "---:",
                _ => "---",
            })
            .collect::<Vec<_>>()
            .join(" | ")
    ));
    lines.extend(rows.iter().skip(1).map(row));
    lines
}

fn serialize_xml_table(
    color: &Option<String>,
    rows: &[NfmTableRow],
    columns: &[NfmTableColumn],
    header_row: bool,
    header_column: bool,
    fit_page_width: bool,
    indent: usize,
) -> Vec<String> {
    let prefix = "\t".repeat(indent);
    let mut attrs = vec![
        format!("header-row=\"{header_row}\""),
        format!("header-column=\"{header_column}\""),
        format!("fit-page-width=\"{fit_page_width}\""),
    ];
    if let Some(color) = color {
        attrs.push(format!("color=\"{color}\""));
    }
    let mut lines = vec![format!("{prefix}<table {}>", attrs.join(" "))];
    if columns
        .iter()
        .any(|column| column.width.is_some() || column.color.is_some() || column.align.is_some())
    {
        lines.push(format!("{prefix}\t<colgroup>"));
        for column in columns {
            let mut attrs = Vec::new();
            if let Some(width) = column.width {
                attrs.push(format!("width=\"{width}\""));
            }
            if let Some(color) = &column.color {
                attrs.push(format!("color=\"{color}\""));
            }
            if let Some(align) = &column.align {
                attrs.push(format!("align=\"{align}\""));
            }
            let suffix = if attrs.is_empty() {
                String::new()
            } else {
                format!(" {}", attrs.join(" "))
            };
            lines.push(format!("{prefix}\t\t<col{suffix} />"));
        }
        lines.push(format!("{prefix}\t</colgroup>"));
    }
    for row in rows {
        let suffix = row
            .color
            .as_ref()
            .map(|color| format!(" color=\"{color}\""))
            .unwrap_or_default();
        lines.push(format!("{prefix}\t<tr{suffix}>"));
        for cell in &row.cells {
            let mut attrs = Vec::new();
            if let Some(color) = &cell.color {
                attrs.push(format!("color=\"{color}\""));
            }
            if let Some(colspan) = cell.colspan {
                attrs.push(format!("colspan=\"{colspan}\""));
            }
            if let Some(rowspan) = cell.rowspan {
                attrs.push(format!("rowspan=\"{rowspan}\""));
            }
            let suffix = if attrs.is_empty() {
                String::new()
            } else {
                format!(" {}", attrs.join(" "))
            };
            lines.push(format!(
                "{prefix}\t\t<td{suffix}>{}</td>",
                serialize_inline_content(&cell.content)
            ));
        }
        lines.push(format!("{prefix}\t</tr>"));
    }
    lines.push(format!("{prefix}</table>"));
    lines
}

fn resolve_ordered_list_starts(blocks: &[NfmBlock]) -> Vec<Option<u64>> {
    let mut starts = Vec::with_capacity(blocks.len());
    let mut next_start = 1u64;
    for block in blocks {
        if let NfmBlock::NumberedListItem { start, .. } = block {
            let start = start.unwrap_or(next_start);
            starts.push(Some(start));
            next_start = start.saturating_add(1);
        } else {
            starts.push(None);
            next_start = 1;
        }
    }
    starts
}

fn collect_block_text(blocks: &[NfmBlock], parts: &mut Vec<String>) {
    for block in blocks {
        match block {
            NfmBlock::Paragraph {
                content, children, ..
            }
            | NfmBlock::Heading {
                content, children, ..
            }
            | NfmBlock::BulletListItem {
                content, children, ..
            }
            | NfmBlock::NumberedListItem {
                content, children, ..
            }
            | NfmBlock::CheckListItem {
                content, children, ..
            }
            | NfmBlock::Toggle {
                content, children, ..
            }
            | NfmBlock::Blockquote {
                content, children, ..
            }
            | NfmBlock::Callout {
                content, children, ..
            } => {
                collect_inline_text(content, parts);
                collect_block_text(children, parts);
            }
            NfmBlock::Image {
                caption, children, ..
            } => {
                collect_inline_text(caption, parts);
                collect_block_text(children, parts);
            }
            NfmBlock::CodeBlock { code, children, .. } => {
                parts.push(code.clone());
                collect_block_text(children, parts);
            }
            NfmBlock::MathBlock { source } => parts.push(source.clone()),
            NfmBlock::Table { rows, .. } => {
                for row in rows {
                    for cell in &row.cells {
                        collect_inline_text(&cell.content, parts);
                    }
                }
            }
            NfmBlock::PageRef { target_block_id } => {
                parts.push(build_page_deep_link(target_block_id))
            }
            NfmBlock::DatabaseViewRef {
                database_view_id,
                display_hint,
            } => {
                parts.push(display_hint.as_ref().unwrap_or(database_view_id).clone());
            }
            NfmBlock::SyncedBlockRef { source_block_id }
            | NfmBlock::TemplateRef {
                source_block_id, ..
            } => parts.push(source_block_id.clone()),
            NfmBlock::ThreadSection {
                label,
                thread_id,
                children,
            } => {
                if let Some(label) = label {
                    parts.push(label.clone());
                }
                if let Some(thread_id) = thread_id {
                    parts.push(thread_id.clone());
                }
                collect_block_text(children, parts);
            }
            NfmBlock::EmptyBlock { children } | NfmBlock::Divider { children } => {
                collect_block_text(children, parts);
            }
            NfmBlock::Canvas { .. } | NfmBlock::Database { .. } | NfmBlock::Page { .. } => {}
        }
    }
}

fn collect_inline_text(items: &[NfmInlineContent], parts: &mut Vec<String>) {
    for item in items {
        match item {
            NfmInlineContent::Math { source } => parts.push(source.clone()),
            NfmInlineContent::Text { text, .. } | NfmInlineContent::Link { text, .. } => {
                parts.push(text.clone())
            }
            NfmInlineContent::LineBreak => parts.push(" ".to_owned()),
            NfmInlineContent::ThreadMention { uuid } => parts.push(uuid.clone()),
            NfmInlineContent::PageMention { target_page_id } => {
                parts.push(build_page_deep_link(target_page_id));
            }
            NfmInlineContent::DateMention(date) => parts.push(format_date_plain_text(date)),
            NfmInlineContent::Attachment { name, .. } => parts.push(name.clone()),
            NfmInlineContent::AgentConfig {
                mode,
                model,
                reasoning,
                ..
            } => {
                parts.extend(
                    [mode, model, reasoning]
                        .into_iter()
                        .filter_map(Clone::clone),
                );
            }
        }
    }
}

fn normalize_date_mention(props: &Map<String, Value>) -> Option<NfmDateMention> {
    let start = normalize_date_value(map_string(props, "start")?)?;
    let start_kind = date_value_kind(&start)?;
    let raw_end = map_string(props, "end")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut end = raw_end.and_then(normalize_date_value);
    if raw_end.is_some() && end.is_none() {
        return None;
    }
    if end.as_deref().and_then(date_value_kind) != end.as_ref().map(|_| start_kind) {
        return None;
    }
    let mut start = start;
    if let Some(candidate_end) = &mut end
        && compare_date_values(&start, candidate_end) == Ordering::Greater
    {
        std::mem::swap(&mut start, candidate_end);
    }
    let format = map_string(props, "format")
        .filter(|value| {
            matches!(
                *value,
                "relative" | "ll" | "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY/MM/DD"
            )
        })
        .map(str::to_owned);
    let time_format = (start_kind == DateValueKind::DateTime)
        .then(|| map_string(props, "timeFormat"))
        .flatten()
        .filter(|value| matches!(*value, "12h" | "24h"))
        .map(str::to_owned);
    let tz = (start_kind == DateValueKind::DateTime)
        .then(|| map_non_empty_string(props, "tz"))
        .flatten();
    Some(NfmDateMention {
        start,
        end,
        tz,
        format,
        time_format,
        reminder: map_non_empty_string(props, "reminder"),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DateValueKind {
    Date,
    DateTime,
}

fn normalize_date_value(value: &str) -> Option<String> {
    let value = value.trim();
    if valid_iso_date(value) {
        return Some(value.to_owned());
    }
    if value.len() != 25 || value.as_bytes().get(10) != Some(&b'T') {
        return None;
    }
    let date = &value[..10];
    let time = &value[11..19];
    let offset = &value[19..];
    if !valid_iso_date(date) || !valid_iso_time(time) || !valid_utc_offset(offset) {
        return None;
    }
    Some(format!(
        "{date}T{}:00{}",
        &time[..5],
        normalize_utc_offset(offset)
    ))
}

fn date_value_kind(value: &str) -> Option<DateValueKind> {
    if valid_iso_date(value) {
        Some(DateValueKind::Date)
    } else if normalize_date_value(value).as_deref() == Some(value) {
        Some(DateValueKind::DateTime)
    } else {
        None
    }
}

fn valid_iso_date(value: &str) -> bool {
    if value.len() != 10 || &value[4..5] != "-" || &value[7..8] != "-" {
        return false;
    }
    let Some(year) = value[..4].parse::<i32>().ok() else {
        return false;
    };
    let Some(month) = value[5..7].parse::<u32>().ok() else {
        return false;
    };
    let Some(day) = value[8..].parse::<u32>().ok() else {
        return false;
    };
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max_day).contains(&day)
}

fn valid_iso_time(value: &str) -> bool {
    value.len() == 8
        && &value[2..3] == ":"
        && &value[5..6] == ":"
        && value[..2].parse::<u8>().is_ok_and(|value| value <= 23)
        && value[3..5].parse::<u8>().is_ok_and(|value| value <= 59)
        && value[6..].parse::<u8>().is_ok_and(|value| value <= 59)
}

fn valid_utc_offset(value: &str) -> bool {
    if matches!(value, "Z" | "z") {
        return true;
    }
    value.len() == 6
        && matches!(&value[..1], "+" | "-")
        && &value[3..4] == ":"
        && value[1..3].parse::<u8>().is_ok_and(|value| value <= 23)
        && value[4..].parse::<u8>().is_ok_and(|value| value <= 59)
}

fn normalize_utc_offset(value: &str) -> &str {
    if matches!(value, "Z" | "z") {
        "Z"
    } else {
        value
    }
}

fn compare_date_values(left: &str, right: &str) -> Ordering {
    if left.len() == 10 || right.len() == 10 {
        left.cmp(right)
    } else {
        datetime_minutes(left).cmp(&datetime_minutes(right))
    }
}

fn datetime_minutes(value: &str) -> i64 {
    let year = value[..4].parse::<i32>().unwrap_or_default();
    let month = value[5..7].parse::<u32>().unwrap_or(1);
    let day = value[8..10].parse::<u32>().unwrap_or(1);
    let hour = value[11..13].parse::<i64>().unwrap_or_default();
    let minute = value[14..16].parse::<i64>().unwrap_or_default();
    let offset = &value[19..];
    let offset_minutes = if matches!(offset, "Z" | "z") {
        0
    } else {
        let sign = if &offset[..1] == "-" { -1 } else { 1 };
        sign * (offset[1..3].parse::<i64>().unwrap_or_default() * 60
            + offset[4..].parse::<i64>().unwrap_or_default())
    };
    days_from_civil(year, month, day) * 1_440 + hour * 60 + minute - offset_minutes
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month as i32;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    (era * 146_097 + day_of_era - 719_468) as i64
}

fn is_leap_year(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn serialize_date_mention_attrs(date: &NfmDateMention) -> String {
    let mut attrs = vec![format!("start=\"{}\"", escape_xml_attr(&date.start))];
    for (name, value) in [
        ("end", &date.end),
        ("tz", &date.tz),
        ("format", &date.format),
        ("time-format", &date.time_format),
        ("reminder", &date.reminder),
    ] {
        if let Some(value) = value {
            attrs.push(format!("{name}=\"{}\"", escape_xml_attr(value)));
        }
    }
    attrs.join(" ")
}

fn format_date_plain_text(date: &NfmDateMention) -> String {
    let start = format_date_value(
        &date.start,
        date.format.as_deref(),
        date.time_format.as_deref(),
    );
    match &date.end {
        Some(end) => format!(
            "@{start} → {}",
            format_date_value(end, date.format.as_deref(), date.time_format.as_deref())
        ),
        None => format!("@{start}"),
    }
}

fn format_date_value(value: &str, date_format: Option<&str>, time_format: Option<&str>) -> String {
    let date = format_date_part(&value[..10], date_format);
    if value.len() == 10 {
        return date;
    }
    format!("{date} {}", format_time_part(&value[11..16], time_format))
}

fn format_date_part(value: &str, format: Option<&str>) -> String {
    let year = &value[..4];
    let month = &value[5..7];
    let day = &value[8..10];
    match format.unwrap_or("relative") {
        "MM/DD/YYYY" => format!("{month}/{day}/{year}"),
        "DD/MM/YYYY" => format!("{day}/{month}/{year}"),
        "YYYY/MM/DD" => format!("{year}/{month}/{day}"),
        _ => {
            let month_name = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ][month
                .parse::<usize>()
                .unwrap_or(1)
                .saturating_sub(1)
                .min(11)];
            format!(
                "{month_name} {}, {year}",
                day.parse::<u8>().unwrap_or_default()
            )
        }
    }
}

fn format_time_part(value: &str, format: Option<&str>) -> String {
    let hour = value[..2].parse::<u8>().unwrap_or_default();
    let minute = &value[3..];
    if format == Some("24h") {
        return format!("{hour:02}:{minute}");
    }
    let suffix = if hour < 12 { "AM" } else { "PM" };
    let display_hour = match hour % 12 {
        0 => 12,
        value => value,
    };
    format!("{display_hour}:{minute} {suffix}")
}

pub(crate) fn parse_inline_content(input: &str) -> Vec<NfmInlineContent> {
    InlineParser::new(input).parse_run(NfmStyleSet::default(), &[])
}

struct InlineParser<'a> {
    input: &'a str,
    position: usize,
}

impl<'a> InlineParser<'a> {
    fn new(input: &'a str) -> Self {
        Self { input, position: 0 }
    }

    fn parse_run(&mut self, styles: NfmStyleSet, terminators: &[&str]) -> Vec<NfmInlineContent> {
        let mut items = Vec::new();
        let mut text = String::new();
        while self.position < self.input.len() {
            if terminators
                .iter()
                .any(|value| self.rest().starts_with(value))
            {
                break;
            }
            if self.rest().starts_with('\\') {
                let mut chars = self.rest().chars();
                chars.next();
                if let Some(character) = chars.next().filter(|value| is_nfm_escapable(*value)) {
                    text.push(character);
                    self.position += 1 + character.len_utf8();
                    continue;
                }
            }
            if self.rest().starts_with("<br>") {
                flush_inline_text(&mut text, &styles, &mut items);
                items.push(NfmInlineContent::LineBreak);
                self.position += 4;
                continue;
            }
            if let Some(item) = self.try_parse_tag() {
                flush_inline_text(&mut text, &styles, &mut items);
                items.push(item);
                continue;
            }
            if let Some(mut span_items) = self.try_parse_span(&styles) {
                flush_inline_text(&mut text, &styles, &mut items);
                items.append(&mut span_items);
                continue;
            }
            if self.rest().starts_with('$')
                && !styles.code
                && let Some(math) = self.try_parse_math()
            {
                flush_inline_text(&mut text, &styles, &mut items);
                items.push(math);
                continue;
            }
            if self.rest().starts_with('`') && !styles.code {
                let fence_length = self
                    .rest()
                    .as_bytes()
                    .iter()
                    .take_while(|byte| **byte == b'`')
                    .count();
                let start = self.position + fence_length;
                if let Some(end) =
                    find_exact_backtick_run(self.input.as_bytes(), start, fence_length)
                {
                    flush_inline_text(&mut text, &styles, &mut items);
                    let mut code_text = &self.input[start..end];
                    if code_text.starts_with(' ')
                        && code_text.ends_with(' ')
                        && !code_text.trim().is_empty()
                    {
                        code_text = &code_text[1..code_text.len() - 1];
                    }
                    items.push(NfmInlineContent::Text {
                        text: code_text.to_owned(),
                        styles: NfmStyleSet {
                            code: true,
                            ..styles.clone()
                        },
                    });
                    self.position = end + fence_length;
                    continue;
                }
            }
            if self.rest().starts_with("**") && !styles.bold {
                flush_inline_text(&mut text, &styles, &mut items);
                self.position += 2;
                let mut nested = styles.clone();
                nested.bold = true;
                items.extend(self.parse_run(nested, &["**"]));
                if self.rest().starts_with("**") {
                    self.position += 2;
                }
                continue;
            }
            if self.rest().starts_with("~~") && !styles.strikethrough {
                flush_inline_text(&mut text, &styles, &mut items);
                self.position += 2;
                let mut nested = styles.clone();
                nested.strikethrough = true;
                items.extend(self.parse_run(nested, &["~~"]));
                if self.rest().starts_with("~~") {
                    self.position += 2;
                }
                continue;
            }
            if self.rest().starts_with('*') && !self.rest().starts_with("**") && !styles.italic {
                flush_inline_text(&mut text, &styles, &mut items);
                self.position += 1;
                let mut nested = styles.clone();
                nested.italic = true;
                items.extend(self.parse_run(nested, &["*"]));
                if self.rest().starts_with('*') {
                    self.position += 1;
                }
                continue;
            }
            if let Some(link) = self.try_parse_link(&styles) {
                flush_inline_text(&mut text, &styles, &mut items);
                items.push(link);
                continue;
            }
            let character = self.rest().chars().next().expect("remaining character");
            text.push(character);
            self.position += character.len_utf8();
        }
        flush_inline_text(&mut text, &styles, &mut items);
        items
    }

    fn try_parse_tag(&mut self) -> Option<NfmInlineContent> {
        let tag = [
            "<attachment",
            "<agent-config",
            "<mention-thread",
            "<mention-page",
            "<mention-date",
        ]
        .into_iter()
        .find(|tag| self.rest().starts_with(tag))?;
        let end = self.rest().find("/>")?;
        let raw = &self.rest()[tag.len()..end];
        let attrs = parse_xml_attrs(raw);
        let item = match tag {
            "<attachment" => {
                let kind = attrs.get("kind")?;
                let mode = attrs.get("mode")?;
                let source = attrs.get("source")?;
                let name = attrs.get("name")?;
                if !matches!(kind.as_str(), "text" | "file" | "folder")
                    || !matches!(mode.as_str(), "materialized" | "link")
                    || source.is_empty()
                    || name.is_empty()
                {
                    return None;
                }
                NfmInlineContent::Attachment {
                    kind: kind.clone(),
                    mode: mode.clone(),
                    source: source.clone(),
                    name: name.clone(),
                    mime_type: attrs.get("mime").filter(|value| !value.is_empty()).cloned(),
                    bytes: attrs
                        .get("bytes")
                        .and_then(|value| value.parse::<u64>().ok()),
                    origin: attrs
                        .get("origin")
                        .filter(|value| !value.is_empty())
                        .cloned(),
                }
            }
            "<agent-config" => NfmInlineContent::AgentConfig {
                mode: attrs.get("mode").filter(|value| !value.is_empty()).cloned(),
                provider: attrs
                    .get("provider")
                    .filter(|value| !value.is_empty())
                    .cloned(),
                model: attrs
                    .get("model")
                    .filter(|value| !value.is_empty())
                    .cloned(),
                reasoning: attrs
                    .get("reasoning")
                    .filter(|value| !value.is_empty())
                    .cloned(),
                speed: attrs
                    .get("speed")
                    .filter(|value| !value.is_empty())
                    .cloned(),
                permission: attrs
                    .get("permission")
                    .filter(|value| !value.is_empty())
                    .cloned(),
                raw_attributes: (!raw.trim().is_empty()).then(|| raw.trim_start().to_owned()),
            },
            "<mention-thread" => {
                let uuid = attrs.get("uuid")?.trim();
                if uuid.is_empty() {
                    return None;
                }
                NfmInlineContent::ThreadMention {
                    uuid: uuid.to_owned(),
                }
            }
            "<mention-page" => {
                if attrs.len() != 1 {
                    return None;
                }
                let url = attrs.get("url")?;
                let target_page_id = parse_page_deep_link(url)?;
                NfmInlineContent::PageMention { target_page_id }
            }
            "<mention-date" => {
                NfmInlineContent::DateMention(normalize_date_mention(&attrs_to_json(&attrs))?)
            }
            _ => return None,
        };
        self.position += end + 2;
        Some(item)
    }

    fn try_parse_math(&mut self) -> Option<NfmInlineContent> {
        if !inline_math_boundary_before(self.input, self.position) {
            return None;
        }
        let source_start = self.position + 1;
        let bytes = self.input.as_bytes();

        if bytes.get(source_start) == Some(&b'`') {
            let fence_length = bytes[source_start..]
                .iter()
                .take_while(|byte| **byte == b'`')
                .count();
            let content_start = source_start + fence_length;
            let source_end = find_exact_backtick_run(bytes, content_start, fence_length)?;
            let closing_dollar = source_end + fence_length;
            if bytes.get(closing_dollar) != Some(&b'$')
                || !inline_math_boundary_after(self.input, closing_dollar + 1)
            {
                return None;
            }
            let mut source = &self.input[content_start..source_end];
            if source.starts_with(' ') && source.ends_with(' ') && source.len() >= 2 {
                source = &source[1..source.len() - 1];
            }
            self.position = closing_dollar + 1;
            return Some(NfmInlineContent::Math {
                source: source.to_owned(),
            });
        }

        let first = self.input[source_start..].chars().next()?;
        if first.is_whitespace() {
            return None;
        }
        let mut cursor = source_start;
        while cursor < self.input.len() {
            let character = self.input[cursor..].chars().next()?;
            if character == '\\' {
                cursor += character.len_utf8();
                if cursor < self.input.len() {
                    cursor += self.input[cursor..].chars().next()?.len_utf8();
                }
                continue;
            }
            if character != '$' {
                cursor += character.len_utf8();
                continue;
            }
            let source = &self.input[source_start..cursor];
            if !source.is_empty()
                && source
                    .chars()
                    .next_back()
                    .is_some_and(|character| !character.is_whitespace())
                && inline_math_boundary_after(self.input, cursor + 1)
            {
                self.position = cursor + 1;
                return Some(NfmInlineContent::Math {
                    source: source.to_owned(),
                });
            }
            cursor += 1;
        }
        None
    }

    fn try_parse_span(&mut self, styles: &NfmStyleSet) -> Option<Vec<NfmInlineContent>> {
        if !self.rest().starts_with("<span ") {
            return None;
        }
        let open_end = self.rest().find('>')?;
        let opening = &self.rest()[6..open_end];
        let mut nested = styles.clone();
        if opening == "underline=\"true\"" {
            nested.underline = true;
        } else {
            let color = opening
                .strip_prefix("color=\"")
                .or_else(|| opening.strip_prefix("color?=\""))?
                .strip_suffix('"')?;
            if NFM_COLORS.contains(&color) {
                nested.color = Some(color.to_owned());
            }
        }
        if !self.rest()[open_end + 1..].contains("</span>") {
            return None;
        }
        self.position += open_end + 1;
        let items = self.parse_run(nested, &["</span>"]);
        if self.rest().starts_with("</span>") {
            self.position += 7;
        }
        Some(items)
    }

    fn try_parse_link(&mut self, styles: &NfmStyleSet) -> Option<NfmInlineContent> {
        if !self.rest().starts_with('[') {
            return None;
        }
        let rest = self.rest();
        let mut depth = 0usize;
        let mut label_end = None;
        let mut cursor = 1usize;
        while cursor < rest.len() {
            let character = rest[cursor..].chars().next()?;
            if character == '\\' {
                cursor += character.len_utf8();
                if cursor < rest.len() {
                    cursor += rest[cursor..].chars().next()?.len_utf8();
                }
                continue;
            }
            if character == '[' {
                depth += 1;
            } else if character == ']' {
                if depth == 0 {
                    label_end = Some(cursor);
                    break;
                }
                depth -= 1;
            }
            cursor += character.len_utf8();
        }
        let label_end = label_end?;
        if !rest[label_end + 1..].starts_with('(') {
            return None;
        }
        let url_start = label_end + 2;
        let mut paren_depth = 0usize;
        let mut url_end = None;
        cursor = url_start;
        while cursor < rest.len() {
            let character = rest[cursor..].chars().next()?;
            if character == '(' {
                paren_depth += 1;
            } else if character == ')' {
                if paren_depth == 0 {
                    url_end = Some(cursor);
                    break;
                }
                paren_depth -= 1;
            }
            cursor += character.len_utf8();
        }
        let url_end = url_end?;
        let raw_label = &rest[1..label_end];
        let parsed = parse_inline_content(raw_label);
        let (text, label_styles) = match parsed.as_slice() {
            [NfmInlineContent::Text { text, styles }] => (text.clone(), styles.clone()),
            _ => (unescape_nfm(raw_label), NfmStyleSet::default()),
        };
        let mut merged = styles.clone();
        merge_styles(&mut merged, &label_styles);
        let href = rest[url_start..url_end].to_owned();
        self.position += url_end + 1;
        Some(NfmInlineContent::Link {
            text,
            href,
            styles: merged,
        })
    }

    fn rest(&self) -> &'a str {
        &self.input[self.position..]
    }
}

fn inline_math_boundary_before(input: &str, position: usize) -> bool {
    position == 0
        || input[..position]
            .chars()
            .next_back()
            .is_some_and(|character| character.is_whitespace() || "([{“‘".contains(character))
}

fn inline_math_boundary_after(input: &str, position: usize) -> bool {
    position == input.len()
        || input[position..]
            .chars()
            .next()
            .is_some_and(|character| character.is_whitespace() || ".,;:!?)]}”’".contains(character))
}

fn find_exact_backtick_run(input: &[u8], start: usize, fence_length: usize) -> Option<usize> {
    let mut cursor = start;
    while cursor < input.len() {
        if input[cursor] != b'`' {
            cursor += 1;
            continue;
        }
        let run_start = cursor;
        while cursor < input.len() && input[cursor] == b'`' {
            cursor += 1;
        }
        if cursor - run_start == fence_length {
            return Some(run_start);
        }
    }
    None
}

fn flush_inline_text(text: &mut String, styles: &NfmStyleSet, output: &mut Vec<NfmInlineContent>) {
    if text.is_empty() {
        return;
    }
    output.push(NfmInlineContent::Text {
        text: std::mem::take(text),
        styles: styles.clone(),
    });
}

fn merge_styles(target: &mut NfmStyleSet, source: &NfmStyleSet) {
    target.bold |= source.bold;
    target.italic |= source.italic;
    target.strikethrough |= source.strikethrough;
    target.underline |= source.underline;
    target.code |= source.code;
    if source.color.is_some() {
        target.color.clone_from(&source.color);
    }
}

pub(crate) fn parse_xml_attrs(input: &str) -> std::collections::BTreeMap<String, String> {
    let mut attrs = std::collections::BTreeMap::new();
    let bytes = input.as_bytes();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let name_start = cursor;
        while cursor < bytes.len()
            && (bytes[cursor].is_ascii_alphanumeric() || matches!(bytes[cursor], b'_' | b'-'))
        {
            cursor += 1;
        }
        if cursor == name_start || bytes.get(cursor..cursor + 2) != Some(b"=\"") {
            cursor = cursor.saturating_add(1);
            continue;
        }
        let name = &input[name_start..cursor];
        cursor += 2;
        let value_start = cursor;
        while cursor < bytes.len() && bytes[cursor] != b'"' {
            cursor += 1;
        }
        if cursor >= bytes.len() {
            break;
        }
        attrs.insert(
            name.to_owned(),
            unescape_xml_attr(&input[value_start..cursor]),
        );
        cursor += 1;
    }
    attrs
}

fn attrs_to_json(attrs: &std::collections::BTreeMap<String, String>) -> Map<String, Value> {
    attrs
        .iter()
        .map(|(key, value)| {
            let key = if key == "time-format" {
                "timeFormat".to_owned()
            } else {
                key.clone()
            };
            (key, Value::String(value.clone()))
        })
        .collect()
}

fn map_string<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}
fn map_non_empty_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map_string(map, key)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}
fn map_number(map: &Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64)
}
fn map_bool(map: &Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}
fn string_prop<'a>(
    props: &'a std::collections::BTreeMap<String, Value>,
    key: &str,
) -> Option<&'a str> {
    props.get(key).and_then(Value::as_str)
}
fn non_empty_string_prop(
    props: &std::collections::BTreeMap<String, Value>,
    key: &str,
) -> Option<String> {
    string_prop(props, key)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}
fn number_prop(props: &std::collections::BTreeMap<String, Value>, key: &str) -> Option<f64> {
    props.get(key).and_then(Value::as_f64)
}
fn bool_prop(props: &std::collections::BTreeMap<String, Value>, key: &str) -> Option<bool> {
    props.get(key).and_then(Value::as_bool)
}
fn positive_integer_prop(
    props: &std::collections::BTreeMap<String, Value>,
    key: &str,
) -> Option<u64> {
    number_prop(props, key)
        .filter(|value| value.is_finite() && *value > 0.0 && value.fract() == 0.0)
        .map(|value| value as u64)
}
fn normalize_code_language(value: Option<&str>) -> String {
    let value = value.unwrap_or_default().trim();
    if value == "text" {
        String::new()
    } else {
        value.to_owned()
    }
}
fn extract_code_text(content: Option<&Value>) -> String {
    let Some(Value::Array(items)) = content else {
        return String::new();
    };
    items
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect()
}
fn select_code_fence(code: &str) -> String {
    let mut current = 0usize;
    let mut longest = 0usize;
    for character in code.chars() {
        if character == '`' {
            current += 1;
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    "`".repeat(3.max(longest + 1))
}
fn select_math_fence(source: &str) -> String {
    let longest = source
        .split('\n')
        .filter(|line| line.len() >= 2 && line.bytes().all(|byte| byte == b'$'))
        .map(str::len)
        .max()
        .unwrap_or_default();
    "$".repeat(2.max(longest + 1))
}
fn color_suffix(color: &Option<String>) -> String {
    color
        .as_ref()
        .map(|color| format!(" {{color=\"{color}\"}}"))
        .unwrap_or_default()
}
fn escape_nfm(input: &str) -> String {
    input
        .chars()
        .flat_map(|character| {
            if is_nfm_escapable(character) {
                vec!['\\', character]
            } else {
                vec![character]
            }
        })
        .collect()
}
fn unescape_nfm(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\' && chars.peek().is_some_and(|value| is_nfm_escapable(*value)) {
            output.push(chars.next().expect("peeked character"));
        } else {
            output.push(character);
        }
    }
    output
}
fn is_nfm_escapable(character: char) -> bool {
    matches!(
        character,
        '\\' | '*' | '~' | '`' | '$' | '[' | ']' | '<' | '>' | '{' | '}' | '|' | '^'
    )
}
fn escape_xml_attr(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&#39;")
}
fn unescape_xml_attr(input: &str) -> String {
    input
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}
fn build_page_deep_link(page_id: &str) -> String {
    format!("nodex://pages/{}", encode_uri_component(page_id))
}
pub(super) fn parse_page_deep_link(value: &str) -> Option<String> {
    let path = value
        .strip_prefix("nodex://pages/")
        .or_else(|| value.strip_prefix("nodex:/pages/"))?;
    percent_decode(path).filter(|value| !value.trim().is_empty() && value.trim() == value)
}
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::new();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if bytes[cursor] == b'%' {
            let encoded = std::str::from_utf8(bytes.get(cursor + 1..cursor + 3)?).ok()?;
            output.push(u8::from_str_radix(encoded, 16).ok()?);
            cursor += 3;
        } else {
            output.push(bytes[cursor]);
            cursor += 1;
        }
    }
    String::from_utf8(output).ok()
}
fn encode_uri_component(input: &str) -> String {
    let mut output = String::new();
    for byte in input.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                *byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            output.push(char::from(*byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}
fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}
fn invalid_block(
    block: &MaterializedBlockNode,
    field: &str,
    message: impl Into<String>,
) -> NfmMaterializationError {
    NfmMaterializationError::InvalidBlock {
        block_id: block.id.clone(),
        field: field.to_owned(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::create_compatible_document;
    use crate::domain::block_materialization::materialize_block_tree;
    use crate::domain::block_tree::decode_block_tree;
    use serde_json::Value;
    use std::path::PathBuf;
    use yrs::updates::decoder::Decode;
    use yrs::{ReadTxn, Transact, Update};

    fn matrix() -> (Vec<MaterializedBlockNode>, Value) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/yjs-yrs");
        let document = create_compatible_document("nfm-matrix");
        let update = std::fs::read(root.join("matrix-base.bin")).expect("matrix fixture");
        document
            .transact_mut()
            .apply_update(Update::decode_v1(&update).expect("valid fixture"))
            .expect("fixture applies");
        let transaction = document.transact();
        let body = transaction.get_xml_fragment("body").expect("body root");
        let tree = decode_block_tree(&body, &transaction).expect("BlockTree");
        let blocks = materialize_block_tree(&tree).expect("BlockNote materialization");
        let expected = serde_json::from_slice(
            &std::fs::read(root.join("matrix-materialization.json")).expect("oracle fixture"),
        )
        .expect("valid oracle fixture");
        (blocks, expected)
    }

    #[test]
    fn matches_the_typescript_nfm_text_and_preview_oracle() {
        let (blocks, expected) = matrix();
        let actual = materialize_nfm(&blocks).expect("NFM materialization");
        assert_eq!(actual.nfm, expected["nfm"]);
        assert_eq!(actual.plain_text, expected["plainText"]);
        assert_eq!(actual.preview, expected["preview"]);
    }

    #[test]
    fn parses_and_canonicalizes_image_caption_inline_nfm() {
        let parsed = parse_inline_content(
            r#"**bold**<br><mention-thread uuid="thread-1" />[link](https://nodex.local)"#,
        );
        assert_eq!(
            serialize_inline_content(&parsed),
            r#"**bold**<br><mention-thread uuid="thread-1" />[link](https://nodex.local)"#
        );
    }

    #[test]
    fn round_trips_canonical_page_mentions_and_keeps_invalid_tags_literal() {
        let canonical = r#"See <mention-page url="nodex://pages/page-1" /> now"#;
        assert_eq!(
            serialize_inline_content(&parse_inline_content(canonical)),
            canonical,
        );

        for invalid in [
            r#"<mention-page />"#,
            r#"<mention-page url="https://example.com" />"#,
            r#"<mention-page url="nodex://pages/page-1" title="Page" />"#,
        ] {
            assert_eq!(
                parse_inline_content(invalid),
                vec![NfmInlineContent::Text {
                    text: invalid.to_owned(),
                    styles: NfmStyleSet::default(),
                }],
            );
        }
    }

    #[test]
    fn round_trips_variable_length_inline_code_fences() {
        for code in [
            "/tmp/Nodex/Default `draft` [one] *two*",
            "`boundary`",
            "two `` interior backticks",
        ] {
            let expected = NfmInlineContent::Text {
                text: code.to_owned(),
                styles: NfmStyleSet {
                    code: true,
                    ..NfmStyleSet::default()
                },
            };
            let serialized = serialize_inline_content(std::slice::from_ref(&expected));
            assert_eq!(parse_inline_content(&serialized), vec![expected]);
        }
    }

    #[test]
    fn round_trips_simple_and_protected_inline_equations() {
        for source in ["E = mc^2", "price = $5 and `raw`", " leading and trailing "] {
            let expected = NfmInlineContent::Math {
                source: source.to_owned(),
            };
            let serialized = serialize_inline_content(std::slice::from_ref(&expected));
            assert_eq!(parse_inline_content(&serialized), vec![expected]);
        }

        let punctuated = "Energy is $E = mc^2$. See ($x + 1$).";
        assert_eq!(
            serialize_inline_content(&parse_inline_content(punctuated)),
            punctuated,
        );
    }

    #[test]
    fn preview_uses_the_typescript_utf16_budget() {
        let text = format!("{}😀 tail", "a".repeat(239));
        assert_eq!(build_preview(&text), format!("{}...", "a".repeat(239)));
    }
}
