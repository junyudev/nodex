//! The Markdown forms Nested Markdown reads besides its canonical ones, and the escapes that
//! keep a paragraph from being read as one of them. `src/shared/nfm/markdown-forms.ts`
//! implements the same rules, and message text links bare URLs as `src/shared/message-text.ts`
//! does; `tests/fixtures/nfm/markdown-input.json` holds both to them.

use std::borrow::Cow;

use super::nfm::{NfmBlock, NfmInlineContent, NfmStyleSet};

fn leading_tabs(line: &str) -> usize {
    line.bytes().take_while(|byte| *byte == b'\t').count()
}

/// A list item: `-`, `*` or `+` bullets followed by a space, and `1.` or `1)` numbers
/// followed by whitespace.
fn is_list_item(body: &str) -> bool {
    if let Some(rest) = body.strip_prefix(['-', '*', '+']) {
        return rest.starts_with(' ');
    }
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0
        && body[digits..]
            .strip_prefix(['.', ')'])
            .is_some_and(|rest| rest.starts_with(char::is_whitespace))
}

/// Lines inside code and equation fences are literal, so list indentation never applies
/// there. Returns the line that closes a fence opened at `index`.
fn fence_end(lines: &[&str], index: usize) -> Option<usize> {
    let tabs = leading_tabs(lines[index]);
    let content = &lines[index][tabs..];
    let after_tabs = |line: &str| line.get(tabs..).unwrap_or("").trim_end().to_owned();
    if let Some(marker) = content
        .chars()
        .next()
        .filter(|marker| matches!(marker, '`' | '~'))
    {
        let length = content.chars().take_while(|char| *char == marker).count();
        if length >= 3 {
            return Some(
                (index + 1..lines.len())
                    .find(|cursor| {
                        let closing = after_tabs(lines[*cursor]);
                        closing.chars().count() >= length
                            && closing.chars().all(|char| char == marker)
                    })
                    .unwrap_or(lines.len() - 1),
            );
        }
    }
    let math = content.trim_end();
    if math.len() >= 2 && math.chars().all(|char| char == '$') {
        return (index + 1..lines.len()).find(|cursor| after_tabs(lines[*cursor]) == math);
    }
    None
}

/// Nests lines indented with spaces under list items, as Markdown does: a list item indented
/// more than the list item before it becomes that item's child, one indented the same is its
/// sibling, and any other line indented under a list item continues that item as its child
/// Block. A list item with no list item before it stays at its tab depth, and any other line
/// without one keeps its leading spaces as text. Tabs keep their canonical meaning. Lines are
/// rewritten one for one.
pub(crate) fn nest_space_indented_list_items(lines: &[&str]) -> Vec<String> {
    let mut output: Vec<String> = lines.iter().map(|line| (*line).to_owned()).collect();
    let mut open: Vec<(usize, usize)> = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        if let Some(end) = fence_end(lines, index) {
            open.clear();
            index = end + 1;
            continue;
        }
        let line = lines[index];
        let tabs = leading_tabs(line);
        let rest = &line[tabs..];
        let body = rest.trim_start();
        index += 1;
        if body.is_empty() {
            continue;
        }
        let spaces = rest[..rest.len() - body.len()].chars().count();
        let column = tabs * 4 + spaces;
        if !is_list_item(body) {
            if spaces == 0 {
                if tabs == 0 {
                    open.clear();
                }
                continue;
            }
            while open
                .last()
                .is_some_and(|(open_column, _)| *open_column >= column)
            {
                open.pop();
            }
            if let Some((_, item_depth)) = open.last() {
                output[index - 1] = format!("{}{body}", "\t".repeat(item_depth + 1));
            }
            continue;
        }
        while open
            .last()
            .is_some_and(|(open_column, _)| *open_column > column)
        {
            open.pop();
        }
        let top = open.last().copied();
        let depth = match top {
            _ if spaces == 0 => tabs,
            None => tabs,
            Some((open_column, open_depth)) if open_column == column => open_depth,
            Some((_, open_depth)) => open_depth + 1,
        };
        if top.is_some_and(|(open_column, _)| open_column == column) {
            open.pop();
        }
        open.push((column, depth));
        if spaces > 0 {
            output[index - 1] = format!("{}{body}", "\t".repeat(depth));
        }
    }
    output
}

