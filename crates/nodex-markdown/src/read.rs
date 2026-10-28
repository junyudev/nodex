//! Reads GFM structure, then gives Nodex syntax its Block meaning.

mod blocks;
mod columns;
mod inline;
mod locations;
mod syntax;
#[cfg(test)]
mod tests;
mod values;

use comrak::{Arena, Options, parse_document};

use crate::{Block, Inline, Located, ReadError, ReadOptions, Style, normalize_blocks};

pub(crate) fn read(markdown: &str, options: ReadOptions) -> Result<Vec<Block>, ReadError> {
    read_document::<false>(markdown, options).map(|located| located.blocks)
}

pub(crate) fn read_located(markdown: &str, options: ReadOptions) -> Result<Located, ReadError> {
    read_document::<true>(markdown, options)
}

pub(crate) fn read_inline(text: &str, options: ReadOptions) -> Result<Vec<Inline>, ReadError> {
    if text.contains(['\n', '\r']) {
        return Err(error(
            1,
            "inline text takes one line; write a line break as `<br>`",
        ));
    }
    let mut items = inline::fragment(text, options, 1, &Style::default(), 0)?;
    crate::model::normalize_inline(&mut items);
    Ok(items)
}

fn read_document<const LOCATED: bool>(
    markdown: &str,
    options: ReadOptions,
) -> Result<Located, ReadError> {
    let source = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let mut syntax = syntax::Syntax::new(&source, options);
    let mut prepared = syntax.prepare(&source)?;
    prepared.push('\n');
    let arena = Arena::new();
    let root = parse_document(&arena, &prepared, &parser_options());
    let reader = blocks::Reader::new(&syntax, &prepared);
    let mut blocks = reader.blocks(root.children(), true)?;
    if blocks.is_empty() {
        blocks.push(Block::empty_paragraph());
    }
    normalize_blocks(&mut blocks);
    let locations = if LOCATED {
        locations::collect(root, &reader, markdown, &blocks)?
    } else {
        Vec::new()
    };
    Ok(Located { blocks, locations })
}

fn parser_options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.cjk_friendly_emphasis = true;
    options.extension.math_dollars = false;
    options.extension.math_latex = true;
    options.extension.math_code = true;
    options.extension.alerts = true;
    options.extension.block_directive = true;
    options.parse.escaped_char_spans = true;
    options.render.sourcepos = true;
    options
}

fn error(line: usize, message: impl Into<String>) -> ReadError {
    ReadError {
        line,
        message: message.into(),
    }
}
