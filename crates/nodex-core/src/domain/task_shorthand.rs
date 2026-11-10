use std::collections::BTreeSet;

use unicode_normalization::UnicodeNormalization;

use super::rich_text::{RichTextItem, rich_text_plain_text};

pub(crate) const TASK_SHORTHAND_GRAMMAR_VERSION: u32 = 1;
const MAX_PREFIX_BYTES: usize = 1_024;
const MAX_TAGS: usize = 32;
const MAX_TAG_NAME_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskShorthandMatch {
    pub(crate) rewritten_title: Vec<RichTextItem>,
    pub(crate) priority: u8,
    pub(crate) estimate: Option<String>,
    pub(crate) tag_names: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskShorthandRejection {
    Malformed,
    NonemptyTitleRequired,
    RichTextBoundary,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TaskShorthandParse {
    NoMatch,
    Rejected(TaskShorthandRejection),
    Match(TaskShorthandMatch),
}

struct TaskShorthandCandidate<'a> {
    priority_char: char,
    estimate: Option<&'static str>,
    raw_tags: Option<&'a str>,
    consumed_bytes: usize,
}

/// Parses only a leading run of ordinary rich-text Text spans. Inline atoms,
/// links and line breaks are authority boundaries and are never flattened.
pub(crate) fn parse_task_shorthand(items: &[RichTextItem]) -> TaskShorthandParse {
    let Some(RichTextItem::Text { text: first, .. }) = items.first() else {
        return TaskShorthandParse::NoMatch;
    };
    if !first.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
        return TaskShorthandParse::NoMatch;
    }

    let mut leading_text = String::new();
    for item in items {
        let RichTextItem::Text { text, .. } = item else {
            break;
        };
        leading_text.push_str(text);
    }

    let Some(candidate) = scan_candidate(&leading_text) else {
        let crosses_authority_boundary = items
            .iter()
            .any(|item| !matches!(item, RichTextItem::Text { .. }))
            && scan_candidate(&rich_text_plain_text(items)).is_some();
        return if crosses_authority_boundary {
            TaskShorthandParse::Rejected(TaskShorthandRejection::RichTextBoundary)
        } else {
            TaskShorthandParse::NoMatch
        };
    };
    validate_candidate(items, &leading_text, candidate)
}

fn scan_candidate(leading_text: &str) -> Option<TaskShorthandCandidate<'_>> {
    let priority_char = leading_text.chars().next()?;
    if !priority_char.is_ascii_digit() {
        return None;
    }
    let mut cursor = 1;
    let mut estimate = None;
    let remaining_upper = leading_text[cursor..].to_ascii_uppercase();
    for candidate in ["XL", "XS", "S", "M", "L"] {
        if remaining_upper.starts_with(candidate) {
            estimate = Some(candidate);
            cursor += candidate.len();
            break;
        }
    }

    let mut raw_tags = None;
    if leading_text[cursor..].starts_with('(') {
        let close_offset = leading_text[cursor + 1..].find(')')?;
        let close = cursor + 1 + close_offset;
        raw_tags = Some(&leading_text[cursor + 1..close]);
        cursor = close + 1;
    }

    if leading_text[cursor..].starts_with(':') {
        return None;
    }
    let whitespace_bytes = leading_text[cursor..]
        .char_indices()
        .take_while(|(_, ch)| ch.is_whitespace())
        .last()
        .map_or(0, |(offset, ch)| offset + ch.len_utf8());
    if whitespace_bytes == 0 {
        return None;
    }
    cursor += whitespace_bytes;

    Some(TaskShorthandCandidate {
        priority_char,
        estimate,
        raw_tags,
        consumed_bytes: cursor,
    })
}

