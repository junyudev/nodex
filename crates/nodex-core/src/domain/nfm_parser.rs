use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Number, Value};
use thiserror::Error;

use super::block_materialization::MaterializedBlockNode;
use super::block_tree::MAX_BLOCK_ID_LENGTH;
use super::nfm::{
    NFM_COLORS, NfmBlock, NfmInlineContent, NfmStyleSet, NfmTableCell, NfmTableColumn, NfmTableRow,
    parse_inline_content, parse_xml_attrs,
};
use super::ordinary_block::{default_props, quote_props};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum NfmParseError {
    #[error("invalid NFM at line {line}: {message}")]
    InvalidSyntax { line: usize, message: String },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum NfmBlockMaterializationError {
    #[error("Block ID allocator returned an invalid or duplicate identity")]
    InvalidBlockId,
}

#[derive(Debug)]
struct FlatBlock {
    indent: usize,
    block: NfmBlock,
}

pub fn parse_nfm(input: &str) -> Result<Vec<NfmBlock>, NfmParseError> {
    if input.trim().is_empty() {
        return Ok(Vec::new());
    }
    let lines: Vec<_> = input.split('\n').collect();
    let mut flat = Vec::new();
    let mut cursor = 0usize;
    while cursor < lines.len() {
        let line = lines[cursor];
        let indent = leading_tabs(line);
        let content = &line[indent..];
        if content.trim().is_empty() {
            cursor += 1;
            continue;
        }
        let (block, next) = parse_block(&lines, cursor, indent)?;
        flat.push(FlatBlock { indent, block });
        cursor = next;
    }
    let mut cursor = 0usize;
    Ok(nest_blocks(&mut flat, &mut cursor, None))
}

pub fn materialize_nfm_blocks_with_ids(
    blocks: &[NfmBlock],
    allocate_block_id: &mut impl FnMut() -> String,
) -> Result<Vec<MaterializedBlockNode>, NfmBlockMaterializationError> {
    let mut allocated = BTreeSet::new();
    blocks
        .iter()
        .map(|block| materialize_parsed_block(block, allocate_block_id, &mut allocated))
        .collect()
}

fn parse_block(
    lines: &[&str],
    index: usize,
    indent: usize,
) -> Result<(NfmBlock, usize), NfmParseError> {
    let content = &lines[index][indent..];
    let trimmed = content.trim();
    if trimmed == "<empty-block/>" {
        return Ok((
            NfmBlock::EmptyBlock {
                children: Vec::new(),
            },
            index + 1,
        ));
    }
    if trimmed == "---" {
        return Ok((
            NfmBlock::Divider {
                children: Vec::new(),
            },
            index + 1,
        ));
    }
    if let Some(parsed) = parse_gfm_table(lines, index, indent) {
        return Ok(parsed);
    }
    if let Some(fence_length) = math_fence(content) {
        let mut source = Vec::new();
        let mut cursor = index + 1;
        let mut closing = None;
        while cursor < lines.len() {
            let line = strip_minimum_indent(lines[cursor], indent).unwrap_or(lines[cursor]);
            if closing_math_fence(line, fence_length) {
                closing = Some(cursor + 1);
                break;
            }
            source.push(line.to_owned());
            cursor += 1;
        }
        if let Some(next) = closing {
            return Ok((
                NfmBlock::MathBlock {
                    source: source.join("\n"),
                },
                next,
            ));
        }
    }
    if let Some(fence) = code_fence(content) {
        let mut code = Vec::new();
        let mut cursor = index + 1;
        while cursor < lines.len() {
            let line = strip_minimum_indent(lines[cursor], indent).unwrap_or(lines[cursor]);
            if closing_fence(line, fence.0, fence.1) {
                cursor += 1;
                break;
            }
            code.push(line.to_owned());
            cursor += 1;
        }
        return Ok((
            NfmBlock::CodeBlock {
                language: fence.2,
                code: code.join("\n"),
                children: Vec::new(),
            },
            cursor,
        ));
    }
    if trimmed.starts_with("<callout") {
        return parse_callout(lines, index, indent);
    }
    if trimmed.starts_with("<table") {
        return parse_xml_table(lines, index, indent);
    }
    if let Some(block) = parse_image(trimmed) {
        return Ok((block, index + 1));
    }
    if let Some(block) = parse_self_closing_block(trimmed, index)? {
        return Ok((block, index + 1));
    }

    let (stripped, color) = strip_color_suffix(content);
    if let Some((marker, rest)) = split_once_space(&stripped)
        && (marker.starts_with("▶#") || marker.starts_with("▼#"))
    {
        let is_open = marker.starts_with('▼');
        let level = marker[marker.chars().next().expect("marker").len_utf8()..]
            .chars()
            .take_while(|character| *character == '#')
            .count();
        if (1..=4).contains(&level) {
            return Ok((
                NfmBlock::Heading {
                    level: level as u8,
                    is_toggleable: true,
                    is_open,
                    content: parse_inline_content(rest),
                    color,
                    children: Vec::new(),
                },
                index + 1,
            ));
        }
    }
    if let Some((marker, rest)) = split_once_space(&stripped)
        && marker.chars().all(|character| character == '#')
        && (1..=4).contains(&marker.len())
    {
        return Ok((
            NfmBlock::Heading {
                level: marker.len() as u8,
                is_toggleable: false,
                is_open: false,
                content: parse_inline_content(rest),
                color,
                children: Vec::new(),
            },
            index + 1,
        ));
    }
    if let Some(rest) = stripped
        .strip_prefix("▶ ")
        .or_else(|| stripped.strip_prefix("▼ "))
    {
        return Ok((
            NfmBlock::Toggle {
                is_open: stripped.starts_with('▼'),
                content: parse_inline_content(rest),
                color,
                children: Vec::new(),
            },
            index + 1,
        ));
    }
    if let Some(rest) = stripped.strip_prefix("- [")
        && let Some((state, text)) = rest.split_once("] ")
        && matches!(state, " " | "x")
    {
        return Ok((
            NfmBlock::CheckListItem {
                checked: state == "x",
                content: parse_inline_content(text),
                color,
                children: Vec::new(),
            },
            index + 1,
        ));
    }
    if let Some(rest) = stripped.strip_prefix("- ") {
        return Ok((
            NfmBlock::BulletListItem {
                content: parse_inline_content(rest),
                color,
                children: Vec::new(),
            },
            index + 1,
        ));
    }
    if let Some((prefix, rest)) = stripped.split_once(". ")
        && let Ok(start) = prefix.parse::<u64>()
    {
        return Ok((
            NfmBlock::NumberedListItem {
                start: Some(start),
                content: parse_inline_content(rest),
                color,
                children: Vec::new(),
            },
            index + 1,
        ));
    }
    if stripped == ">" || stripped.starts_with("> ") {
        return Ok((
            NfmBlock::Blockquote {
                content: parse_inline_content(stripped.strip_prefix("> ").unwrap_or("")),
                color,
                children: Vec::new(),
            },
            index + 1,
        ));
    }
    Ok((
        NfmBlock::Paragraph {
            content: parse_inline_content(&stripped),
            color,
            children: Vec::new(),
        },
        index + 1,
    ))
}

fn math_fence(content: &str) -> Option<usize> {
    let trimmed = content.trim_end();
    (trimmed.len() >= 2 && trimmed.bytes().all(|byte| byte == b'$')).then_some(trimmed.len())
}

fn closing_math_fence(content: &str, fence_length: usize) -> bool {
    let trimmed = content.trim_end();
    trimmed.len() == fence_length && trimmed.bytes().all(|byte| byte == b'$')
}

fn parse_callout(
    lines: &[&str],
    index: usize,
    indent: usize,
) -> Result<(NfmBlock, usize), NfmParseError> {
    let opening = lines[index][indent..].trim();
    let attrs = opening
        .strip_prefix("<callout")
        .and_then(|value| value.strip_suffix('>'))
        .ok_or_else(|| syntax(index, "invalid callout opening tag"))?;
    let attrs = parse_xml_attrs(attrs);
    let mut inner = Vec::new();
    let mut cursor = index + 1;
    let mut closed = false;
    while cursor < lines.len() {
        let line = strip_minimum_indent(lines[cursor], indent)
            .ok_or_else(|| syntax(cursor, "callout indentation is invalid"))?;
        if line.trim_end() == "</callout>" {
            cursor += 1;
            closed = true;
            break;
        }
        inner.push(line.strip_prefix('\t').unwrap_or(line));
        cursor += 1;
    }
    if !closed {
        return Err(syntax(index, "callout is missing its closing tag"));
    }
    let mut blocks = parse_nfm(&inner.join("\n"))?;
    let content = if matches!(blocks.first(), Some(NfmBlock::Paragraph { .. })) {
        match blocks.remove(0) {
            NfmBlock::Paragraph { content, .. } => content,
            _ => unreachable!(),
        }
    } else {
        Vec::new()
    };
    Ok((
        NfmBlock::Callout {
            icon: attrs.get("icon").filter(|value| !value.is_empty()).cloned(),
            content,
            color: valid_color(attrs.get("color")),
            children: blocks,
        },
        cursor,
    ))
}

fn parse_image(line: &str) -> Option<NfmBlock> {
    let opening_end = line.find('>')?;
    let closing = line.strip_suffix("</image>")?;
    let attrs = line[..opening_end].strip_prefix("<image")?;
    let attrs = parse_xml_attrs(attrs);
    let source = attrs.get("source")?.clone();
    let caption = &closing[opening_end + 1..];
    Some(NfmBlock::Image {
        source,
        caption: parse_inline_content(caption),
        preview_width: attrs
            .get("preview-width")
            .or_else(|| attrs.get("previewWidth"))
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value > 0.0),
        color: valid_color(attrs.get("color")),
        children: Vec::new(),
    })
}

