//! The WebAssembly interface the app uses. Blocks cross it as BlockNote JSON text, which keeps
//! the interface to strings and lets the app hand the result straight to the editor.

use std::collections::HashMap;

use wasm_bindgen::prelude::*;

use crate::{LineBreaks, PortableOptions, ReadOptions};

fn read_options(mode: &str) -> Result<ReadOptions, JsValue> {
    match mode {
        "exact" => Ok(ReadOptions::EXACT),
        "boundary" => Ok(ReadOptions::BOUNDARY),
        "document" => Ok(ReadOptions::DOCUMENT),
        other => Err(JsValue::from_str(&format!("unknown read mode `{other}`"))),
    }
}

fn refusal(error: crate::ReadError) -> JsValue {
    JsValue::from_str(
        &serde_json::json!({ "line": error.line, "message": error.message }).to_string(),
    )
}

fn json(text: &str) -> Result<serde_json::Value, JsValue> {
    serde_json::from_str(text).map_err(|error| JsValue::from_str(&error.to_string()))
}

fn blocks(blocks_json: &str) -> Result<Vec<crate::Block>, JsValue> {
    crate::blocks_from_json(&json(blocks_json)?)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Reads Nodex Markdown as BlockNote JSON text. A refused exact write throws a JSON text
/// `{"line": number, "message": string}`.
#[wasm_bindgen]
pub fn read(markdown: &str, mode: &str) -> Result<String, JsValue> {
    let options = read_options(mode)?;
    crate::read_json(markdown, options)
        .map(|blocks| blocks.to_string())
        .map_err(refusal)
}

/// Reads Blocks and their own UTF-8 byte ranges, in preorder.
#[wasm_bindgen(js_name = readLocated)]
pub fn read_located(markdown: &str, mode: &str) -> Result<String, JsValue> {
    let located = crate::read_located(markdown, read_options(mode)?).map_err(refusal)?;
    let locations: Vec<_> = located
        .locations
        .into_iter()
        .map(|block| block.spans)
        .collect();
    Ok(serde_json::json!({
        "blocks": crate::blocks_to_json(&located.blocks),
        "locations": locations,
    })
    .to_string())
}

/// Reads one line of inline Nodex Markdown, as a Page title is written, as inline content JSON
/// text. A refused exact read throws like `read`.
#[wasm_bindgen(js_name = readInline)]
pub fn read_inline(text: &str, mode: &str) -> Result<String, JsValue> {
    let items = crate::read_inline(text, read_options(mode)?).map_err(refusal)?;
    Ok(crate::inline_content_to_json(&items).to_string())
}

/// Literal text with its GFM web and mail addresses linked, as inline BlockNote JSON text.
#[wasm_bindgen(js_name = linkLiteralAddresses)]
pub fn link_literal_addresses(text: &str) -> String {
    crate::inline_content_to_json(&crate::link_literal_addresses(text)).to_string()
}

/// The one-line text of inline content given as BlockNote JSON text.
#[wasm_bindgen(js_name = writeInline)]
pub fn write_inline(inline_json: &str) -> Result<String, JsValue> {
    let items = crate::inline_content_from_json(&json(inline_json)?)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    Ok(crate::write_inline(&items))
}

/// All of the Blocks' words on one line.
#[wasm_bindgen(js_name = plainText)]
pub fn plain_text(blocks_json: &str) -> Result<String, JsValue> {
    Ok(crate::text::plain_text(&blocks(blocks_json)?))
}

/// One line per Block, keeping each text's own line breaks.
#[wasm_bindgen(js_name = blockLines)]
pub fn block_lines(blocks_json: &str) -> Result<String, JsValue> {
    Ok(crate::text::block_lines(&blocks(blocks_json)?))
}

/// The start of plain text, as previews show it.
#[wasm_bindgen]
pub fn preview(plain_text: &str) -> String {
    crate::text::preview(plain_text)
}

/// The exact text of Blocks given as BlockNote JSON text.
#[wasm_bindgen]
pub fn write(blocks_json: &str) -> Result<String, JsValue> {
    Ok(crate::write(&blocks(blocks_json)?))
}

/// Exact Markdown of Blocks with skill atoms projected to invocation words.
#[wasm_bindgen(js_name = writeAgentMessage)]
pub fn write_agent_message(blocks_json: &str) -> Result<String, JsValue> {
    Ok(crate::write_agent_message(&blocks(blocks_json)?))
}

/// Portable Markdown of Blocks, as JSON text `{"markdown": string, "exact": boolean}`.
/// `page_titles_json` maps Page ids to the titles that name mentions of them.
#[wasm_bindgen(js_name = writePortable)]
pub fn write_portable(
    blocks_json: &str,
    line_breaks: &str,
    page_titles_json: &str,
) -> Result<String, JsValue> {
    let titles: HashMap<String, String> = if page_titles_json.is_empty() {
        HashMap::new()
    } else {
        serde_json::from_str(page_titles_json)
            .map_err(|error| JsValue::from_str(&error.to_string()))?
    };
    let page_title = |id: &str| titles.get(id).cloned();
    let options = PortableOptions {
        line_breaks: match line_breaks {
            "document" => LineBreaks::Document,
            _ => LineBreaks::Comment,
        },
        page_title: Some(&page_title),
    };
    let portable = crate::write_portable(&blocks(blocks_json)?, &options);
    Ok(serde_json::json!({ "markdown": portable.markdown, "exact": portable.exact }).to_string())
}