fn validate_candidate(
    items: &[RichTextItem],
    leading_text: &str,
    candidate: TaskShorthandCandidate<'_>,
) -> TaskShorthandParse {
    // A digit-leading title becomes a shorthand candidate only after a complete
    // compact token and its whitespace separator have been recognized. Keep all
    // semantic validation below this gate so ordinary titles remain literal.
    if !matches!(candidate.priority_char, '0'..='3') {
        return TaskShorthandParse::Rejected(TaskShorthandRejection::Malformed);
    }
    if candidate.consumed_bytes > MAX_PREFIX_BYTES {
        return TaskShorthandParse::Rejected(TaskShorthandRejection::Malformed);
    }
    let Some(tags) = parse_tags(candidate.raw_tags) else {
        return TaskShorthandParse::Rejected(TaskShorthandRejection::Malformed);
    };
    if title_is_empty(items, leading_text, candidate.consumed_bytes) {
        return TaskShorthandParse::Rejected(TaskShorthandRejection::NonemptyTitleRequired);
    }

    let priority = candidate
        .priority_char
        .to_digit(10)
        .expect("validated priority") as u8;
    TaskShorthandParse::Match(TaskShorthandMatch {
        rewritten_title: strip_leading_text(items, candidate.consumed_bytes),
        priority,
        estimate: candidate.estimate.map(str::to_owned),
        tag_names: tags,
    })
}

fn parse_tags(raw_tags: Option<&str>) -> Option<Vec<String>> {
    let Some(raw_tags) = raw_tags else {
        return Some(Vec::new());
    };
    if raw_tags.contains(['(', ')']) {
        return None;
    }
    let mut seen = BTreeSet::new();
    let mut tags = Vec::new();
    for raw in raw_tags.split(',') {
        let canonical = raw.trim().nfc().collect::<String>();
        if canonical.is_empty()
            || canonical.len() > MAX_TAG_NAME_BYTES
            || canonical.chars().any(char::is_control)
        {
            return None;
        }
        if seen.insert(canonical.clone()) {
            tags.push(canonical);
        }
    }
    (tags.len() <= MAX_TAGS).then_some(tags)
}

fn title_is_empty(items: &[RichTextItem], leading_text: &str, consumed_bytes: usize) -> bool {
    !leading_text[consumed_bytes..]
        .chars()
        .any(|ch| !ch.is_whitespace())
        && !items
            .iter()
            .skip_while(|item| matches!(item, RichTextItem::Text { .. }))
            .any(|item| match item {
                RichTextItem::Text { text, .. } | RichTextItem::Link { text, .. } => {
                    !text.trim().is_empty()
                }
                RichTextItem::LineBreak => false,
                RichTextItem::ThreadMention { .. }
                | RichTextItem::PageMention { .. }
                | RichTextItem::SkillMention { .. }
                | RichTextItem::DateMention { .. } => true,
            })
}

