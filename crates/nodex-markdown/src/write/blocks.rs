//! Block layout, with list adjacency carried through the final nested item.

use super::inline::{self, Position};
use crate::attributes::{Attribute, write_attribute_list};
use crate::{Align, Block, BlockKind, Colors, Inline, Table};

#[derive(Clone, Copy, Default)]
pub(super) struct Mode {
    pub portable: bool,
    pub document_breaks: bool,
    pub nested: bool,
}

/// Lines carry preorder ownership through indentation and quote prefixes.
struct Rendered {
    lines: Vec<(String, Option<usize>)>,
    block_count: usize,
}

impl Rendered {
    fn own(source: String) -> Self {
        Self {
            lines: source
                .split('\n')
                .map(|line| (line.to_owned(), Some(0)))
                .collect(),
            block_count: 1,
        }
    }

    fn children(&mut self, mut children: Self, blank: bool, indent: usize) {
        if blank {
            self.lines.push((String::new(), None));
        }
        let prefix = " ".repeat(indent);
        let offset = self.block_count;
        self.block_count += children.block_count;
        for (line, owner) in &mut children.lines {
            if !line.is_empty() {
                line.insert_str(0, &prefix);
            }
            *owner = owner.map(|owner| owner + offset);
        }
        self.lines.extend(children.lines);
    }

    fn finish(self) -> (String, Vec<crate::SourceBlock>) {
        let mut source = String::new();
        let mut locations = vec![crate::SourceBlock::default(); self.block_count];
        let last = self.lines.len().saturating_sub(1);
        for (index, (line, owner)) in self.lines.into_iter().enumerate() {
            let start = source.len();
            source.push_str(&line);
            if index != last {
                source.push('\n');
            }
            if start == source.len() {
                continue;
            }
            let Some(owner) = owner else {
                continue;
            };
            let spans = &mut locations[owner].spans;
            if let Some(previous) = spans.last_mut().filter(|span| span.end == start) {
                previous.end = source.len();
            } else {
                spans.push(start..source.len());
            }
        }
        (source, locations)
    }
}

pub(super) fn flow_located(blocks: &[Block]) -> (String, Vec<crate::SourceBlock>) {
    flow_rendered(blocks, Mode::default()).finish()
}

pub(super) fn flow_with_mode(blocks: &[Block], mode: Mode) -> String {
    flow_rendered(blocks, mode).finish().0
}

fn flow_rendered(blocks: &[Block], mode: Mode) -> Rendered {
    let mut out = Rendered {
        lines: Vec::new(),
        block_count: 0,
    };
    let mut ends_item = false;
    let mut number: Option<u64> = None;
    for (index, block) in blocks.iter().enumerate() {
        let current_number = if let BlockKind::Numbered { start, .. } = &block.kind {
            let next = number.map_or(u64::from(start.unwrap_or(1).max(1)), |n| n + 1);
            number = Some(next);
            next
        } else {
            number = None;
            1
        };
        let follows = block.is_list_item()
            && ((ends_item
                && (!mode.portable
                    || (index > 0
                        && matches!(blocks[index - 1].kind, BlockKind::Numbered { .. })
                            == matches!(block.kind, BlockKind::Numbered { .. }))))
                || (mode.portable
                    && index > 0
                    && matches!(blocks[index - 1].kind, BlockKind::Paragraph { .. })
                    && !matches!(
                        block.kind,
                        BlockKind::Numbered {
                            start: Some(2..),
                            ..
                        }
                    )));
        out.children(
            render(block, current_number, mode),
            index > 0 && !follows,
            0,
        );
        ends_item = block.is_list_item() && block.children.last().is_none_or(ends_list_item);
    }
    out
}

fn ends_list_item(block: &Block) -> bool {
    block.is_list_item() && block.children.last().is_none_or(ends_list_item)
}