fn parse_self_closing_block(
    line: &str,
    line_index: usize,
) -> Result<Option<NfmBlock>, NfmParseError> {
    let Some(inner) = line
        .strip_prefix('<')
        .and_then(|value| value.strip_suffix("/>"))
    else {
        return Ok(None);
    };
    let inner = inner.trim_end();
    let name_end = inner.find(char::is_whitespace).unwrap_or(inner.len());
    let name = &inner[..name_end];
    let attrs = parse_xml_attrs(&inner[name_end..]);
    let block = match name {
        "database-view-ref" => NfmBlock::DatabaseViewRef {
            database_view_id: attrs.get("database-view").cloned().unwrap_or_default(),
            display_hint: non_empty_attr(&attrs, "display-hint"),
        },
        "database" => {
            let uuid = exact_non_empty_attr(&attrs, "uuid")
                .ok_or_else(|| syntax(line_index, "database requires an exact uuid"))?;
            NfmBlock::Database { uuid }
        }
        "canvas" => {
            let uuid = exact_non_empty_attr(&attrs, "uuid")
                .ok_or_else(|| syntax(line_index, "canvas requires an exact uuid"))?;
            NfmBlock::Canvas { uuid }
        }
        "synced-block-ref" => NfmBlock::SyncedBlockRef {
            source_block_id: attrs.get("source-block").cloned().unwrap_or_default(),
        },
        "template-ref" => NfmBlock::TemplateRef {
            source_block_id: attrs.get("source-block").cloned().unwrap_or_default(),
            display_hint: non_empty_attr(&attrs, "display-hint"),
        },
        "thread-section" => NfmBlock::ThreadSection {
            label: non_empty_attr(&attrs, "label"),
            thread_id: non_empty_attr(&attrs, "thread"),
            children: Vec::new(),
        },
        "page" => {
            let uuid = exact_non_empty_attr(&attrs, "uuid")
                .ok_or_else(|| syntax(line_index, "page requires an exact uuid"))?;
            NfmBlock::Page { uuid }
        }
        "page-ref" => {
            let url = attrs.get("url").cloned().unwrap_or_default();
            let target_block_id = parse_page_deep_link(&url)
                .ok_or_else(|| syntax(line_index, "Page reference URL is invalid"))?;
            NfmBlock::PageRef { target_block_id }
        }
        _ => return Ok(None),
    };
    Ok(Some(block))
}