fn strip_leading_text(items: &[RichTextItem], mut remaining: usize) -> Vec<RichTextItem> {
    let mut rewritten = Vec::new();
    for item in items {
        match item {
            RichTextItem::Text { text, styles } if remaining > 0 => {
                if remaining >= text.len() {
                    remaining -= text.len();
                    continue;
                }
                rewritten.push(RichTextItem::Text {
                    text: text[remaining..].to_owned(),
                    styles: styles.clone(),
                });
                remaining = 0;
            }
            _ => rewritten.push(item.clone()),
        }
    }
    rewritten
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::rich_text::RichTextStyles;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        title: String,
        outcome: String,
        #[serde(rename = "match")]
        matches: bool,
        priority: Option<u8>,
        estimate: Option<String>,
        tags: Option<Vec<String>>,
        rewritten_title: Option<String>,
    }

    fn text(value: &str) -> RichTextItem {
        RichTextItem::Text {
            text: value.to_owned(),
            styles: RichTextStyles::default(),
        }
    }

    #[test]
    fn parses_whitespace_forms_and_preserves_title_styles() {
        let styled = RichTextStyles {
            bold: true,
            ..RichTextStyles::default()
        };
        let result = parse_task_shorthand(&[
            text("1XL(ui, unclear) "),
            RichTextItem::Text {
                text: "Fix import".to_owned(),
                styles: styled.clone(),
            },
        ]);
        let TaskShorthandParse::Match(parsed) = result else {
            panic!("expected match")
        };
        assert_eq!(parsed.priority, 1);
        assert_eq!(parsed.estimate.as_deref(), Some("XL"));
        assert_eq!(parsed.tag_names, ["ui", "unclear"]);
        assert_eq!(
            parsed.rewritten_title,
            [RichTextItem::Text {
                text: "Fix import".to_owned(),
                styles: styled
            }]
        );
    }

    #[test]
    fn supports_priority_only_and_normalizes_deduplicated_tags() {
        let TaskShorthandParse::Match(priority) = parse_task_shorthand(&[text("1 Investigate")])
        else {
            panic!("expected priority")
        };
        assert_eq!(priority.priority, 1);
        let TaskShorthandParse::Match(tags) =
            parse_task_shorthand(&[text("2(UI, U\u{308}I, UI) Work")])
        else {
            panic!("expected tags")
        };
        assert_eq!(tags.tag_names, ["UI", "ÜI"]);
    }

    #[test]
    fn colon_p4_empty_title_and_inline_boundaries_are_never_applied() {
        assert_eq!(
            parse_task_shorthand(&[text("1XL: Fix")]),
            TaskShorthandParse::NoMatch
        );
        assert!(matches!(
            parse_task_shorthand(&[text("4XL Later")]),
            TaskShorthandParse::Rejected(_)
        ));
        assert!(matches!(
            parse_task_shorthand(&[text("1XL(ui)")]),
            TaskShorthandParse::NoMatch
        ));
        assert!(matches!(
            parse_task_shorthand(&[
                text("1XL"),
                RichTextItem::ThreadMention {
                    uuid: "t".to_owned()
                }
            ]),
            TaskShorthandParse::NoMatch
        ));
        assert!(matches!(
            parse_task_shorthand(&[
                text("4XL"),
                RichTextItem::PageMention {
                    target_page_id: "page:target".to_owned()
                }
            ]),
            TaskShorthandParse::NoMatch
        ));
        assert!(matches!(
            parse_task_shorthand(&[
                text("1"),
                RichTextItem::Link {
                    text: "XL".to_owned(),
                    href: "https://nodex.dev".to_owned(),
                    styles: RichTextStyles::default(),
                },
                text(" Fix import"),
            ]),
            TaskShorthandParse::Rejected(TaskShorthandRejection::RichTextBoundary)
        ));
        let TaskShorthandParse::Match(prefix_before_atom) = parse_task_shorthand(&[
            text("1XL "),
            RichTextItem::PageMention {
                target_page_id: "page:target".to_owned(),
            },
        ]) else {
            panic!("expected prefix before rich title atom to match")
        };
        assert_eq!(
            prefix_before_atom.rewritten_title,
            [RichTextItem::PageMention {
                target_page_id: "page:target".to_owned(),
            }]
        );
    }

    #[test]
    fn matches_the_shared_v1_conformance_corpus() {
        let fixtures = serde_json::from_str::<Vec<Fixture>>(include_str!(
            "../../../../src/shared/fixtures/task-shorthand-v1-conformance.json"
        ))
        .expect("task shorthand fixtures");
        for fixture in fixtures {
            let parsed = parse_task_shorthand(&[text(&fixture.title)]);
            let outcome = match &parsed {
                TaskShorthandParse::NoMatch => "no_match",
                TaskShorthandParse::Rejected(_) => "rejected",
                TaskShorthandParse::Match(_) => "match",
            };
            assert_eq!(outcome, fixture.outcome, "{}", fixture.title);
            if !fixture.matches {
                assert!(
                    !matches!(parsed, TaskShorthandParse::Match(_)),
                    "{}",
                    fixture.title
                );
                continue;
            }
            let TaskShorthandParse::Match(parsed) = parsed else {
                panic!("expected match for {}", fixture.title)
            };
            assert_eq!(Some(parsed.priority), fixture.priority, "{}", fixture.title);
            assert_eq!(parsed.estimate, fixture.estimate, "{}", fixture.title);
            assert_eq!(
                parsed.tag_names,
                fixture.tags.unwrap_or_default(),
                "{}",
                fixture.title
            );
            assert_eq!(
                parsed.rewritten_title,
                [text(
                    fixture.rewritten_title.as_deref().expect("rewritten title")
                )],
                "{}",
                fixture.title
            );
        }
    }
}