fn render(block: &Block, number: u64, mode: Mode) -> Rendered {
    let source = match &block.kind {
        BlockKind::Paragraph { text, colors } if !block.children.is_empty() => {
            return container(
                block,
                "paragraph",
                text,
                inline::colors(*colors),
                &block.children,
                mode,
            );
        }
        BlockKind::Paragraph { text, colors } => {
            let mut written = own_text(block, text, *colors, mode, |s| s.to_owned());
            if written.is_empty() {
                return Rendered::own("<br>".to_owned());
            }
            // Alone on its line, an image that opens no link would read as an image Block.
            if matches!(text.as_slice(), [Inline::Image(image)] if image.href.is_none()) {
                written.push_str("<!-- -->");
            }
            written
        }
        BlockKind::Heading {
            level,
            toggleable: true,
            text,
            colors,
        } => {
            let mut attrs = vec![Attribute::value("heading", level.clamp(&1, &4).to_string())];
            attrs.extend(inline::colors(*colors));
            return container(block, "toggle", text, attrs, &block.children, mode);
        }
        BlockKind::Heading {
            level,
            text,
            colors,
            ..
        } => {
            let marker = "#".repeat(usize::from((*level).clamp(1, 4)));
            let written = own_text(block, text, *colors, mode, |s| with_marker(&marker, s));
            with_marker(&marker, &written)
        }
        BlockKind::Bullet { text, colors } => return list(block, "-", 2, text, *colors, mode),
        BlockKind::Numbered { text, colors, .. } => {
            let marker = format!("{number}.");
            return list(block, &marker, marker.len() + 1, text, *colors, mode);
        }
        BlockKind::Check {
            checked,
            text,
            colors,
        } => {
            return list(
                block,
                if *checked { "- [x]" } else { "- [ ]" },
                2,
                text,
                *colors,
                mode,
            );
        }
        BlockKind::Toggle { text, colors } => {
            return container(
                block,
                "toggle",
                text,
                inline::colors(*colors),
                &block.children,
                mode,
            );
        }
        BlockKind::Quote { text, colors } => return quote(block, None, text, *colors, mode),
        BlockKind::Callout { icon, text, colors } => match alert(icon) {
            Some(alert) => return quote(block, Some(alert), text, *colors, mode),
            None => {
                let mut attrs = vec![Attribute::value("icon", icon)];
                attrs.extend(inline::colors(*colors));
                return container(block, "callout", text, attrs, &block.children, mode);
            }
        },
        BlockKind::Code { language, code } => {
            let fence = "`".repeat(3.max(inline::longest_run(code, '`') + 1));
            let language = crate::code_languages::language_id(language);
            let info = if language == crate::model::PLAIN_CODE_LANGUAGE {
                ""
            } else {
                language
            };
            fenced(&format!("{fence}{info}"), code, &fence)
        }
        BlockKind::Math { source } => {
            let longest = source
                .lines()
                .filter(|line| line.chars().all(|c| c == '$'))
                .map(str::len)
                .max()
                .unwrap_or(0);
            let fence = "$".repeat(2.max(longest + 1));
            fenced(&fence, source, &fence)
        }
        BlockKind::Table(table) => table_text(table, mode),
        BlockKind::Divider => "---".to_owned(),
        BlockKind::Image {
            url,
            caption,
            width,
        } => inline::image(url, caption, *width)
            .finish_expected(str::to_owned, vec![Block::new(block.kind.clone())]),
        BlockKind::Page => leaf(
            "page",
            vec![Attribute::value(
                "id",
                block.id.as_deref().unwrap_or_default(),
            )],
        ),
        BlockKind::Database => leaf(
            "database",
            vec![Attribute::value(
                "id",
                block.id.as_deref().unwrap_or_default(),
            )],
        ),
        BlockKind::Canvas => leaf(
            "canvas",
            vec![Attribute::value(
                "id",
                block.id.as_deref().unwrap_or_default(),
            )],
        ),
        BlockKind::PageRef { page } => leaf("page-ref", vec![Attribute::value("page", page)]),
        BlockKind::DatabaseViewRef { view, hint } => {
            leaf_hint("database-view-ref", "view", view, hint)
        }
        BlockKind::SyncedBlockRef { source } => {
            leaf("synced-block-ref", vec![Attribute::value("source", source)])
        }
        BlockKind::TemplateRef { source, hint } => {
            leaf_hint("template-ref", "source", source, hint)
        }
    };
    Rendered::own(source)
}