fn parse_gfm_table(lines: &[&str], index: usize, indent: usize) -> Option<(NfmBlock, usize)> {
    let header = exact_indent(lines.get(index).copied()?, indent)?;
    let delimiter = exact_indent(lines.get(index + 1).copied()?, indent)?;
    let header_cells = split_gfm_row(header);
    let delimiter_cells = split_gfm_row(delimiter);
    if header_cells.len() <= 1 || header_cells.len() != delimiter_cells.len() {
        return None;
    }
    let columns: Vec<_> = delimiter_cells
        .iter()
        .map(|value| {
            delimiter_alignment(value).map(|align| NfmTableColumn {
                align,
                ..NfmTableColumn::default()
            })
        })
        .collect::<Option<_>>()?;
    let mut rows = vec![NfmTableRow {
        cells: header_cells
            .iter()
            .map(|value| NfmTableCell {
                content: parse_inline_content(value),
                ..NfmTableCell::default()
            })
            .collect(),
        color: None,
    }];
    let mut cursor = index + 2;
    while cursor < lines.len() {
        let Some(row) = exact_indent(lines[cursor], indent) else {
            break;
        };
        if row.trim().is_empty() {
            break;
        }
        let cells = split_gfm_row(row);
        if cells.len() <= 1 {
            break;
        }
        rows.push(NfmTableRow {
            cells: (0..columns.len())
                .map(|cell| NfmTableCell {
                    content: parse_inline_content(
                        cells.get(cell).map(String::as_str).unwrap_or(""),
                    ),
                    ..NfmTableCell::default()
                })
                .collect(),
            color: None,
        });
        cursor += 1;
    }
    Some((
        NfmBlock::Table {
            color: None,
            rows,
            columns,
            header_row: true,
            header_column: false,
            fit_page_width: false,
        },
        cursor,
    ))
}

fn parse_xml_table(
    lines: &[&str],
    index: usize,
    indent: usize,
) -> Result<(NfmBlock, usize), NfmParseError> {
    let opening = lines[index][indent..].trim();
    let attrs = opening
        .strip_prefix("<table")
        .and_then(|value| value.strip_suffix('>'))
        .ok_or_else(|| syntax(index, "invalid table opening tag"))?;
    let attrs = parse_xml_attrs(attrs);
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut cursor = index + 1;
    let mut closed = false;
    while cursor < lines.len() {
        let trimmed = strip_minimum_indent(lines[cursor], indent)
            .ok_or_else(|| syntax(cursor, "table indentation is invalid"))?
            .trim();
        if trimmed == "</table>" {
            cursor += 1;
            closed = true;
            break;
        }
        if trimmed == "<colgroup>" {
            cursor += 1;
            while cursor < lines.len() {
                let column = strip_minimum_indent(lines[cursor], indent)
                    .ok_or_else(|| syntax(cursor, "column indentation is invalid"))?
                    .trim();
                if column == "</colgroup>" {
                    cursor += 1;
                    break;
                }
                if let Some(inner) = column
                    .strip_prefix("<col")
                    .and_then(|value| value.strip_suffix("/>"))
                {
                    let attrs = parse_xml_attrs(inner);
                    columns.push(NfmTableColumn {
                        width: positive_attr(&attrs, "width"),
                        color: valid_color(attrs.get("color")),
                        align: attrs
                            .get("align")
                            .filter(|value| matches!(value.as_str(), "left" | "center" | "right"))
                            .cloned(),
                    });
                }
                cursor += 1;
            }
            continue;
        }
        if trimmed.starts_with("<tr") {
            let row_attrs = trimmed
                .strip_prefix("<tr")
                .and_then(|value| value.strip_suffix('>'))
                .map(parse_xml_attrs)
                .unwrap_or_default();
            let mut cells = Vec::new();
            cursor += 1;
            while cursor < lines.len() {
                let cell_line = strip_minimum_indent(lines[cursor], indent)
                    .ok_or_else(|| syntax(cursor, "table row indentation is invalid"))?
                    .trim();
                if cell_line == "</tr>" {
                    cursor += 1;
                    break;
                }
                if let Some(cell) = parse_xml_cell(cell_line) {
                    cells.push(cell);
                }
                cursor += 1;
            }
            rows.push(NfmTableRow {
                cells,
                color: valid_color(row_attrs.get("color")),
            });
            continue;
        }
        cursor += 1;
    }
    if !closed {
        return Err(syntax(index, "table is missing its closing tag"));
    }
    let (rows, columns) = normalize_table(rows, columns);
    Ok((
        NfmBlock::Table {
            color: valid_color(attrs.get("color")),
            rows,
            columns,
            header_row: bool_attr(&attrs, "header-row") == Some(true),
            header_column: bool_attr(&attrs, "header-column") == Some(true),
            fit_page_width: bool_attr(&attrs, "fit-page-width") == Some(true),
        },
        cursor,
    ))
}

