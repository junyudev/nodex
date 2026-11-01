//! GFM autolink discovery without interpreting the surrounding literal text as Markdown.

use crate::{Inline, Style, StyledText};
use comrak::{Arena, nodes::NodeValue, parse_document};

/// Keeps every source character, adding only links that Comrak recognizes as bare addresses.
/// Source positions select the original spelling, so entities, escapes, indentation and other
/// Markdown-looking text are never decoded or reformatted by this projection.
pub(crate) fn link_literal_addresses(text: &str) -> Vec<Inline> {
    if text.is_empty() {
        return Vec::new();
    }
    if !text.contains([':', '@']) && !text.contains("www.") {
        return vec![super::inline::text(text)];
    }
    let mut out = Vec::new();
    let mut cursor = 0;
    let mut checked_through = 0;
    for (start, end, email) in candidates(text) {
        if start < cursor || start < checked_through {
            continue;
        }
        // Escape only the preceding character, preserving WWW's literal left boundary without
        // allowing it to open a code span, HTML, image or link around the address candidate.
        let before = text[..start].chars().next_back().unwrap_or(' ');
        let before = if before.is_ascii_punctuation() {
            format!("\\{before}")
        } else if before == '\n' || before == '\r' {
            " ".to_owned()
        } else {
            before.to_string()
        };
        let prefix = format!("x {before}");
        // Email discovery runs on decoded text after inline parsing. References prevent even
        // punctuation inside the candidate (such as underscores) from becoming Markdown.
        let body = if email {
            text[start..end]
                .chars()
                .map(|character| {
                    if character.is_ascii_punctuation() {
                        format!("&#{};", u32::from(character))
                    } else {
                        character.to_string()
                    }
                })
                .collect::<String>()
        } else {
            text[start..end].to_owned()
        };
        let source = format!("{prefix}{body}");
        let arena = Arena::new();
        let root = parse_document(&arena, &source, &super::parser_options());
        // One ordinary text word proves all of its candidates together. Only syntax that can
        // hide an address requires another probe; avoid reparsing every marker in a long word.
        if !email
            && root.descendants().all(|node| {
                let data = node.data.borrow();
                if data.sourcepos.end.column <= prefix.len() {
                    return true;
                }
                match &data.value {
                    NodeValue::Document | NodeValue::Paragraph => true,
                    NodeValue::Text(text) => !text.contains(['[', ']']),
                    _ => false,
                }
            })
        {
            checked_through = end;
        }
        for node in root.descendants() {
            let data = node.data.borrow();
            let NodeValue::Link(link) = &data.value else {
                continue;
            };
            let range = if email {
                node.first_child()
                    .and_then(|child| match &child.data.borrow().value {
                        NodeValue::Text(label) => text[cursor.max(start)..end]
                            .find(label.as_ref())
                            .map(|offset| {
                                let begin = cursor.max(start) + offset;
                                begin..begin + label.len()
                            }),
                        _ => None,
                    })
            } else {
                let position = data.sourcepos;
                if position.start.line != 1 || position.end.line != 1 {
                    continue;
                }
                position
                    .start
                    .column
                    .checked_sub(prefix.len() + 1)
                    .and_then(|offset| {
                        let length = position.end.column.checked_sub(position.start.column - 1)?;
                        Some(start + offset..start + offset + length)
                    })
            };
            let Some(range) = range else { continue };
            let (begin, finish) = (range.start, range.end);
            let Some(label) = text.get(begin..finish) else {
                continue;
            };
            let self_link = link.url == label
                || link.url == format!("http://{label}")
                || link.url == format!("mailto:{label}");
            if begin < cursor
                || !self_link
                || !link.url.split_once(':').is_some_and(|(scheme, _)| {
                    ["http", "https", "mailto"]
                        .iter()
                        .any(|expected| scheme.eq_ignore_ascii_case(expected))
                })
            {
                continue;
            }
            if begin > cursor {
                out.push(super::inline::text(&text[cursor..begin]));
            }
            out.push(Inline::Link {
                href: link.url.clone(),
                content: vec![StyledText {
                    text: label.to_owned(),
                    style: Style::default(),
                }],
            });
            cursor = finish;
        }
    }
    if cursor < text.len() {
        out.push(super::inline::text(&text[cursor..]));
    }
    crate::model::normalize_inline(&mut out);
    out
}

