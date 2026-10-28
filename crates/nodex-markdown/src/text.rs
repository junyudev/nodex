//! Plain text of Blocks: what search, previews and summaries read.
//!
//! Plain text is the words a person sees, without Markdown: each Block's text, a code Block's
//! code, an equation's source, a table's cells, an image's caption, and each inline atom as the
//! words it shows (a date as `@Oct 27, 2026`, an attachment as its name). Links and mentions
//! read as the Page or chat they point to.

use crate::model::{Block, BlockKind, DateMention, Inline};

/// The longest preview, in UTF-16 code units, as the app measures text.
pub const PREVIEW_UNITS: usize = 240;

/// All of the Blocks' words on one line, whitespace collapsed to single spaces.
pub fn plain_text(blocks: &[Block]) -> String {
    let mut parts = Vec::new();
    collect_blocks(blocks, &mut parts);
    parts
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// One line per Block in document order, keeping a text's own line breaks, as a message reads.
pub fn block_lines(blocks: &[Block]) -> String {
    let mut lines = Vec::new();
    collect_lines(blocks, &mut lines);
    lines.join("\n")
}

/// The start of plain text, cut at [`PREVIEW_UNITS`] UTF-16 code units and ending in `...`
/// when it was cut.
pub fn preview(plain_text: &str) -> String {
    if plain_text.encode_utf16().count() <= PREVIEW_UNITS {
        return plain_text.to_owned();
    }
    let mut units = 0usize;
    let mut boundary = 0usize;
    for (index, character) in plain_text.char_indices() {
        let next = units + character.len_utf16();
        if next > PREVIEW_UNITS {
            break;
        }
        units = next;
        boundary = index + character.len_utf8();
    }
    format!("{}...", plain_text[..boundary].trim_end())
}

/// The plain words of inline content.
pub fn inline_text(items: &[Inline]) -> String {
    let mut parts = Vec::new();
    collect_inline(items, &mut parts);
    parts.concat()
}

fn collect_blocks(blocks: &[Block], parts: &mut Vec<String>) {
    for block in blocks {
        match &block.kind {
            BlockKind::Paragraph { text, .. }
            | BlockKind::Heading { text, .. }
            | BlockKind::Bullet { text, .. }
            | BlockKind::Numbered { text, .. }
            | BlockKind::Check { text, .. }
            | BlockKind::Toggle { text, .. }
            | BlockKind::Quote { text, .. }
            | BlockKind::Callout { text, .. } => collect_inline(text, parts),
            BlockKind::Image { caption, .. } => parts.push(caption.clone()),
            BlockKind::Code { code, .. } => parts.push(code.clone()),
            BlockKind::Math { source } => parts.push(source.clone()),
            BlockKind::Table(table) => {
                for cell in table.rows.iter().flatten() {
                    collect_inline(&cell.text, parts);
                }
            }
            BlockKind::PageRef { page } => parts.push(crate::links::page_link(page)),
            BlockKind::DatabaseViewRef { view, hint } => {
                parts.push(if hint.is_empty() {
                    view.clone()
                } else {
                    hint.clone()
                });
            }
            BlockKind::SyncedBlockRef { source } | BlockKind::TemplateRef { source, .. } => {
                parts.push(source.clone())
            }
            BlockKind::Divider | BlockKind::Page | BlockKind::Database | BlockKind::Canvas => {}
        }
        collect_blocks(&block.children, parts);
    }
}

fn collect_lines(blocks: &[Block], lines: &mut Vec<String>) {
    for block in blocks {
        match &block.kind {
            BlockKind::Paragraph { text, .. }
            | BlockKind::Heading { text, .. }
            | BlockKind::Bullet { text, .. }
            | BlockKind::Numbered { text, .. }
            | BlockKind::Check { text, .. }
            | BlockKind::Toggle { text, .. }
            | BlockKind::Quote { text, .. }
            | BlockKind::Callout { text, .. } => lines.push(inline_text(text)),
            BlockKind::Code { code, .. } => lines.extend(code.lines().map(str::to_owned)),
            _ => {
                let mut parts = Vec::new();
                collect_blocks(
                    std::slice::from_ref(&Block::new(block.kind.clone())),
                    &mut parts,
                );
                let text = parts.join(" ");
                if !text.trim().is_empty() {
                    lines.push(text);
                }
            }
        }
        collect_lines(&block.children, lines);
    }
}

fn collect_inline(items: &[Inline], parts: &mut Vec<String>) {
    for item in items {
        match item {
            Inline::Text { text, .. } => parts.push(text.clone()),
            Inline::Link { content, .. } => {
                parts.extend(content.iter().map(|run| run.text.clone()));
            }
            Inline::Math { source } => parts.push(source.clone()),
            Inline::PageMention { page } => parts.push(crate::links::page_link(page)),
            Inline::ChatMention { session } => parts.push(crate::links::session_link(session)),
            Inline::DateMention(date) => parts.push(date_plain_text(date)),
            Inline::Attachment(attachment) => parts.push(attachment.name.clone()),
            Inline::AgentConfig(config) => parts.extend(
                [&config.mode, &config.model, &config.reasoning]
                    .into_iter()
                    .flatten()
                    .cloned(),
            ),
            Inline::Image(image) => parts.push(image.alt.clone()),
        }
    }
}

/// A date mention as the words it shows, independent of today: `@Oct 27, 2026`,
/// `@10/27/2026 9:00 AM`, `@Oct 27, 2026 → Oct 28, 2026`.
pub fn date_plain_text(date: &DateMention) -> String {
    let format =
        |value: &str| format_date_value(value, date.format.as_deref(), date.time_format.as_deref());
    match &date.end {
        Some(end) => format!("@{} → {}", format(&date.start), format(end)),
        None => format!("@{}", format(&date.start)),
    }
}

fn format_date_value(value: &str, date_format: Option<&str>, time_format: Option<&str>) -> String {
    let Some(day) = value.get(..10) else {
        return value.to_owned();
    };
    let date = format_date_part(day, date_format);
    match value.get(11..16) {
        Some(time) if value.len() > 10 => format!("{date} {}", format_time_part(time, time_format)),
        _ => date,
    }
}

fn format_date_part(value: &str, format: Option<&str>) -> String {
    let (Some(year), Some(month), Some(day)) = (value.get(..4), value.get(5..7), value.get(8..10))
    else {
        return value.to_owned();
    };
    match format.unwrap_or("relative") {
        "MM/DD/YYYY" => format!("{month}/{day}/{year}"),
        "DD/MM/YYYY" => format!("{day}/{month}/{year}"),
        "YYYY/MM/DD" => format!("{year}/{month}/{day}"),
        _ => {
            const MONTHS: [&str; 12] = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            let index = month.parse::<usize>().unwrap_or(1).clamp(1, 12) - 1;
            format!(
                "{} {}, {year}",
                MONTHS[index],
                day.parse::<u8>().unwrap_or_default()
            )
        }
    }
}

fn format_time_part(value: &str, format: Option<&str>) -> String {
    let hour = value
        .get(..2)
        .and_then(|hour| hour.parse::<u8>().ok())
        .unwrap_or_default();
    let minute = value.get(3..).unwrap_or("00");
    if format == Some("24h") {
        return format!("{hour:02}:{minute}");
    }
    let suffix = if hour < 12 { "AM" } else { "PM" };
    let display_hour = match hour % 12 {
        0 => 12,
        other => other,
    };
    format!("{display_hour}:{minute} {suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Colors, Style};

    fn paragraph(items: Vec<Inline>) -> Block {
        Block::new(BlockKind::Paragraph {
            text: items,
            colors: Colors::default(),
        })
    }

    fn text(value: &str) -> Inline {
        Inline::Text {
            text: value.to_owned(),
            style: Style::default(),
        }
    }

    #[test]
    fn collapses_whitespace_across_blocks_and_atoms() {
        let blocks = vec![
            paragraph(vec![
                text("Ship  by "),
                Inline::DateMention(DateMention {
                    start: "2026-11-20".into(),
                    ..DateMention::default()
                }),
            ]),
            Block::new(BlockKind::Code {
                language: "text".into(),
                code: "a\nb".into(),
            }),
        ];
        assert_eq!(plain_text(&blocks), "Ship by @Nov 20, 2026 a b");
        assert_eq!(block_lines(&blocks), "Ship  by @Nov 20, 2026\na\nb");
    }

    #[test]
    fn formats_times_and_ranges() {
        let date = DateMention {
            start: "2026-10-27T09:00:00+08:00".into(),
            end: Some("2026-10-27T13:30:00+08:00".into()),
            format: Some("MM/DD/YYYY".into()),
            ..DateMention::default()
        };
        assert_eq!(
            date_plain_text(&date),
            "@10/27/2026 9:00 AM → 10/27/2026 1:30 PM"
        );
    }

    #[test]
    fn cuts_previews_at_utf16_units() {
        let long = "字".repeat(300);
        let cut = preview(&long);
        assert!(cut.ends_with("..."));
        assert_eq!(
            cut.trim_end_matches("...").encode_utf16().count(),
            PREVIEW_UNITS
        );
        assert_eq!(preview("short"), "short");
    }
}