fn parse_xml_cell(line: &str) -> Option<NfmTableCell> {
    let tag = if line.starts_with("<td") { "td" } else { "th" };
    let open_end = line.find('>')?;
    let closing = format!("</{tag}>");
    let without_closing = line.strip_suffix(&closing)?;
    let attrs = parse_xml_attrs(&line[tag.len() + 1..open_end]);
    Some(NfmTableCell {
        content: parse_inline_content(&without_closing[open_end + 1..]),
        color: valid_color(attrs.get("color")),
        colspan: positive_attr(&attrs, "colspan").filter(|value| *value > 1),
        rowspan: positive_attr(&attrs, "rowspan").filter(|value| *value > 1),
    })
}

fn nest_blocks(flat: &mut [FlatBlock], cursor: &mut usize, parent: Option<usize>) -> Vec<NfmBlock> {
    let mut output = Vec::new();
    while *cursor < flat.len() {
        let indent = flat[*cursor].indent;
        if parent.is_some_and(|parent| indent <= parent) {
            break;
        }
        let mut block = std::mem::replace(
            &mut flat[*cursor].block,
            NfmBlock::EmptyBlock {
                children: Vec::new(),
            },
        );
        *cursor += 1;
        let children = if *cursor < flat.len() && flat[*cursor].indent > indent {
            nest_blocks(flat, cursor, Some(indent))
        } else {
            Vec::new()
        };
        if set_children(&mut block, children.clone()) {
            output.push(block);
        } else {
            output.push(block);
            output.extend(children);
        }
    }
    output
}

fn set_children(block: &mut NfmBlock, children: Vec<NfmBlock>) -> bool {
    let target = match block {
        NfmBlock::Paragraph { children, .. }
        | NfmBlock::EmptyBlock { children }
        | NfmBlock::BulletListItem { children, .. }
        | NfmBlock::NumberedListItem { children, .. }
        | NfmBlock::CheckListItem { children, .. }
        | NfmBlock::Toggle { children, .. }
        | NfmBlock::Blockquote { children, .. }
        | NfmBlock::Callout { children, .. } => children,
        NfmBlock::Heading {
            is_toggleable: true,
            children,
            ..
        } => children,
        _ => return false,
    };
    target.extend(children);
    true
}

