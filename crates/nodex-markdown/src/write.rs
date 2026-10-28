//! Writing Blocks as exact or portable Nodex Markdown.

mod blocks;
mod escapes;
mod inline;
mod portable;

use crate::{Block, Inline, Portable, PortableOptions, SourceBlock};

pub(crate) fn write_exact(blocks: &[Block]) -> String {
    write_located(blocks).0
}

pub(crate) fn write_located(blocks: &[Block]) -> (String, Vec<SourceBlock>) {
    if blocks.len() == 1 && blocks[0] == Block::empty_paragraph() {
        return (String::new(), vec![SourceBlock::default()]);
    }
    blocks::flow_located(blocks)
}

pub(crate) fn write_portable(blocks: &[Block], options: &PortableOptions<'_>) -> Portable {
    portable::write(blocks, options)
}

/// Titles use the same single-line inline text as a container label.
pub(crate) fn write_inline(items: &[Inline]) -> String {
    inline::text(items, inline::Position::Label).finish_expected(
        |label| format!(":::paragraph[{label}]\n:::"),
        vec![Block::new(crate::BlockKind::Paragraph {
            text: items.to_vec(),
            colors: crate::Colors::default(),
        })],
    )
}

#[cfg(test)]
mod tests;
