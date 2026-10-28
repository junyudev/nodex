//! The conversion seam between canonical Core Blocks and the shared text language.
//! Core allocates identities; the language model deliberately omits ordinary Block ids.
use serde_json::{Value, json};
use thiserror::Error;

use super::block_materialization::MaterializedBlockNode;

pub use nodex_markdown::links::parse_page_link as parse_page_deep_link;
pub use nodex_markdown::text::{
    block_lines as extract_block_lines, plain_text as extract_plain_text,
};
pub use nodex_markdown::{
    Block as MarkdownBlock, Located as LocatedMarkdown, SourceBlock as MarkdownSourceBlock,
};
pub use nodex_markdown::{
    write as serialize_markdown, write_located as serialize_markdown_located,
};

#[derive(Debug, Error, PartialEq)]
pub enum MarkdownMaterializationError {
    #[error(transparent)]
    Model(#[from] nodex_markdown::ModelError),
    #[error("Block JSON: {0}")]
    Json(String),
}

pub struct MarkdownMaterialization {
    pub blocks: Vec<nodex_markdown::Block>,
    pub markdown: String,
    pub plain_text: String,
    pub preview: String,
}

pub fn language_blocks(
    blocks: &[MaterializedBlockNode],
) -> Result<Vec<nodex_markdown::Block>, MarkdownMaterializationError> {
    let json = serde_json::to_value(blocks)
        .map_err(|error| MarkdownMaterializationError::Json(error.to_string()))?;
    let mut blocks = nodex_markdown::blocks_from_json(&json)?;
    fn omit_view_identities(blocks: &mut [nodex_markdown::Block]) {
        for block in blocks {
            if !matches!(
                block.kind,
                nodex_markdown::BlockKind::Page
                    | nodex_markdown::BlockKind::Database
                    | nodex_markdown::BlockKind::Canvas
            ) {
                block.id = None;
            }
            omit_view_identities(&mut block.children);
        }
    }
    omit_view_identities(&mut blocks);
    Ok(blocks)
}

pub fn materialize_markdown(
    blocks: &[MaterializedBlockNode],
) -> Result<MarkdownMaterialization, MarkdownMaterializationError> {
    let blocks = language_blocks(blocks)?;
    let markdown = nodex_markdown::write(&blocks);
    let plain_text = nodex_markdown::text::plain_text(&blocks);
    let preview = nodex_markdown::text::preview(&plain_text);
    Ok(MarkdownMaterialization {
        blocks,
        markdown,
        plain_text,
        preview,
    })
}

pub fn materialize_markdown_blocks_with_ids(
    blocks: &[nodex_markdown::Block],
    allocate: &mut impl FnMut() -> String,
) -> Result<Vec<MaterializedBlockNode>, MarkdownMaterializationError> {
    nodex_markdown::blocks_to_json(blocks)
        .as_array()
        .expect("language Blocks are an array")
        .iter()
        .map(|value| assign_identity(value, allocate))
        .collect()
}

fn assign_identity(
    value: &Value,
    allocate: &mut impl FnMut() -> String,
) -> Result<MaterializedBlockNode, MarkdownMaterializationError> {
    let block_type = value["type"]
        .as_str()
        .ok_or_else(|| MarkdownMaterializationError::Json("Block type is missing".into()))?
        .to_owned();
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(&mut *allocate);
    let props = value
        .get("props")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let has_inline_content = !matches!(
        block_type.as_str(),
        "image"
            | "divider"
            | "page"
            | "database"
            | "canvas"
            | "pageRef"
            | "databaseViewRef"
            | "syncedBlockRef"
            | "templateRef"
    );
    let mut content = value
        .get("content")
        .cloned()
        .or_else(|| has_inline_content.then(|| json!([])));
    if block_type == "table"
        && let Some(content) = &mut content
    {
        canonical_table(content);
    }
    if let Some(content) = &mut content {
        canonical_inline(content);
    }
    let children = value
        .get("children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|child| assign_identity(child, allocate))
        .collect::<Result<_, _>>()?;
    Ok(MaterializedBlockNode {
        id,
        block_type,
        props,
        content,
        children,
    })
}

fn canonical_table(value: &mut Value) {
    let Some(content) = value.as_object_mut() else {
        return;
    };
    let columns = content
        .get("rows")
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(|row| row.get("cells"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    content
        .entry("columnWidths")
        .or_insert_with(|| json!(vec![Value::Null; columns]));
    let Some(rows) = content.get_mut("rows").and_then(Value::as_array_mut) else {
        return;
    };
    rows.iter_mut()
        .filter_map(|row| row.get_mut("cells").and_then(Value::as_array_mut))
        .flatten()
        .for_each(canonical_cell);
}

fn canonical_cell(value: &mut Value) {
    let Some(cell) = value.as_object_mut() else {
        return;
    };
    cell.entry("type").or_insert_with(|| json!("tableCell"));
    cell.entry("content").or_insert_with(|| json!([]));
    cell.entry("props").or_insert_with(|| json!({}));
}

fn canonical_inline(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(canonical_inline),
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("text") {
                object.entry("styles").or_insert_with(|| json!({}));
            }
            if object.get("type").and_then(Value::as_str) == Some("math") {
                object.entry("props").or_insert_with(|| json!({}));
            }
            object.values_mut().for_each(canonical_inline);
        }
        _ => {}
    }
}

pub fn parse_markdown(
    input: &str,
) -> Result<Vec<nodex_markdown::Block>, nodex_markdown::ReadError> {
    nodex_markdown::read(input, nodex_markdown::ReadOptions::EXACT)
}

pub fn parse_markdown_located(
    input: &str,
) -> Result<nodex_markdown::Located, nodex_markdown::ReadError> {
    nodex_markdown::read_located(input, nodex_markdown::ReadOptions::EXACT)
}