fn materialize_parsed_block(
    block: &NfmBlock,
    allocate_block_id: &mut impl FnMut() -> String,
    allocated: &mut BTreeSet<String>,
) -> Result<MaterializedBlockNode, NfmBlockMaterializationError> {
    let id = allocate_block_id();
    if id.is_empty()
        || id.trim() != id
        || id.len() > MAX_BLOCK_ID_LENGTH
        || !allocated.insert(id.clone())
    {
        return Err(NfmBlockMaterializationError::InvalidBlockId);
    }
    let (block_type, props, content, source_children): (
        &str,
        BTreeMap<String, Value>,
        Option<Value>,
        &[NfmBlock],
    ) = match block {
        NfmBlock::Paragraph {
            content,
            color,
            children,
        } => (
            "paragraph",
            default_props(),
            Some(inline_json(content)),
            children.as_slice(),
        )
            .with_color(color),
        NfmBlock::EmptyBlock { children } => (
            "paragraph",
            default_props(),
            Some(Value::Array(Vec::new())),
            children,
        ),
        NfmBlock::Heading {
            level,
            is_toggleable,
            content,
            color,
            children,
            ..
        } => {
            let mut props = default_props();
            props.insert("level".to_owned(), number(*level as u64));
            props.insert("isToggleable".to_owned(), Value::Bool(*is_toggleable));
            (
                "heading",
                props,
                Some(inline_json(content)),
                children.as_slice(),
            )
                .with_color(color)
        }
        NfmBlock::BulletListItem {
            content,
            color,
            children,
        } => (
            "bulletListItem",
            default_props(),
            Some(inline_json(content)),
            children.as_slice(),
        )
            .with_color(color),
        NfmBlock::NumberedListItem {
            start,
            content,
            color,
            children,
        } => {
            let mut props = default_props();
            if let Some(start) = start {
                props.insert("start".to_owned(), number(*start));
            }
            (
                "numberedListItem",
                props,
                Some(inline_json(content)),
                children.as_slice(),
            )
                .with_color(color)
        }
        NfmBlock::CheckListItem {
            checked,
            content,
            color,
            children,
        } => {
            let mut props = default_props();
            props.insert("checked".to_owned(), Value::Bool(*checked));
            (
                "checkListItem",
                props,
                Some(inline_json(content)),
                children.as_slice(),
            )
                .with_color(color)
        }
        NfmBlock::Toggle {
            content,
            color,
            children,
            ..
        } => (
            "toggleListItem",
            default_props(),
            Some(inline_json(content)),
            children.as_slice(),
        )
            .with_color(color),
        NfmBlock::Blockquote {
            content,
            color,
            children,
        } => (
            "quote",
            quote_props(),
            Some(inline_json(content)),
            children.as_slice(),
        )
            .with_color(color),
        NfmBlock::CodeBlock {
            language,
            code,
            children,
        } => (
            "codeBlock",
            [(
                "language".to_owned(),
                Value::String(if language.is_empty() {
                    "text".to_owned()
                } else {
                    language.clone()
                }),
            )]
            .into_iter()
            .collect(),
            Some(Value::Array(vec![text_json(code, &NfmStyleSet::default())])),
            children,
        ),
        NfmBlock::MathBlock { source } => (
            "mathBlock",
            BTreeMap::new(),
            Some(Value::Array(vec![text_json(
                source,
                &NfmStyleSet::default(),
            )])),
            &[],
        ),
        NfmBlock::Table {
            color,
            rows,
            columns,
            header_row,
            header_column,
            ..
        } => {
            let mut props = [("textColor".to_owned(), Value::String("default".to_owned()))]
                .into_iter()
                .collect();
            apply_color(&mut props, color);
            (
                "table",
                props,
                Some(table_json(rows, columns, *header_row, *header_column)),
                &[],
            )
        }
        NfmBlock::Callout {
            icon,
            content,
            color,
            children,
        } => {
            let mut props = default_props();
            props.insert(
                "icon".to_owned(),
                Value::String(icon.clone().unwrap_or_else(|| "💡".to_owned())),
            );
            (
                "callout",
                props,
                Some(inline_json(content)),
                children.as_slice(),
            )
                .with_color(color)
        }
        NfmBlock::Image {
            source,
            caption,
            preview_width,
            color,
            children,
        } => {
            let mut props = BTreeMap::from([
                ("textAlignment".to_owned(), Value::String("left".to_owned())),
                (
                    "backgroundColor".to_owned(),
                    Value::String("default".to_owned()),
                ),
                ("name".to_owned(), Value::String(String::new())),
                ("url".to_owned(), Value::String(source.clone())),
                (
                    "caption".to_owned(),
                    Value::String(super::nfm::serialize_inline_content_for_adapter(caption)),
                ),
                ("showPreview".to_owned(), Value::Bool(true)),
            ]);
            if let Some(width) = preview_width.and_then(Number::from_f64) {
                props.insert("previewWidth".to_owned(), Value::Number(width));
            }
            ("image", props, None, children.as_slice()).with_color(color)
        }
        NfmBlock::DatabaseViewRef {
            database_view_id,
            display_hint,
        } => (
            "databaseViewRef",
            BTreeMap::from([
                (
                    "databaseViewId".to_owned(),
                    Value::String(database_view_id.clone()),
                ),
                (
                    "displayHint".to_owned(),
                    Value::String(display_hint.clone().unwrap_or_default()),
                ),
            ]),
            None,
            &[],
        ),
        NfmBlock::Database { .. } => ("database", BTreeMap::new(), None, &[]),
        NfmBlock::Canvas { .. } => ("canvas", BTreeMap::new(), None, &[]),
        NfmBlock::SyncedBlockRef { source_block_id } => (
            "syncedBlockRef",
            [(
                "sourceBlockId".to_owned(),
                Value::String(source_block_id.clone()),
            )]
            .into_iter()
            .collect(),
            None,
            &[],
        ),
        NfmBlock::TemplateRef {
            source_block_id,
            display_hint,
        } => (
            "templateRef",
            BTreeMap::from([
                (
                    "sourceBlockId".to_owned(),
                    Value::String(source_block_id.clone()),
                ),
                (
                    "displayHint".to_owned(),
                    Value::String(display_hint.clone().unwrap_or_default()),
                ),
            ]),
            None,
            &[],
        ),
        NfmBlock::Page { .. } => ("page", BTreeMap::new(), None, &[]),
        NfmBlock::PageRef { target_block_id } => (
            "pageRef",
            BTreeMap::from([(
                "targetBlockId".to_owned(),
                Value::String(target_block_id.clone()),
            )]),
            None,
            &[],
        ),
        NfmBlock::ThreadSection {
            label,
            thread_id,
            children,
        } => {
            let mut props = default_props();
            props.insert(
                "label".to_owned(),
                Value::String(label.clone().unwrap_or_default()),
            );
            props.insert(
                "threadId".to_owned(),
                Value::String(thread_id.clone().unwrap_or_default()),
            );
            ("threadSection", props, None, children)
        }
        NfmBlock::Divider { children } => ("divider", BTreeMap::new(), None, children),
    };
    let children = source_children
        .iter()
        .map(|child| materialize_parsed_block(child, allocate_block_id, allocated))
        .collect::<Result<_, _>>()?;
    Ok(MaterializedBlockNode {
        id,
        block_type: block_type.to_owned(),
        props,
        content,
        children,
    })
}

trait WithColor {
    fn with_color(self, color: &Option<String>) -> Self;
}

impl<'a> WithColor
    for (
        &'a str,
        BTreeMap<String, Value>,
        Option<Value>,
        &'a [NfmBlock],
    )
{
    fn with_color(mut self, color: &Option<String>) -> Self {
        apply_color(&mut self.1, color);
        self
    }
}

fn inline_json(items: &[NfmInlineContent]) -> Value {
    Value::Array(items.iter().map(inline_item_json).collect())
}