fn own_text(
    block: &Block,
    text: &[Inline],
    colors: Colors,
    mode: Mode,
    context: impl Fn(&str) -> String,
) -> String {
    let attributes = inline::optional_attributes(&inline::colors(colors));
    let attach = |s: &str| {
        if attributes.is_empty() {
            return s.to_owned();
        }
        if s.is_empty() {
            return attributes.clone();
        }
        format!("{s} {attributes}")
    };
    let position = if matches!(block.kind, BlockKind::Heading { .. }) {
        Position::Label
    } else {
        Position::Text
    };
    // Comment indentation is preserved only at the document root. A paragraph
    // child must be reduced inside a parent, where its own indentation is text
    // only when protected by a character reference.
    let nested_paragraph = mode.nested && matches!(block.kind, BlockKind::Paragraph { .. });
    let in_place = |source: String| {
        if nested_paragraph {
            format!(":::paragraph\n{}\n:::", indent_lines(&source, 2))
        } else {
            source
        }
    };
    let expected = Block::new(block.kind.clone());
    let expected = if nested_paragraph {
        Block::with_children(
            BlockKind::Paragraph {
                text: Vec::new(),
                colors: Colors::default(),
            },
            vec![expected],
        )
    } else {
        expected
    };
    let written = inline::text_with_mode(text, position, mode.portable, mode.document_breaks)
        .finish_expected(|s| in_place(context(&attach(s))), vec![expected]);
    attach(&written)
}

fn list(
    block: &Block,
    marker: &str,
    indent: usize,
    text: &[Inline],
    colors: Colors,
    mode: Mode,
) -> Rendered {
    let mut minimal = Block::new(block.kind.clone());
    if let BlockKind::Numbered { start, .. } = &mut minimal.kind {
        *start = marker
            .strip_suffix('.')
            .and_then(|number| number.parse::<u32>().ok())
            .filter(|number| *number != 1);
    }
    let written = own_text(&minimal, text, colors, mode, |s| {
        list_lines(marker, indent, s)
    });
    let written = empty_parent_text(written, &block.children);
    let mut out = Rendered::own(list_lines(marker, indent, &written));
    if !block.children.is_empty() {
        out.children(
            flow_rendered(
                &block.children,
                Mode {
                    nested: true,
                    ..mode
                },
            ),
            !block.children[0].is_list_item(),
            indent,
        );
    }
    out
}

fn list_lines(marker: &str, indent: usize, text: &str) -> String {
    let mut lines = text.split('\n');
    let mut out = with_marker(marker, lines.next().unwrap_or_default());
    for line in lines {
        out.push('\n');
        if !line.is_empty() {
            out.push_str(&" ".repeat(indent));
            out.push_str(line);
        }
    }
    out
}

fn empty_parent_text(text: String, children: &[Block]) -> String {
    if text.is_empty()
        && children
            .first()
            .is_some_and(|child| matches!(child.kind, BlockKind::Paragraph { .. }))
    {
        return "<!-- -->".to_owned();
    }
    text
}

fn quote(
    block: &Block,
    alert: Option<&str>,
    text: &[Inline],
    colors: Colors,
    mode: Mode,
) -> Rendered {
    let written = own_text(block, text, colors, mode, |s| {
        let body = if let Some(alert) = alert {
            format!("[!{alert}]\n{s}")
        } else {
            s.to_owned()
        };
        quote_lines(&body)
    });
    let written = empty_parent_text(written, &block.children);
    let body = match alert {
        Some(alert) if written.is_empty() => format!("[!{alert}]"),
        Some(alert) => format!("[!{alert}]\n{written}"),
        None => written,
    };
    let mut out = Rendered::own(body);
    if !block.children.is_empty() {
        let follows = mode.portable
            && block.children[0].is_list_item()
            && !matches!(
                block.children[0].kind,
                BlockKind::Numbered {
                    start: Some(2..),
                    ..
                }
            );
        out.children(
            flow_rendered(
                &block.children,
                Mode {
                    nested: true,
                    ..mode
                },
            ),
            !follows,
            0,
        );
    }
    for (line, _) in &mut out.lines {
        *line = with_marker(">", line);
    }
    out
}

pub(super) fn quote_lines(text: &str) -> String {
    text.split('\n')
        .map(|line| with_marker(">", line))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn alert(icon: &str) -> Option<&'static str> {
    match icon {
        "ℹ️" => Some("NOTE"),
        "💡" => Some("TIP"),
        "❗" => Some("IMPORTANT"),
        "⚠️" => Some("WARNING"),
        "🛑" => Some("CAUTION"),
        _ => None,
    }
}