/// Escapes the start of a paragraph line that would otherwise be read as a Block marker or
/// as indentation, so the text stays a paragraph as written: `\- not a list`,
/// `1\. not a list`, `\# not a heading`, `\---`, and `\  indented text`. Characters that are
/// escaped everywhere, such as `*`, `>` and `|`, need nothing more.
pub(crate) fn protect_paragraph_start(text: &str) -> String {
    if text.starts_with([' ', '\t']) {
        return format!("\\{text}");
    }
    if text.trim() == "---" {
        return text.replacen('-', "\\-", 1);
    }
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0
        && let Some(after) = text[digits..].strip_prefix(['.', ')'])
        && (after.is_empty() || after.starts_with(char::is_whitespace))
    {
        return format!("{}\\{}", &text[..digits], &text[digits..]);
    }
    let hashes = text.bytes().take_while(|byte| *byte == b'#').count();
    let bullet = text
        .strip_prefix(['-', '+'])
        .is_some_and(|after| after.is_empty() || after.starts_with(' '));
    if bullet
        || ((1..=4).contains(&hashes) && text[hashes..].starts_with([' ', '\t']))
        || text.starts_with(['▶', '▼'])
    {
        return format!("\\{text}");
    }
    text.to_owned()
}

/// Reads a paragraph line's start escape back: `\- x` is the text `- x`.
pub(crate) fn unprotect_paragraph_start(text: &str) -> Cow<'_, str> {
    let spaces = text.len() - text.trim_start_matches(' ').len();
    let (indent, rest) = text.split_at(spaces);
    if let Some(after) = rest.strip_prefix('\\')
        && after.starts_with([' ', '\t', '-', '+', '#', '▶', '▼'])
    {
        return Cow::Owned(format!("{indent}{after}"));
    }
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0
        && let Some(after) = rest[digits..].strip_prefix('\\')
        && after.starts_with(['.', ')'])
    {
        return Cow::Owned(format!("{indent}{}{after}", &rest[..digits]));
    }
    Cow::Borrowed(text)
}

const SCHEMES: [&str; 2] = ["https://", "http://"];

/// The URL starting at `start`, without trailing punctuation or an unmatched closing bracket.
fn url_at(text: &str, start: usize) -> Option<&str> {
    let end = text[start..]
        .find(|char: char| char.is_whitespace() || char == '<')
        .map_or(text.len(), |offset| start + offset);
    let mut url = &text[start..end];
    while let Some(last) = url.chars().last() {
        let unmatched = |open: char| url.matches(open).count() < url.matches(last).count();
        if ".,:;!?'\"*_~".contains(last)
            || (last == ')' && unmatched('('))
            || (last == ']' && unmatched('['))
        {
            url = &url[..url.len() - last.len_utf8()];
        } else {
            break;
        }
    }
    let scheme = SCHEMES.iter().find(|scheme| url.starts_with(**scheme))?;
    (url.len() > scheme.len()).then_some(url)
}

/// Splits bare URLs out of plain text as links with the text's own styles, or None when the
/// text has none.
fn autolink_text(text: &str, styles: &NfmStyleSet) -> Option<Vec<NfmInlineContent>> {
    if styles.code {
        return None;
    }
    let mut parts = Vec::new();
    let mut cursor = 0;
    let mut search_from = 0;
    while let Some(start) = SCHEMES
        .iter()
        .filter_map(|scheme| {
            text[search_from..]
                .find(scheme)
                .map(|offset| search_from + offset)
        })
        .min()
    {
        let inside_word = text[..start]
            .chars()
            .last()
            .is_some_and(|char| char.is_ascii_alphanumeric());
        let Some(url) = (!inside_word).then(|| url_at(text, start)).flatten() else {
            search_from = start + 1;
            continue;
        };
        if start > cursor {
            parts.push(NfmInlineContent::Text {
                text: text[cursor..start].to_owned(),
                styles: styles.clone(),
            });
        }
        parts.push(NfmInlineContent::Link {
            text: url.to_owned(),
            href: url.to_owned(),
            styles: styles.clone(),
        });
        cursor = start + url.len();
        search_from = cursor;
    }
    if cursor == 0 {
        return None;
    }
    if cursor < text.len() {
        parts.push(NfmInlineContent::Text {
            text: text[cursor..].to_owned(),
            styles: styles.clone(),
        });
    }
    Some(parts)
}

fn autolink_inline(content: &mut Vec<NfmInlineContent>) {
    let mut linked = Vec::with_capacity(content.len());
    for item in std::mem::take(content) {
        let parts = match &item {
            NfmInlineContent::Text { text, styles } => autolink_text(text, styles),
            _ => None,
        };
        match parts {
            Some(parts) => linked.extend(parts),
            None => linked.push(item),
        }
    }
    *content = linked;
}

/// Links the bare URLs in message text, everywhere text is written except image captions.
pub(crate) fn autolink_blocks(blocks: &mut [NfmBlock]) {
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
                autolink_inline(content);
                autolink_blocks(children);
            }
            NfmBlock::Table { rows, .. } => {
                for cell in rows.iter_mut().flat_map(|row| row.cells.iter_mut()) {
                    autolink_inline(&mut cell.content);
                }
            }
            NfmBlock::EmptyBlock { children }
            | NfmBlock::Divider { children }
            | NfmBlock::CodeBlock { children, .. }
            | NfmBlock::Image { children, .. }
            | NfmBlock::ThreadSection { children, .. } => autolink_blocks(children),
            _ => {}
        }
    }
}