fn inline_item_json(item: &NfmInlineContent) -> Value {
    match item {
        NfmInlineContent::Math { source } => serde_json::json!({
            "type": "math",
            "props": {},
            "content": source,
        }),
        NfmInlineContent::Text { text, styles } => text_json(text, styles),
        NfmInlineContent::Link { text, href, styles } => serde_json::json!({
            "type": "link",
            "href": href,
            "content": [text_json(text, styles)],
        }),
        NfmInlineContent::LineBreak => text_json("\n", &NfmStyleSet::default()),
        NfmInlineContent::Attachment {
            kind,
            mode,
            source,
            name,
            mime_type,
            bytes,
            origin,
        } => {
            let mut props = Map::from_iter([
                ("kind".to_owned(), Value::String(kind.clone())),
                ("mode".to_owned(), Value::String(mode.clone())),
                ("source".to_owned(), Value::String(source.clone())),
                ("name".to_owned(), Value::String(name.clone())),
            ]);
            if let Some(value) = mime_type {
                props.insert("mimeType".to_owned(), Value::String(value.clone()));
            }
            if kind != "folder"
                && let Some(value) = bytes
            {
                props.insert("bytes".to_owned(), number(*value));
            }
            if let Some(value) = origin {
                props.insert("origin".to_owned(), Value::String(value.clone()));
            }
            serde_json::json!({ "type": "attachment", "props": props })
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
            let raw = raw_attributes.clone().unwrap_or_default();
            let attrs = parse_xml_attrs(&raw);
            let unknown = attrs
                .keys()
                .filter(|key| {
                    !matches!(
                        key.as_str(),
                        "mode" | "provider" | "model" | "reasoning" | "speed" | "permission"
                    )
                })
                .cloned()
                .collect::<Vec<_>>()
                .join(",");
            serde_json::json!({
                "type": "agentConfig",
                "props": {
                    "mode": mode.clone().unwrap_or_default(),
                    "provider": provider.clone().unwrap_or_default(),
                    "model": model.clone().unwrap_or_default(),
                    "reasoning": reasoning.clone().unwrap_or_default(),
                    "speed": speed.clone().unwrap_or_default(),
                    "permission": permission.clone().unwrap_or_default(),
                    "unknownAttributes": unknown,
                    "rawAttributes": raw,
                }
            })
        }
        NfmInlineContent::ThreadMention { uuid } => serde_json::json!({
            "type": "threadMention",
            "props": { "uuid": uuid },
        }),
        NfmInlineContent::PageMention { target_page_id } => serde_json::json!({
            "type": "pageMention",
            "props": { "targetPageId": target_page_id },
        }),
        NfmInlineContent::DateMention(date) => serde_json::json!({
            "type": "dateMention",
            "props": {
                "start": date.start,
                "end": date.end.clone().unwrap_or_default(),
                "tz": date.tz.clone().unwrap_or_default(),
                "format": date.format.clone().unwrap_or_default(),
                "timeFormat": date.time_format.clone().unwrap_or_default(),
                "reminder": date.reminder.clone().unwrap_or_default(),
            }
        }),
    }
}

fn text_json(text: &str, styles: &NfmStyleSet) -> Value {
    let mut output = Map::new();
    for (key, enabled) in [
        ("bold", styles.bold),
        ("italic", styles.italic),
        ("strike", styles.strikethrough),
        ("underline", styles.underline),
        ("code", styles.code),
    ] {
        if enabled {
            output.insert(key.to_owned(), Value::Bool(true));
        }
    }
    if let Some(color) = &styles.color {
        output.insert(
            if color.ends_with("_bg") {
                "backgroundColor"
            } else {
                "textColor"
            }
            .to_owned(),
            Value::String(color.strip_suffix("_bg").unwrap_or(color).to_owned()),
        );
    }
    serde_json::json!({ "type": "text", "text": text, "styles": output })
}

fn table_json(
    rows: &[NfmTableRow],
    columns: &[NfmTableColumn],
    header_row: bool,
    header_column: bool,
) -> Value {
    let mut result = Map::from_iter([
        ("type".to_owned(), Value::String("tableContent".to_owned())),
        (
            "columnWidths".to_owned(),
            Value::Array(
                columns
                    .iter()
                    .map(|column| column.width.map(number).unwrap_or(Value::Null))
                    .collect(),
            ),
        ),
        (
            "rows".to_owned(),
            Value::Array(
                rows.iter()
                    .map(|row| {
                        serde_json::json!({
                            "cells": row.cells.iter().enumerate().map(|(index, cell)| {
                                let column = columns.get(index);
                                let mut props = BTreeMap::from([
                                    ("backgroundColor".to_owned(), Value::String(
                                        cell.color.as_ref().or(row.color.as_ref()).or_else(|| column.and_then(|value| value.color.as_ref()))
                                            .map(|value| value.strip_suffix("_bg").unwrap_or(value))
                                            .unwrap_or("default")
                                            .to_owned(),
                                    )),
                                    ("textColor".to_owned(), Value::String("default".to_owned())),
                                    ("textAlignment".to_owned(), Value::String(
                                        column.and_then(|value| value.align.clone()).unwrap_or_else(|| "left".to_owned()),
                                    )),
                                    ("colspan".to_owned(), number(1)),
                                    ("rowspan".to_owned(), number(1)),
                                ]);
                                if let Some(value) = cell.colspan { props.insert("colspan".to_owned(), number(value)); }
                                if let Some(value) = cell.rowspan { props.insert("rowspan".to_owned(), number(value)); }
                                serde_json::json!({
                                    "type": "tableCell",
                                    "props": props,
                                    "content": inline_json(&cell.content),
                                })
                            }).collect::<Vec<_>>()
                        })
                    })
                    .collect(),
            ),
        ),
    ]);
    if header_row {
        result.insert("headerRows".to_owned(), number(1));
    }
    if header_column {
        result.insert("headerCols".to_owned(), number(1));
    }
    Value::Object(result)
}

