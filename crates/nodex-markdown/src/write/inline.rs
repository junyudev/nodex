//! Shared inline wrappers, atoms and literal fences.

use super::escapes::{Text, needs_span};
use crate::attributes::{Attribute, write_attribute_list};
use crate::{AttachmentKind, Colors, Inline, Style};

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum Position {
    #[default]
    Text,
    Label,
    Cell,
}

#[derive(Clone)]
struct Segment {
    text: Text,
    literal: String,
    href: Option<String>,
    style: Style,
}

pub(super) fn colors(colors: Colors) -> Vec<Attribute> {
    let mut attributes = Vec::new();
    if let Some(color) = colors.text {
        attributes.push(Attribute::value("color", color.name()));
    }
    if let Some(color) = colors.background {
        attributes.push(Attribute::value("background", color.name()));
    }
    attributes
}

pub(super) fn optional_attributes(attributes: &[Attribute]) -> String {
    if attributes.is_empty() {
        String::new()
    } else {
        write_attribute_list(attributes)
    }
}

pub(super) fn text(items: &[Inline], position: Position) -> Text {
    text_with_mode(items, position, false, false)
}

pub(super) fn text_with_mode(
    items: &[Inline],
    position: Position,
    portable: bool,
    document_breaks: bool,
) -> Text {
    let mut segments = Vec::new();
    for item in items {
        match item {
            Inline::Text { text, style } => add_text(&mut segments, text, style, None),
            Inline::Link { href, content } => {
                for run in content {
                    add_text(&mut segments, &run.text, &run.style, Some(href));
                }
            }
            other => segments.push(Segment {
                text: Text::syntax(atom(other, position)),
                literal: String::new(),
                href: None,
                style: Style::default(),
            }),
        }
    }
    for index in 0..segments.len() {
        if segments[index].literal.is_empty()
            || segments[index].literal == "\n"
            || !segments[index].style.is_plain()
        {
            continue;
        }
        let leading = index == 0 || segments[index - 1].literal == "\n";
        let trailing = index + 1 == segments.len() || segments[index + 1].literal == "\n";
        segments[index].text = Text::escaped_edges(&segments[index].literal, leading, trailing);
    }
    // A physical empty line would start another Block. Keep the first interior break
    // as a newline and write the rest of its run as inline breaks.
    let mut start = 0;
    while start < segments.len() {
        if segments[start].literal != "\n" {
            start += 1;
            continue;
        }
        let mut end = start + 1;
        while end < segments.len() && segments[end].literal == "\n" {
            end += 1;
        }
        let all_inline = position != Position::Text || start == 0 || end == segments.len();
        for (offset, segment) in segments[start..end].iter_mut().enumerate() {
            if all_inline || offset > 0 {
                segment.text = Text::syntax("<br>");
            }
        }
        start = end;
    }
    if portable && document_breaks && position == Position::Text {
        for segment in &mut segments {
            if segment.text.source == "\n" {
                segment.text = Text::syntax("\\\n");
            }
        }
    }
    let mut out = nest(&segments, 0, portable, position == Position::Cell);
    if items.len() == 1
        && matches!(&items[0], Inline::Text { text, .. } if text == "\n")
        && position == Position::Text
    {
        out.push_syntax("<!-- -->");
    }
    out
}

fn add_text(segments: &mut Vec<Segment>, text: &str, style: &Style, href: Option<&String>) {
    for part in text.split_inclusive('\n') {
        let value = part.strip_suffix('\n').unwrap_or(part);
        if !value.is_empty() {
            segments.push(Segment {
                text: Text::escaped(value),
                literal: value.to_owned(),
                href: href.cloned(),
                style: style.clone(),
            });
        }
        if part.ends_with('\n') {
            segments.push(Segment {
                text: Text::syntax("\n"),
                literal: "\n".to_owned(),
                href: href.cloned(),
                style: Style::default(),
            });
        }
    }
}

