//! Source ownership follows the Block tree, excluding children and separator lines.

use super::blocks::Reader;
use crate::{Block, ReadError, SourceBlock};
use comrak::nodes::{AstNode, NodeValue};
use std::ops::Range;

struct Location {
    lines: Range<usize>,
    children: Vec<Location>,
    literal_lines: bool,
    first_marker: bool,
}

pub(super) fn collect<'a>(
    root: &'a AstNode<'a>,
    reader: &Reader<'_>,
    source: &str,
    blocks: &[Block],
) -> Result<Vec<SourceBlock>, ReadError> {
    let tree = nodes(root.children(), reader)?;
    let lines = original_lines(source);
    let mut locations = Vec::new();
    for location in tree {
        flatten(&location, reader, &lines, &mut locations);
    }
    if locations.is_empty() && blocks.len() == 1 {
        locations.push(SourceBlock::default());
    }
    Ok(locations)
}

fn nodes<'a>(
    nodes: impl Iterator<Item = &'a AstNode<'a>>,
    reader: &Reader<'_>,
) -> Result<Vec<Location>, ReadError> {
    let mut out = Vec::new();
    for node in nodes {
        let data = node.data.borrow();
        let children = match &data.value {
            NodeValue::Document | NodeValue::List(_) => {
                out.extend(self::nodes(node.children(), reader)?);
                continue;
            }
            NodeValue::Item(_)
            | NodeValue::TaskItem(_)
            | NodeValue::BlockQuote
            | NodeValue::Alert(_) => {
                let leading = node.first_child().is_some_and(|first| matches!(first.data.borrow().value, NodeValue::Paragraph) || matches!(&first.data.borrow().value, NodeValue::HtmlBlock(html) if html.literal.trim().starts_with("<!--") && reader.syntax.leaf_comment(&html.literal).is_none()));
                self::nodes(node.children().skip(usize::from(leading)), reader)?
            }
            NodeValue::BlockDirective(d) => {
                let table = d
                    .info
                    .strip_prefix("nodex-")
                    .and_then(|id| id.parse::<usize>().ok())
                    .and_then(|id| reader.syntax.containers.get(id))
                    .is_some_and(|d| d.name == "table");
                if table {
                    Vec::new()
                } else {
                    self::nodes(node.children(), reader)?
                }
            }
            NodeValue::Paragraph | NodeValue::HtmlBlock(_) => {
                if reader.is_empty(node) {
                    continue;
                }
                Vec::new()
            }
            NodeValue::Heading(_)
            | NodeValue::ThematicBreak
            | NodeValue::CodeBlock(_)
            | NodeValue::Table(_) => Vec::new(),
            _ => continue,
        };
        let pos = data.sourcepos;
        out.push(Location {
            lines: pos.start.line.saturating_sub(1)..pos.end.line,
            children,
            literal_lines: matches!(data.value, NodeValue::CodeBlock(_)),
            first_marker: matches!(data.value, NodeValue::BlockQuote | NodeValue::Alert(_)),
        });
    }
    Ok(out)
}

fn flatten(
    location: &Location,
    reader: &Reader<'_>,
    lines: &[(&str, Range<usize>)],
    out: &mut Vec<SourceBlock>,
) {
    let mut spans: Vec<Range<usize>> = Vec::new();
    let mut child = 0;
    let mut next_line = location.lines.start;
    while next_line < location.lines.end {
        let line = next_line;
        next_line += 1;
        while location
            .children
            .get(child)
            .is_some_and(|c| c.lines.end <= line)
        {
            child += 1;
        }
        if location
            .children
            .get(child)
            .is_some_and(|c| c.lines.contains(&line))
        {
            next_line = location.children[child].lines.end;
            continue;
        }
        if reader.syntax.line_numbers.get(line) == Some(&0) {
            continue;
        }
        let original = reader.syntax.line(line + 1).saturating_sub(1);
        let Some((text, range)) = lines.get(original) else {
            continue;
        };
        // A quote's empty prefixed line is a separator, rather than the quote's text.
        if range.is_empty() {
            continue;
        }
        if !location.literal_lines
            && text.trim_matches([' ', '\t', '\r', '\n', '>']).is_empty()
            && !(location.first_marker && line == location.lines.start && text.contains('>'))
        {
            continue;
        }
        if let Some(previous) = spans
            .last_mut()
            .filter(|previous| previous.end == range.start)
        {
            previous.end = range.end;
        } else if !spans.last().is_some_and(|previous| previous == range) {
            spans.push(range.clone());
        }
    }
    out.push(SourceBlock { spans });
    for child in &location.children {
        flatten(child, reader, lines, out);
    }
}

/// CRLF and lone CR each end one original line; offsets always refer to the original bytes.
fn original_lines(source: &str) -> Vec<(&str, Range<usize>)> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < source.len() {
        if !matches!(source.as_bytes()[i], b'\n' | b'\r') {
            i += 1;
            continue;
        }
        i += if source.as_bytes()[i] == b'\r' && source.as_bytes().get(i + 1) == Some(&b'\n') {
            2
        } else {
            1
        };
        lines.push((&source[start..i], start..i));
        start = i;
    }
    lines.push((&source[start..], start..source.len()));
    lines
}
