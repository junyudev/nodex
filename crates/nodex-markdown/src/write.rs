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

/// Run the writer with unambiguous text markers, then project invocation words into the
/// actual output. This keeps Markdown punctuation and wrappers from adjoining the name.
pub(crate) fn project_skills(
    blocks: &[Block],
    writer: impl FnOnce(&[Block]) -> String,
) -> Option<String> {
    use crate::{BlockKind, Style};

    fn visit(blocks: &mut [Block], inline: &mut impl FnMut(&mut [Inline])) {
        for block in blocks {
            match &mut block.kind {
                BlockKind::Paragraph { text, .. }
                | BlockKind::Heading { text, .. }
                | BlockKind::Bullet { text, .. }
                | BlockKind::Numbered { text, .. }
                | BlockKind::Check { text, .. }
                | BlockKind::Toggle { text, .. }
                | BlockKind::Quote { text, .. }
                | BlockKind::Callout { text, .. }
                | BlockKind::Prompt { text, .. } => inline(text),
                BlockKind::Table(table) => {
                    for cell in table.rows.iter_mut().flatten() {
                        inline(&mut cell.text);
                    }
                }
                _ => {}
            }
            visit(&mut block.children, inline);
        }
    }

    let mut projected = blocks.to_vec();
    let mut names = Vec::new();
    let mut prefix = "\u{e000}skill".to_owned();
    visit(&mut projected, &mut |items| {
        for item in items {
            if let Inline::SkillMention { name } = item {
                names.push(name.clone());
            }
        }
    });
    if names.is_empty() {
        return None;
    }
    let source = crate::blocks_to_json(blocks).to_string();
    while source.contains(&prefix) {
        prefix.push('s');
    }
    let mut index = 0;
    visit(&mut projected, &mut |items| {
        for item in items {
            if matches!(item, Inline::SkillMention { .. }) {
                *item = Inline::Text {
                    text: format!("{prefix}{index}\u{e001}"),
                    style: Style::default(),
                };
                index += 1;
            }
        }
    });
    crate::normalize_blocks(&mut projected);
    let markdown = writer(&projected);
    let mut chunks = markdown.split(&prefix);
    let mut out = chunks.next().unwrap_or_default().to_owned();
    for chunk in chunks {
        let (index, tail) = chunk.split_once('\u{e001}').expect("skill marker");
        let index: usize = index.parse().expect("skill marker index");
        if out.chars().next_back().is_some_and(|c| !c.is_whitespace()) {
            out.push(' ');
        }
        out.push('$');
        out.push_str(&names[index]);
        if tail.chars().next().is_some_and(|c| !c.is_whitespace()) {
            out.push(' ');
        }
        out.push_str(tail);
    }
    Some(out)
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