fn same_wrapper(left: &Segment, right: &Segment, depth: usize) -> bool {
    match depth {
        0 => left.href == right.href,
        1 => {
            (
                left.style.underline,
                left.style.color,
                left.style.background,
            ) == (
                right.style.underline,
                right.style.color,
                right.style.background,
            )
        }
        2 => left.style.bold == right.style.bold,
        3 => left.style.italic == right.style.italic,
        4 => left.style.strike == right.style.strike,
        _ => left.style.code == right.style.code,
    }
}

fn nest(segments: &[Segment], depth: usize, portable: bool, cell: bool) -> Text {
    if depth > 5 {
        let mut out = Text::default();
        for segment in segments {
            out.append(segment.text.clone());
        }
        return out;
    }
    let mut groups: Vec<Text> = Vec::new();
    let mut start = 0;
    while start < segments.len() {
        let mut end = start + 1;
        while end < segments.len() && same_wrapper(&segments[start], &segments[end], depth) {
            end += 1;
        }
        let head = &segments[start];
        let inner = nest(&segments[start..end], depth + 1, portable, cell);
        let wrapped = match depth {
            0 if head.href.is_some() => {
                let href = head.href.as_deref().unwrap_or_default();
                let plain = segments[start..end]
                    .iter()
                    .all(|segment| segment.style.is_plain());
                let label: String = segments[start..end]
                    .iter()
                    .map(|segment| segment.literal.as_str())
                    .collect();
                // Read the URL in place: not every URL-shaped label is a GFM bare link.
                if plain
                    && bare_link(
                        href,
                        &label,
                        groups
                            .last()
                            .and_then(|g| unescape(&g.source).chars().next_back()),
                        segments
                            .get(end)
                            .and_then(|s| unescape(&s.text.source).chars().next()),
                    )
                {
                    Text::autolink(label, href)
                } else {
                    let url = destination(href);
                    let url = if cell { url.replace('|', "\\|") } else { url };
                    surround("[", inner, &format!("]({url})"))
                }
            }
            1 if head.style.underline
                || head.style.color.is_some()
                || head.style.background.is_some() =>
            {
                let mut attrs = colors(Colors {
                    text: head.style.color,
                    background: head.style.background,
                });
                if head.style.underline {
                    attrs.insert(0, Attribute::flag("underline"));
                }
                surround(
                    ":span[",
                    inner,
                    &format!("]{}", write_attribute_list(&attrs)),
                )
            }
            2 if head.style.bold => emphasis("**", inner, &groups, segments.get(end), portable),
            3 if head.style.italic => emphasis("*", inner, &groups, segments.get(end), portable),
            4 if head.style.strike => emphasis("~~", inner, &groups, segments.get(end), portable),
            5 if head.style.code => {
                let literal: String = segments[start..end]
                    .iter()
                    .map(|s| s.literal.as_str())
                    .collect();
                let code = literal_fence(&literal, '`', 1);
                Text::syntax(if cell { code.replace('|', "\\|") } else { code })
            }
            _ => inner,
        };
        let adjacent_delimiters = groups.last().is_some_and(|previous| {
            previous.source.ends_with(['*', '~']) && wrapped.source.starts_with(['*', '~'])
        });
        let wrapped = if !portable && adjacent_delimiters {
            surround(":span[", wrapped, "]")
        } else {
            wrapped
        };
        groups.push(wrapped);
        start = end;
    }
    let mut out = Text::default();
    for group in groups {
        out.append(group);
    }
    out
}

fn emphasis(
    delimiter: &str,
    inner: Text,
    groups: &[Text],
    next: Option<&Segment>,
    portable: bool,
) -> Text {
    let before = groups.last().map_or("", |g| g.source.as_str());
    let after = next.map_or("", |s| s.text.source.as_str());
    let protect = !portable && needs_span(delimiter, &inner.source, before, after);
    let wrapped = surround(delimiter, inner, delimiter);
    if protect {
        surround(":span[", wrapped, "]")
    } else {
        wrapped
    }
}