fn apply_color(props: &mut BTreeMap<String, Value>, color: &Option<String>) {
    let Some(color) = color else {
        return;
    };
    let (key, value) = match color.strip_suffix("_bg") {
        Some(value) => ("backgroundColor", value),
        None => ("textColor", color.as_str()),
    };
    props.insert(key.to_owned(), Value::String(value.to_owned()));
}

fn normalize_table(
    mut rows: Vec<NfmTableRow>,
    mut columns: Vec<NfmTableColumn>,
) -> (Vec<NfmTableRow>, Vec<NfmTableColumn>) {
    let column_count = columns
        .len()
        .max(rows.iter().map(|row| row.cells.len()).max().unwrap_or(0))
        .max(1);
    columns.resize(column_count, NfmTableColumn::default());
    if rows.is_empty() {
        rows.push(NfmTableRow::default());
    }
    for row in &mut rows {
        row.cells.resize(column_count, NfmTableCell::default());
    }
    (rows, columns)
}

fn strip_color_suffix(input: &str) -> (String, Option<String>) {
    let trimmed = input.trim_end();
    let Some(opening) = trimmed.rfind(" {color=\"") else {
        return (input.to_owned(), None);
    };
    let suffix = &trimmed[opening + 9..];
    let Some(color) = suffix.strip_suffix("\"}") else {
        return (input.to_owned(), None);
    };
    if !NFM_COLORS.contains(&color) {
        return (input.to_owned(), None);
    }
    (
        trimmed[..opening].trim_end().to_owned(),
        Some(color.to_owned()),
    )
}

fn code_fence(content: &str) -> Option<(char, usize, String)> {
    let marker = content.chars().next()?;
    if !matches!(marker, '`' | '~') {
        return None;
    }
    let length = content.chars().take_while(|value| *value == marker).count();
    (length >= 3).then(|| {
        (
            marker,
            length,
            content[marker.len_utf8() * length..].trim().to_owned(),
        )
    })
}

fn closing_fence(content: &str, marker: char, minimum: usize) -> bool {
    let trimmed = content.trim_end();
    trimmed.chars().count() >= minimum && trimmed.chars().all(|value| value == marker)
}

fn split_gfm_row(line: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut buffer = String::new();
    let mut code = false;
    let mut chars = line.trim().chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\'
            && let Some(next) = chars.next()
        {
            buffer.push(character);
            buffer.push(next);
            continue;
        }
        if character == '`' {
            code = !code;
        }
        if character == '|' && !code {
            cells.push(buffer.trim().to_owned());
            buffer.clear();
        } else {
            buffer.push(character);
        }
    }
    cells.push(buffer.trim().to_owned());
    if cells.first().is_some_and(String::is_empty) {
        cells.remove(0);
    }
    if cells.last().is_some_and(String::is_empty) {
        cells.pop();
    }
    cells
}

fn delimiter_alignment(value: &str) -> Option<Option<String>> {
    let trimmed = value.trim();
    let core = trimmed.trim_matches(':');
    if core.len() < 3 || !core.chars().all(|value| value == '-') {
        return None;
    }
    Some(match (trimmed.starts_with(':'), trimmed.ends_with(':')) {
        (true, true) => Some("center".to_owned()),
        (true, false) => Some("left".to_owned()),
        (false, true) => Some("right".to_owned()),
        (false, false) => None,
    })
}