fn container(
    block: &Block,
    name: &str,
    text: &[Inline],
    attributes: Vec<Attribute>,
    children: &[Block],
    mode: Mode,
) -> Rendered {
    let attrs = inline::optional_attributes(&attributes);
    let label = inline::text(text, Position::Label).finish_expected(
        |s| {
            format!(
                ":::{}{}{}\n:::",
                name,
                if s.is_empty() {
                    String::new()
                } else {
                    format!("[{s}]")
                },
                attrs
            )
        },
        vec![Block::new(block.kind.clone())],
    );
    let label = if label.is_empty() {
        String::new()
    } else {
        format!("[{label}]")
    };
    let mut out = Rendered::own(format!(":::{name}{label}{attrs}"));
    if !children.is_empty() {
        out.children(
            flow_rendered(
                children,
                Mode {
                    nested: true,
                    ..mode
                },
            ),
            false,
            2,
        );
    }
    out.lines.push((":::".to_owned(), Some(0)));
    out
}

pub(super) fn indent_lines(text: &str, indent: usize) -> String {
    let prefix = " ".repeat(indent);
    text.split('\n')
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                format!("{prefix}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn with_marker(marker: &str, text: &str) -> String {
    if text.is_empty() {
        marker.to_owned()
    } else {
        format!("{marker} {text}")
    }
}

fn fenced(open: &str, text: &str, close: &str) -> String {
    if text.is_empty() {
        format!("{open}\n{close}")
    } else {
        format!("{open}\n{text}\n{close}")
    }
}

fn leaf(name: &str, attrs: Vec<Attribute>) -> String {
    format!("::{name}{}", write_attribute_list(&attrs))
}

fn leaf_hint(name: &str, key: &str, value: &str, hint: &str) -> String {
    let mut attrs = vec![Attribute::value(key, value)];
    if !hint.is_empty() {
        attrs.push(Attribute::value("hint", hint));
    }
    leaf(name, attrs)
}

fn table_text(table: &Table, mode: Mode) -> String {
    // Column count walks the rows; compute it once, rather than for every row.
    let columns = table.column_count();
    let mut attributes = Vec::new();
    if !table.header_row || table.header_column {
        attributes.push(Attribute::value(
            "header",
            match (table.header_row, table.header_column) {
                (true, true) => "both",
                (false, true) => "column",
                _ => "none",
            },
        ));
    }
    if table.widths.iter().any(Option::is_some) {
        attributes.push(Attribute::value(
            "widths",
            (0..columns)
                .map(|i| {
                    table
                        .widths
                        .get(i)
                        .copied()
                        .flatten()
                        .map_or_else(|| "auto".to_owned(), |n| n.to_string())
                })
                .collect::<Vec<_>>()
                .join(","),
        ));
    }
    if let Some(color) = table.color {
        attributes.push(Attribute::value("color", color.name()));
    }
    let mut lines = Vec::new();
    for (index, row) in table.rows.iter().enumerate() {
        let cells = (0..columns)
            .map(|column| {
                let Some(cell) = row.get(column) else {
                    return String::new();
                };
                let attrs = cell
                    .background
                    .map(|color| {
                        write_attribute_list(&[Attribute::value("background", color.name())])
                    })
                    .unwrap_or_default();
                let attach = |s: &str| {
                    if attrs.is_empty() {
                        s.to_owned()
                    } else if s.is_empty() {
                        attrs.clone()
                    } else {
                        format!("{s} {attrs}")
                    }
                };
                let text = inline::text_with_mode(
                    &cell.text,
                    Position::Cell,
                    mode.portable,
                    mode.document_breaks,
                )
                .finish_expected(
                    |s| format!("| {} |\n| --- |", attach(s)),
                    vec![Block::new(BlockKind::Table(Table {
                        rows: vec![vec![crate::Cell {
                            align: Align::Left,
                            ..cell.clone()
                        }]],
                        header_row: true,
                        ..Table::default()
                    }))],
                );
                attach(&text)
            })
            .collect::<Vec<_>>();
        lines.push(pipe_row(&cells));
        if index == 0 {
            let delimiters = (0..columns)
                .map(|column| {
                    match row.get(column).map(|cell| cell.align).unwrap_or_default() {
                        Align::Left => "---",
                        Align::Center => ":---:",
                        Align::Right => "---:",
                    }
                    .to_owned()
                })
                .collect::<Vec<_>>();
            lines.push(pipe_row(&delimiters));
        }
    }
    let body = lines.join("\n");
    if attributes.is_empty() {
        return body;
    }
    format!(
        ":::table{}\n{}\n:::",
        write_attribute_list(&attributes),
        indent_lines(&body, 2)
    )
}

fn pipe_row(cells: &[String]) -> String {
    let mut out = String::from("|");
    for cell in cells {
        out.push(' ');
        out.push_str(cell);
        if !cell.is_empty() {
            out.push(' ');
        }
        out.push('|');
    }
    out
}