/// These are lexical probe boundaries, not address validation. Comrak alone decides the
/// scheme, host, mail/domain validity, balancing, entities and trailing punctuation.
fn candidates(text: &str) -> Vec<(usize, usize, bool)> {
    let bytes = text.as_bytes();
    let mut candidates = Vec::new();
    let mut word_end = 0;
    for (index, &byte) in bytes.iter().enumerate() {
        let start = match byte {
            b':' if text[index..].starts_with("://") => {
                let before = bytes[..index]
                    .iter()
                    .rev()
                    .take_while(|byte| byte.is_ascii_alphabetic())
                    .count();
                index - before
            }
            b'w' if text[index..].starts_with("www.") => index,
            b'@' => {
                let before = bytes[..index]
                    .iter()
                    .rev()
                    .take_while(|byte| {
                        byte.is_ascii_alphanumeric()
                            || matches!(byte, b'.' | b'+' | b'-' | b'_' | b':')
                    })
                    .count();
                if before == 0 {
                    continue;
                }
                index - before
            }
            _ => continue,
        };
        if word_end <= index {
            word_end = bytes[index..]
                .iter()
                .position(|byte| matches!(byte, 9..=13 | 32))
                .map_or(text.len(), |end| index + end);
        }
        let email = byte == b'@';
        let end = if email {
            text[index + 1..]
                .char_indices()
                .find(|(_, character)| {
                    !character.is_ascii_alphanumeric() && !matches!(character, '.' | '-' | '_')
                })
                .map_or(text.len(), |(offset, character)| {
                    index + 1 + offset + character.len_utf8()
                })
        } else {
            word_end
        };
        candidates.push((start, end, email));
    }
    candidates.sort_unstable();
    candidates.dedup();
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_addresses_use_the_readers_gfm_boundaries_and_keep_every_character() {
        for source in [
            "see https://e.x/a, www.e.x or a@b.co",
            "中文\thttps://example.com/a_(b)?x=1&y=2.  ",
            "AT&amp;T \\* https://e.x/?a=1&amp;b=2\n\tmail a.b+tag@example.com!",
            "a@b.com and bad@localhost www.bad_domain.example https://e.x/a).",
        ] {
            let items = link_literal_addresses(source);
            let restored: String = items
                .iter()
                .map(|item| match item {
                    Inline::Text { text, .. } => text.clone(),
                    Inline::Link { content, .. } => {
                        content.iter().map(|run| run.text.as_str()).collect()
                    }
                    _ => unreachable!(),
                })
                .collect();
            assert_eq!(restored, source);
            let read = crate::read_inline(&source.replace('\n', " "), crate::ReadOptions::BOUNDARY)
                .unwrap();
            let links = |items: Vec<Inline>| {
                items
                    .into_iter()
                    .filter(|item| matches!(item, Inline::Link { .. }))
                    .collect::<Vec<_>>()
            };
            assert_eq!(links(items), links(read), "{source}");
        }
    }

    #[test]
    fn surrounding_literal_markdown_never_hides_an_address() {
        let url = "http://127.0.0.1:51283/api/projects/assets/a.png";
        for source in [
            format!("instead of currently \"![image]({url})\"."),
            format!("[label]({url})"),
            format!("`code {url} `"),
            format!("<span href=\"{url} \">"),
            format!("![outer [inner]]({url})"),
        ] {
            let items = link_literal_addresses(&source);
            assert_eq!(
                items
                    .iter()
                    .filter(|item| matches!(item, Inline::Link { .. }))
                    .count(),
                1,
                "{source}"
            );
            assert!(items.iter().any(|item| matches!(item, Inline::Link { href, content } if href == url && content[0].text == url)), "{source}: {items:?}");
            let blocks = vec![crate::Block::new(crate::BlockKind::Paragraph {
                text: items,
                colors: crate::Colors::default(),
            })];
            assert_eq!(crate::text::block_lines(&blocks), source);
        }
        for source in [
            "[me+tag@example.com]",
            "`me+tag@example.com`",
            "[email](me+tag@example.com)",
        ] {
            assert!(link_literal_addresses(source).iter().any(|item| matches!(item, Inline::Link { href, content } if href == "mailto:me+tag@example.com" && content[0].text == "me+tag@example.com")), "{source}");
        }
    }

    #[test]
    fn literal_candidates_preserve_the_readers_address_rules() {
        for address in [
            "http://localhost:51283/a.png",
            "HTTP://example.com/a_(b)?x=1&y=2.",
            "www.example.com/a_(b)",
            "www.bad_domain.example",
            "bad@localhost",
            "me+tag@example.com",
            "a.b-c_d@example.com",
            "invalid@domain.123",
            "wordhttps://example.com",
            "awww.example.com",
            "https://example.com/a&amp;",
            "https://example.com/a_(b)).",
        ] {
            let source = format!("Before {address} after");
            let links = |items: Vec<Inline>| {
                items
                    .into_iter()
                    .filter(|item| matches!(item, Inline::Link { .. }))
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                links(link_literal_addresses(&source)),
                links(crate::read_inline(&source, crate::ReadOptions::EXACT).unwrap()),
                "{source}"
            );
        }
    }

    #[test]
    fn repeated_candidates_in_one_literal_word_preserve_the_following_address() {
        let url = "https://example.com";
        let source = format!("{} {url}", "http://bad_host.test".repeat(2000));
        let items = link_literal_addresses(&source);
        let links: Vec<_> = items
            .iter()
            .filter(|item| matches!(item, Inline::Link { .. }))
            .collect();
        assert_eq!(links.len(), 1);
        assert!(matches!(links[0], Inline::Link { href, .. } if href == url));
    }

    #[test]
    fn email_punctuation_is_literal_rather_than_emphasis() {
        for address in ["_john@example.com", "a@b_domain_.com"] {
            assert!(link_literal_addresses(address).iter().any(|item| matches!(item, Inline::Link { href, content } if href == &format!("mailto:{address}") && content[0].text == address)), "{address}");
        }
        assert!(
            link_literal_addresses("_john@example.com_")
                .iter()
                .all(|item| matches!(item, Inline::Text { .. }))
        );
        assert!(
            link_literal_addresses("a@b._domain_.com")
                .iter()
                .all(|item| matches!(item, Inline::Text { .. }))
        );
    }
}