fn parse_page_deep_link(value: &str) -> Option<String> {
    let path = value
        .strip_prefix("nodex://pages/")
        .or_else(|| value.strip_prefix("nodex:/pages/"))?;
    percent_decode(path).filter(|value| !value.trim().is_empty())
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

fn exact_indent(line: &str, indent: usize) -> Option<&str> {
    (leading_tabs(line) == indent).then(|| &line[indent..])
}

fn strip_minimum_indent(line: &str, indent: usize) -> Option<&str> {
    (leading_tabs(line) >= indent).then(|| &line[indent..])
}

fn leading_tabs(line: &str) -> usize {
    line.bytes().take_while(|value| *value == b'\t').count()
}

fn split_once_space(value: &str) -> Option<(&str, &str)> {
    value.split_once(' ')
}

fn valid_color(value: Option<&String>) -> Option<String> {
    value
        .filter(|value| NFM_COLORS.contains(&value.as_str()))
        .cloned()
}

fn non_empty_attr(attrs: &BTreeMap<String, String>, key: &str) -> Option<String> {
    attrs.get(key).filter(|value| !value.is_empty()).cloned()
}

fn exact_non_empty_attr(attrs: &BTreeMap<String, String>, key: &str) -> Option<String> {
    attrs
        .get(key)
        .filter(|value| !value.is_empty() && value.trim() == value.as_str())
        .cloned()
}

fn bool_attr(attrs: &BTreeMap<String, String>, key: &str) -> Option<bool> {
    match attrs.get(key).map(String::as_str) {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    }
}

fn positive_attr(attrs: &BTreeMap<String, String>, key: &str) -> Option<u64> {
    attrs
        .get(key)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn number(value: u64) -> Value {
    Value::Number(Number::from(value))
}

fn syntax(line: usize, message: impl Into<String>) -> NfmParseError {
    NfmParseError::InvalidSyntax {
        line: line + 1,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::Value;

    use crate::domain::nfm::{materialize_nfm, serialize_nfm};

    use super::*;

    #[test]
    fn parses_the_complete_canonical_matrix_back_to_the_same_nfm() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/yjs-yrs");
        let oracle: Value = serde_json::from_slice(
            &std::fs::read(root.join("matrix-materialization.json")).expect("oracle"),
        )
        .expect("valid oracle");
        let nfm = oracle["nfm"].as_str().expect("NFM");
        let parsed = parse_nfm(nfm).expect("parse canonical NFM");
        assert_eq!(serialize_nfm(&parsed), nfm);

        let mut next_id = 0usize;
        let materialized = materialize_nfm_blocks_with_ids(&parsed, &mut || {
            next_id += 1;
            format!("parsed-{next_id}")
        })
        .expect("materialized parsed NFM");
        let replaced = materialize_nfm(&materialized).expect("NFM").nfm;
        assert!(replaced.contains("<page uuid=\"parsed-15\" />"));
        assert!(replaced.contains("<database uuid=\"parsed-16\" />"));
    }

    #[test]
    fn matches_the_typescript_nfm_to_blocknote_oracle() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/yjs-yrs");
        let oracle: Value = serde_json::from_slice(
            &std::fs::read(root.join("nfm-parser-oracle.json")).expect("oracle"),
        )
        .expect("valid oracle");
        let mut next_id = 0usize;
        let parsed = parse_nfm(oracle["input"].as_str().expect("input NFM")).expect("parse NFM");
        let actual = materialize_nfm_blocks_with_ids(&parsed, &mut || {
            next_id += 1;
            format!("oracle-nfm-{next_id}")
        })
        .expect("materialize NFM");

        assert_eq!(
            serde_json::to_value(&actual).expect("serialize blocks"),
            oracle["blockTree"]
        );
        assert_eq!(
            materialize_nfm(&actual).expect("materialize NFM").nfm,
            oracle["nfm"]
        );
    }

    #[test]
    fn empty_input_is_an_empty_forest_and_materialization_rejects_duplicate_ids() {
        let parsed = parse_nfm("\n \t\n").expect("empty NFM forest");
        assert!(parsed.is_empty());
        let allocation_calls = std::cell::Cell::new(0);
        let materialized = materialize_nfm_blocks_with_ids(&parsed, &mut || {
            allocation_calls.set(allocation_calls.get() + 1);
            "unused".to_owned()
        })
        .expect("empty materialized forest");
        assert!(materialized.is_empty());
        assert_eq!(allocation_calls.get(), 0);

        let parsed = parse_nfm("One\nTwo").expect("NFM forest");
        let error = materialize_nfm_blocks_with_ids(&parsed, &mut || "duplicate".to_owned())
            .expect_err("duplicate IDs");
        assert_eq!(error, NfmBlockMaterializationError::InvalidBlockId);
    }

    #[test]
    fn equations_round_trip_between_nfm_and_materialized_blocks() {
        let nfm = "Energy $E = mc^2$\n$$$\nline one\n$$\nline two\n$$$";
        let parsed = parse_nfm(nfm).expect("Equation NFM");
        assert_eq!(serialize_nfm(&parsed), nfm);

        let mut next_id = 0usize;
        let materialized = materialize_nfm_blocks_with_ids(&parsed, &mut || {
            next_id += 1;
            format!("equation-{next_id}")
        })
        .expect("materialized Equations");
        assert_eq!(materialized[1].block_type, "mathBlock");
        assert_eq!(materialized[1].props, BTreeMap::new());
        assert_eq!(
            materialized[1].content,
            Some(serde_json::json!([{
                "type": "text",
                "text": "line one\n$$\nline two",
                "styles": {},
            }]))
        );
        assert_eq!(materialize_nfm(&materialized).expect("NFM").nfm, nfm);
    }

    #[test]
    fn callout_body_and_children_keep_distinct_structural_roles() {
        let inner = parse_nfm("Callout body\nCallout child").expect("Callout inner NFM");
        assert_eq!(inner.len(), 2, "{inner:#?}");
        let parsed =
            parse_nfm("<callout icon=\"💡\">\n\tCallout body\n\tCallout child\n</callout>")
                .expect("nested Callout NFM");

        assert!(
            matches!(
                parsed.as_slice(),
                [NfmBlock::Callout {
                    content,
                    children,
                    ..
                }] if !content.is_empty()
                    && matches!(children.as_slice(), [NfmBlock::Paragraph { children, .. }] if children.is_empty())
            ),
            "{parsed:#?}",
        );
    }

    #[test]
    fn canvas_owner_shells_require_and_preserve_an_exact_uuid() {
        let nfm = r#"<canvas uuid="canvas-1" />"#;
        let parsed = parse_nfm(nfm).expect("canonical Canvas");

        assert_eq!(serialize_nfm(&parsed), nfm);
        assert!(matches!(
            parsed.as_slice(),
            [NfmBlock::Canvas { uuid }] if uuid == "canvas-1"
        ));
        assert!(parse_nfm("<canvas />").is_err());
        assert!(parse_nfm(r#"<canvas uuid=" canvas-1" />"#).is_err());
    }
}