fn surround(open: &str, inner: Text, close: &str) -> Text {
    let mut out = Text::syntax(open);
    out.append(inner);
    out.push_syntax(close);
    out
}

fn unescape(source: &str) -> String {
    let mut out = String::new();
    let decoded = crate::attributes::decode_references(source);
    let mut chars = decoded.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\' && chars.peek().is_some_and(char::is_ascii_punctuation) {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(character);
        }
    }
    out
}

pub(super) fn longest_run(source: &str, marker: char) -> usize {
    let mut longest = 0;
    let mut current = 0;
    for character in source.chars() {
        current = if character == marker { current + 1 } else { 0 };
        longest = longest.max(current);
    }
    longest
}

pub(super) fn literal_fence(source: &str, marker: char, minimum: usize) -> String {
    let fence = marker
        .to_string()
        .repeat(minimum.max(longest_run(source, marker) + 1));
    let padding = if source.starts_with(marker)
        || source.ends_with(marker)
        || (source.starts_with(' ') && source.ends_with(' ') && !source.chars().all(|c| c == ' '))
    {
        " "
    } else {
        ""
    };
    format!("{fence}{padding}{source}{padding}{fence}")
}

pub(super) fn destination(url: &str) -> String {
    let mut balance = 0_i64;
    let mut unbalanced = false;
    for character in url.chars() {
        if character == '(' {
            balance += 1;
        }
        if character == ')' {
            balance -= 1;
            unbalanced |= balance < 0;
        }
    }
    let angle = url
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '<' | '>'))
        || balance != 0
        || unbalanced;
    let mut encoded = String::with_capacity(url.len());
    for (index, character) in url.char_indices() {
        match character {
            '&' if url_reference(&url[index..]) => encoded.push_str("&amp;"),
            '<' => encoded.push_str("&lt;"),
            '>' => encoded.push_str("&gt;"),
            '\\' => encoded.push_str("\\\\"),
            '\n' => encoded.push_str("&#10;"),
            '\r' => encoded.push_str("&#13;"),
            other => encoded.push(other),
        }
    }
    if angle {
        format!("<{encoded}>")
    } else {
        encoded
    }
}

fn url_reference(source: &str) -> bool {
    let Some(end) = source.bytes().take(34).position(|byte| byte == b';') else {
        return false;
    };
    let reference = &source[..=end];
    if !reference[1..end]
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'#')
    {
        return false;
    }
    crate::read_inline(reference, crate::ReadOptions::EXACT)
        .ok()
        .is_some_and(|items| crate::text::inline_text(&items) != reference)
}

fn bare_link(href: &str, label: &str, before: Option<char>, after: Option<char>) -> bool {
    // The label is still fully escaped here.
    let label = label.to_owned();
    let starts = if label == href
        && (label
            .get(..8)
            .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
            || label
                .get(..7)
                .is_some_and(|s| s.eq_ignore_ascii_case("http://")))
    {
        !before.is_some_and(|c| c.is_ascii_alphabetic())
    } else if href == format!("http://{label}")
        && label
            .get(..4)
            .is_some_and(|s| s.eq_ignore_ascii_case("www."))
    {
        before.is_none_or(|c| c.is_whitespace() || "*_~(".contains(c))
    } else if href == format!("mailto:{label}") {
        !before.is_some_and(|c| c.is_ascii_alphanumeric() || "+-._".contains(c))
    } else {
        false
    };
    if !starts
        || after.is_some_and(|c| {
            !c.is_whitespace() && !".,:;!?'\")]。．，、？！：；（）【】「」『』〈〉《》".contains(c)
        })
    {
        return false;
    }
    let expected = vec![crate::Block::new(crate::BlockKind::Paragraph {
        text: vec![Inline::Link {
            href: href.to_owned(),
            content: vec![crate::StyledText {
                text: label.clone(),
                style: Style::default(),
            }],
        }],
        colors: Colors::default(),
    })];
    crate::read(&label, crate::ReadOptions::EXACT).ok().as_ref() == Some(&expected)
}

pub(super) fn image(url: &str, alt: &str, width: Option<u32>) -> Text {
    let mut out = Text::syntax("![");
    out.append(Text::escaped(alt));
    if let Some(width) = width {
        out.push_syntax(&format!("|{width}"));
    }
    out.push_syntax(&format!("]({})", destination(url)));
    out
}

fn atom(item: &Inline, position: Position) -> String {
    let (name, attributes) = match item {
        Inline::PageMention { page } => return format!("<{}>", crate::links::page_link(page)),
        Inline::ChatMention { session } => {
            return format!("<{}>", crate::links::session_link(session));
        }
        Inline::Math { source } => return literal_fence(source, '$', 2),
        Inline::Image(image) => {
            let written = image_text(image);
            return if position == Position::Cell {
                table_pipes(&written)
            } else {
                written
            };
        }
        Inline::DateMention(date) => {
            let mut attrs = vec![Attribute::value("start", &date.start)];
            for (key, value) in [
                ("end", &date.end),
                ("tz", &date.tz),
                ("format", &date.format),
                ("time-format", &date.time_format),
                ("reminder", &date.reminder),
            ] {
                if let Some(value) = value {
                    attrs.push(Attribute::value(key, value));
                }
            }
            ("date", attrs)
        }
        Inline::Attachment(attachment) => {
            let mut attrs = vec![Attribute::value("kind", attachment.kind.name())];
            if attachment.link {
                attrs.push(Attribute::value("mode", "link"));
            }
            attrs.push(Attribute::value("source", &attachment.source));
            attrs.push(Attribute::value("name", &attachment.name));
            if let Some(mime) = &attachment.mime {
                attrs.push(Attribute::value("mime", mime));
            }
            if attachment.kind != AttachmentKind::Folder
                && let Some(bytes) = attachment.bytes
            {
                attrs.push(Attribute::value("bytes", bytes.to_string()));
            }
            if let Some(origin) = &attachment.origin {
                attrs.push(Attribute::value("origin", origin));
            }
            ("attachment", attrs)
        }
        Inline::AgentConfig(config) => {
            let mut attrs = Vec::new();
            for (key, value) in [
                ("mode", &config.mode),
                ("provider", &config.provider),
                ("model", &config.model),
                ("reasoning", &config.reasoning),
                ("speed", &config.speed),
            ] {
                if let Some(value) = value {
                    attrs.push(Attribute::value(key, value));
                }
            }
            attrs.extend(
                config
                    .unknown
                    .iter()
                    .map(|(key, value)| Attribute::value(key, value)),
            );
            ("agent-config", attrs)
        }
        Inline::Text { .. } | Inline::Link { .. } => return String::new(),
    };
    format!(":{name}{}", write_attribute_list(&attributes))
}

fn table_pipes(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut backslashes = 0;
    for character in source.chars() {
        if character == '|' && backslashes % 2 == 0 {
            out.push('\\');
        }
        out.push(character);
        backslashes = if character == '\\' {
            backslashes + 1
        } else {
            0
        };
    }
    out
}

fn image_text(value: &crate::InlineImage) -> String {
    let mut standalone = value.clone();
    standalone.href = None;
    let expected = vec![crate::Block::new(crate::BlockKind::Paragraph {
        text: vec![Inline::Image(standalone)],
        colors: Colors::default(),
    })];
    let written = image(&value.url, &value.alt, value.width)
        .finish_expected(|s| format!("{s}<!-- -->"), expected);
    match &value.href {
        Some(href) => format!("[{written}]({})", destination(href)),
        None => written,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bare_url_is_a_link() {
        let url = "https://example.com/docs";
        assert!(
            bare_link(url, url, Some(' '), Some(' ')),
            "{:?}",
            crate::read(url, crate::ReadOptions::EXACT)
        );
    }
}
